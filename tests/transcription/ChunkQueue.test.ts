import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkNotice, TranscriptionListener, TranscriptionProgress } from '../../src/session/ports';
import { SESSION_SCHEMA_VERSION, type SessionRecord, type Track } from '../../src/session/records';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings } from '../../src/settings/settings';
import { WhisperTranscriber, type WhisperTranscriberOptions } from '../../src/transcription/ChunkQueue';
import { WhisperError, type WhisperRequest, type WhisperSegment } from '../../src/transcription/WhisperRunner';

const SESSION_ID = 'session-1';

let dir: string;
let store: SessionStore;
let session: SessionRecord;

beforeAll(() => {
	vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
});

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-queue-'));
	store = new SessionStore(join(dir, 'sessions'));
	const settings = createDefaultSettings();
	settings.whisper.executablePath = join(dir, 'whisper-cli');
	settings.whisper.modelDir = join(dir, 'models');
	settings.whisper.model = 'ggml-base.bin';
	settings.whisper.silenceThresholdDbfs = -50;
	session = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SESSION_ID,
		blockId: 'block-1',
		notePath: 'a.md',
		startedAt: '2026-10-29T00:00:00.000Z',
		state: 'recording',
		settings,
	};
	await store.createSession(session);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function notice(track: Track, sequence: number, rmsDbfs = -30): ChunkNotice {
	return {
		track,
		sequence,
		startMs: sequence * 10_000,
		durationMs: 10_000,
		path: `chunks/${track}-${String(sequence).padStart(6, '0')}.wav`,
		rmsDbfs,
	};
}

class Listener implements TranscriptionListener {
	progresses: TranscriptionProgress[] = [];
	failures: Error[] = [];
	lowDisk = 0;

	progress(progress: TranscriptionProgress): void {
		this.progresses.push(progress);
	}

	failed(error: Error): void {
		this.failures.push(error);
	}

	lowDiskSpace(): void {
		this.lowDisk += 1;
	}

	get last(): TranscriptionProgress | undefined {
		return this.progresses[this.progresses.length - 1];
	}
}

/** 呼び出しを記録し、チャンクのパスごとに結果を返す偽のwhisper。既定は1区間を返す。 */
class FakeWhisper {
	calls: WhisperRequest[] = [];
	running = 0;
	maxRunning = 0;
	results = new Map<string, () => Promise<WhisperSegment[]>>();

	readonly run = async (request: WhisperRequest): Promise<WhisperSegment[]> => {
		this.calls.push(request);
		this.running += 1;
		this.maxRunning = Math.max(this.maxRunning, this.running);
		try {
			await new Promise((resolve) => window.setTimeout(resolve, 5));
			const result = this.results.get(request.wavPath.slice(request.wavPath.indexOf('chunks')));
			return result ? await result() : [{ startMs: 1000, endMs: 2500, text: 'テスト' }];
		} finally {
			this.running -= 1;
		}
	};

	get processedPaths(): string[] {
		return this.calls.map((call) => call.wavPath.slice(call.wavPath.indexOf('chunks')));
	}
}

let whisper: FakeWhisper;

beforeEach(() => {
	whisper = new FakeWhisper();
});

function transcriber(overrides: Partial<WhisperTranscriberOptions> = {}): WhisperTranscriber {
	return new WhisperTranscriber({ store, runWhisper: whisper.run, freeDiskBytes: () => Promise.resolve(10 ** 12), ...overrides });
}

describe('ChunkQueue', () => {
	it('チャンクを記録してから処理し、区間をセッション時刻で保存する', async () => {
		const listener = new Listener();
		const job = transcriber().begin(session, listener);
		job.enqueue(notice('self', 0));
		job.enqueue(notice('other', 1));
		await expect(job.finish()).resolves.toEqual({ complete: true });

		const chunks = await store.loadChunks(SESSION_ID);
		expect(chunks.map((chunk) => [chunk.track, chunk.state, chunk.attempts])).toEqual([
			['self', 'done', 1],
			['other', 'done', 1],
		]);
		expect(await store.loadSegments(SESSION_ID)).toEqual([
			{ segmentId: 'self-0-0', track: 'self', sequence: 0, index: 0, startMs: 1000, endMs: 2500, text: 'テスト' },
			{ segmentId: 'other-1-0', track: 'other', sequence: 1, index: 0, startMs: 11_000, endMs: 12_500, text: 'テスト' },
		]);
		expect(listener.last).toEqual({ queued: 0, processed: 2, failed: 0 });

		const call = whisper.calls[0];
		expect(call?.modelPath).toBe(join(dir, 'models', 'ggml-base.bin'));
		expect(call?.wavPath).toBe(join(store.sessionDir(SESSION_ID), 'chunks', 'self-000000.wav'));
		expect(call?.outputPrefix).toBe(join(store.sessionDir(SESSION_ID), 'transcripts', 'self-000000'));
		expect(call?.language).toBe('ja');
	});

	it('無音のチャンクはwhisperを起動せずに処理済みとして記録する', async () => {
		const job = transcriber().begin(session, new Listener());
		job.enqueue(notice('other', 0, -60));
		await expect(job.finish()).resolves.toEqual({ complete: true });
		expect(whisper.calls).toHaveLength(0);
		expect((await store.loadChunks(SESSION_ID))[0]?.state).toBe('silent');
	});

	it('whisper-cliは同時に1プロセスだけ起動する', async () => {
		const job = transcriber().begin(session, new Listener());
		for (let i = 0; i < 4; i++) {
			job.enqueue(notice(i % 2 === 0 ? 'self' : 'other', i));
		}
		await job.finish();
		expect(whisper.calls).toHaveLength(4);
		expect(whisper.maxRunning).toBe(1);
	});

	it('同じチャンクの通知を二重に処理しない', async () => {
		const job = transcriber().begin(session, new Listener());
		job.enqueue(notice('self', 0));
		job.enqueue(notice('self', 0));
		await job.finish();
		expect(whisper.calls).toHaveLength(1);
		expect(await store.loadChunks(SESSION_ID)).toHaveLength(1);
	});

	it('失敗したチャンクを記録して残りを処理し、除外した件数を返す', async () => {
		whisper.results.set('chunks/self-000000.wav', () => Promise.reject(new WhisperError('timeout', 'timeout')));
		const listener = new Listener();
		const job = transcriber().begin(session, listener);
		job.enqueue(notice('self', 0));
		job.enqueue(notice('other', 1));
		await expect(job.finish()).resolves.toEqual({ complete: true, failedChunks: 1 });
		expect((await store.loadChunks(SESSION_ID)).map((chunk) => chunk.state)).toEqual(['failed', 'done']);
		expect(listener.last).toEqual({ queued: 0, processed: 1, failed: 1 });
		expect(listener.failures).toHaveLength(0);
	});

	it('再試行では失敗したチャンクだけを再処理する', async () => {
		whisper.results.set('chunks/self-000000.wav', () => Promise.reject(new WhisperError('exit', 'exit')));
		const first = transcriber().begin(session, new Listener());
		first.enqueue(notice('self', 0));
		first.enqueue(notice('other', 1));
		first.enqueue(notice('other', 2, -60));
		await first.finish();

		whisper.results.clear();
		whisper.calls = [];
		const retry = transcriber().begin(session, new Listener());
		await expect(retry.finish()).resolves.toEqual({ complete: true });
		expect(whisper.processedPaths).toEqual(['chunks/self-000000.wav']);
		const chunks = await store.loadChunks(SESSION_ID);
		expect(chunks.map((chunk) => [chunk.state, chunk.attempts])).toEqual([
			['done', 2],
			['done', 1],
			['silent', 0],
		]);
		expect((await store.loadSegments(SESSION_ID)).map((segment) => segment.segmentId)).toEqual(['other-1-0', 'self-0-0']);
	});

	it('作業領域に残ったpendingのチャンクを読み込んで処理する', async () => {
		await store.appendChunk(SESSION_ID, { ...notice('self', 0), state: 'pending', attempts: 0 });
		await store.appendChunk(SESSION_ID, { ...notice('other', 0), state: 'done', attempts: 1 });
		const listener = new Listener();
		const job = transcriber().begin(session, listener);
		// 読み込み済みのチャンクの再通知は受け付けない。
		job.enqueue(notice('other', 0));
		await expect(job.finish()).resolves.toEqual({ complete: true });
		expect(whisper.processedPaths).toEqual(['chunks/self-000000.wav']);
		expect(listener.progresses[0]).toEqual({ queued: 1, processed: 1, failed: 0 });
	});

	it('区間の保存後に中断されたチャンクを再処理しても、同じ区間を重複させない', async () => {
		await store.appendChunk(SESSION_ID, { ...notice('self', 0), state: 'pending', attempts: 1 });
		await store.appendSegments(SESSION_ID, [{ segmentId: 'self-0-0', track: 'self', sequence: 0, index: 0, startMs: 1000, endMs: 2500, text: 'テスト' }]);
		const job = transcriber().begin(session, new Listener());
		await job.finish();
		expect(await store.loadSegments(SESSION_ID)).toHaveLength(1);
	});

	it('中断したチャンクはpendingのまま残す', async () => {
		let release: () => void = () => undefined;
		whisper.results.set(
			'chunks/self-000000.wav',
			() =>
				new Promise((_, reject) => {
					release = () => reject(new WhisperError('aborted', 'aborted'));
				}),
		);
		const job = transcriber().begin(session, new Listener());
		job.enqueue(notice('self', 0));
		job.enqueue(notice('self', 1));
		await vi.waitFor(() => expect(whisper.calls).toHaveLength(1));
		const aborting = job.abort();
		release();
		await aborting;
		expect((await store.loadChunks(SESSION_ID)).map((chunk) => chunk.state)).toEqual(['pending', 'pending']);
		expect(whisper.calls).toHaveLength(1);
	});

	it('空き容量の不足を1回だけ通知する', async () => {
		const listener = new Listener();
		const job = transcriber({ freeDiskBytes: () => Promise.resolve(1024), minFreeDiskBytes: 2048 }).begin(session, listener);
		job.enqueue(notice('self', 0));
		job.enqueue(notice('other', 0));
		await job.finish();
		expect(listener.lowDisk).toBe(1);
	});

	it('作業領域へ記録できなければ処理を止めてセッションへ通知する', async () => {
		const listener = new Listener();
		const failing = Object.assign(Object.create(store) as SessionStore, {
			appendChunk: () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })),
		});
		const job = transcriber({ store: failing }).begin(session, listener);
		job.enqueue(notice('self', 0));
		job.enqueue(notice('self', 1));
		await expect(job.finish()).rejects.toThrow('no space');
		expect(listener.failures).toHaveLength(1);
		expect(whisper.calls).toHaveLength(0);
	});
});

describe('ChunkQueueと偽のwhisper-cliの結合', () => {
	it('正常・壊れたJSON・範囲外・異常終了を区別して記録する', async () => {
		const cli = join(dir, 'whisper-cli');
		// 入力ファイル名でシナリオを選ぶ。self-000000は正常、以降は失敗。
		await fs.writeFile(
			cli,
			`#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const out = arg('-of') + '.json';
const wav = arg('-f');
if (wav.endsWith('self-000000.wav')) fs.writeFileSync(out, JSON.stringify({ transcription: [{ offsets: { from: 0, to: 4000 }, text: ' 今日は' }, { offsets: { from: 4000, to: 9000 }, text: ' 定例です' }] }));
else if (wav.endsWith('self-000001.wav')) fs.writeFileSync(out, '{"transcription": [');
else if (wav.endsWith('self-000002.wav')) fs.writeFileSync(out, JSON.stringify({ transcription: [{ offsets: { from: 0, to: 20000 }, text: 'x' }] }));
else process.exit(1);
`,
		);
		await fs.chmod(cli, 0o755);
		session.settings.whisper.executablePath = cli;
		const job = new WhisperTranscriber({ store, freeDiskBytes: () => Promise.resolve(10 ** 12) }).begin(session, new Listener());
		for (let i = 0; i < 4; i++) {
			job.enqueue(notice('self', i));
		}
		await expect(job.finish()).resolves.toEqual({ complete: true, failedChunks: 3 });
		expect((await store.loadChunks(SESSION_ID)).map((chunk) => chunk.state)).toEqual(['done', 'failed', 'failed', 'failed']);
		expect((await store.loadSegments(SESSION_ID)).map((segment) => [segment.startMs, segment.endMs, segment.text])).toEqual([
			[0, 4000, '今日は'],
			[4000, 9000, '定例です'],
		]);
		await expect(fs.readdir(join(store.sessionDir(SESSION_ID), 'transcripts'))).resolves.toEqual([]);
	});
});
