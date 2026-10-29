import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEdits, NoteWriteError, type TextEdit } from '../../src/note/meetingBlock';
import { type NoteAccess, NoteWriter } from '../../src/note/NoteWriter';
import { type ChunkRecord, SESSION_SCHEMA_VERSION, type SessionRecord, type Track } from '../../src/session/records';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings } from '../../src/settings/settings';

const S = 'session-1';
const PATH = 'Meetings/定例.md';

/** パスごとの本文を持つ偽のノート。saveDropsはディスクへの保存が反映されない状況を表す。 */
class FakeNotes implements NoteAccess {
	files = new Map<string, string>();
	edits = 0;
	saveDrops = false;

	read(path: string): Promise<string> {
		const text = this.files.get(path);
		if (text === undefined) {
			return Promise.reject(new NoteWriteError('noteMissing', 'missing'));
		}
		return Promise.resolve(text);
	}

	async edit(path: string, compute: (text: string) => TextEdit[]): Promise<string> {
		const text = await this.read(path);
		const next = applyEdits(text, compute(text));
		this.edits += 1;
		if (!this.saveDrops) {
			this.files.set(path, next);
		}
		return this.read(path);
	}

	get note(): string {
		return this.files.get(PATH) ?? '';
	}
}

let dir: string;
let store: SessionStore;
let access: FakeNotes;
let writer: NoteWriter;
let session: SessionRecord;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-note-'));
	store = new SessionStore(join(dir, 'sessions'));
	const settings = createDefaultSettings();
	settings.whisper.model = 'ggml-base.bin';
	session = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: S,
		blockId: 'block-1',
		notePath: PATH,
		startedAt: '2026-10-29T01:00:00.000Z',
		state: 'recording',
		settings,
	};
	await store.createSession(session);
	access = new FakeNotes();
	access.files.set(PATH, ['# 定例', '', '```lms', 'id: block-1', '```', '', '議題メモ'].join('\n'));
	writer = new NoteWriter(access, store);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function addChunk(track: Track, sequence: number, text?: string): Promise<void> {
	const chunk: ChunkRecord = {
		track,
		sequence,
		startMs: sequence * 10_000,
		durationMs: 10_000,
		path: `chunks/${track}-${String(sequence).padStart(6, '0')}.wav`,
		rmsDbfs: -30,
		state: text === undefined ? 'silent' : 'done',
		attempts: 1,
	};
	await store.appendChunk(S, chunk);
	if (text !== undefined) {
		await store.appendSegments(S, [{ segmentId: `${track}-${sequence}-0`, track, sequence, index: 0, startMs: chunk.startMs + 1000, endMs: chunk.startMs + 2000, text }]);
	}
}

function transcriptLines(): string[] {
	return access.note.split('\n').filter((line) => line.startsWith('- ['));
}

describe('NoteWriter', () => {
	it('確定した時間窓の区間を追記し、反映済みを記録する', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		await addChunk('self', 1, '未確定の発言');
		await writer.sync(session, 'running');

		expect(transcriptLines()).toEqual(['- [00:00:01] **自分**: では始めます。']);
		expect(access.note).not.toMatch(/<!-- lms:(self|other)-/);
		expect(await store.loadNoteProgress(S)).toEqual({ reflectedWindows: 1 });
		expect(access.note).toContain('議題メモ');
	});

	it('停止後は端数の時間窓も反映する', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0, '了解です。');
		await addChunk('self', 1, '最後の発言');
		await writer.sync(session, 'complete');

		expect(transcriptLines()).toHaveLength(3);
		expect(await store.loadNoteProgress(S)).toEqual({ reflectedWindows: 2 });
	});

	it('再起動後に同じ区間を二重に追記しない', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		await writer.sync(session, 'running');

		const restarted = new NoteWriter(access, store);
		await restarted.prepare(session);
		await restarted.sync(session, 'complete');
		expect(transcriptLines()).toHaveLength(1);
	});

	it('ノートへの保存後、反映済みの記録の前に止まっても二重に追記しない', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		await writer.sync(session, 'running');
		// note.jsonの更新前に異常終了した状態を作る。書く前の記録だけが残る。
		await store.saveNoteProgress(S, { reflectedWindows: 0, pendingAppend: { windows: 1, text: '- [00:00:01] **自分**: では始めます。\n' } });

		await new NoteWriter(access, store).sync(session, 'complete');
		expect(transcriptLines()).toHaveLength(1);
		expect(await store.loadNoteProgress(S)).toEqual({ reflectedWindows: 1 });
	});

	it('書く前の記録があってもノートに本文がなければ追記し直す', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		await store.saveNoteProgress(S, { reflectedWindows: 0, pendingAppend: { windows: 1, text: '- [00:00:01] **自分**: では始めます。\n' } });

		await writer.sync(session, 'running');
		expect(transcriptLines()).toEqual(['- [00:00:01] **自分**: では始めます。']);
		expect(await store.loadNoteProgress(S)).toEqual({ reflectedWindows: 1 });
	});

	it('利用者が削除した反映済みの行を戻さない', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, '削除される発言');
		await addChunk('other', 0);
		await writer.sync(session, 'running');
		access.files.set(PATH, access.note.replace(/- \[00:00:01\].*\n/, ''));

		await addChunk('self', 1, '次の発言');
		await addChunk('other', 1);
		await writer.sync(session, 'running');
		expect(transcriptLines()).toEqual(['- [00:00:11] **自分**: 次の発言']);
	});

	it('境界が欠けていれば書き込まず、反映済みにしない', async () => {
		await writer.prepare(session);
		access.files.set(PATH, access.note.replace(`<!-- lms:${S}:transcript:end -->`, ''));
		const before = access.note;
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);

		await expect(writer.sync(session, 'running')).rejects.toMatchObject({ code: 'boundaryBroken' });
		expect(access.note).toBe(before);
		expect((await store.loadNoteProgress(S)).reflectedWindows).toBe(0);
	});

	it('ディスクへの保存を確認できなければ反映済みにしない', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		access.saveDrops = true;

		await expect(writer.sync(session, 'running')).rejects.toMatchObject({ code: 'notSaved' });
		expect((await store.loadNoteProgress(S)).reflectedWindows).toBe(0);

		// 保存できるようになれば、再試行で1回だけ書く。
		access.saveDrops = false;
		await writer.sync(session, 'running');
		expect(transcriptLines()).toHaveLength(1);
		expect(await store.loadNoteProgress(S)).toEqual({ reflectedWindows: 1 });
	});

	it('ノートが見つからなければ止める', async () => {
		await writer.prepare(session);
		access.files.delete(PATH);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		await expect(writer.sync(session, 'running')).rejects.toMatchObject({ code: 'noteMissing' });
	});

	it('録音中に新しく確定した時間窓がなければノートに触れない', async () => {
		await writer.prepare(session);
		const edits = access.edits;
		await writer.sync(session, 'running');
		expect(access.edits).toBe(edits);
	});

	it('並行した書き込みを直列化する', async () => {
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0);
		await Promise.all([writer.prepare(session), writer.sync(session, 'running'), writer.sync(session, 'running')]);
		expect(transcriptLines()).toHaveLength(1);
	});

	it('メタ情報の領域を作らない', async () => {
		await writer.prepare(session);
		await writer.sync(session, 'complete');
		expect(access.note).not.toContain(':meta:');
		expect(access.note).not.toContain('処理結果');
	});

	describe('要約の出力', () => {
		const SUMMARY_A = '## 要約\n初回の要約\n## 決定事項\n- なし\n## タスク\n- [ ] 見積もりを送る\n## 未解決の論点\n- なし';
		const SUMMARY_B = SUMMARY_A.replace('初回の要約', '再生成した要約');

		async function saveRun(result: string): Promise<void> {
			await store.saveSummary(S, {
				runId: 'run',
				provider: 'openai',
				model: 'gpt-test',
				status: 'success',
				progress: { completed: 1, total: 1 },
				inputHash: 'sha256-x',
				input: 'x',
				settings: session.settings.summary,
				result,
			});
		}

		function summaryArea(): string {
			const start = access.note.indexOf(`<!-- lms:${S}:summary:start -->`);
			const end = access.note.indexOf(`<!-- lms:${S}:summary:end -->`);
			return access.note.slice(start, end);
		}

		it('文字起こし領域の直前に要約領域を作って出力する', async () => {
			await writer.prepare(session);
			await saveRun(SUMMARY_A);
			await writer.writeSummary(session);
			expect(access.note).toContain(`# 定例\n\n<!-- lms:${S}:summary:start -->\n${SUMMARY_A}\n<!-- lms:${S}:summary:end -->\n<!-- lms:${S}:transcript:start -->`);
			expect(access.note).toMatch(new RegExp(`<!-- lms:${S}:transcript:end -->\n\`\`\`lms\n`));
			expect(access.note.endsWith('議題メモ')).toBe(true);
			// 要約の入力には要約領域を含めない。
			await expect(writer.readTranscript(PATH, S)).resolves.not.toContain('初回の要約');
		});

		it('編集されていない要約は再生成で置き換える', async () => {
			await writer.prepare(session);
			await saveRun(SUMMARY_A);
			await writer.writeSummary(session);
			await saveRun(SUMMARY_B);
			await writer.writeSummary(session);
			expect(summaryArea()).toContain('再生成した要約');
			expect(summaryArea()).not.toContain('初回の要約');
		});

		it('編集やタスクのチェックがあれば置き換えず、新しい案を追記する', async () => {
			await writer.prepare(session);
			await saveRun(SUMMARY_A);
			await writer.writeSummary(session);
			access.files.set(PATH, access.note.replace('- [ ] 見積もりを送る', '- [x] 見積もりを送る').replace('初回の要約', '初回の要約（手で修正）'));
			await saveRun(SUMMARY_B);
			await writer.writeSummary(session);
			expect(summaryArea()).toContain('- [x] 見積もりを送る');
			expect(summaryArea()).toContain('初回の要約（手で修正）');
			expect(summaryArea()).toContain('**再生成した要約（');
			expect(summaryArea()).toContain('再生成した要約\n## 決定事項');

			// 追記後にもう一度再生成しても、編集した内容は残る。
			await writer.writeSummary(session);
			expect(summaryArea()).toContain('初回の要約（手で修正）');
			expect(summaryArea().match(/\*\*再生成した要約（/g)).toHaveLength(2);
		});

		it('文字起こしの反映で要約の記録を消さない', async () => {
			await writer.prepare(session);
			await saveRun(SUMMARY_A);
			await writer.writeSummary(session);
			await addChunk('self', 0, 'では始めます。');
			await addChunk('other', 0);
			await writer.sync(session, 'complete');
			expect((await store.loadNoteProgress(S)).summaryHash).toMatch(/^sha256-/);
		});

		it('成功した要約がなければ、または境界がなければ書かない', async () => {
			await writer.prepare(session);
			await expect(writer.writeSummary(session)).rejects.toThrow('保存済みの要約がありません。');
			await saveRun(SUMMARY_A);
			access.files.set(PATH, access.note.replace(`<!-- lms:${S}:transcript:end -->`, ''));
			await expect(writer.writeSummary(session)).rejects.toMatchObject({ code: 'boundaryBroken' });
		});
	});

	it('要約用の文字起こしを読み出す', async () => {
		await writer.prepare(session);
		await addChunk('self', 0, 'では始めます。');
		await addChunk('other', 0, '了解です。');
		await writer.sync(session, 'complete');
		await expect(writer.readTranscript(PATH, S)).resolves.toBe('- [00:00:01] **自分**: では始めます。\n- [00:00:01] **相手**: 了解です。');
	});
});
