import { type ChildProcessByStdio, spawn } from 'child_process';
import type { Readable, Writable } from 'stream';
import type { ChunkNotice, Recorder, RecorderListener, RecordingHandle } from '../session/ports';
import type { SessionRecord, Track } from '../session/records';
import { checkExecutableFile } from '../settings/validation';
import {
	type DeviceInfo,
	encodeCommand,
	HELPER_PROTOCOL_VERSION,
	type HelperCommand,
	type HelperErrorEvent,
	type HelperEvent,
	HelperProtocolError,
	parseHelperEvent,
} from './protocol';

// 録音ヘルパーの起動・通信・監視。ヘルパーはプラグインのフォルダに置いた実行ファイルを直接起動する。
// 直接起動すると、録音の許可はObsidianに付く。
// 1プロセスで扱うのは1回のデバイス一覧取得か1セッションの録音だけで、終わったらヘルパーは終了する。

export const HELPER_FILE_NAME = 'lms-audio-helper';

export interface HelperTimeouts {
	/** helloからreadyまで、listDevicesからdevicesまで。 */
	responseMs: number;
	/** startからstartedまで。初回はマイクの許可ダイアログへの応答を待つため長くとる。 */
	startMs: number;
	/** stopから終了まで。端数チャンクの書き込みを含む。 */
	stopMs: number;
	/** 標準入力を閉じる・SIGTERMを送ってから終了まで。過ぎたらSIGKILLで止める。 */
	exitMs: number;
	/** ヘルパーはheartbeatが15秒届かなければ録音を止める（プラグインの異常終了で録音が続かないようにするため）。 */
	heartbeatMs: number;
}

const DEFAULT_TIMEOUTS: HelperTimeouts = {
	responseMs: 10_000,
	startMs: 120_000,
	stopMs: 30_000,
	exitMs: 5_000,
	heartbeatMs: 5_000,
};

/** 改行が来ないまま出力が続く場合に、メモリを使い切らないための上限。 */
const MAX_LINE_LENGTH = 1024 * 1024;

export interface HelperClientOptions {
	executablePath: string;
	/** manifest.jsonの版。ヘルパーのhelperVersionと一致しなければ使わない。 */
	pluginVersion: string;
	/** セッションの作業領域。ヘルパーはその下のchunks/へ書く。 */
	sessionDir(sessionId: string): string;
	timeouts?: Partial<HelperTimeouts>;
}

export interface DeviceList {
	inputs: DeviceInfo[];
	outputs: DeviceInfo[];
	defaultInputUid: string | null;
	defaultOutputUid: string | null;
}

/** ヘルパーが報告したエラー。codeで原因を判別する（microphoneDenied、deviceDisconnectedなど）。 */
export class HelperError extends Error {
	constructor(
		readonly code: string,
		detail: string,
		readonly retryable: boolean,
		readonly target: string | null,
	) {
		super(`録音ヘルパーのエラー（${code}）: ${detail}`);
		this.name = 'HelperError';
	}
}

export class HelperClient implements Recorder {
	private readonly timeouts: HelperTimeouts;

	constructor(private readonly options: HelperClientOptions) {
		this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
	}

	async listDevices(): Promise<DeviceList> {
		const connection = await this.connect();
		try {
			const devices = await connection.request({ type: 'listDevices', requestId: connection.nextRequestId() }, 'devices', this.timeouts.responseMs);
			return {
				inputs: devices.inputs,
				outputs: devices.outputs,
				defaultInputUid: devices.defaultInputUid,
				defaultOutputUid: devices.defaultOutputUid,
			};
		} finally {
			await connection.closeInput(this.timeouts.exitMs);
		}
	}

	async start(session: SessionRecord, listener: RecorderListener): Promise<RecordingHandle> {
		const workDir = this.options.sessionDir(session.sessionId);
		const connection = await this.connect();
		const recording = new HelperRecording(connection, session.sessionId, listener, this.timeouts);
		const { recording: device, whisper } = session.settings;
		try {
			await recording.begin({
				type: 'start',
				requestId: connection.nextRequestId(),
				sessionId: session.sessionId,
				inputUid: device.microphoneDeviceUid === '' ? null : device.microphoneDeviceUid,
				outputUid: device.outputDeviceUid === '' ? null : device.outputDeviceUid,
				chunkSeconds: whisper.chunkSeconds,
				workDir,
			});
		} catch (error) {
			// 開始処理中のヘルパーはSIGTERMで録音を止め、資源を解放して終了する。
			await connection.terminate(this.timeouts.exitMs);
			throw error;
		}
		return recording;
	}

	/** 起動してhelloを交わし、プロトコル版とヘルパー版を確かめる。 */
	private async connect(): Promise<HelperConnection> {
		const { executablePath, pluginVersion } = this.options;
		const problem = await checkExecutableFile(executablePath);
		if (problem !== undefined) {
			throw new Error(`録音ヘルパー（${executablePath}）: ${problem}`);
		}
		const connection = new HelperConnection(executablePath);
		try {
			const ready = await connection.request(
				{ type: 'hello', requestId: connection.nextRequestId(), protocolVersion: HELPER_PROTOCOL_VERSION },
				'ready',
				this.timeouts.responseMs,
			);
			if (ready.protocolVersion !== HELPER_PROTOCOL_VERSION || ready.helperVersion !== pluginVersion) {
				throw new Error(
					`録音ヘルパーの版（${ready.helperVersion}、プロトコル${ready.protocolVersion}）がプラグインの版（${pluginVersion}、プロトコル${HELPER_PROTOCOL_VERSION}）と一致しません。ヘルパーを作り直して配置してください。`,
				);
			}
		} catch (error) {
			await connection.closeInput(this.timeouts.exitMs);
			throw error;
		}
		return connection;
	}
}

type StoppedEvent = Extract<HelperEvent, { type: 'stopped' }>;

/** 1セッションの録音。ヘルパーの通知をセッションへ渡し、停止と異常終了を判定する。 */
class HelperRecording implements RecordingHandle {
	/** `track:sequence`。同じチャンクの通知を二度渡さない。 */
	private readonly received = new Set<string>();
	private stoppedEvent: StoppedEvent | undefined;
	private helperError: HelperError | undefined;
	private started = false;
	private stopRequest: Promise<void> | undefined;
	private heartbeat: number | undefined;

	constructor(
		private readonly connection: HelperConnection,
		private readonly sessionId: string,
		private readonly listener: RecorderListener,
		private readonly timeouts: HelperTimeouts,
	) {
		connection.onNotice = (event) => this.handle(event);
		void connection.exited.then(() => this.handleExit());
	}

	async begin(command: Extract<HelperCommand, { type: 'start' }>): Promise<void> {
		const started = await this.connection.request(command, 'started', this.timeouts.startMs);
		if (started.sessionId !== this.sessionId) {
			throw new HelperProtocolError('startedのsessionIdが一致しません。');
		}
		this.started = true;
		this.heartbeat = window.setInterval(() => this.connection.send({ type: 'heartbeat', sessionId: this.sessionId }), this.timeouts.heartbeatMs);
	}

	/** 停止要求は1回だけ送る。端数チャンクと停止通知を受け、ヘルパーが終了してから解決する。 */
	stop(): Promise<void> {
		this.stopRequest ??= this.runStop();
		return this.stopRequest;
	}

	private async runStop(): Promise<void> {
		this.connection.send({ type: 'stop', sessionId: this.sessionId });
		if (!(await this.connection.waitForExit(this.timeouts.stopMs))) {
			throw new Error('録音ヘルパーが時間内に停止しなかったため、強制終了しました。確定済みのチャンクは作業領域に残っています。');
		}
		const stopped = this.stoppedEvent;
		if (stopped === undefined || stopped.reason !== 'stopCommand' || this.connection.failure !== undefined || this.helperError !== undefined) {
			throw this.failureReason();
		}
		for (const track of ['self', 'other'] as const) {
			const missing = this.firstMissing(track, stopped.lastSequence[track]);
			if (missing !== undefined) {
				throw new Error(`${track}トラックのチャンク${missing}の通知を受け取っていません。確定済みのチャンクは作業領域に残っています。`);
			}
		}
	}

	private handle(event: HelperEvent): void {
		if ('sessionId' in event && event.sessionId !== null && event.sessionId !== this.sessionId) {
			this.connection.fail(new HelperProtocolError('別のセッションの通知を受け取りました。'));
			return;
		}
		switch (event.type) {
			case 'chunkReady': {
				const key = `${event.track}:${event.sequence}`;
				if (this.received.has(key)) {
					return;
				}
				this.received.add(key);
				const chunk: ChunkNotice = {
					track: event.track,
					sequence: event.sequence,
					startMs: event.startMs,
					durationMs: event.durationMs,
					path: event.path,
					rmsDbfs: event.rmsDbfs,
				};
				this.listener.chunkReady(chunk);
				return;
			}
			case 'stopped':
				this.stoppedEvent = event;
				return;
			case 'error':
				this.helperError ??= toHelperError(event);
				return;
			default:
				// 要求への応答が期限切れの後に届いた場合。要求側は既に失敗として扱っている。
				return;
		}
	}

	private handleExit(): void {
		if (this.heartbeat !== undefined) {
			window.clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		// 停止要求後の終了はstopの結果で、開始前の終了はstartの失敗で伝える。
		if (this.started && this.stopRequest === undefined) {
			this.listener.failed(this.failureReason());
		}
	}

	private failureReason(): Error {
		if (this.connection.failure !== undefined) {
			return this.connection.failure;
		}
		if (this.helperError !== undefined) {
			return this.helperError;
		}
		if (this.stoppedEvent !== undefined) {
			return new Error(`録音ヘルパーが録音を停止しました（${this.stoppedEvent.reason}）。`);
		}
		return new Error(`録音ヘルパーが停止通知なしで終了しました（${this.connection.describeExit()}）。`);
	}

	private firstMissing(track: Track, last: number | null): number | undefined {
		if (last === null) {
			return undefined;
		}
		for (let sequence = 0; sequence <= last; sequence++) {
			if (!this.received.has(`${track}:${sequence}`)) {
				return sequence;
			}
		}
		return undefined;
	}
}

interface ExitStatus {
	code: number | null;
	signal: NodeJS.Signals | null;
}

type ResponseType = 'ready' | 'devices' | 'started';

interface Waiter {
	expected: ResponseType;
	resolve(event: HelperEvent): void;
	reject(error: Error): void;
	timer: number;
}

/** ヘルパー1プロセスとのJSON Linesの送受信。プロトコル違反と終了を検知し、待機中の要求を失敗させる。 */
class HelperConnection {
	/** requestIdを持たない通知と、待つ要求のない応答の受け口。 */
	onNotice: (event: HelperEvent) => void = () => undefined;
	/** プロセスの終了。起動に失敗した場合も終了として扱う。 */
	readonly exited: Promise<ExitStatus>;
	/** プロトコル違反・起動失敗など、通信を続けられない原因。 */
	failure: Error | undefined;
	private exitStatus: ExitStatus | undefined;
	private readonly child: ChildProcessByStdio<Writable, Readable, null>;
	private readonly pending = new Map<string, Waiter>();
	private buffer = '';
	private requestCount = 0;

	constructor(executablePath: string) {
		// 標準エラー出力は診断専用で、プラグインは使わない。読まずにパイプが詰まらないよう捨てる。
		this.child = spawn(executablePath, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
		this.exited = new Promise((resolve) => {
			const finish = (status: ExitStatus): void => {
				if (this.exitStatus !== undefined) {
					return;
				}
				this.exitStatus = status;
				this.rejectPending(this.failure ?? new Error(`録音ヘルパーが終了しました（${this.describeExit()}）。`));
				resolve(status);
			};
			this.child.once('close', (code, signal) => finish({ code, signal }));
			this.child.once('error', (error) => {
				this.failure ??= new Error(`録音ヘルパーを起動できません: ${error.message}`);
				// 起動に失敗した場合はcloseが来ないことがある。
				if (this.child.pid === undefined) {
					finish({ code: null, signal: null });
				}
			});
		});
		// 終了したヘルパーへの書き込みはEPIPEになる。終了はexitedで扱うため、ここでは無視する。
		this.child.stdin.on('error', () => undefined);
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (data: string) => this.receive(data));
	}

	nextRequestId(): string {
		this.requestCount += 1;
		return `r${this.requestCount}`;
	}

	/** 終了後や標準入力を閉じた後は送らない。 */
	send(command: HelperCommand): void {
		if (this.exitStatus === undefined && this.child.stdin.writable) {
			this.child.stdin.write(encodeCommand(command));
		}
	}

	request<T extends ResponseType>(command: HelperCommand & { requestId: string }, expected: T, timeoutMs: number): Promise<Extract<HelperEvent, { type: T }>> {
		if (this.failure !== undefined || this.exitStatus !== undefined) {
			return Promise.reject(this.failure ?? new Error(`録音ヘルパーが終了しています（${this.describeExit()}）。`));
		}
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(command.requestId);
				reject(new Error(`録音ヘルパーが${command.type}に時間内に応答しませんでした。`));
			}, timeoutMs);
			this.pending.set(command.requestId, {
				expected,
				resolve: (event) => resolve(event as Extract<HelperEvent, { type: T }>),
				reject,
				timer,
			});
			this.send(command);
		});
	}

	/** プロトコル違反などで通信を打ち切る。SIGTERMを受けたヘルパーは録音を止めて終了する。 */
	fail(error: Error): void {
		this.failure ??= error;
		this.rejectPending(error);
		if (this.exitStatus === undefined) {
			this.child.kill('SIGTERM');
		}
	}

	/** 標準入力を閉じて終了を待つ。ヘルパーはEOFで録音を止める。 */
	async closeInput(graceMs: number): Promise<void> {
		this.child.stdin.end();
		await this.waitForExit(graceMs);
	}

	async terminate(graceMs: number): Promise<void> {
		if (this.exitStatus === undefined) {
			this.child.kill('SIGTERM');
		}
		await this.waitForExit(graceMs);
	}

	/** 期限内に終了したかを返す。期限を過ぎたらSIGKILLで止め、終了を待つ。 */
	async waitForExit(timeoutMs: number): Promise<boolean> {
		let timer: number | undefined;
		const timedOut = new Promise<true>((resolve) => {
			timer = window.setTimeout(() => resolve(true), timeoutMs);
		});
		const result = await Promise.race([this.exited.then(() => false), timedOut]);
		window.clearTimeout(timer);
		if (result) {
			this.child.kill('SIGKILL');
			await this.exited;
			return false;
		}
		return true;
	}

	describeExit(): string {
		const status = this.exitStatus;
		if (status === undefined) {
			return '実行中';
		}
		return status.signal !== null ? `シグナル${status.signal}` : `終了コード${status.code ?? '不明'}`;
	}

	private receive(data: string): void {
		this.buffer += data;
		let newline = this.buffer.indexOf('\n');
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim() !== '') {
				this.dispatch(line);
			}
			newline = this.buffer.indexOf('\n');
		}
		if (this.buffer.length > MAX_LINE_LENGTH) {
			this.buffer = '';
			this.fail(new HelperProtocolError('改行のない出力が長すぎます。'));
		}
	}

	private dispatch(line: string): void {
		if (this.failure !== undefined) {
			return;
		}
		let event: HelperEvent;
		try {
			event = parseHelperEvent(line);
		} catch (error) {
			this.fail(error instanceof Error ? error : new HelperProtocolError('解析できません。'));
			return;
		}
		const requestId = 'requestId' in event ? event.requestId : null;
		const waiter = requestId === null ? undefined : this.pending.get(requestId);
		if (requestId === null || waiter === undefined) {
			this.onNotice(event);
			return;
		}
		this.pending.delete(requestId);
		window.clearTimeout(waiter.timer);
		if (event.type === 'error') {
			waiter.reject(toHelperError(event));
		} else if (event.type !== waiter.expected) {
			this.fail(new HelperProtocolError(`${waiter.expected}を待っている要求に${event.type}が届きました。`));
			waiter.reject(this.failure ?? new HelperProtocolError('応答の種類が一致しません。'));
		} else {
			waiter.resolve(event);
		}
	}

	private rejectPending(error: Error): void {
		for (const waiter of this.pending.values()) {
			window.clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}
}

function toHelperError(event: HelperErrorEvent): HelperError {
	return new HelperError(event.code, event.message, event.retryable, event.target);
}
