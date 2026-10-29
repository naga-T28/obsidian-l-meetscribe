import { isRecord } from '../json';
import { type LMeetscribeSettings, parseSettings } from '../settings/settings';

// 作業領域に保存する記録の型と実行時検証。
// 読み込んだ値が型に合わなければSessionDataErrorを投げ、推測で補わない。

export const SESSION_SCHEMA_VERSION = 1;

export type SessionState = 'preparing' | 'recording' | 'draining' | 'summarizing' | 'completed' | 'error';
export type Track = 'self' | 'other';
/** silentは無音判定で文字起こしを省いたチャンク。処理済みとして扱う。 */
export type ChunkState = 'pending' | 'done' | 'silent' | 'failed';
export type SummaryStatus = 'running' | 'success' | 'skipped' | 'failed';
export type FailureStage = 'start' | 'recording' | 'transcription' | 'note' | 'storage';

/** error状態の原因。messageには音声・文字起こしの内容を含めない。 */
export interface SessionFailure {
	stage: FailureStage;
	message: string;
	/** 原因の識別子（録音ヘルパーのエラーコード、Node.jsのエラーコードなど）。UIで次の操作の案内に使う。 */
	code?: string;
}

export interface SessionRecord {
	schemaVersion: typeof SESSION_SCHEMA_VERSION;
	sessionId: string;
	blockId: string;
	notePath: string;
	/** ISO 8601形式の開始日時。 */
	startedAt: string;
	state: SessionState;
	/** 開始時に固定した設定。実行中に設定画面で変更しても影響しない。 */
	settings: LMeetscribeSettings;
	/** state が error の場合だけ持つ。 */
	failure?: SessionFailure;
}

export interface ChunkRecord {
	track: Track;
	sequence: number;
	startMs: number;
	durationMs: number;
	/** セッション作業領域からの相対パス。 */
	path: string;
	rmsDbfs: number;
	state: ChunkState;
	attempts: number;
}

export interface SegmentRecord {
	segmentId: string;
	track: Track;
	/** 区間を含むチャンクの番号。両トラックで同じ番号は同じ時間窓を表す。 */
	sequence: number;
	/** チャンク内での区間の位置。 */
	index: number;
	/** セッション開始からのミリ秒。 */
	startMs: number;
	endMs: number;
	text: string;
}

export interface SummaryRun {
	runId: string;
	provider: 'openai' | 'ollama';
	model: string;
	status: SummaryStatus;
	progress: { completed: number; total: number };
	/** 要約対象の文字起こしを識別するハッシュ。再実行時の入力の一致確認に使う。 */
	inputHash: string;
	/** 実行開始時に固定した要約の入力（ノートの文字起こし領域。利用者の編集を含む）。 */
	input: string;
	/** 実行時の要約設定。自動要約では開始時、手動要約では実行時のもの。APIキーの値は含まない。 */
	settings: LMeetscribeSettings['summary'];
	/** 成功時の要約本文。 */
	result?: string;
	/** skipped・failedの理由。 */
	reason?: string;
}

/** ノートへの反映の進み具合。番号0からreflectedWindowsの数の時間窓は、ディスク上のノートへの保存を確認済み。 */
export interface NoteProgress {
	reflectedWindows: number;
	/** 最後に要約領域へ書いた内容のハッシュ。領域の内容がこれと違えば、利用者が編集したとみなす。 */
	summaryHash?: string;
	/**
	 * ノートへ書き始めて、保存をまだ確認していない追記。windowsは追記後に反映済みとなる時間窓の数。
	 * 確認前に止まった場合は、文字起こし領域にtextがあるかで反映済みかを判断し、二重に追記しない。
	 */
	pendingAppend?: { windows: number; text: string };
}

/** 作業領域のデータが壊れている、または形式が合わない。内容は含めず、ファイルと位置だけを示す。 */
export class SessionDataError extends Error {
	constructor(
		readonly file: string,
		readonly detail: string,
	) {
		super(`${file}: ${detail}`);
		this.name = 'SessionDataError';
	}
}

/** パスの一部になるIDは英数字とハイフンに限る。 */
export function isValidStorageId(value: string): boolean {
	return /^[A-Za-z0-9-]+$/.test(value);
}

export function parseSessionRecord(value: unknown, file: string): SessionRecord {
	const v = new Validator(file, value);
	if (v.get('schemaVersion') !== SESSION_SCHEMA_VERSION) {
		throw new SessionDataError(file, '対応していないschemaVersionです。');
	}
	const sessionId = v.string('sessionId');
	if (!isValidStorageId(sessionId)) {
		throw new SessionDataError(file, 'sessionIdの形式が正しくありません。');
	}
	const startedAt = v.string('startedAt');
	if (Number.isNaN(Date.parse(startedAt))) {
		throw new SessionDataError(file, 'startedAtが日時ではありません。');
	}
	let settings: LMeetscribeSettings;
	try {
		settings = parseSettings(v.object('settings'));
	} catch {
		throw new SessionDataError(file, '設定スナップショットを読み込めません。');
	}
	const session: SessionRecord = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId,
		blockId: v.string('blockId'),
		notePath: v.string('notePath'),
		startedAt,
		state: v.oneOf('state', ['preparing', 'recording', 'draining', 'summarizing', 'completed', 'error']),
		settings,
	};
	if (v.get('failure') !== undefined) {
		const failure = new Validator(file, v.object('failure'));
		session.failure = {
			stage: failure.oneOf('stage', ['start', 'recording', 'transcription', 'note', 'storage']),
			message: failure.string('message', true),
		};
		const code = failure.optionalString('code');
		if (code !== undefined) {
			session.failure.code = code;
		}
	}
	return session;
}

export function parseChunkRecord(value: unknown, file: string): ChunkRecord {
	const v = new Validator(file, value);
	const path = v.string('path');
	if (!isSessionRelativePath(path)) {
		throw new SessionDataError(file, 'チャンクのパスが作業領域の外を指しています。');
	}
	return {
		track: v.oneOf('track', ['self', 'other']),
		sequence: v.integer('sequence', 0),
		startMs: v.number('startMs', 0),
		durationMs: v.number('durationMs', 0),
		path,
		rmsDbfs: v.number('rmsDbfs'),
		state: v.oneOf('state', ['pending', 'done', 'silent', 'failed']),
		attempts: v.integer('attempts', 0),
	};
}

export function parseSegmentRecord(value: unknown, file: string): SegmentRecord {
	const v = new Validator(file, value);
	const startMs = v.number('startMs', 0);
	const endMs = v.number('endMs', 0);
	if (endMs < startMs) {
		throw new SessionDataError(file, 'endMsがstartMsより前です。');
	}
	return {
		segmentId: v.string('segmentId'),
		track: v.oneOf('track', ['self', 'other']),
		sequence: v.integer('sequence', 0),
		index: v.integer('index', 0),
		startMs,
		endMs,
		text: v.string('text', true),
	};
}

export function parseSummaryRun(value: unknown, file: string): SummaryRun {
	const v = new Validator(file, value);
	const progress = new Validator(file, v.object('progress'));
	const run: SummaryRun = {
		runId: v.string('runId'),
		provider: v.oneOf('provider', ['openai', 'ollama']),
		model: v.string('model'),
		status: v.oneOf('status', ['running', 'success', 'skipped', 'failed']),
		progress: { completed: progress.integer('completed', 0), total: progress.integer('total', 0) },
		inputHash: v.string('inputHash'),
		input: v.string('input', true),
		settings: parseSummarySettings(v.object('settings'), file),
	};
	const result = v.optionalString('result');
	const reason = v.optionalString('reason');
	if (result !== undefined) {
		run.result = result;
	}
	if (reason !== undefined) {
		run.reason = reason;
	}
	return run;
}

export function parseNoteProgress(value: unknown, file: string): NoteProgress {
	const v = new Validator(file, value);
	const progress: NoteProgress = { reflectedWindows: v.integer('reflectedWindows', 0) };
	const summaryHash = v.optionalString('summaryHash');
	if (summaryHash !== undefined) {
		progress.summaryHash = summaryHash;
	}
	const pending = v.get('pendingAppend');
	if (pending !== undefined) {
		const p = new Validator(file, pending);
		progress.pendingAppend = { windows: p.integer('windows', 0), text: p.string('text') };
	}
	return progress;
}

function parseSummarySettings(value: Record<string, unknown>, file: string): LMeetscribeSettings['summary'] {
	try {
		return parseSettings({ summary: value }).summary;
	} catch {
		throw new SessionDataError(file, '要約設定のスナップショットを読み込めません。');
	}
}

/** 区切り文字にかかわらず、絶対パスと「..」を含むパスを拒否する。 */
function isSessionRelativePath(path: string): boolean {
	return path !== '' && !path.startsWith('/') && !path.split(/[\\/]/).some((segment) => segment === '..' || segment === '');
}

class Validator {
	private readonly record: Record<string, unknown>;

	constructor(
		private readonly file: string,
		value: unknown,
	) {
		if (!isRecord(value)) {
			throw new SessionDataError(file, 'オブジェクトではありません。');
		}
		this.record = value;
	}

	get(key: string): unknown {
		return this.record[key];
	}

	string(key: string, allowEmpty = false): string {
		const value = this.record[key];
		if (typeof value !== 'string' || (!allowEmpty && value === '')) {
			throw this.fail(key);
		}
		return value;
	}

	optionalString(key: string): string | undefined {
		return this.record[key] === undefined ? undefined : this.string(key, true);
	}

	number(key: string, min = Number.NEGATIVE_INFINITY): number {
		const value = this.record[key];
		if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
			throw this.fail(key);
		}
		return value;
	}

	integer(key: string, min: number): number {
		const value = this.number(key, min);
		if (!Number.isSafeInteger(value)) {
			throw this.fail(key);
		}
		return value;
	}

	object(key: string): Record<string, unknown> {
		const value = this.record[key];
		if (!isRecord(value)) {
			throw this.fail(key);
		}
		return value;
	}

	oneOf<T extends string>(key: string, allowed: readonly T[]): T {
		const found = allowed.find((candidate) => candidate === this.record[key]);
		if (found === undefined) {
			throw this.fail(key);
		}
		return found;
	}

	private fail(key: string): SessionDataError {
		return new SessionDataError(this.file, `${key}の値が正しくありません。`);
	}
}
