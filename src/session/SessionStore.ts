import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
	type ChunkRecord,
	isValidStorageId,
	type NoteProgress,
	parseChunkRecord,
	parseNoteProgress,
	parseSegmentRecord,
	parseSessionRecord,
	parseSummaryRun,
	SessionDataError,
	type SessionRecord,
	type SegmentRecord,
	type SummaryRun,
} from './records';

const SESSION_FILE = 'session.json';
const CHUNKS_FILE = 'chunks.jsonl';
const TRANSCRIPT_FILE = 'transcript.jsonl';
const SUMMARY_FILE = 'summary.json';
const NOTE_FILE = 'note.json';

/** 一般の一時ディレクトリは自動削除されるため、Application Supportに置く。 */
export function defaultSessionsRoot(vaultId: string): string {
	if (!isValidStorageId(vaultId)) {
		throw new Error('vaultIdの形式が正しくありません。');
	}
	return join(homedir(), 'Library', 'Application Support', 'L Meetscribe', vaultId, 'sessions');
}

export type SessionListEntry = { sessionId: string; session: SessionRecord } | { sessionId: string; error: SessionDataError };

/**
 * Vault外の作業領域でセッションのデータを読み書きする。
 * 書き込みは呼び出し側が直列化する前提とし、同じファイルへの並行書き込みは調停しない。
 * 例外のメッセージには音声・文字起こしの内容を含めない。
 */
export class SessionStore {
	constructor(private readonly rootDir: string) {}

	sessionDir(sessionId: string): string {
		if (!isValidStorageId(sessionId)) {
			throw new Error('sessionIdの形式が正しくありません。');
		}
		return join(this.rootDir, sessionId);
	}

	/** 作業領域を新しく作る。同じIDの作業領域があれば失敗し、既存のデータを上書きしない。 */
	async createSession(session: SessionRecord): Promise<void> {
		const dir = this.sessionDir(session.sessionId);
		await fs.mkdir(this.rootDir, { recursive: true });
		await fs.mkdir(dir);
		await writeFileAtomic(join(dir, SESSION_FILE), JSON.stringify(session));
	}

	async saveSession(session: SessionRecord): Promise<void> {
		await writeFileAtomic(join(this.sessionDir(session.sessionId), SESSION_FILE), JSON.stringify(session));
	}

	async loadSession(sessionId: string): Promise<SessionRecord> {
		const session = parseSessionRecord(await readJsonFile(this.sessionDir(sessionId), SESSION_FILE), SESSION_FILE);
		if (session.sessionId !== sessionId) {
			throw new SessionDataError(SESSION_FILE, 'sessionIdがフォルダ名と一致しません。');
		}
		return session;
	}

	/** チャンクの状態を追記する。同じtrack・sequenceの記録は後のものが優先される。 */
	async appendChunk(sessionId: string, chunk: ChunkRecord): Promise<void> {
		await appendJsonLines(join(this.sessionDir(sessionId), CHUNKS_FILE), [chunk]);
	}

	/** track・sequenceごとに最新の状態を返す。壊れた末尾行はファイルから切り詰める。 */
	async loadChunks(sessionId: string): Promise<ChunkRecord[]> {
		const records = await loadJsonLines(this.sessionDir(sessionId), CHUNKS_FILE, parseChunkRecord);
		return latestByKey(records, (chunk) => `${chunk.track}:${chunk.sequence}`);
	}

	async appendSegments(sessionId: string, segments: readonly SegmentRecord[]): Promise<void> {
		await appendJsonLines(join(this.sessionDir(sessionId), TRANSCRIPT_FILE), segments);
	}

	/** segmentIdごとに最新の区間を返す。壊れた末尾行はファイルから切り詰める。 */
	async loadSegments(sessionId: string): Promise<SegmentRecord[]> {
		const records = await loadJsonLines(this.sessionDir(sessionId), TRANSCRIPT_FILE, parseSegmentRecord);
		return latestByKey(records, (segment) => segment.segmentId);
	}

	async saveSummary(sessionId: string, run: SummaryRun): Promise<void> {
		await writeFileAtomic(join(this.sessionDir(sessionId), SUMMARY_FILE), JSON.stringify(run));
	}

	/** 要約を実行していなければundefinedを返す。 */
	async loadSummary(sessionId: string): Promise<SummaryRun | undefined> {
		const raw = await readJsonFile(this.sessionDir(sessionId), SUMMARY_FILE, true);
		return raw === undefined ? undefined : parseSummaryRun(raw, SUMMARY_FILE);
	}

	async saveNoteProgress(sessionId: string, progress: NoteProgress): Promise<void> {
		await writeFileAtomic(join(this.sessionDir(sessionId), NOTE_FILE), JSON.stringify(progress));
	}

	/** まだノートへ反映していなければ、時間窓0件として返す。 */
	async loadNoteProgress(sessionId: string): Promise<NoteProgress> {
		const raw = await readJsonFile(this.sessionDir(sessionId), NOTE_FILE, true);
		return raw === undefined ? { reflectedWindows: 0 } : parseNoteProgress(raw, NOTE_FILE);
	}

	/** 復旧検出用。読めないセッションも一覧から外さず、エラーとして返す。 */
	async listSessions(): Promise<SessionListEntry[]> {
		let entries;
		try {
			entries = await fs.readdir(this.rootDir, { withFileTypes: true });
		} catch (error) {
			if (isNotFound(error)) {
				return [];
			}
			throw error;
		}
		const result: SessionListEntry[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !isValidStorageId(entry.name)) {
				continue;
			}
			try {
				result.push({ sessionId: entry.name, session: await this.loadSession(entry.name) });
			} catch (error) {
				if (!(error instanceof SessionDataError)) {
					throw error;
				}
				result.push({ sessionId: entry.name, error });
			}
		}
		return result;
	}

	async deleteSession(sessionId: string): Promise<void> {
		await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
	}
}

/** 指定したパスを含むファイルシステムの空き容量（バイト）。 */
export async function getFreeDiskBytes(path: string): Promise<number> {
	const stats = await fs.statfs(path);
	return stats.bavail * stats.bsize;
}

/** 一時ファイルへ書いて同期してから置換し、書き込み途中の内容を残さない。 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
	const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		const handle = await fs.open(tempPath, 'wx');
		try {
			await handle.writeFile(content, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(tempPath, path);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

async function appendJsonLines(path: string, records: readonly unknown[]): Promise<void> {
	if (records.length === 0) {
		return;
	}
	const content = records.map((record) => `${JSON.stringify(record)}\n`).join('');
	const handle = await fs.open(path, 'a');
	try {
		await handle.writeFile(content, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readJsonFile(dir: string, file: string, optional = false): Promise<unknown> {
	let text: string;
	try {
		text = await fs.readFile(join(dir, file), 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			if (optional) {
				return undefined;
			}
			throw new SessionDataError(file, 'ファイルがありません。');
		}
		throw error;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// JSON.parseのメッセージには内容の一部が含まれるため、理由だけを返す。
		throw new SessionDataError(file, 'JSONとして読み込めません。');
	}
}

async function loadJsonLines<T>(dir: string, file: string, parse: (value: unknown, file: string) => T): Promise<T[]> {
	const path = join(dir, file);
	let buffer: Buffer;
	try {
		buffer = await fs.readFile(path);
	} catch (error) {
		if (isNotFound(error)) {
			return [];
		}
		throw error;
	}
	const { records, validBytes } = parseJsonLines(buffer, file, parse);
	if (validBytes < buffer.length) {
		// 壊れた末尾を残すと、次の追記がその行に連結されて途中の行まで壊れる。
		await fs.truncate(path, validBytes);
	}
	return records;
}

/**
 * JSON Linesを読む。追記は1行と改行を1回で書くため、改行で終わらない末尾は書き込み途中とみなして捨てる。
 * 改行で終わる行が不正な場合は、途中のデータが壊れているためエラーにする。
 * validBytesは最後の完全な行までのバイト数。
 */
export function parseJsonLines<T>(
	buffer: Buffer,
	file: string,
	parse: (value: unknown, file: string) => T,
): { records: T[]; validBytes: number } {
	const records: T[] = [];
	let offset = 0;
	let lineNumber = 0;
	for (let newline = buffer.indexOf(0x0a, offset); newline !== -1; newline = buffer.indexOf(0x0a, offset)) {
		lineNumber += 1;
		const location = `${file} ${lineNumber}行目`;
		let value: unknown;
		try {
			value = JSON.parse(buffer.subarray(offset, newline).toString('utf8')) as unknown;
		} catch {
			// JSON.parseのメッセージには内容の一部が含まれるため、位置だけを返す。
			throw new SessionDataError(location, 'JSONとして読み込めません。');
		}
		records.push(parse(value, location));
		offset = newline + 1;
	}
	return { records, validBytes: offset };
}

function latestByKey<T>(records: readonly T[], key: (record: T) => string): T[] {
	const latest = new Map<string, T>();
	for (const record of records) {
		// Mapは最初に現れた順を保つ。値だけを最新の記録に置き換える。
		latest.set(key(record), record);
	}
	return [...latest.values()];
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
