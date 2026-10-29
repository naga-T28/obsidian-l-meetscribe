import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkAudioCleaner } from '../../src/audio/WorkAudioCleaner';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from '../../src/session/records';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings } from '../../src/settings/settings';

const S = 'session-1';

let dir: string;
let store: SessionStore;
let session: SessionRecord;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-work-audio-'));
	store = new SessionStore(join(dir, 'sessions'));
	session = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: S,
		blockId: 'block-1',
		notePath: 'a.md',
		startedAt: '2026-10-29T00:00:00.000Z',
		state: 'draining',
		settings: createDefaultSettings(),
	};
	await store.createSession(session);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('WorkAudioCleaner', () => {
	it('作業音声とWhisperの一時出力を削除し、記録は残す', async () => {
		await fs.mkdir(join(store.sessionDir(S), 'chunks'));
		await fs.writeFile(join(store.sessionDir(S), 'chunks', 'self-000000.wav'), 'x');
		await fs.mkdir(join(store.sessionDir(S), 'transcripts'));
		await new WorkAudioCleaner(store).cleanup(session);
		await expect(fs.readdir(store.sessionDir(S))).resolves.toEqual(['session.json']);
	});

	it('削除済みでも失敗しない', async () => {
		await new WorkAudioCleaner(store).cleanup(session);
		await expect(new WorkAudioCleaner(store).cleanup(session)).resolves.toBeUndefined();
	});
});
