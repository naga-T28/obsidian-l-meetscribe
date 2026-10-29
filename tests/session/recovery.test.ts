import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyReconciliation, findRecoveryCandidates, type FoundChunk, reconcileChunks, scanChunkFiles } from '../../src/session/recovery';
import { type ChunkRecord, type ChunkState, SESSION_SCHEMA_VERSION, type SessionRecord, type SessionState, type Track } from '../../src/session/records';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings } from '../../src/settings/settings';

const S = 'session-1';
const THRESHOLD = -70;

function path(track: Track, sequence: number): string {
	return `chunks/${track}-${String(sequence).padStart(6, '0')}.wav`;
}

/** ヘルパーが書くメタ情報と同じ形。 */
function meta(track: Track, sequence: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { sessionId: S, track, sequence, startMs: sequence * 10_000, durationMs: 10_000, path: path(track, sequence), rmsDbfs: -30, ...overrides };
}

function record(track: Track, sequence: number, state: ChunkState): ChunkRecord {
	return { track, sequence, startMs: sequence * 10_000, durationMs: 10_000, path: path(track, sequence), rmsDbfs: -30, state, attempts: state === 'pending' ? 0 : 1 };
}

describe('reconcileChunks', () => {
	it('キューにないWAVをメタ情報から処理待ちとして補う', () => {
		const found: FoundChunk[] = [
			{ path: path('self', 0), meta: meta('self', 0) },
			{ path: path('self', 1), meta: meta('self', 1) },
			{ path: path('other', 1), meta: meta('other', 1, { rmsDbfs: -90 }) },
		];
		const result = reconcileChunks(S, [record('self', 0, 'done')], found, THRESHOLD);
		expect(result.added).toEqual([
			{ ...record('self', 1, 'pending') },
			{ ...record('other', 1, 'silent'), rmsDbfs: -90, attempts: 0 },
		]);
		expect(result.unknownTime).toEqual([]);
		expect(result.missingFiles).toEqual([]);
	});

	it('メタ情報が欠けた・壊れた・一致しないWAVは時刻不明として補わない', () => {
		const found: FoundChunk[] = [
			{ path: path('self', 0), meta: undefined },
			{ path: path('self', 1), meta: meta('self', 1, { startMs: 'x' }) },
			{ path: path('self', 2), meta: meta('self', 2, { sessionId: 'other-session' }) },
			{ path: path('self', 3), meta: meta('self', 4) },
			{ path: path('other', 5), meta: meta('other', 5, { path: '../escape.wav' }) },
		];
		const result = reconcileChunks(S, [], found, THRESHOLD);
		expect(result.added).toEqual([]);
		expect(result.unknownTime).toEqual(found.map((chunk) => chunk.path));
	});

	it('未処理・失敗なのにWAVがないチャンクを不一致として返す', () => {
		const records = [record('self', 0, 'done'), record('self', 1, 'pending'), record('other', 1, 'failed'), record('other', 0, 'silent')];
		const result = reconcileChunks(S, records, [], THRESHOLD);
		expect(result.missingFiles).toEqual([path('self', 1), path('other', 1)]);
	});
});

let dir: string;
let store: SessionStore;

function session(state: SessionState, id = S): SessionRecord {
	return { schemaVersion: SESSION_SCHEMA_VERSION, sessionId: id, blockId: 'block-1', notePath: 'a.md', startedAt: '2026-10-29T00:00:00.000Z', state, settings: createDefaultSettings() };
}

async function writeChunkFile(name: string, content = 'wav'): Promise<void> {
	await fs.writeFile(join(store.sessionDir(S), 'chunks', name), content);
}

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-recovery-'));
	store = new SessionStore(join(dir, 'sessions'));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('scanChunkFiles', () => {
	it('確定名のWAVとメタ情報だけを読み、一時ファイルを含めない', async () => {
		await store.createSession(session('recording'));
		await fs.mkdir(join(store.sessionDir(S), 'chunks'));
		await writeChunkFile('self-000000.wav');
		await writeChunkFile('self-000000.json', JSON.stringify(meta('self', 0)));
		await writeChunkFile('other-000000.wav');
		await writeChunkFile('other-000000.json', '{broken');
		await writeChunkFile('.self-000001.wav.tmp');
		await writeChunkFile('notes.txt');

		expect(await scanChunkFiles(store.sessionDir(S))).toEqual([
			{ path: path('other', 0), meta: undefined },
			{ path: path('self', 0), meta: meta('self', 0) },
		]);
	});

	it('chunks/がなければundefinedを返す', async () => {
		await store.createSession(session('draining'));
		await expect(scanChunkFiles(store.sessionDir(S))).resolves.toBeUndefined();
	});
});

describe('findRecoveryCandidates と applyReconciliation', () => {
	it('completed以外と読めないセッションを返し、照合結果を添える', async () => {
		await store.createSession(session('recording'));
		await fs.mkdir(join(store.sessionDir(S), 'chunks'));
		await writeChunkFile('self-000000.wav');
		await writeChunkFile('self-000000.json', JSON.stringify(meta('self', 0)));
		await store.createSession(session('completed', 'done-1'));
		await store.createSession(session('draining', 'cleaned-1'));
		await fs.mkdir(join(dir, 'sessions', 'broken-1'));
		await fs.writeFile(join(dir, 'sessions', 'broken-1', 'session.json'), '{');

		const candidates = await findRecoveryCandidates(store);
		const byId = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]));
		expect([...byId.keys()].sort()).toEqual(['broken-1', 'cleaned-1', S]);
		expect(byId.get(S)?.reconciliation?.added).toHaveLength(1);
		expect(byId.get(S)?.workAudioDeleted).toBe(false);
		expect(byId.get('cleaned-1')?.workAudioDeleted).toBe(true);
		expect(byId.get('broken-1')?.error).toContain('session.json');
		// 一覧の取得ではキューを変更しない。
		expect(await store.loadChunks(S)).toEqual([]);
	});

	it('補ったチャンクをキューへ記録し、2回目は何も補わない', async () => {
		const target = session('recording');
		await store.createSession(target);
		await fs.mkdir(join(store.sessionDir(S), 'chunks'));
		await writeChunkFile('self-000000.wav');
		await writeChunkFile('self-000000.json', JSON.stringify(meta('self', 0)));

		expect((await applyReconciliation(store, target)).added).toHaveLength(1);
		expect(await store.loadChunks(S)).toEqual([record('self', 0, 'pending')]);
		expect((await applyReconciliation(store, target)).added).toHaveLength(0);
		expect(await store.loadChunks(S)).toHaveLength(1);
	});
});
