import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWhisperOutput, runWhisper, WhisperError, type WhisperRequest } from '../../src/transcription/WhisperRunner';

// 偽のwhisper-cliは実際の子プロセスとして起動する。引数を記録し、シナリオごとの本体で-ofの先へJSONを書く。

const PRELUDE = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(LOG, JSON.stringify(args));
const arg = (name) => args[args.indexOf(name) + 1];
const writeJson = (value) => fs.writeFileSync(arg('-of') + '.json', typeof value === 'string' ? value : JSON.stringify(value));
const segment = (from, to, text) => ({ timestamps: {}, offsets: { from, to }, text });
`;

let dir: string;
let logPath: string;

beforeAll(() => {
	vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
});

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-whisper-'));
	logPath = join(dir, 'args.json');
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function fakeCli(body: string): Promise<string> {
	const path = join(dir, 'whisper-cli');
	await fs.writeFile(path, `#!${process.execPath}\nconst LOG = ${JSON.stringify(logPath)};\n${PRELUDE}\n${body}\n`);
	await fs.chmod(path, 0o755);
	return path;
}

function request(executablePath: string, overrides: Partial<WhisperRequest> = {}): WhisperRequest {
	return {
		executablePath,
		modelPath: join(dir, 'models dir', 'ggml-base.bin'),
		wavPath: join(dir, 'chunks', 'self-000000.wav'),
		language: 'ja',
		outputPrefix: join(dir, 'self-000000'),
		durationMs: 10_000,
		timeoutMs: 10_000,
		...overrides,
	};
}

async function failure(promise: Promise<unknown>): Promise<WhisperError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	if (!(error instanceof WhisperError)) {
		throw new Error(`WhisperErrorではありません: ${String(error)}`);
	}
	return error;
}

describe('runWhisper', () => {
	it('引数配列で起動し、JSONの区間をミリ秒で返して出力ファイルを消す', async () => {
		const cli = await fakeCli(`writeJson({ transcription: [segment(0, 3200, ' こんにちは'), segment(3200, 3300, ' '), segment(3300, 10000, '会議です')] });`);
		const req = request(cli);
		await expect(runWhisper(req)).resolves.toEqual([
			{ startMs: 0, endMs: 3200, text: 'こんにちは' },
			{ startMs: 3300, endMs: 10000, text: '会議です' },
		]);
		const args = JSON.parse(await fs.readFile(logPath, 'utf8')) as string[];
		// 空白を含むパスも1つの引数として渡る。
		expect(args).toEqual(['-m', req.modelPath, '-f', req.wavPath, '-l', 'ja', '-oj', '-of', req.outputPrefix]);
		await expect(fs.access(`${req.outputPrefix}.json`)).rejects.toThrow();
	});

	it('前回の試行の出力を読まない', async () => {
		const cli = await fakeCli('');
		const req = request(cli);
		await fs.writeFile(`${req.outputPrefix}.json`, JSON.stringify({ transcription: [] }));
		expect((await failure(runWhisper(req))).reason).toBe('output');
	});

	it('壊れたJSONは内容を含めずに失敗する', async () => {
		const cli = await fakeCli(`writeJson('{"transcription": [秘密の発言');`);
		const error = await failure(runWhisper(request(cli)));
		expect(error.reason).toBe('output');
		expect(error.message).not.toContain('秘密');
	});

	it('チャンク長をわずかに超える終了時刻はチャンク長に切り詰める', async () => {
		// 実機のwhisper-cliは10,000ミリ秒のチャンクに10,020を返した。
		const cli = await fakeCli(`writeJson({ transcription: [segment(9000, 10020, 'x')] });`);
		await expect(runWhisper(request(cli))).resolves.toEqual([{ startMs: 9000, endMs: 10_000, text: 'x' }]);
	});

	it('チャンクの範囲から大きく外れた区間は失敗にする', async () => {
		const cli = await fakeCli(`writeJson({ transcription: [segment(9000, 11_001, 'x')] });`);
		expect((await failure(runWhisper(request(cli)))).reason).toBe('output');
	});

	it('異常終了は出力があっても失敗にする', async () => {
		const cli = await fakeCli(`writeJson({ transcription: [] }); process.exit(3);`);
		const error = await failure(runWhisper(request(cli)));
		expect(error.reason).toBe('exit');
		expect(error.message).toContain('終了コード3');
	});

	it('起動できない実行ファイルは失敗にする', async () => {
		expect((await failure(runWhisper(request(join(dir, 'missing'))))).reason).toBe('exit');
	});

	it('期限を過ぎたら止めてタイムアウトにする', async () => {
		const cli = await fakeCli('setInterval(() => undefined, 1000);');
		const started = Date.now();
		expect((await failure(runWhisper(request(cli, { timeoutMs: 300 })))).reason).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('中断の要求で止める', async () => {
		const cli = await fakeCli('setInterval(() => undefined, 1000);');
		const controller = new AbortController();
		const running = runWhisper(request(cli, { signal: controller.signal }));
		window.setTimeout(() => controller.abort(), 200);
		expect((await failure(running)).reason).toBe('aborted');
	});
});

describe('parseWhisperOutput', () => {
	it('必須の値が欠けた区間を拒否する', () => {
		expect(() => parseWhisperOutput(JSON.stringify({ transcription: [{ offsets: { from: 0 }, text: 'a' }] }), 1000)).toThrow(WhisperError);
		expect(() => parseWhisperOutput(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 10 } }] }), 1000)).toThrow(WhisperError);
		expect(() => parseWhisperOutput(JSON.stringify({ result: {} }), 1000)).toThrow(WhisperError);
	});

	it('開始が終了より後の区間と負の開始を拒否する', () => {
		expect(() => parseWhisperOutput(JSON.stringify({ transcription: [{ offsets: { from: 500, to: 400 }, text: 'a' }] }), 1000)).toThrow(WhisperError);
		expect(() => parseWhisperOutput(JSON.stringify({ transcription: [{ offsets: { from: -1, to: 400 }, text: 'a' }] }), 1000)).toThrow(WhisperError);
	});

	it('チャンク長ちょうどの終了は受け付ける', () => {
		expect(parseWhisperOutput(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: 'a' }] }), 1000)).toHaveLength(1);
	});
});
