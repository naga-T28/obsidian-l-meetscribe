import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ChunkNotice,
	NoteOutput,
	Recorder,
	RecorderListener,
	RecordingHandle,
	Summarizer,
	SummaryOutcome,
	Transcriber,
	TranscriptionJob,
	TranscriptionListener,
	TranscriptionResult,
	TranscriptionStatus,
	WorkAudio,
} from '../../src/session/ports';
import type { SessionRecord, SessionState } from '../../src/session/records';
import type { SessionSnapshot } from '../../src/session/RecordingSession';
import { checkSupportedOs, SessionManager } from '../../src/session/SessionManager';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings, type LMeetscribeSettings } from '../../src/settings/settings';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeRecorder implements Recorder {
	listener: RecorderListener | undefined;
	startCalls = 0;
	stopCalls = 0;
	startGate: Deferred<void> | undefined;
	startError: Error | undefined;
	stopError: Error | undefined;

	async start(_session: SessionRecord, listener: RecorderListener): Promise<RecordingHandle> {
		this.startCalls += 1;
		this.listener = listener;
		await this.startGate?.promise;
		if (this.startError) {
			throw this.startError;
		}
		return {
			stop: async () => {
				this.stopCalls += 1;
				await Promise.resolve();
				if (this.stopError) {
					throw this.stopError;
				}
			},
		};
	}
}

class FakeJob implements TranscriptionJob {
	enqueued: ChunkNotice[] = [];
	finishCalls = 0;
	abortCalls = 0;

	constructor(
		readonly listener: TranscriptionListener,
		private readonly result: () => Promise<TranscriptionResult>,
	) {}

	enqueue(chunk: ChunkNotice): void {
		this.enqueued.push(chunk);
	}

	finish(): Promise<TranscriptionResult> {
		this.finishCalls += 1;
		return this.result();
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
		await Promise.resolve();
	}
}

class FakeTranscriber implements Transcriber {
	jobs: FakeJob[] = [];
	results: TranscriptionResult[] = [];

	begin(_session: SessionRecord, listener: TranscriptionListener): TranscriptionJob {
		const job = new FakeJob(listener, () => Promise.resolve(this.results.shift() ?? { complete: true }));
		this.jobs.push(job);
		return job;
	}

	get lastJob(): FakeJob {
		const job = this.jobs[this.jobs.length - 1];
		if (!job) {
			throw new Error('job not started');
		}
		return job;
	}
}

class FakeNotes implements NoteOutput {
	prepared: string[] = [];
	syncs: TranscriptionStatus[] = [];
	prepareError: Error | undefined;
	syncError: Error | undefined;
	notePaths: string[] = [];

	async prepare(session: SessionRecord): Promise<void> {
		this.prepared.push(session.sessionId);
		await Promise.resolve();
		if (this.prepareError !== undefined) {
			throw this.prepareError;
		}
	}

	summaryWrites = 0;
	summaryError: Error | undefined;

	async writeSummary(): Promise<void> {
		this.summaryWrites += 1;
		await Promise.resolve();
		if (this.summaryError !== undefined) {
			throw this.summaryError;
		}
	}

	async sync(session: SessionRecord, status: TranscriptionStatus): Promise<void> {
		this.syncs.push(status);
		this.notePaths.push(session.notePath);
		await Promise.resolve();
		if (this.syncError !== undefined) {
			throw this.syncError;
		}
	}
}

class FakeWorkAudio implements WorkAudio {
	cleanupError: Error | undefined;
	calls: string[] = [];

	async cleanup(): Promise<void> {
		this.calls.push('cleanup');
		await Promise.resolve();
		if (this.cleanupError !== undefined) {
			throw this.cleanupError;
		}
	}
}

class FakeSummarizer implements Summarizer {
	calls: { session: SessionRecord; settings: LMeetscribeSettings['summary'] }[] = [];
	outcome: SummaryOutcome | Error = { status: 'success' };

	async summarize(session: SessionRecord, settings: LMeetscribeSettings['summary']): Promise<SummaryOutcome> {
		this.calls.push({ session, settings });
		await Promise.resolve();
		if (this.outcome instanceof Error) {
			throw this.outcome;
		}
		return this.outcome;
	}
}

let dir: string;
let settings: LMeetscribeSettings;
let store: SessionStore;
let recorder: FakeRecorder;
let transcriber: FakeTranscriber;
let summarizer: FakeSummarizer;
let notes: FakeNotes;
let workAudio: FakeWorkAudio;
let manager: SessionManager;
let nextId: number;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-manager-'));
	const executable = join(dir, 'whisper-cli');
	await fs.writeFile(executable, '#!/bin/sh\n');
	await fs.chmod(executable, 0o755);
	settings = createDefaultSettings();
	settings.whisper.executablePath = executable;
	settings.whisper.modelDir = dir;
	settings.whisper.model = 'ggml-base.bin';
	// 開始前の確認はggml形式の先頭だけを読む。
	for (const model of ['ggml-base.bin', 'ggml-large-v3.bin']) {
		await fs.writeFile(join(dir, model), Buffer.from('lmgg'));
	}
	store = new SessionStore(join(dir, 'sessions'));
	recorder = new FakeRecorder();
	transcriber = new FakeTranscriber();
	summarizer = new FakeSummarizer();
	notes = new FakeNotes();
	workAudio = new FakeWorkAudio();
	nextId = 1;
	manager = createManager(store);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function createManager(persistence: Pick<SessionStore, 'createSession' | 'saveSession' | 'loadSession'>): SessionManager {
	return new SessionManager({
		store: persistence,
		recorder,
		transcriber,
		notes,
		workAudio,
		summarizer,
		getSettings: () => settings,
		createSessionId: () => `session-${nextId++}`,
		now: () => new Date('2026-10-28T10:00:00.000Z'),
	});
}

async function startOk(blockId = 'block-1'): Promise<string> {
	const result = await manager.start({ blockId, notePath: 'Meetings/定例.md' });
	if (!result.ok) {
		throw new Error(`start failed: ${result.reason}`);
	}
	return result.sessionId;
}

function recordStates(): SessionState[] {
	const states: SessionState[] = [];
	manager.subscribe((snapshot) => {
		if (snapshot && states[states.length - 1] !== snapshot.state) {
			states.push(snapshot.state);
		}
	});
	return states;
}

describe('開始', () => {
	it('preparingからrecordingへ進み、作業領域に保存する', async () => {
		const states = recordStates();
		const sessionId = await startOk();
		expect(states).toEqual(['preparing', 'recording']);
		expect(manager.current).toMatchObject({ sessionId, blockId: 'block-1', state: 'recording' });
		expect((await store.loadSession(sessionId)).state).toBe('recording');
		expect(recorder.startCalls).toBe(1);
	});

	it('必須設定が不足していれば、セッションを作らずに理由を返す', async () => {
		settings.whisper.model = '';
		settings.whisper.executablePath = join(dir, 'missing');
		const result = await manager.start({ blockId: 'block-1', notePath: 'a.md' });
		expect(result).toMatchObject({ ok: false, reason: 'invalidSettings' });
		expect(result.ok ? [] : 'problems' in result ? result.problems : []).toHaveLength(2);
		expect(manager.current).toBeUndefined();
		expect(recorder.startCalls).toBe(0);
	});

	it('録音開始の失敗はerrorにし、原因を記録する', async () => {
		recorder.startError = new Error('マイクの使用が許可されていません。');
		const sessionId = await startOk();
		expect(manager.current).toMatchObject({ state: 'error', failure: { stage: 'start', message: 'マイクの使用が許可されていません。' } });
		expect((await store.loadSession(sessionId)).failure?.stage).toBe('start');
		expect(transcriber.lastJob.abortCalls).toBe(1);
	});

	it('開始待ちの間に録音障害が起きたら、取得した録音を止めてerrorにする', async () => {
		recorder.startGate = deferred<void>();
		const starting = manager.start({ blockId: 'block-1', notePath: 'a.md' });
		await waitFor(() => recorder.listener !== undefined);
		recorder.listener?.failed(new Error('ヘルパーが終了しました。'));
		recorder.startGate.resolve();
		await starting;
		expect(manager.current).toMatchObject({ state: 'error', failure: { stage: 'start' } });
		expect(recorder.stopCalls).toBe(1);
	});
});

describe('排他', () => {
	it('処理中は別の開始を拒否し、処理中の会議を返す', async () => {
		await startOk('block-1');
		const result = await manager.start({ blockId: 'block-2', notePath: 'b.md' });
		expect(result).toMatchObject({ ok: false, reason: 'busy', active: { blockId: 'block-1', state: 'recording' } });
		expect(recorder.startCalls).toBe(1);
	});

	it('同時に呼ばれた開始のうち1件だけを受け付ける', async () => {
		const results = await Promise.all([
			manager.start({ blockId: 'block-1', notePath: 'a.md' }),
			manager.start({ blockId: 'block-2', notePath: 'b.md' }),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results[1]).toMatchObject({ ok: false, reason: 'busy' });
		expect(recorder.startCalls).toBe(1);
	});

	it('errorの間は開始を拒否し、解放すると開始できる', async () => {
		transcriber.results = [{ complete: false, reason: '失敗したチャンクが1件あります。' }];
		await startOk('block-1');
		await manager.stop();
		expect(manager.current?.state).toBe('error');
		expect(await manager.start({ blockId: 'block-2', notePath: 'b.md' })).toMatchObject({ ok: false, reason: 'busy' });

		manager.release();
		expect(manager.current).toBeUndefined();
		expect((await manager.start({ blockId: 'block-2', notePath: 'b.md' })).ok).toBe(true);
	});

	it('完了後は次の開始を受け付ける', async () => {
		await startOk('block-1');
		await manager.stop();
		expect(manager.current?.state).toBe('completed');
		expect((await manager.start({ blockId: 'block-2', notePath: 'b.md' })).ok).toBe(true);
		expect(manager.current?.blockId).toBe('block-2');
	});

	it('error以外のセッションは解放しない', async () => {
		await startOk();
		manager.release();
		expect(manager.current?.state).toBe('recording');
	});
});

describe('停止', () => {
	it('連打しても停止処理を1回だけ行う', async () => {
		const states = recordStates();
		await startOk();
		await Promise.all([manager.stop(), manager.stop(), manager.stop()]);
		await manager.stop();
		expect(recorder.stopCalls).toBe(1);
		expect(transcriber.lastJob.finishCalls).toBe(1);
		expect(summarizer.calls).toHaveLength(1);
		expect(states).toEqual(['preparing', 'recording', 'draining', 'summarizing', 'completed']);
	});

	it('録音停止の通知を待ってから文字起こしの完了を待つ', async () => {
		await startOk();
		const order: string[] = [];
		const job = transcriber.lastJob;
		const originalFinish = job.finish.bind(job);
		job.finish = () => {
			order.push(`finish:${recorder.stopCalls}`);
			return originalFinish();
		};
		await manager.stop();
		expect(order).toEqual(['finish:1']);
	});

	it('録音中に届いたチャンクを文字起こしへ渡す', async () => {
		await startOk();
		const chunk: ChunkNotice = { track: 'self', sequence: 0, startMs: 0, durationMs: 10000, path: 'chunks/self-0.wav', rmsDbfs: -30 };
		recorder.listener?.chunkReady(chunk);
		expect(transcriber.lastJob.enqueued).toEqual([chunk]);
	});

	it('録音停止に失敗しても、受け取った分で会議を完了し、異常を会議ブロック用に残す', async () => {
		await startOk();
		recorder.stopError = new Error('停止通知を受け取れませんでした。');
		await manager.stop();
		expect(manager.current?.state).toBe('completed');
		expect(manager.current?.exclusions).toEqual(['録音の停止時に異常がありました（停止通知を受け取れませんでした。）。通知を受け取れなかったチャンクは除外しました']);
		expect(summarizer.calls).toHaveLength(1);
	});

	it('文字起こしに失敗したチャンクを除外して完了し、件数を会議ブロック用に残す', async () => {
		transcriber.results = [{ complete: true, failedChunks: 2 }];
		await startOk();
		await manager.stop();
		expect(manager.current?.state).toBe('completed');
		expect(notes.syncs).toEqual(['complete']);
		expect(manager.current?.exclusions).toEqual(['2件のチャンク（約20秒）は文字起こしに失敗したため除外しました']);
		expect(workAudio.calls).toEqual(['cleanup']);
	});

	it('preparingやcompletedでの停止要求は無視する', async () => {
		recorder.startGate = deferred<void>();
		const starting = manager.start({ blockId: 'block-1', notePath: 'a.md' });
		await waitFor(() => manager.current?.state === 'preparing');
		await manager.stop();
		expect(manager.current?.state).toBe('preparing');
		recorder.startGate.resolve();
		await starting;
		await manager.stop();
		await manager.stop();
		expect(manager.current?.state).toBe('completed');
		expect(recorder.stopCalls).toBe(1);
	});
});

describe('設定スナップショット', () => {
	it('開始後の設定変更を実行中のセッションに反映しない', async () => {
		const sessionId = await startOk();
		settings.whisper.model = 'ggml-large-v3.bin';
		settings.summary.autoSummarize = false;
		settings.summary.openai.model = 'changed-model';

		const saved = await store.loadSession(sessionId);
		expect(saved.settings.whisper.model).toBe('ggml-base.bin');

		await manager.stop();
		// 開始時は自動要約ONだったため、変更後のOFFは適用されない。
		expect(summarizer.calls).toHaveLength(1);
		expect(summarizer.calls[0]?.settings.openai.model).toBe('');
		expect(summarizer.calls[0]?.session.settings.whisper.model).toBe('ggml-base.bin');
	});

	it('ブロックで選んだデバイスをスナップショットに固定する', async () => {
		const result = await manager.start({
			blockId: 'block-1',
			notePath: 'a.md',
			devices: { microphoneDeviceUid: 'usb-mic', outputDeviceUid: 'headphones' },
		});
		if (!result.ok) {
			throw new Error('start failed');
		}

		const saved = await store.loadSession(result.sessionId);
		expect(saved.settings.recording).toMatchObject({ microphoneDeviceUid: 'usb-mic', outputDeviceUid: 'headphones' });
		expect(settings.recording.microphoneDeviceUid).toBe('');
	});

	it('変更した設定は次のセッションから適用する', async () => {
		await startOk('block-1');
		settings.whisper.model = 'ggml-large-v3.bin';
		await manager.stop();
		const next = await startOk('block-2');
		expect((await store.loadSession(next)).settings.whisper.model).toBe('ggml-large-v3.bin');
	});
});

describe('文字起こしと要約', () => {
	it('文字起こしの進捗を主状態とは別に通知する', async () => {
		const snapshots: SessionSnapshot[] = [];
		manager.subscribe((snapshot) => snapshot && snapshots.push(snapshot));
		await startOk();
		transcriber.lastJob.listener.progress({ queued: 2, processed: 3, failed: 0 });
		expect(manager.current).toMatchObject({ state: 'recording', transcription: { queued: 2, processed: 3, failed: 0 } });
		expect(snapshots[snapshots.length - 1]?.transcription.queued).toBe(2);
	});

	it('自動要約がOFFなら要約せずに完了し、理由を残す', async () => {
		settings.summary.autoSummarize = false;
		const states = recordStates();
		await startOk();
		await manager.stop();
		expect(states).toEqual(['preparing', 'recording', 'draining', 'completed']);
		expect(manager.current?.summary).toMatchObject({ status: 'skipped' });
		expect(summarizer.calls).toHaveLength(0);
	});

	it.each<[string, SummaryOutcome | Error, string]>([
		['skipped', { status: 'skipped', reason: 'APIキーが未設定です。' }, 'skipped'],
		['failed', { status: 'failed', reason: '429' }, 'failed'],
		['例外', new Error('通信が切断されました。'), 'failed'],
	])('要約の%sを文字起こしの失敗として扱わない', async (_label, outcome, status) => {
		summarizer.outcome = outcome;
		await startOk();
		await manager.stop();
		expect(manager.current?.state).toBe('completed');
		expect(manager.current?.summary?.status).toBe(status);
		expect(manager.current?.failure).toBeUndefined();
	});

	it('未処理・失敗チャンクが残れば要約せずにerrorにする', async () => {
		transcriber.results = [{ complete: false, reason: '失敗したチャンクが1件あります。' }];
		await startOk();
		await manager.stop();
		expect(manager.current).toMatchObject({ state: 'error', failure: { stage: 'transcription', message: '失敗したチャンクが1件あります。' } });
		expect(summarizer.calls).toHaveLength(0);
	});

	it('errorから保存済みデータの処理を再開できる', async () => {
		transcriber.results = [{ complete: false, reason: '失敗' }, { complete: true }];
		const sessionId = await startOk();
		await manager.stop();
		await manager.retry();
		expect(manager.current?.state).toBe('completed');
		expect(manager.current?.failure).toBeUndefined();
		expect(transcriber.jobs).toHaveLength(2);
		expect(recorder.startCalls).toBe(1);
		expect((await store.loadSession(sessionId)).failure).toBeUndefined();
	});

	it('再試行の二重呼び出しで処理を重複させない', async () => {
		transcriber.results = [{ complete: false, reason: '失敗' }];
		await startOk();
		await manager.stop();
		await Promise.all([manager.retry(), manager.retry()]);
		expect(transcriber.jobs).toHaveLength(2);
	});

	it('完了済みセッションを実行時の要約設定で手動要約できる', async () => {
		settings.summary.autoSummarize = false;
		const sessionId = await startOk();
		await manager.stop();
		settings.summary.provider = 'ollama';
		const states = recordStates();
		expect(await manager.summarize(sessionId)).toEqual({ ok: true });
		expect(states).toEqual(['completed', 'summarizing', 'completed']);
		expect(summarizer.calls[0]?.settings.provider).toBe('ollama');
		expect(manager.current?.summary?.status).toBe('success');
	});

	it('作業領域から完了済みセッションを読み込んで手動要約できる', async () => {
		const sessionId = await startOk();
		await manager.stop();
		const restarted = createManager(store);
		expect(await restarted.summarize(sessionId)).toEqual({ ok: true });
		expect(summarizer.calls).toHaveLength(2);
	});

	it('未完了のセッションは手動要約せず、排他も占有しない', async () => {
		const sessionId = await startOk();
		const restarted = createManager(store);
		expect(await restarted.summarize(sessionId)).toEqual({ ok: false, reason: 'notCompleted' });
		expect(restarted.current).toBeUndefined();
	});

	it('処理中は手動要約を拒否する', async () => {
		const sessionId = await startOk();
		expect(await manager.summarize(sessionId)).toMatchObject({ ok: false, reason: 'busy' });
	});
});

describe('障害', () => {
	it('録音障害でerrorにし、録音とWhisperを止める', async () => {
		await startOk();
		recorder.listener?.failed(new Error('入力デバイスが切断されました。'));
		await waitFor(() => manager.current?.state === 'error');
		expect(manager.current?.failure).toEqual({ stage: 'recording', message: '入力デバイスが切断されました。' });
		await waitFor(() => recorder.stopCalls === 1 && transcriber.lastJob.abortCalls === 1);
	});

	it('エラーのcodeを失敗の記録に残す', async () => {
		const sessionId = await startOk();
		recorder.listener?.failed(Object.assign(new Error('gone'), { code: 'deviceDisconnected' }));
		await waitFor(() => manager.current?.state === 'error');

		expect(manager.current?.failure).toEqual({ stage: 'recording', message: 'gone', code: 'deviceDisconnected' });
		await vi.waitFor(async () => expect((await store.loadSession(sessionId)).failure?.code).toBe('deviceDisconnected'));
	});

	it('相手トラックで無音が続いた時間を数え、音が入ったら数え直す', async () => {
		await startOk();
		const chunk = (track: 'self' | 'other', sequence: number, rmsDbfs: number): ChunkNotice => ({
			track,
			sequence,
			startMs: sequence * 10000,
			durationMs: 10000,
			path: `chunks/${track}-${String(sequence).padStart(6, '0')}.wav`,
			rmsDbfs,
		});
		for (let sequence = 0; sequence < 6; sequence++) {
			recorder.listener?.chunkReady(chunk('other', sequence, -90));
			recorder.listener?.chunkReady(chunk('self', sequence, -20));
		}
		expect(manager.current?.otherSilentMs).toBe(60000);

		recorder.listener?.chunkReady(chunk('other', 6, -30));
		expect(manager.current?.otherSilentMs).toBe(0);
	});

	it('文字起こしの記録の障害でerrorにし、録音を止める', async () => {
		await startOk();
		transcriber.lastJob.listener.failed(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
		await waitFor(() => manager.current?.state === 'error');
		expect(manager.current?.failure).toEqual({ stage: 'storage', message: 'no space', code: 'ENOSPC' });
		await waitFor(() => recorder.stopCalls === 1);
	});

	it('空き容量の不足で録音を止め、確定済みのチャンクの文字起こしを続ける', async () => {
		await startOk();
		transcriber.lastJob.listener.lowDiskSpace();
		expect(manager.current?.diskSpaceLow).toBe(true);
		await waitFor(() => manager.current?.state === 'completed');
		expect(recorder.stopCalls).toBe(1);
		expect(transcriber.lastJob.finishCalls).toBe(1);
	});

	it('状態の保存に失敗したらerrorにし、録音を止める', async () => {
		let failSaves = false;
		manager = createManager({
			createSession: (record) => store.createSession(record),
			loadSession: (id) => store.loadSession(id),
			saveSession: (record) => (failSaves ? Promise.reject(new Error('ディスクに書き込めません。')) : store.saveSession(record)),
		});
		await startOk();
		failSaves = true;
		await manager.stop();
		expect(manager.current).toMatchObject({ state: 'error', failure: { stage: 'storage', message: 'ディスクに書き込めません。' } });
		expect(recorder.stopCalls).toBe(1);
	});
});

describe('ノートへの反映', () => {
	it('録音を始める前に出力領域を用意する', async () => {
		await startOk();
		expect(notes.prepared).toEqual(['session-1']);
		expect(recorder.startCalls).toBe(1);
	});

	it('出力領域を用意できなければ録音せずにerrorにする', async () => {
		notes.prepareError = Object.assign(new Error('ブロックがありません。'), { code: 'blockMissing' });
		await startOk();
		expect(manager.current?.failure).toEqual({ stage: 'note', message: 'ブロックがありません。', code: 'blockMissing' });
		expect(recorder.startCalls).toBe(0);
	});

	it('処理済みのチャンクが増えたら録音中に反映する', async () => {
		await startOk();
		const { listener } = transcriber.lastJob;
		listener.progress({ queued: 1, processed: 0, failed: 0 });
		listener.progress({ queued: 0, processed: 1, failed: 0 });
		await waitFor(() => notes.syncs.length === 1);
		expect(notes.syncs).toEqual(['running']);
	});

	it('録音中の反映の失敗では録音を止めず、警告を出す', async () => {
		await startOk();
		notes.syncError = new Error('境界がありません。');
		transcriber.lastJob.listener.progress({ queued: 0, processed: 1, failed: 0 });
		await waitFor(() => manager.current?.noteProblem !== undefined);
		expect(manager.current?.state).toBe('recording');
	});

	it('停止後に処理結果を反映してから完了する', async () => {
		settings.summary.autoSummarize = false;
		await startOk();
		await manager.stop();
		expect(notes.syncs).toEqual(['complete']);
		expect(manager.current?.state).toBe('completed');
	});

	it('文字起こしが未完了でも確定分を反映し、errorにする', async () => {
		transcriber.results = [{ complete: false, reason: '失敗したチャンクが1件あります。' }];
		await startOk();
		await manager.stop();
		expect(notes.syncs).toEqual(['incomplete']);
		expect(manager.current?.failure?.stage).toBe('transcription');
	});

	it('停止後の反映に失敗したらnote段階のerrorにし、再試行で反映し直す', async () => {
		settings.summary.autoSummarize = false;
		await startOk();
		notes.syncError = Object.assign(new Error('境界がありません。'), { code: 'boundaryBroken' });
		await manager.stop();
		expect(manager.current?.failure).toEqual({ stage: 'note', message: '境界がありません。', code: 'boundaryBroken' });

		notes.syncError = undefined;
		await manager.retry();
		expect(manager.current?.state).toBe('completed');
		expect(notes.syncs).toEqual(['complete', 'complete']);
	});

	it('ノートとフォルダの改名に追従する', async () => {
		settings.summary.autoSummarize = false;
		const sessionId = await startOk();
		await manager.noteRenamed('Meetings/定例.md', 'Meetings/週次定例.md');
		expect(manager.current?.notePath).toBe('Meetings/週次定例.md');
		await manager.noteRenamed('Meetings', 'Archive/Meetings');
		expect(manager.current?.notePath).toBe('Archive/Meetings/週次定例.md');
		await manager.noteRenamed('Other.md', 'Moved.md');
		expect((await store.loadSession(sessionId)).notePath).toBe('Archive/Meetings/週次定例.md');

		await manager.stop();
		expect(notes.notePaths).toEqual(['Archive/Meetings/週次定例.md']);
	});
});

describe('作業音声の削除', () => {
	it('文字起こしの全文をノートへ反映してから作業音声を削除する', async () => {
		await startOk();
		await manager.stop();
		expect(notes.syncs).toEqual(['complete']);
		expect(workAudio.calls).toEqual(['cleanup']);
		expect(manager.current?.state).toBe('completed');
	});

	it('文字起こしが未完了なら作業音声を削除しない', async () => {
		transcriber.results = [{ complete: false, reason: '失敗したチャンクが1件あります。' }];
		await startOk();
		await manager.stop();
		expect(notes.syncs).toEqual(['incomplete']);
		expect(workAudio.calls).toEqual([]);
	});

	it('ノートへの反映に失敗したら作業音声を削除しない', async () => {
		notes.syncError = new Error('境界がありません。');
		await startOk();
		await manager.stop();
		expect(workAudio.calls).toEqual([]);
	});

	it('要約の失敗は作業音声の削除を妨げない', async () => {
		summarizer.outcome = new Error('APIエラー');
		await startOk();
		await manager.stop();
		expect(workAudio.calls).toEqual(['cleanup']);
		expect(manager.current?.summary?.status).toBe('failed');
	});

	it('作業音声の削除に失敗したらstorage段階のerrorにする', async () => {
		workAudio.cleanupError = new Error('削除できません。');
		await startOk();
		await manager.stop();
		expect(manager.current?.failure?.stage).toBe('storage');
	});
});

describe('中断したセッションの復旧', () => {
	async function interrupted(state: SessionState, id = 'old-1'): Promise<void> {
		await store.createSession({
			schemaVersion: 1,
			sessionId: id,
			blockId: 'block-1',
			notePath: 'Meetings/定例.md',
			startedAt: '2026-10-27T10:00:00.000Z',
			state,
			settings: structuredClone(settings),
		});
	}

	it('録音中に中断したセッションを、録音を再開せずに処理し直して完了する', async () => {
		settings.summary.autoSummarize = false;
		await interrupted('recording');
		await expect(manager.recover('old-1')).resolves.toEqual({ ok: true });
		expect(recorder.startCalls).toBe(0);
		expect(notes.prepared).toEqual(['old-1']);
		expect(transcriber.lastJob.finishCalls).toBe(1);
		expect(workAudio.calls).toEqual(['cleanup']);
		expect(manager.current).toMatchObject({ sessionId: 'old-1', state: 'completed' });
		expect((await store.loadSession('old-1')).state).toBe('completed');
	});

	it('排他の内側で書き出し先を変えられる', async () => {
		settings.summary.autoSummarize = false;
		await interrupted('draining');
		await manager.recover('old-1', (record) => {
			record.notePath = '会議の書き出し.md';
			return Promise.resolve();
		});
		expect(notes.notePaths).toEqual(['会議の書き出し.md']);
	});

	it('要約中に中断したセッションは要約の失敗として完了にする', async () => {
		await interrupted('summarizing');
		await manager.recover('old-1');
		expect(manager.current).toMatchObject({ state: 'completed', summary: { status: 'failed' } });
		expect(transcriber.jobs).toHaveLength(0);
	});

	it('処理中は復旧を拒否し、完了済みは対象外にする', async () => {
		await interrupted('recording');
		await interrupted('completed', 'done-1');
		await startOk();
		expect(await manager.recover('old-1')).toMatchObject({ ok: false, reason: 'busy' });
		expect(manager.isActive('session-1')).toBe(true);
		await manager.stop();
		expect(await manager.recover('done-1')).toEqual({ ok: false, reason: 'notRecoverable' });
		expect(manager.isActive('done-1')).toBe(false);
	});

	it('復旧中は別の開始を拒否する', async () => {
		await interrupted('recording');
		transcriber.results = [{ complete: false, reason: '失敗' }];
		await manager.recover('old-1');
		expect(manager.current?.state).toBe('error');
		expect(await manager.start({ blockId: 'block-2', notePath: 'b.md' })).toMatchObject({ ok: false, reason: 'busy' });
	});
});

describe('要約のノート出力', () => {
	it('要約に成功したらノートへ出力して完了する', async () => {
		await startOk();
		await manager.stop();
		expect(notes.summaryWrites).toBe(1);
		expect(manager.current).toMatchObject({ state: 'completed', summary: { status: 'success' } });
	});

	it('ノートへの出力に失敗しても文字起こしは完了として扱う', async () => {
		notes.summaryError = new Error('境界がありません。');
		await startOk();
		await manager.stop();
		expect(manager.current).toMatchObject({ state: 'completed', summary: { status: 'failed', reason: '要約をノートへ出力できません: 境界がありません。' } });
		expect(manager.current?.failure).toBeUndefined();
	});

	it('要約を省略した場合はノートへ出力しない', async () => {
		summarizer.outcome = { status: 'skipped', reason: 'APIキーが未設定です。' };
		await startOk();
		await manager.stop();
		expect(notes.summaryWrites).toBe(0);
		expect(manager.current).toMatchObject({ state: 'completed', summary: { status: 'skipped', reason: 'APIキーが未設定です。' } });
	});

	it('設定後に手動で要約し、ノートへ出力できる', async () => {
		summarizer.outcome = { status: 'skipped', reason: 'APIキーが未設定です。' };
		const sessionId = await startOk();
		await manager.stop();
		summarizer.outcome = { status: 'success' };
		await expect(manager.summarize(sessionId)).resolves.toEqual({ ok: true });
		expect(notes.summaryWrites).toBe(1);
		expect(manager.current?.summary?.status).toBe('success');
	});
});

describe('購読と終了処理', () => {
	it('登録時に現在の状態を通知し、解除後は通知しない', async () => {
		const received: (SessionSnapshot | undefined)[] = [];
		const unsubscribe = manager.subscribe((snapshot) => received.push(snapshot));
		expect(received).toEqual([undefined]);
		await startOk();
		const count = received.length;
		unsubscribe();
		await manager.stop();
		expect(received).toHaveLength(count);
		expect(manager.current?.state).toBe('completed');
	});

	it('購読側でスナップショットを書き換えても本体に影響しない', async () => {
		await startOk();
		const snapshot = manager.current;
		if (snapshot) {
			snapshot.state = 'completed';
			snapshot.transcription.queued = 99;
		}
		expect(manager.current).toMatchObject({ state: 'recording', transcription: { queued: 0 } });
	});

	it('終了処理で録音とWhisperを止め、未完了の状態を作業領域に残す', async () => {
		const sessionId = await startOk();
		await manager.shutdown();
		expect(recorder.stopCalls).toBe(1);
		expect(transcriber.lastJob.abortCalls).toBe(1);
		expect((await store.loadSession(sessionId)).state).toBe('recording');
	});

	it('開始待ちの間に終了したら、取得した録音を止める', async () => {
		recorder.startGate = deferred<void>();
		const starting = manager.start({ blockId: 'block-1', notePath: 'a.md' });
		await waitFor(() => recorder.listener !== undefined);
		await manager.shutdown();
		recorder.startGate.resolve();
		const result = await starting;
		expect(result.ok).toBe(true);
		expect(recorder.stopCalls).toBe(1);
		expect((await store.loadSession('session-1')).state).toBe('preparing');
	});
});

async function waitFor(condition: () => boolean): Promise<void> {
	await vi.waitFor(() => {
		if (!condition()) {
			throw new Error('condition not met');
		}
	});
}

describe('checkSupportedOs', () => {
	it.each([
		['darwin', '23.2.0', true],
		['darwin', '25.6.0', true],
		['darwin', '23.1.0', false],
		['darwin', '22.6.0', false],
		['darwin', 'unknown', false],
		['linux', '6.1.0', false],
	])('%s %sの対応可否を判定する', (platform, release, supported) => {
		expect(checkSupportedOs(platform, release) === undefined).toBe(supported);
	});
});
