import { promises as fs } from 'fs';
import { basename, join } from 'path';
import type { ChunkNotice, Transcriber, TranscriptionJob, TranscriptionListener, TranscriptionResult } from '../session/ports';
import type { ChunkRecord, SegmentRecord, SessionRecord } from '../session/records';
import { getFreeDiskBytes, type SessionStore } from '../session/SessionStore';
import { type RunWhisper, runWhisper, WhisperError } from './WhisperRunner';

/** これを下回ったら録音停止を求める。2トラックの音声は1時間でおよそ230MBになる。 */
export const MIN_FREE_DISK_BYTES = 256 * 1024 * 1024;

/** whisper-cliはチャンクごとにモデルを読み直すため、短いチャンクでも読み込み時間分の余裕を取る。 */
export function defaultWhisperTimeoutMs(durationMs: number): number {
	return Math.max(120_000, durationMs * 12);
}

export type ChunkQueueStore = Pick<SessionStore, 'sessionDir' | 'loadChunks' | 'appendChunk' | 'appendSegments'>;

export interface WhisperTranscriberOptions {
	store: ChunkQueueStore;
	runWhisper?: RunWhisper;
	freeDiskBytes?: (path: string) => Promise<number>;
	minFreeDiskBytes?: number;
	timeoutMs?: (durationMs: number) => number;
}

export class WhisperTranscriber implements Transcriber {
	constructor(private readonly options: WhisperTranscriberOptions) {}

	begin(session: SessionRecord, listener: TranscriptionListener): TranscriptionJob {
		return new ChunkQueue(session, listener, this.options);
	}
}

/**
 * セッションのチャンクを1件ずつwhisper-cliへ渡す。
 * 状態はchunks.jsonlへ記録してから処理し、メモリには索引だけを置く。
 * 作業領域にpending・failedのチャンクがあれば処理の対象にする（再試行・復旧）。
 */
export class ChunkQueue implements TranscriptionJob {
	private readonly chunks = new Map<string, ChunkRecord>();
	/** 処理待ちのチャンクの索引。先頭が処理中。 */
	private readonly waiting: string[] = [];
	private writes: Promise<void>;
	private running = false;
	private idle: Promise<void> = Promise.resolve();
	private error: Error | undefined;
	private aborted = false;
	private diskWarned = false;
	private readonly abortController = new AbortController();
	private readonly sessionDir: string;
	private readonly run: RunWhisper;

	constructor(
		private readonly session: SessionRecord,
		private readonly listener: TranscriptionListener,
		private readonly options: WhisperTranscriberOptions,
	) {
		this.sessionDir = options.store.sessionDir(session.sessionId);
		this.run = options.runWhisper ?? runWhisper;
		this.writes = Promise.resolve();
		void this.write(() => this.load());
	}

	enqueue(chunk: ChunkNotice): void {
		void this.write(() => this.accept(chunk));
	}

	async finish(): Promise<TranscriptionResult> {
		await this.settle();
		if (this.error !== undefined) {
			throw this.error;
		}
		const { queued, failed } = this.progress();
		if (this.aborted || queued > 0) {
			return { complete: false, reason: `未処理のチャンクが${queued}件あります。` };
		}
		// 失敗したチャンクは録音中に再処理しない。停止後は除外して会議を完了させる。
		return failed > 0 ? { complete: true, failedChunks: failed } : { complete: true };
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.abortController.abort();
		await this.settle();
	}

	/** 受け付け済みの記録と、処理中のチャンクの終了を待つ。 */
	private async settle(): Promise<void> {
		await this.writes;
		while (this.running) {
			await this.idle;
		}
	}

	private async load(): Promise<void> {
		for (const loaded of await this.options.store.loadChunks(this.session.sessionId)) {
			let chunk = loaded;
			// 再処理・復旧では、前回失敗したチャンクにもう一度だけ機会を与える。統合で処理済みと数えないよう、未処理に戻して記録する。
			if (chunk.state === 'failed') {
				chunk = { ...chunk, state: 'pending' };
				await this.options.store.appendChunk(this.session.sessionId, chunk);
			}
			this.chunks.set(chunkKey(chunk), chunk);
			if (chunk.state === 'pending') {
				this.waiting.push(chunkKey(chunk));
			}
		}
		this.reportProgress();
		this.kick();
	}

	/** 同じチャンクの通知は1回だけ受け付ける。無音のチャンクは処理済みとして記録する。 */
	private async accept(notice: ChunkNotice): Promise<void> {
		const key = chunkKey(notice);
		if (this.chunks.has(key)) {
			return;
		}
		const silent = notice.rmsDbfs < this.session.settings.whisper.silenceThresholdDbfs;
		const chunk: ChunkRecord = { ...notice, state: silent ? 'silent' : 'pending', attempts: 0 };
		await this.options.store.appendChunk(this.session.sessionId, chunk);
		this.chunks.set(key, chunk);
		if (!silent) {
			this.waiting.push(key);
		}
		this.reportProgress();
		this.kick();
		await this.checkDiskSpace();
	}

	private async checkDiskSpace(): Promise<void> {
		if (this.diskWarned) {
			return;
		}
		const free = await (this.options.freeDiskBytes ?? getFreeDiskBytes)(this.sessionDir);
		if (free < (this.options.minFreeDiskBytes ?? MIN_FREE_DISK_BYTES)) {
			this.diskWarned = true;
			this.listener.lowDiskSpace();
		}
	}

	private canRun(): boolean {
		return !this.aborted && this.error === undefined;
	}

	/** whisper-cliは同時に1プロセスだけ起動する。 */
	private kick(): void {
		if (this.running || !this.canRun() || this.waiting.length === 0) {
			return;
		}
		this.running = true;
		this.idle = this.drain();
	}

	private async drain(): Promise<void> {
		try {
			for (let key = this.waiting[0]; key !== undefined && this.canRun(); key = this.waiting[0]) {
				await this.process(key);
				// 中断したチャンクはpendingのまま残し、次回の処理対象にする。
				if (this.aborted) {
					return;
				}
				this.waiting.shift();
			}
		} catch (error) {
			this.broken(error);
		} finally {
			this.running = false;
		}
	}

	private async process(key: string): Promise<void> {
		const chunk = this.chunks.get(key);
		if (chunk === undefined) {
			return;
		}
		const attempts = chunk.attempts + 1;
		const { whisper } = this.session.settings;
		const outputDir = join(this.sessionDir, 'transcripts');
		let segments: SegmentRecord[];
		try {
			await fs.mkdir(outputDir, { recursive: true });
			const result = await this.run({
				executablePath: whisper.executablePath,
				modelPath: join(whisper.modelDir, whisper.model),
				wavPath: join(this.sessionDir, chunk.path),
				language: whisper.language,
				outputPrefix: join(outputDir, basename(chunk.path, '.wav')),
				durationMs: chunk.durationMs,
				timeoutMs: (this.options.timeoutMs ?? defaultWhisperTimeoutMs)(chunk.durationMs),
				signal: this.abortController.signal,
			});
			// 区間IDはチャンクと区間の位置から決める。再処理しても同じIDになり、後の記録で置き換わる。
			segments = result.map((segment, index) => ({
				segmentId: `${chunk.track}-${chunk.sequence}-${index}`,
				track: chunk.track,
				sequence: chunk.sequence,
				index,
				startMs: chunk.startMs + segment.startMs,
				endMs: chunk.startMs + segment.endMs,
				text: segment.text,
			}));
		} catch (error) {
			if (this.aborted) {
				return;
			}
			if (!(error instanceof WhisperError)) {
				throw error;
			}
			await this.update(key, { ...chunk, state: 'failed', attempts });
			return;
		}
		// 区間を保存してから処理済みにする。間で中断しても、再処理で同じ区間IDが上書きされる。
		await this.options.store.appendSegments(this.session.sessionId, segments);
		await this.update(key, { ...chunk, state: 'done', attempts });
	}

	private async update(key: string, chunk: ChunkRecord): Promise<void> {
		await this.write(() => this.options.store.appendChunk(this.session.sessionId, chunk));
		this.chunks.set(key, chunk);
		this.reportProgress();
	}

	/** chunks.jsonlへの追記を直列化する。失敗したら以降の処理を止め、セッションへ通知する。 */
	private write(task: () => Promise<void>): Promise<void> {
		const result = this.writes.then(() => (this.error === undefined ? task() : undefined));
		this.writes = result.catch((error: unknown) => this.broken(error));
		return result;
	}

	private broken(error: unknown): void {
		if (this.error !== undefined || this.aborted) {
			return;
		}
		this.error = error instanceof Error ? error : new Error('文字起こしの記録に失敗しました。');
		this.abortController.abort();
		this.listener.failed(this.error);
	}

	private progress(): { queued: number; processed: number; failed: number } {
		let queued = 0;
		let processed = 0;
		let failed = 0;
		for (const chunk of this.chunks.values()) {
			if (chunk.state === 'pending') {
				queued += 1;
			} else if (chunk.state === 'failed') {
				failed += 1;
			} else {
				processed += 1;
			}
		}
		return { queued, processed, failed };
	}

	private reportProgress(): void {
		if (!this.aborted) {
			this.listener.progress(this.progress());
		}
	}
}

function chunkKey(chunk: Pick<ChunkRecord, 'track' | 'sequence'>): string {
	return `${chunk.track}:${chunk.sequence}`;
}
