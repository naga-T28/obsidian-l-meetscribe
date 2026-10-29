import type { ChunkRecord, SessionRecord } from './records';
import type { LMeetscribeSettings } from '../settings/settings';

// セッションが利用する外部処理の境界。実装はHelperClient（録音）、WhisperTranscriber（文字起こし）、NoteWriter（ノート）、
// WorkAudioCleaner（作業音声の削除）、SummaryService（要約）が担う。テストでは偽実装に差し替える。

/** ヘルパーが確定したチャンクの通知。処理状態はChunkQueueが持つ。 */
export type ChunkNotice = Omit<ChunkRecord, 'state' | 'attempts'>;

export interface RecorderListener {
	chunkReady(chunk: ChunkNotice): void;
	/** デバイス切断・ヘルパー異常終了など、録音を続けられない障害。 */
	failed(error: Error): void;
}

export interface Recorder {
	/** 音声取得を開始する。取得が始まってから解決する。 */
	start(session: SessionRecord, listener: RecorderListener): Promise<RecordingHandle>;
}

export interface RecordingHandle {
	/** 停止を要求し、最後の端数チャンクの通知と停止通知を受けてから解決する。 */
	stop(): Promise<void>;
}

export interface TranscriptionProgress {
	/** 処理待ちのチャンク数。 */
	queued: number;
	processed: number;
	failed: number;
}

export interface TranscriptionListener {
	progress(progress: TranscriptionProgress): void;
	/** 作業領域へ記録できないなど、文字起こしを続けられない障害。チャンク単位の失敗は含めない。 */
	failed(error: Error): void;
	/** 作業領域の空き容量が不足した。セッションは新しい録音を止める（ディスクを使い切らないため）。 */
	lowDiskSpace(): void;
}

/** 文字起こしに失敗したチャンクは除外して完了とする。failedChunksは除外した件数。 */
export type TranscriptionResult = { complete: true; failedChunks?: number } | { complete: false; reason: string };

export interface Transcriber {
	/** セッションの処理を始める。作業領域に未処理のチャンクがあれば、それも対象にする。 */
	begin(session: SessionRecord, listener: TranscriptionListener): TranscriptionJob;
}

export interface TranscriptionJob {
	enqueue(chunk: ChunkNotice): void;
	/**
	 * 録音停止後に呼ぶ。全チャンクの文字起こしと作業領域への保存が済んでから解決する。ノートへの反映はNoteOutputが担う。
	 * 未処理のチャンクが残る場合はcomplete: falseを返す。失敗したチャンクは除外し、件数をfailedChunksで返す。
	 */
	finish(): Promise<TranscriptionResult>;
	/** Whisperを止める。未処理のデータは作業領域に残す。 */
	abort(): Promise<void>;
}

/** ノートへの反映で区別する文字起こしの状態。メタ情報の「処理結果」に使う。 */
export type TranscriptionStatus = 'running' | 'complete' | 'incomplete';

export interface NoteOutput {
	/** 会議ブロックへセッションIDを記録し、出力領域を用意する。録音の開始前に呼ぶ。 */
	prepare(session: SessionRecord): Promise<void>;
	/**
	 * 確定した時間窓の未反映の区間をノートへ追記する。running以外では、録音の終了として端数の時間窓も確定させる。
	 * ディスク上のノートに保存されたことを確かめてから解決する。
	 */
	sync(session: SessionRecord, status: TranscriptionStatus): Promise<void>;
	/** 保存済みの要約を要約領域へ書く。利用者の編集がある要約は置き換えない。 */
	writeSummary(session: SessionRecord): Promise<void>;
}

export interface WorkAudio {
	/** 作業音声を削除する。音声は保存しない。文字起こしの全文をノートへ保存してから呼ぶ。 */
	cleanup(session: SessionRecord): Promise<void>;
}

export type SummaryOutcome = { status: 'success' } | { status: 'skipped'; reason: string } | { status: 'failed'; reason: string };

export interface SummaryProgress {
	/** 済んだリクエスト数と、現時点で見込むリクエスト数。統合の段数が増えるとtotalも増える。 */
	completed: number;
	total: number;
}

export interface SummaryListener {
	progress(progress: SummaryProgress): void;
}

export interface Summarizer {
	/** 自動要約ではセッション開始時、手動要約では実行時の要約設定を受け取る。 */
	summarize(session: SessionRecord, settings: LMeetscribeSettings['summary'], listener?: SummaryListener): Promise<SummaryOutcome>;
}
