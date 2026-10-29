import { release } from 'os';
import type { LMeetscribeSettings } from '../settings/settings';
import { checkExecutableFile, checkReadableDirectory, validateWhisperModelLanguage } from '../settings/validation';
import { checkWhisperModel } from '../transcription/ModelScanner';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from './records';
import { RecordingSession, type SessionServices, type SessionSnapshot } from './RecordingSession';

export interface SessionManagerOptions extends SessionServices {
	/** 現在の設定。開始時に複製して固定する。 */
	getSettings(): LMeetscribeSettings;
	createSessionId(): string;
	now(): Date;
}

export interface StartRequest {
	blockId: string;
	notePath: string;
	/** ブロックで選んだデバイス。空文字は既定入力・すべての出力。省略時は設定の値を使う。 */
	devices?: Pick<LMeetscribeSettings['recording'], 'microphoneDeviceUid' | 'outputDeviceUid'>;
}

export type StartResult =
	| { ok: true; sessionId: string }
	/** activeは処理中の会議。開始処理の途中で会議がまだない場合はundefined。 */
	| { ok: false; reason: 'busy'; active: SessionSnapshot | undefined }
	| { ok: false; reason: 'invalidSettings'; problems: string[] };

export type SummarizeResult =
	| { ok: true }
	| { ok: false; reason: 'busy'; active: SessionSnapshot | undefined }
	| { ok: false; reason: 'notCompleted' };

export type RecoverResult =
	| { ok: true }
	| { ok: false; reason: 'busy'; active: SessionSnapshot | undefined }
	| { ok: false; reason: 'notRecoverable' };

export type SessionListener = (snapshot: SessionSnapshot | undefined) => void;

/**
 * プラグイン本体が所有し、同時に1件のセッションだけを実行する。
 * UIはsubscribeで状態を購読するだけで、UIの破棄は録音に影響しない。
 */
export class SessionManager {
	private session: RecordingSession | undefined;
	/** 開始・読み込みの非同期処理中に、別の開始を受け付けないための印。 */
	private opening = false;
	private readonly listeners = new Set<SessionListener>();

	constructor(private readonly options: SessionManagerOptions) {}

	/** 直近のセッション。完了後も次のセッションを開始するまで保持する。 */
	get current(): SessionSnapshot | undefined {
		return this.session?.snapshot;
	}

	/** 登録時に現在の状態を1回通知する。戻り値の関数で購読を解除する。 */
	subscribe(listener: SessionListener): () => void {
		this.listeners.add(listener);
		listener(this.current);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async start(request: StartRequest): Promise<StartResult> {
		if (this.isBusy()) {
			return { ok: false, reason: 'busy', active: this.current };
		}
		this.opening = true;
		try {
			// 録音中に設定画面で変更されても影響しないよう、開始時の設定を複製して固定する。
			const settings = structuredClone(this.options.getSettings());
			if (request.devices !== undefined) {
				settings.recording.microphoneDeviceUid = request.devices.microphoneDeviceUid;
				settings.recording.outputDeviceUid = request.devices.outputDeviceUid;
			}
			const problems = await checkStartPrerequisites(settings);
			if (problems.length > 0) {
				return { ok: false, reason: 'invalidSettings', problems };
			}
			const record: SessionRecord = {
				schemaVersion: SESSION_SCHEMA_VERSION,
				sessionId: this.options.createSessionId(),
				blockId: request.blockId,
				notePath: request.notePath,
				startedAt: this.options.now().toISOString(),
				state: 'preparing',
				settings,
			};
			await this.options.store.createSession(record);
			const session = this.adopt(record);
			await session.start();
			return { ok: true, sessionId: record.sessionId };
		} finally {
			this.opening = false;
		}
	}

	stop(): Promise<void> {
		return this.session?.stop() ?? Promise.resolve();
	}

	retry(): Promise<void> {
		return this.session?.retry() ?? Promise.resolve();
	}

	/** Vaultのrenameイベントから呼ぶ。実行中のセッションのノートであれば、書き込み先を追従させる。 */
	noteRenamed(oldPath: string, newPath: string): Promise<void> {
		return this.session?.renameNote(oldPath, newPath) ?? Promise.resolve();
	}

	/**
	 * 前回の起動で中断したセッションを保存済みのデータから処理し直す。同時1件の排他を守る。
	 * prepareは排他の内側で、キューの照合や書き出し先の変更に使う。
	 */
	async recover(sessionId: string, prepare?: (record: SessionRecord) => Promise<void>): Promise<RecoverResult> {
		if (this.isBusy()) {
			return { ok: false, reason: 'busy', active: this.current };
		}
		let session: RecordingSession;
		this.opening = true;
		try {
			const record = await this.options.store.loadSession(sessionId);
			if (record.state === 'completed') {
				return { ok: false, reason: 'notRecoverable' };
			}
			await prepare?.(record);
			session = this.adopt(record);
		} finally {
			this.opening = false;
		}
		await session.recover();
		return { ok: true };
	}

	/** 実行中のセッションのデータは破棄させない。 */
	isActive(sessionId: string): boolean {
		return this.session?.sessionId === sessionId && this.isBusy();
	}

	/** errorのセッションを手元から外し、次の開始を許可する。作業領域のデータは復旧用に残す。 */
	release(): void {
		if (this.session?.state === 'error') {
			this.session = undefined;
			this.notify();
		}
	}

	/** 完了済みセッションを手動で要約する。要約設定は実行時のものを使う。 */
	async summarize(sessionId: string): Promise<SummarizeResult> {
		if (this.isBusy()) {
			return { ok: false, reason: 'busy', active: this.current };
		}
		let session = this.session?.sessionId === sessionId ? this.session : undefined;
		if (session === undefined) {
			this.opening = true;
			try {
				const record = await this.options.store.loadSession(sessionId);
				// 未完了のセッションは「未完了の会議」の再処理で扱う。資源を持たないまま排他を占有しないよう取り込まない。
				if (record.state !== 'completed') {
					return { ok: false, reason: 'notCompleted' };
				}
				session = this.adopt(record);
			} finally {
				this.opening = false;
			}
		}
		if (session.state !== 'completed') {
			return { ok: false, reason: 'notCompleted' };
		}
		await session.summarize(structuredClone(this.options.getSettings().summary));
		return { ok: true };
	}

	/** プラグインのonunloadで呼ぶ。ヘルパーとWhisperを止め、未処理のデータは作業領域に残す。 */
	async shutdown(): Promise<void> {
		this.listeners.clear();
		await this.session?.shutdown();
	}

	private isBusy(): boolean {
		return this.opening || (this.session?.isBusy ?? false);
	}

	private adopt(record: SessionRecord): RecordingSession {
		const session = new RecordingSession(record, this.options, () => this.notify());
		this.session = session;
		this.notify();
		return session;
	}

	private notify(): void {
		const snapshot = this.current;
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}

/** 録音開始前に、文字起こしに必要な設定がそろっているかを確認する。 */
async function checkStartPrerequisites(settings: LMeetscribeSettings): Promise<string[]> {
	const { whisper } = settings;
	const problems = [
		checkSupportedOs(process.platform, release()),
		await checkExecutableFile(whisper.executablePath).then((error) => error && `Whisper実行ファイル: ${error}`),
		await checkReadableDirectory(whisper.modelDir).then((error) => error && `Whisperモデルフォルダ: ${error}`),
		await checkWhisperModel(whisper.modelDir, whisper.model),
		validateWhisperModelLanguage(whisper.model, whisper.language),
	];
	return problems.filter((problem): problem is string => problem !== undefined);
}

/**
 * Core Audioタップを使うため、macOS 14.2（Darwin 23.2）以降に限る。
 * `release`は`os.release()`のDarwinカーネル版。
 */
export function checkSupportedOs(platform: string, release: string): string | undefined {
	const [major = Number.NaN, minor = Number.NaN] = release.split('.').map((part) => Number.parseInt(part, 10));
	// 版を読めない場合も対応外として扱う（NaNとの比較はすべてfalseになる）。
	const supported = major > 23 || (major === 23 && minor >= 2);
	if (platform !== 'darwin' || !supported) {
		return '録音にはmacOS 14.2以降が必要です。';
	}
	return undefined;
}
