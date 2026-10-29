import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChunkRecord, SessionDataError, type SessionRecord, type SegmentRecord, type SummaryRun } from '../../src/session/records';
import { defaultSessionsRoot, getFreeDiskBytes, parseJsonLines, SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings } from '../../src/settings/settings';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		schemaVersion: 1,
		sessionId: 's-1',
		blockId: 'b-1',
		notePath: 'Meetings/定例.md',
		startedAt: '2026-10-28T10:00:00.000Z',
		state: 'recording',
		settings: createDefaultSettings(),
		...overrides,
	};
}

function chunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
	return { track: 'self', sequence: 0, startMs: 0, durationMs: 10000, path: 'chunks/self-0.wav', rmsDbfs: -30, state: 'pending', attempts: 0, ...overrides };
}

function segment(overrides: Partial<SegmentRecord> = {}): SegmentRecord {
	return { segmentId: 'self-0-0', track: 'self', sequence: 0, index: 0, startMs: 0, endMs: 1200, text: '架空の発言です。', ...overrides };
}

let root: string;
let store: SessionStore;

beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), 'lms-store-'));
	store = new SessionStore(join(root, 'sessions'));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('session.json', () => {
	it('作成・置換・読み込みができる', async () => {
		await store.createSession(session());
		await store.saveSession(session({ state: 'draining' }));
		expect(await store.loadSession('s-1')).toEqual(session({ state: 'draining' }));
	});

	it('置換後に一時ファイルを残さない', async () => {
		await store.createSession(session());
		await store.saveSession(session({ state: 'completed' }));
		expect(await fs.readdir(store.sessionDir('s-1'))).toEqual(['session.json']);
	});

	it('書き込みに失敗しても既存のsession.jsonを壊さない', async () => {
		await store.createSession(session());
		const circular = session() as SessionRecord & { self?: unknown };
		circular.self = circular;
		await expect(store.saveSession(circular)).rejects.toThrow();
		expect(await store.loadSession('s-1')).toEqual(session());
		expect(await fs.readdir(store.sessionDir('s-1'))).toEqual(['session.json']);
	});

	it('同じIDの作業領域を上書きしない', async () => {
		await store.createSession(session());
		await expect(store.createSession(session({ state: 'preparing' }))).rejects.toThrow();
		expect((await store.loadSession('s-1')).state).toBe('recording');
	});

	it('パスとして不正なIDを拒否する', () => {
		expect(() => store.sessionDir('../x')).toThrow();
		expect(() => store.sessionDir('')).toThrow();
		expect(() => defaultSessionsRoot('../vault')).toThrow();
	});

	it('壊れたJSONの内容をエラーメッセージに含めない', async () => {
		await store.createSession(session());
		await fs.writeFile(join(store.sessionDir('s-1'), 'session.json'), '{"secret transcript');
		const error = await store.loadSession('s-1').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SessionDataError);
		expect((error as Error).message).not.toContain('secret');
	});

	it('形式が合わないsession.jsonを拒否する', async () => {
		await store.createSession(session());
		const path = join(store.sessionDir('s-1'), 'session.json');
		const cases: unknown[] = [
			{ ...session(), state: 'paused' },
			{ ...session(), schemaVersion: 2 },
			{ ...session(), startedAt: 'yesterday' },
			{ ...session(), sessionId: 's-2' },
			{ ...session(), settings: { schemaVersion: 99 } },
			[],
		];
		for (const value of cases) {
			await fs.writeFile(path, JSON.stringify(value));
			await expect(store.loadSession('s-1')).rejects.toBeInstanceOf(SessionDataError);
		}
	});
});

describe('chunks.jsonl・transcript.jsonl', () => {
	beforeEach(async () => {
		await store.createSession(session());
	});

	it('ファイルがなければ空として扱う', async () => {
		expect(await store.loadChunks('s-1')).toEqual([]);
		expect(await store.loadSegments('s-1')).toEqual([]);
	});

	it('同じチャンクは最新の状態を返し、最初に現れた順を保つ', async () => {
		await store.appendChunk('s-1', chunk());
		await store.appendChunk('s-1', chunk({ track: 'other' }));
		await store.appendChunk('s-1', chunk({ state: 'done', attempts: 1 }));
		expect(await store.loadChunks('s-1')).toEqual([chunk({ state: 'done', attempts: 1 }), chunk({ track: 'other' })]);
	});

	it('区間を複数まとめて追記できる', async () => {
		await store.appendSegments('s-1', [segment(), segment({ segmentId: 'other-0-0', track: 'other', text: '' })]);
		expect(await store.loadSegments('s-1')).toHaveLength(2);
	});

	it('壊れた末尾行を捨て、ファイルを最後の完全な行まで切り詰める', async () => {
		await store.appendChunk('s-1', chunk());
		const path = join(store.sessionDir('s-1'), 'chunks.jsonl');
		await fs.appendFile(path, '{"track":"self","seq');
		expect(await store.loadChunks('s-1')).toEqual([chunk()]);
		expect(await fs.readFile(path, 'utf8')).toBe(`${JSON.stringify(chunk())}\n`);

		await store.appendChunk('s-1', chunk({ sequence: 1 }));
		expect(await store.loadChunks('s-1')).toEqual([chunk(), chunk({ sequence: 1 })]);
	});

	it('改行で終わらない末尾行は、JSONとして読めても書き込み途中として捨てる', async () => {
		await store.appendChunk('s-1', chunk());
		const path = join(store.sessionDir('s-1'), 'chunks.jsonl');
		await fs.appendFile(path, JSON.stringify(chunk({ sequence: 1 })));
		expect(await store.loadChunks('s-1')).toEqual([chunk()]);
	});

	it('途中の行が壊れていればエラーにし、ファイルを変更しない', async () => {
		const path = join(store.sessionDir('s-1'), 'transcript.jsonl');
		const content = `${JSON.stringify(segment())}\n{"secret\n${JSON.stringify(segment({ segmentId: 'x' }))}\n`;
		await fs.writeFile(path, content);
		const error = await store.loadSegments('s-1').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SessionDataError);
		expect((error as SessionDataError).file).toBe('transcript.jsonl 2行目');
		expect((error as Error).message).not.toContain('secret');
		expect(await fs.readFile(path, 'utf8')).toBe(content);
	});

	it('形式が合わない行を拒否する', async () => {
		const path = join(store.sessionDir('s-1'), 'chunks.jsonl');
		const invalid: unknown[] = [
			{ ...chunk(), track: 'both' },
			{ ...chunk(), sequence: -1 },
			{ ...chunk(), sequence: 1.5 },
			{ ...chunk(), path: '../../outside.wav' },
			{ ...chunk(), path: '/tmp/a.wav' },
			{ ...chunk(), state: 'processing' },
			{ ...chunk(), rmsDbfs: null },
		];
		for (const value of invalid) {
			await fs.writeFile(path, `${JSON.stringify(value)}\n`);
			await expect(store.loadChunks('s-1')).rejects.toBeInstanceOf(SessionDataError);
		}
		await fs.writeFile(join(store.sessionDir('s-1'), 'transcript.jsonl'), `${JSON.stringify({ ...segment(), startMs: 10, endMs: 5 })}\n`);
		await expect(store.loadSegments('s-1')).rejects.toBeInstanceOf(SessionDataError);
	});
});

describe('parseJsonLines', () => {
	it('最後の完全な行までのバイト数を返す', () => {
		const text = '{"a":1}\n{"a":2}\n{"a"';
		const result = parseJsonLines(Buffer.from(text), 'x.jsonl', (value) => value);
		expect(result.records).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.validBytes).toBe(16);
	});

	it('マルチバイト文字を含む行でもバイト数で切り詰め位置を返す', () => {
		const line = `${JSON.stringify({ text: '日本語' })}\n`;
		const result = parseJsonLines(Buffer.from(`${line}{"text":"日`), 'x.jsonl', (value) => value);
		expect(result.validBytes).toBe(Buffer.byteLength(line));
	});
});

describe('summary.json', () => {
	const run: SummaryRun = {
		runId: 'r-1',
		provider: 'ollama',
		model: 'gemma4:e4b',
		status: 'success',
		progress: { completed: 3, total: 3 },
		inputHash: 'sha256-abc',
		input: '- [00:00:01] **自分**: 架空の発言',
		settings: createDefaultSettings().summary,
		result: '## 要約\n架空の要約',
	};

	it('未実行ならundefinedを返す', async () => {
		await store.createSession(session());
		expect(await store.loadSummary('s-1')).toBeUndefined();
	});

	it('保存して読み戻せる', async () => {
		await store.createSession(session());
		await store.saveSummary('s-1', run);
		expect(await store.loadSummary('s-1')).toEqual(run);
		await store.saveSummary('s-1', { ...run, status: 'failed', result: undefined, reason: 'timeout' });
		expect(await store.loadSummary('s-1')).toEqual({ ...run, status: 'failed', result: undefined, reason: 'timeout' });
	});

	it('形式が合わない要約を拒否する', async () => {
		await store.createSession(session());
		await fs.writeFile(join(store.sessionDir('s-1'), 'summary.json'), JSON.stringify({ ...run, provider: 'gemini' }));
		await expect(store.loadSummary('s-1')).rejects.toBeInstanceOf(SessionDataError);
	});
});

describe('一覧・削除・空き容量', () => {
	it('作業領域がなければ空の一覧を返す', async () => {
		expect(await store.listSessions()).toEqual([]);
	});

	it('読めないセッションもエラーとして一覧に含める', async () => {
		await store.createSession(session());
		await store.createSession(session({ sessionId: 's-2' }));
		await fs.writeFile(join(store.sessionDir('s-2'), 'session.json'), '{');
		await fs.mkdir(join(root, 'sessions', 'not valid'));
		await fs.writeFile(join(root, 'sessions', 'file.txt'), '');

		const entries = await store.listSessions();
		const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
		expect(entries).toHaveLength(2);
		expect(byId.get('s-1')).toEqual({ sessionId: 's-1', session: session() });
		expect(byId.get('s-2')).toMatchObject({ sessionId: 's-2', error: expect.any(SessionDataError) as unknown });
	});

	it('session.jsonがない作業領域もエラーとして一覧に含める', async () => {
		await fs.mkdir(join(root, 'sessions', 's-3'), { recursive: true });
		expect(await store.listSessions()).toMatchObject([{ sessionId: 's-3', error: expect.any(SessionDataError) as unknown }]);
	});

	it('作業領域を削除する', async () => {
		await store.createSession(session());
		await store.appendChunk('s-1', chunk());
		await store.deleteSession('s-1');
		expect(await store.listSessions()).toEqual([]);
		await expect(store.deleteSession('s-1')).resolves.toBeUndefined();
	});

	it('空き容量を返す', async () => {
		const bytes = await getFreeDiskBytes(root);
		expect(Number.isFinite(bytes)).toBe(true);
		expect(bytes).toBeGreaterThan(0);
	});
});
