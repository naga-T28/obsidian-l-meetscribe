import type { LMeetscribeSettings } from '../settings/settings';
import type {
	ChunkNotice,
	NoteOutput,
	Recorder,
	RecordingHandle,
	Summarizer,
	SummaryOutcome,
	Transcriber,
	TranscriptionJob,
	TranscriptionListener,
	TranscriptionProgress,
	SummaryProgress,
	TranscriptionStatus,
	WorkAudio,
} from './ports';
import type { FailureStage, SessionFailure, SessionRecord, SessionState } from './records';
import type { SessionStore } from './SessionStore';

export type SessionPersistence = Pick<SessionStore, 'createSession' | 'saveSession' | 'loadSession'>;

export interface SessionServices {
	store: SessionPersistence;
	recorder: Recorder;
	transcriber: Transcriber;
	notes: NoteOutput;
	workAudio: WorkAudio;
	summarizer: Summarizer;
}

/** UIへ渡す状態。購読側が書き換えても本体に影響しないよう、毎回複製して渡す。 */
export interface SessionSnapshot {
	sessionId: string;
	blockId: string;
	notePath: string;
	startedAt: string;
	state: SessionState;
	/** 録音中も進む文字起こしの進捗。主状態とは別に持つ。 */
	transcription: TranscriptionProgress;
	/** 相手トラックで無音しきい値未満のチャンクが続いている時間。60秒以上で確認を促す（システム音声の許可がないと無音になるため）。 */
	otherSilentMs: number;
	/** 空き容量の不足で録音を止めた。 */
	diskSpaceLow: boolean;
	/** 録音中のノートへの反映の失敗。録音は続け、結果は作業領域に残す。 */
	noteProblem?: string;
	/** 文字起こしから除外した部分の説明。ノートには書かず、会議ブロックに表示する。 */
	exclusions?: string[];
	summary?: SummaryOutcome;
	/** 要約中の進み具合。 */
	summaryProgress?: SummaryProgress;
	failure?: SessionFailure;
}

// セッションの状態遷移。ここにない遷移は拒否する。
const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
	preparing: ['recording', 'error'],
	recording: ['draining', 'error'],
	draining: ['summarizing', 'completed', 'error'],
	summarizing: ['completed'],
	completed: ['summarizing'],
	error: ['draining'],
};

export class InvalidTransitionError extends Error {
	constructor(from: SessionState, to: SessionState) {
		super(`状態を${from}から${to}へ変更できません。`);
		this.name = 'InvalidTransitionError';
	}
}

/**
 * 1回の録音の状態遷移と、録音・文字起こし・要約の実行順序を管理する。
 * 状態は変更してから作業領域へ保存し、購読者へ通知する。
 */
export class RecordingSession {
	private readonly record: SessionRecord;
	private progress: TranscriptionProgress = { queued: 0, processed: 0, failed: 0 };
	private otherSilentMs = 0;
	private diskSpaceLow = false;
	private noteProblem: string | undefined;
	/** 実行中のノートへの反映。録音中の反映は1件ずつ行い、間に来た要求はまとめる。 */
	private noteSync: Promise<void> | undefined;
	private noteSyncRequested = false;
	private summary: SummaryOutcome | undefined;
	private summaryProgress: SummaryProgress | undefined;
	private recording: RecordingHandle | undefined;
	private job: TranscriptionJob | undefined;
	private stopRequest: Promise<void> | undefined;
	/** 停止時の録音ヘルパーの異常。会議は止めず、除外の説明として会議ブロックに示す。 */
	private stopProblem: string | undefined;
	private exclusions: string[] = [];
	private saveQueue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		record: SessionRecord,
		private readonly services: SessionServices,
		private readonly onChange: () => void,
	) {
		this.record = structuredClone(record);
	}

	get sessionId(): string {
		return this.record.sessionId;
	}

	get state(): SessionState {
		return this.record.state;
	}

	/** completed以外は排他の対象。errorは明示的に解放するまで次の開始を拒否する。 */
	get isBusy(): boolean {
		return this.record.state !== 'completed';
	}

	get snapshot(): SessionSnapshot {
		const snapshot: SessionSnapshot = {
			sessionId: this.record.sessionId,
			blockId: this.record.blockId,
			notePath: this.record.notePath,
			startedAt: this.record.startedAt,
			state: this.record.state,
			transcription: { ...this.progress },
			otherSilentMs: this.otherSilentMs,
			diskSpaceLow: this.diskSpaceLow,
		};
		if (this.exclusions.length > 0) {
			snapshot.exclusions = [...this.exclusions];
		}
		if (this.summary !== undefined) {
			snapshot.summary = { ...this.summary };
		}
		if (this.summaryProgress !== undefined && this.record.state === 'summarizing') {
			snapshot.summaryProgress = { ...this.summaryProgress };
		}
		if (this.record.failure !== undefined) {
			snapshot.failure = { ...this.record.failure };
		}
		if (this.noteProblem !== undefined) {
			snapshot.noteProblem = this.noteProblem;
		}
		return snapshot;
	}

	/** preparingの記録が作業領域に保存済みである前提で、録音を開始する。 */
	async start(): Promise<void> {
		if (this.record.state !== 'preparing' || this.recording !== undefined) {
			return;
		}
		// ブロックへセッションIDを記録し、出力領域を用意できなければ録音しない。
		try {
			await this.services.notes.prepare(this.record);
		} catch (error) {
			await this.fail('note', error);
			return;
		}
		if (this.disposed) {
			return;
		}
		// 最初のチャンク通知より先に受け口を用意する。
		this.job = this.services.transcriber.begin(this.record, this.transcriptionListener);
		try {
			this.recording = await this.services.recorder.start(this.record, {
				chunkReady: (chunk) => {
					this.trackOtherSilence(chunk);
					this.job?.enqueue(chunk);
				},
				failed: (error) => void this.handleRecordingFailure(error),
			});
		} catch (error) {
			await this.fail('start', error);
			return;
		}
		// 開始待ちの間に録音障害でerrorへ移った場合と、プラグインが終了した場合は録音を止める。
		// 終了時の状態は復旧用にpreparingのまま残す。
		if (this.disposed || this.record.state !== 'preparing') {
			await this.releaseResources();
			return;
		}
		await this.moveOrFail('recording');
	}

	/** 停止要求は1回だけ処理する。2回目以降の呼び出しは最初の要求の完了を待つだけにする。 */
	stop(): Promise<void> {
		if (this.stopRequest === undefined && this.record.state === 'recording') {
			this.stopRequest = this.runStop();
		}
		return this.stopRequest ?? Promise.resolve();
	}

	/** errorから保存済みデータの処理を再開する。録音は再開しない。 */
	async retry(): Promise<void> {
		if (this.record.state !== 'error' || this.disposed) {
			return;
		}
		delete this.record.failure;
		if (!(await this.moveOrFail('draining'))) {
			return;
		}
		// 開始時の準備が済んでいない場合や、別ノートへ書き出す場合に出力領域を用意する。用意済みなら何もしない。
		try {
			await this.services.notes.prepare(this.record);
		} catch (error) {
			await this.fail('note', error);
			return;
		}
		this.job = this.services.transcriber.begin(this.record, this.transcriptionListener);
		await this.finishTranscription();
	}

	/**
	 * 前回の起動で中断したセッションを、保存済みのデータから処理し直す。録音は再開しない。
	 * 要約中に中断した場合は文字起こしが済んでいるため、要約の失敗として完了にする。
	 */
	async recover(): Promise<void> {
		if (this.disposed || this.record.state === 'completed') {
			return;
		}
		if (this.record.state === 'summarizing') {
			this.summary = { status: 'failed', reason: '前回の終了時に要約が中断されました。手動で要約できます。' };
			await this.moveTo('completed').catch(() => undefined);
			return;
		}
		// 中断時の状態からの遷移は状態図にないため、error（再処理を待つ状態）として扱い、再試行の経路を通す。
		this.record.state = 'error';
		this.record.failure = { stage: 'recording', message: '前回の終了時に処理が中断されました。' };
		await this.retry();
	}

	/** ノートの改名・移動に追従する。フォルダの移動では、配下のノートのパスを書き換える。 */
	async renameNote(oldPath: string, newPath: string): Promise<void> {
		const { notePath } = this.record;
		let next: string | undefined;
		if (notePath === oldPath) {
			next = newPath;
		} else if (notePath.startsWith(`${oldPath}/`)) {
			next = newPath + notePath.slice(oldPath.length);
		}
		if (next === undefined || this.disposed) {
			return;
		}
		this.record.notePath = next;
		this.notify();
		await this.save().catch(() => undefined);
	}

	/** 完了済みセッションの手動要約。要約設定は実行時のものを使う。 */
	async summarize(settings: LMeetscribeSettings['summary']): Promise<void> {
		if (this.record.state !== 'completed' || this.disposed) {
			return;
		}
		await this.runSummary(settings);
	}

	/**
	 * プラグインの無効化・終了時に呼ぶ。ヘルパーとWhisperを止め、状態は変更しない。
	 * 作業領域の状態が未完了のまま残るため、次回起動時に復旧の対象になる。
	 */
	async shutdown(): Promise<void> {
		this.disposed = true;
		await this.releaseResources();
	}

	private readonly transcriptionListener: TranscriptionListener = {
		progress: (progress) => {
			const advanced = progress.processed !== this.progress.processed;
			this.progress = { ...progress };
			this.notify();
			if (advanced) {
				this.requestNoteSync();
			}
		},
		failed: (error) => void this.fail('storage', error),
		// 確定済みのチャンクは残し、停止後に文字起こしを続ける。
		lowDiskSpace: () => {
			this.diskSpaceLow = true;
			this.notify();
			void this.stop();
		},
	};

	private async runStop(): Promise<void> {
		if (!(await this.moveOrFail('draining'))) {
			return;
		}
		try {
			await this.recording?.stop();
		} catch (error) {
			// 停止の操作で会議を終える。通知を受け取れなかったチャンクは文字起こしせず、受け取った分で完了させる。
			this.stopProblem = describeError(error);
		}
		this.recording = undefined;
		await this.finishTranscription();
	}

	private async finishTranscription(): Promise<void> {
		let result;
		try {
			result = await this.requireJob().finish();
		} catch (error) {
			await this.fail('transcription', error);
			return;
		}
		this.job = undefined;
		if (this.disposed || this.record.state !== 'draining') {
			return;
		}
		if (result.complete) {
			this.exclusions = this.describeExclusions(result.failedChunks ?? 0);
		}
		// 未完了でも確定した時間窓は反映する。作業音声は再試行に備えて残す。
		if (!(await this.syncNoteFinal(result.complete ? 'complete' : 'incomplete'))) {
			return;
		}
		if (!result.complete) {
			await this.fail('transcription', result.reason);
			return;
		}
		// 全文のノート保存が済んだ後に削除する。要約の結果は待たない。
		try {
			await this.services.workAudio.cleanup(this.record);
		} catch (error) {
			await this.fail('storage', error);
			return;
		}
		if (this.record.settings.summary.autoSummarize) {
			await this.runSummary(this.record.settings.summary);
			return;
		}
		this.summary = { status: 'skipped', reason: '停止後の自動要約がオフです。手動で要約できます。' };
		await this.moveOrFail('completed');
	}

	/** 要約の失敗は文字起こしの失敗にしない。結果にかかわらずcompletedへ進む。 */
	private async runSummary(settings: LMeetscribeSettings['summary']): Promise<void> {
		if (!(await this.moveOrFail('summarizing'))) {
			return;
		}
		let outcome: SummaryOutcome;
		try {
			this.summaryProgress = undefined;
			outcome = await this.services.summarizer.summarize(this.record, structuredClone(settings), {
				progress: (progress) => {
					this.summaryProgress = { ...progress };
					this.notify();
				},
			});
		} catch (error) {
			outcome = { status: 'failed', reason: describeError(error) };
		}
		if (this.disposed) {
			return;
		}
		// 要約はsummary.jsonに保存済み。ノートへの出力に失敗しても文字起こしと既存の要約は残る。
		if (outcome.status === 'success') {
			try {
				await this.services.notes.writeSummary(this.record);
			} catch (error) {
				outcome = { status: 'failed', reason: `要約をノートへ出力できません: ${describeError(error)}` };
			}
		}
		this.summary = outcome;
		// summarizingからerrorへの遷移はないため、保存に失敗してもcompletedのまま扱う。
		// 要約の結果はsummary.jsonが正であり、session.jsonの遅れは復旧時に再判定する。
		await this.moveTo('completed').catch(() => undefined);
	}

	/** 録音中の反映要求。実行中なら終わった後にもう1回だけ反映する。 */
	private requestNoteSync(): void {
		this.noteSyncRequested = true;
		// 開始の条件をここで確かめ、runNoteSyncのループが少なくとも1回は待機を挟むようにする。
		if (this.noteSync !== undefined || this.disposed || this.record.state === 'error') {
			return;
		}
		this.noteSync = this.runNoteSync();
	}

	private async runNoteSync(): Promise<void> {
		try {
			while (this.noteSyncRequested && !this.disposed && this.record.state !== 'error') {
				this.noteSyncRequested = false;
				try {
					await this.services.notes.sync(this.record, 'running');
					this.setNoteProblem(undefined);
				} catch (error) {
					// 録音は止めない。停止後の反映で失敗すればerrorにする。
					this.setNoteProblem(describeError(error));
				}
			}
		} finally {
			this.noteSync = undefined;
		}
	}

	/** 文字起こしから除外した部分の説明。 */
	private describeExclusions(failedChunks: number): string[] {
		const notes: string[] = [];
		if (failedChunks > 0) {
			const seconds = failedChunks * this.record.settings.whisper.chunkSeconds;
			notes.push(`${failedChunks}件のチャンク（約${seconds}秒）は文字起こしに失敗したため除外しました`);
		}
		if (this.stopProblem !== undefined) {
			notes.push(`録音の停止時に異常がありました（${this.stopProblem}）。通知を受け取れなかったチャンクは除外しました`);
		}
		return notes;
	}

	/** 停止後の反映。失敗したらnote段階のerrorにし、結果は作業領域に残す。反映できたかを返す。 */
	private async syncNoteFinal(status: TranscriptionStatus): Promise<boolean> {
		this.noteSyncRequested = false;
		await this.noteSync;
		try {
			await this.services.notes.sync(this.record, status);
		} catch (error) {
			await this.fail('note', error);
			return false;
		}
		this.setNoteProblem(undefined);
		return !this.disposed && this.record.state === 'draining';
	}

	private setNoteProblem(problem: string | undefined): void {
		if (this.noteProblem !== problem) {
			this.noteProblem = problem;
			this.notify();
		}
	}

	/** 無音しきい値は開始時の設定を使う。無音でないチャンクが来たら数え直す。 */
	private trackOtherSilence(chunk: ChunkNotice): void {
		if (chunk.track !== 'other') {
			return;
		}
		const silent = chunk.rmsDbfs < this.record.settings.whisper.silenceThresholdDbfs;
		const next = silent ? this.otherSilentMs + chunk.durationMs : 0;
		if (next !== this.otherSilentMs) {
			this.otherSilentMs = next;
			this.notify();
		}
	}

	private async handleRecordingFailure(error: Error): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.record.state === 'preparing') {
			await this.fail('start', error);
		} else if (this.record.state === 'recording') {
			await this.fail('recording', error);
		}
		// 停止処理中の障害はRecordingHandle.stopの失敗として扱う。
	}

	/** 遷移と保存を行い、保存に失敗したらerrorへ移す。遷移できたかを返す。 */
	private async moveOrFail(next: SessionState): Promise<boolean> {
		try {
			await this.moveTo(next);
			return true;
		} catch (error) {
			if (error instanceof InvalidTransitionError) {
				throw error;
			}
			await this.fail('storage', error);
			return false;
		}
	}

	/** 状態は同期的に変更する。並行した呼び出しが変更前の状態を読んで二重に処理しないため。 */
	private async moveTo(next: SessionState): Promise<void> {
		const current = this.record.state;
		if (!TRANSITIONS[current].includes(next)) {
			throw new InvalidTransitionError(current, next);
		}
		this.record.state = next;
		this.notify();
		await this.save();
	}

	private async fail(stage: FailureStage, cause: unknown): Promise<void> {
		if (this.record.state === 'error' || !TRANSITIONS[this.record.state].includes('error')) {
			return;
		}
		this.record.state = 'error';
		this.record.failure = { stage, message: describeError(cause) };
		const code = errorCode(cause);
		if (code !== undefined) {
			this.record.failure.code = code;
		}
		this.notify();
		await this.releaseResources();
		// 保存できなくても、メモリ上のerror状態で利用者に原因を示す。
		await this.save().catch(() => undefined);
	}

	/** 録音とWhisperを止める。止める処理の失敗は記録済みの原因を上書きしない。 */
	private async releaseResources(): Promise<void> {
		const recording = this.recording;
		const job = this.job;
		this.recording = undefined;
		this.job = undefined;
		await Promise.allSettled([recording?.stop(), job?.abort()]);
	}

	private save(): Promise<void> {
		const record = structuredClone(this.record);
		const saved = this.saveQueue.then(() => this.services.store.saveSession(record));
		// 失敗した保存の後でも次の保存を実行する。
		this.saveQueue = saved.catch(() => undefined);
		return saved;
	}

	private requireJob(): TranscriptionJob {
		if (this.job === undefined) {
			throw new Error('文字起こしの処理が開始されていません。');
		}
		return this.job;
	}

	private notify(): void {
		if (!this.disposed) {
			this.onChange();
		}
	}
}

function describeError(error: unknown): string {
	if (typeof error === 'string') {
		return error;
	}
	return error instanceof Error ? error.message : '不明なエラー';
}

/** 録音ヘルパーのエラーやNode.jsのエラーが持つ`code`。依存を増やさないよう、型ではなく値で判定する。 */
function errorCode(error: unknown): string | undefined {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
		return error.code;
	}
	return undefined;
}
