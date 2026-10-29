import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelperClient, type HelperClientOptions, HelperError } from '../../src/audio/HelperClient';
import { HelperProtocolError } from '../../src/audio/protocol';
import type { ChunkNotice, RecorderListener } from '../../src/session/ports';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from '../../src/session/records';
import { createDefaultSettings } from '../../src/settings/settings';

// 偽ヘルパーは実際の子プロセスとして起動し、標準入出力のパイプ越しに通信する。
// シナリオごとにonCommandを書いたNode.jsスクリプトを一時フォルダへ置く。

const SESSION_ID = 'session-1';

// 偽ヘルパーの共通部分。受け取ったコマンドを記録し、send・raw・exitで応答する。
const PRELUDE = `
const fs = require('fs');
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const raw = (data) => process.stdout.write(data);
const exit = (code) => process.stdout.write('', () => process.exit(code));
const record = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + '\\n');
const ready = (cmd, version = '0.1.0') => send({ type: 'ready', requestId: cmd.requestId, protocolVersion: 1, helperVersion: version, capabilities: [] });
const started = (cmd) => send({ type: 'started', requestId: cmd.requestId, sessionId: cmd.sessionId, inputUid: 'mic', outputTarget: 'all' });
const chunk = (track, sequence, sessionId = '${SESSION_ID}') => send({
	type: 'chunkReady', sessionId, track, sequence, startMs: sequence * 10000, durationMs: 10000,
	path: 'chunks/' + track + '-' + String(sequence).padStart(6, '0') + '.wav', rmsDbfs: -30,
});
const stopped = (lastSequence, reason = 'stopCommand') => send({ type: 'stopped', sessionId: '${SESSION_ID}', reason, lastSequence });
let onEnd = () => exit(0);
process.on('SIGTERM', () => { record('SIGTERM'); exit(143); });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
	buffer += data;
	let index;
	while ((index = buffer.indexOf('\\n')) >= 0) {
		const cmd = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		record(cmd);
		onCommand(cmd);
	}
});
process.stdin.on('end', () => { record('EOF'); onEnd(); });
`;

let dir: string;
let logPath: string;

beforeAll(() => {
	// 本体はObsidianのwindowのタイマーを使う。Node.jsではグローバルのタイマーで代用する。
	vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
});

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-helper-'));
	logPath = join(dir, 'log.jsonl');
	await fs.mkdir(join(dir, 'sessions', SESSION_ID), { recursive: true });
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function writeHelper(scenario: string): Promise<string> {
	const path = join(dir, 'fake-helper');
	const source = `#!${process.execPath}\nconst LOG = ${JSON.stringify(logPath)};\n${PRELUDE}\n${scenario}\n`;
	await fs.writeFile(path, source, { mode: 0o755 });
	return path;
}

async function createClient(scenario: string, options: Partial<HelperClientOptions> = {}): Promise<HelperClient> {
	return new HelperClient({
		executablePath: await writeHelper(scenario),
		pluginVersion: '0.1.0',
		sessionDir: (sessionId) => join(dir, 'sessions', sessionId),
		...options,
		timeouts: { responseMs: 2000, startMs: 2000, stopMs: 2000, exitMs: 1000, heartbeatMs: 1000, ...options.timeouts },
	});
}

async function readLog(): Promise<unknown[]> {
	const text = await fs.readFile(logPath, 'utf8').catch(() => '');
	return text
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as unknown);
}

function commandTypes(log: unknown[]): string[] {
	return log.map((entry) => (typeof entry === 'string' ? entry : (entry as { type: string }).type));
}

function sessionRecord(): SessionRecord {
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SESSION_ID,
		blockId: 'block-1',
		notePath: 'Meetings/test.md',
		startedAt: '2026-10-29T00:00:00.000Z',
		state: 'preparing',
		settings: createDefaultSettings(),
	};
}

class Listener implements RecorderListener {
	readonly chunks: ChunkNotice[] = [];
	readonly failures: Error[] = [];

	chunkReady(chunk: ChunkNotice): void {
		this.chunks.push(chunk);
	}

	failed(error: Error): void {
		this.failures.push(error);
	}
}

// 録音開始までの標準的な応答。シナリオごとにstart以降の動作を足す。
const RECORDING_PRELUDE = `
let afterStart = () => {};
let onStop = () => {};
function onCommand(cmd) {
	if (cmd.type === 'hello') ready(cmd);
	if (cmd.type === 'start') { started(cmd); afterStart(); }
	if (cmd.type === 'stop') onStop();
}
`;

describe('HelperClient.listDevices', () => {
	it('分割された行とマルチバイト文字を組み立ててデバイス一覧を返し、標準入力を閉じる', async () => {
		const client = await createClient(`
			function onCommand(cmd) {
				if (cmd.type === 'hello') ready(cmd);
				if (cmd.type === 'listDevices') {
					const line = Buffer.from(JSON.stringify({
						type: 'devices', requestId: cmd.requestId,
						inputs: [{ uid: 'mic', name: '内蔵マイク', inputChannels: 1, outputChannels: 0, nominalSampleRate: 48000 }],
						outputs: [], defaultInputUid: 'mic', defaultOutputUid: null,
					}) + '\\n');
					// 「内」の途中でUTF-8を分割して送る。
					const cut = line.indexOf(Buffer.from('内')) + 1;
					process.stdout.write(line.subarray(0, cut));
					setTimeout(() => process.stdout.write(line.subarray(cut)), 20);
				}
			}
		`);

		const devices = await client.listDevices();

		expect(devices.inputs).toEqual([{ uid: 'mic', name: '内蔵マイク', inputChannels: 1, outputChannels: 0, nominalSampleRate: 48000 }]);
		expect(devices.defaultOutputUid).toBeNull();
		expect(commandTypes(await readLog())).toEqual(['hello', 'listDevices', 'EOF']);
	});

	it('ヘルパーの版がプラグインと異なれば拒否する', async () => {
		const client = await createClient(`function onCommand(cmd) { if (cmd.type === 'hello') ready(cmd, '9.9.9'); }`);

		await expect(client.listDevices()).rejects.toThrow(/9\.9\.9.*一致しません/);
	});

	it('実行ファイルがなければ起動しない', async () => {
		const client = new HelperClient({ executablePath: join(dir, 'missing'), pluginVersion: '0.1.0', sessionDir: () => dir });

		await expect(client.listDevices()).rejects.toThrow(/録音ヘルパー/);
	});

	it('応答がなければ時間切れで失敗し、ヘルパーを終了させる', async () => {
		// 負荷が高いと偽ヘルパーの起動に1秒以上かかり、EOFを読む前に強制終了されるため、終了の猶予を広げる。
		const client = await createClient(`function onCommand() {}`, { timeouts: { responseMs: 50, exitMs: 10_000 } });

		await expect(client.listDevices()).rejects.toThrow(/時間内に応答しませんでした/);
		expect(commandTypes(await readLog())).toContain('EOF');
	});

	it('JSONでない出力をプロトコル違反として拒否する', async () => {
		const client = await createClient(`function onCommand(cmd) { if (cmd.type === 'hello') raw('not json\\n'); }`);

		await expect(client.listDevices()).rejects.toBeInstanceOf(HelperProtocolError);
	});
});

describe('HelperClient.start', () => {
	it('開始要求に作業領域と設定を渡し、重複を除いたチャンクと端数を受けてから停止する', async () => {
		const client = await createClient(`${RECORDING_PRELUDE}
			afterStart = () => { chunk('self', 0); chunk('other', 0); chunk('self', 0); };
			onStop = () => { chunk('self', 1); chunk('other', 1); stopped({ self: 1, other: 1 }); exit(0); };
		`);
		const listener = new Listener();

		const recording = await client.start(sessionRecord(), listener);
		await vi.waitFor(() => expect(listener.chunks).toHaveLength(2));
		await recording.stop();

		expect(listener.chunks.map((chunk) => `${chunk.track}:${chunk.sequence}`)).toEqual(['self:0', 'other:0', 'self:1', 'other:1']);
		expect(listener.chunks[0]).toEqual({ track: 'self', sequence: 0, startMs: 0, durationMs: 10000, path: 'chunks/self-000000.wav', rmsDbfs: -30 });
		expect(listener.failures).toEqual([]);
		const start = (await readLog()).find((entry) => (entry as { type?: string }).type === 'start');
		expect(start).toMatchObject({
			sessionId: SESSION_ID,
			workDir: join(dir, 'sessions', SESSION_ID),
			chunkSeconds: 10,
			inputUid: null,
			outputUid: null,
		});
	});

	it('2回目の停止要求は送らず、最初の結果を返す', async () => {
		const client = await createClient(`${RECORDING_PRELUDE}
			onStop = () => { stopped({ self: null, other: null }); exit(0); };
		`);
		const recording = await client.start(sessionRecord(), new Listener());

		await Promise.all([recording.stop(), recording.stop()]);

		expect(commandTypes(await readLog()).filter((type) => type === 'stop')).toHaveLength(1);
	});

	it('録音中はheartbeatを送る', async () => {
		const client = await createClient(`${RECORDING_PRELUDE}
			onStop = () => { stopped({ self: null, other: null }); exit(0); };
		`, { timeouts: { heartbeatMs: 20 } });
		const recording = await client.start(sessionRecord(), new Listener());

		await vi.waitFor(async () => {
			expect(commandTypes(await readLog()).filter((type) => type === 'heartbeat').length).toBeGreaterThanOrEqual(2);
		});
		await recording.stop();
	});

	it('開始の拒否をコード付きのエラーで返す', async () => {
		const client = await createClient(`
			function onCommand(cmd) {
				if (cmd.type === 'hello') ready(cmd);
				if (cmd.type === 'start') {
					send({ type: 'error', code: 'microphoneDenied', message: 'denied', retryable: false, target: 'self', requestId: cmd.requestId, sessionId: cmd.sessionId });
				}
			}
		`);

		const error: unknown = await client.start(sessionRecord(), new Listener()).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(HelperError);
		expect((error as HelperError).code).toBe('microphoneDenied');
		expect((error as HelperError).target).toBe('self');
	});

	it('開始が時間内に終わらなければ失敗し、SIGTERMで止める', async () => {
		const client = await createClient(`function onCommand(cmd) { if (cmd.type === 'hello') ready(cmd); }`, { timeouts: { startMs: 50 } });
		const listener = new Listener();

		await expect(client.start(sessionRecord(), listener)).rejects.toThrow(/時間内に応答しませんでした/);

		expect(commandTypes(await readLog())).toContain('SIGTERM');
		expect(listener.failures).toEqual([]);
	});
});

describe('HelperClient 録音中の障害', () => {
	it('停止通知なしの終了を録音の失敗として通知する', async () => {
		const client = await createClient(`${RECORDING_PRELUDE}
			afterStart = () => { chunk('self', 0); setTimeout(() => exit(3), 20); };
		`);
		const listener = new Listener();
		const recording = await client.start(sessionRecord(), listener);

		await vi.waitFor(() => expect(listener.failures).toHaveLength(1));

		expect(listener.failures[0]?.message).toMatch(/停止通知なしで終了しました（終了コード3）/);
		expect(listener.chunks).toHaveLength(1);
		await expect(recording.stop()).rejects.toThrow(/停止通知なし/);
	});

	it('ヘルパーが報告したエラーをコード付きで通知する', async () => {
		const client = await createClient(`${RECORDING_PRELUDE}
			afterStart = () => {
				send({ type: 'error', code: 'deviceDisconnected', message: 'gone', retryable: false, target: 'self', requestId: null, sessionId: '${SESSION_ID}' });
				stopped({ self: null, other: null }, 'error');
				exit(1);
			};
		`);
		const listener = new Listener();
		await client.start(sessionRecord(), listener);

		await vi.waitFor(() => expect(listener.failures).toHaveLength(1));

		expect(listener.failures[0]).toBeInstanceOf(HelperError);
		expect((listener.failures[0] as HelperError).code).toBe('deviceDisconnected');
	});

	it.each([
		['不正なJSON', `raw('{"type":\\n');`, HelperProtocolError],
		['別セッションの通知', `chunk('self', 0, 'session-2');`, HelperProtocolError],
		['作業領域外のパス', `send({ type: 'chunkReady', sessionId: '${SESSION_ID}', track: 'self', sequence: 0, startMs: 0, durationMs: 1, path: '../x.wav', rmsDbfs: -1 });`, HelperProtocolError],
	])('%sを拒否し、ヘルパーを止めて失敗を通知する', async (_name, emit, errorType) => {
		const client = await createClient(`${RECORDING_PRELUDE}
			afterStart = () => { ${emit} };
		`);
		const listener = new Listener();
		await client.start(sessionRecord(), listener);

		await vi.waitFor(() => expect(listener.failures).toHaveLength(1));

		expect(listener.failures[0]).toBeInstanceOf(errorType);
		expect(listener.chunks).toEqual([]);
		expect(commandTypes(await readLog())).toContain('SIGTERM');
	});

	it('停止通知の最終番号までのチャンクが欠けていれば停止を失敗にする', async () => {
		const client = await createClient(`${RECORDING_PRELUDE}
			onStop = () => { chunk('self', 0); chunk('self', 1); stopped({ self: 2, other: null }); exit(0); };
		`);
		const recording = await client.start(sessionRecord(), new Listener());

		await expect(recording.stop()).rejects.toThrow(/selfトラックのチャンク2/);
	});

	it('停止要求に応じなければ強制終了して失敗にする', async () => {
		const client = await createClient(RECORDING_PRELUDE, { timeouts: { stopMs: 50 } });
		const listener = new Listener();
		const recording = await client.start(sessionRecord(), listener);

		await expect(recording.stop()).rejects.toThrow(/強制終了しました/);
		expect(listener.failures).toEqual([]);
	});
});
