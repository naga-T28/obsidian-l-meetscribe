import type { NoteOutput, TranscriptionStatus } from '../session/ports';
import type { NoteProgress, SessionRecord } from '../session/records';
import type { SessionStore } from '../session/SessionStore';
import { mergeTranscript } from '../transcription/TranscriptMerger';
import { insertBlockId, NoteWriteError, type TextEdit } from './meetingBlock';
import {
	appendTranscriptEdit,
	formatTranscriptLines,
	prepareEdits,
	readSummaryArea,
	readTranscriptArea,
	transcriptAreaIncludes,
	writeSummaryEdit,
} from './outputArea';

/** ノートの読み書き。Obsidianでの実装はObsidianNoteAccess。テストでは文字列で代用する。 */
export interface NoteAccess {
	read(path: string): Promise<string>;
	/**
	 * 最新の本文からcomputeで求めた変更を適用し、ディスクへ保存した後の本文を返す。
	 * computeが例外を投げたら何も書かない。
	 */
	edit(path: string, compute: (text: string) => TextEdit[]): Promise<string>;
}

export type NoteWriterStore = Pick<SessionStore, 'loadChunks' | 'loadSegments' | 'loadNoteProgress' | 'saveNoteProgress' | 'loadSummary'>;

/**
 * 会議ノートの出力領域を更新する。書き込みはすべて1本の鎖で直列化し、毎回最新の本文から境界を探す。
 * 追記はディスク上のノートで保存を確かめてから反映済みとして作業領域に記録する。
 */
export class NoteWriter implements NoteOutput {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly access: NoteAccess,
		private readonly store: NoteWriterStore,
	) {}

	/** 空のlmsブロックにIDを付ける。行範囲は描画時のもので、最新の本文で空のブロックのままかを確かめる。 */
	assignBlockId(path: string, lineStart: number, lineEnd: number, id: string): Promise<void> {
		return this.serial(async () => {
			await this.access.edit(path, (text) => [insertBlockId(text, lineStart, lineEnd, id)]);
		});
	}

	prepare(session: SessionRecord): Promise<void> {
		return this.serial(async () => {
			await this.access.edit(session.notePath, (text) => prepareEdits(text, session.blockId, session.sessionId));
		});
	}

	sync(session: SessionRecord, status: TranscriptionStatus): Promise<void> {
		return this.serial(() => this.syncNow(session, status));
	}

	/**
	 * summary.jsonに保存済みの成功した要約を、要約領域へ書く。
	 * 利用者が編集した要約は置き換えず、別案として追記する。ディスク上のノートへの保存を確かめる。
	 */
	writeSummary(session: SessionRecord): Promise<void> {
		return this.serial(async () => {
			const { sessionId } = session;
			const run = await this.store.loadSummary(sessionId);
			if (run?.status !== 'success' || run.result === undefined) {
				throw new Error('保存済みの要約がありません。');
			}
			const summary = run.result;
			const progress = await this.store.loadNoteProgress(sessionId);
			let hash: string | undefined;
			const saved = await this.access.edit(session.notePath, (text) => {
				const write = writeSummaryEdit(text, sessionId, summary, progress.summaryHash, `再生成した要約（${formatLocalDateTime(new Date())}、${run.model}）`);
				hash = write.hash;
				return [write.edit];
			});
			if (!(readSummaryArea(saved, sessionId) ?? '').includes(summary.trim())) {
				throw new NoteWriteError('notSaved', '要約をノートへ保存できたことを確認できませんでした。');
			}
			if (hash !== undefined) {
				await this.store.saveNoteProgress(sessionId, { ...progress, summaryHash: hash });
			}
		});
	}

	/** 要約へ渡す文字起こし。利用者が編集した内容を含む。 */
	readTranscript(path: string, sessionId: string): Promise<string> {
		return this.serial(async () => readTranscriptArea(await this.access.read(path), sessionId));
	}

	private async syncNow(session: SessionRecord, status: TranscriptionStatus): Promise<void> {
		const { sessionId } = session;
		const [chunks, segments] = await Promise.all([this.store.loadChunks(sessionId), this.store.loadSegments(sessionId)]);
		const progress = await this.settlePendingAppend(session);
		const merged = mergeTranscript({ chunks, segments, labels: session.settings.display, recordingEnded: status !== 'running' });
		if (status === 'running' && merged.confirmedWindows <= progress.reflectedWindows) {
			return;
		}
		// 反映済みの時間窓の区間は追記しない。利用者が削除した行を戻さないため。
		const body = formatTranscriptLines(
			merged.lines.filter((line) => line.sequence >= progress.reflectedWindows),
			session.settings.display.showTimestamps,
		);
		const reflectedWindows = Math.max(progress.reflectedWindows, merged.confirmedWindows);
		if (body !== '') {
			// 書く前に記録し、保存の確認前に止まっても、次回にノートの本文で反映済みかを判断できるようにする。
			await this.store.saveNoteProgress(sessionId, { ...progress, pendingAppend: { windows: reflectedWindows, text: body } });
		}
		const saved = await this.access.edit(session.notePath, (text) => (body === '' ? [] : [appendTranscriptEdit(text, sessionId, body)]));
		if (body !== '' && !transcriptAreaIncludes(saved, sessionId, body)) {
			throw new NoteWriteError('notSaved', '文字起こしをノートへ保存できたことを確認できませんでした。');
		}
		if (body !== '' || reflectedWindows > progress.reflectedWindows) {
			await this.store.saveNoteProgress(sessionId, { ...withoutPending(progress), reflectedWindows });
		}
	}

	/**
	 * 前回、保存を確認する前に止まった追記を片付ける。ノートに本文があれば反映済みとし、なければ未反映のまま追記し直す。
	 * 確認の後に利用者が編集していた場合は、本文が一致せず追記し直すことがある。
	 */
	private async settlePendingAppend(session: SessionRecord): Promise<NoteProgress> {
		const progress = await this.store.loadNoteProgress(session.sessionId);
		const pending = progress.pendingAppend;
		if (pending === undefined) {
			return progress;
		}
		const text = await this.access.read(session.notePath);
		const settled = withoutPending(progress);
		if (transcriptAreaIncludes(text, session.sessionId, pending.text)) {
			settled.reflectedWindows = Math.max(settled.reflectedWindows, pending.windows);
		}
		await this.store.saveNoteProgress(session.sessionId, settled);
		return settled;
	}

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const result = this.queue.then(task);
		this.queue = result.catch(() => undefined);
		return result;
	}
}

function withoutPending(progress: NoteProgress): NoteProgress {
	const rest = { ...progress };
	delete rest.pendingAppend;
	return rest;
}

function formatLocalDateTime(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
