import { promises as fs } from 'fs';
import { join } from 'path';
import { isRecord } from '../json';
import { type ChunkRecord, parseChunkRecord, SessionDataError, type SessionRecord } from './records';
import type { SessionListEntry, SessionStore } from './SessionStore';

// 未完了セッションの検出と、作業領域のチャンクファイルとキュー（chunks.jsonl）の照合。
// 通知前に異常終了したチャンクは、ヘルパーが書いた確定名のメタ情報からキューへ補う。

const CHUNK_FILE = /^(self|other)-(\d{6})\.(wav|json)$/;

/** chunks/にある確定名のファイル。メタ情報は読めた場合だけ持つ。 */
export interface FoundChunk {
	/** セッション作業領域からの相対パス（`chunks/<track>-<番号>.wav`）。 */
	path: string;
	/** 同じ名前の`.json`の内容。ないか読めなければundefined。 */
	meta: unknown;
}

export interface ChunkReconciliation {
	/** キューにないWAVのうち、メタ情報から補えたチャンク。 */
	added: ChunkRecord[];
	/** メタ情報が欠けた・壊れたWAV。時刻が分からないため処理せず、消さずに残す。 */
	unknownTime: string[];
	/** キューでは未処理・失敗なのに、WAVがないチャンク。 */
	missingFiles: string[];
}

/**
 * キューと実ファイルを照合する。silentThresholdDbfs未満のチャンクは無音として補う。
 * chunksDirExistsがfalseなら作業音声は削除済みで、ファイルがないことを不一致としない。
 */
export function reconcileChunks(
	sessionId: string,
	records: readonly ChunkRecord[],
	found: readonly FoundChunk[],
	silenceThresholdDbfs: number,
): ChunkReconciliation {
	const known = new Set(records.map((record) => record.path));
	const present = new Set(found.map((chunk) => chunk.path));
	const added: ChunkRecord[] = [];
	const unknownTime: string[] = [];
	for (const chunk of found) {
		if (known.has(chunk.path)) {
			continue;
		}
		const record = chunkFromMeta(sessionId, chunk);
		if (record === undefined) {
			unknownTime.push(chunk.path);
			continue;
		}
		record.state = record.rmsDbfs < silenceThresholdDbfs ? 'silent' : 'pending';
		added.push(record);
	}
	const missingFiles = records
		.filter((record) => (record.state === 'pending' || record.state === 'failed') && !present.has(record.path))
		.map((record) => record.path);
	return { added, unknownTime, missingFiles };
}

/** メタ情報がファイル名・セッションと一致し、型が正しい場合だけチャンクとして扱う。 */
function chunkFromMeta(sessionId: string, chunk: FoundChunk): ChunkRecord | undefined {
	const match = CHUNK_FILE.exec(chunk.path.slice('chunks/'.length));
	if (!isRecord(chunk.meta) || chunk.meta.sessionId !== sessionId || match === null) {
		return undefined;
	}
	let record: ChunkRecord;
	try {
		record = parseChunkRecord({ ...chunk.meta, state: 'pending', attempts: 0 }, chunk.path);
	} catch (error) {
		if (error instanceof SessionDataError) {
			return undefined;
		}
		throw error;
	}
	if (record.path !== chunk.path || record.track !== match[1] || record.sequence !== Number(match[2])) {
		return undefined;
	}
	return record;
}

/** chunks/の確定名のWAVと、対応するメタ情報を読む。一時ファイル（`.<名前>.tmp`）は含めない。chunks/がなければundefined。 */
export async function scanChunkFiles(sessionDir: string): Promise<FoundChunk[] | undefined> {
	const dir = join(sessionDir, 'chunks');
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	const found: FoundChunk[] = [];
	for (const name of names.filter((entry) => CHUNK_FILE.test(entry) && entry.endsWith('.wav')).sort()) {
		let meta: unknown;
		try {
			meta = JSON.parse(await fs.readFile(join(dir, name.replace(/\.wav$/, '.json')), 'utf8')) as unknown;
		} catch {
			// メタ情報がない・壊れている場合は時刻不明として扱う。
			meta = undefined;
		}
		found.push({ path: `chunks/${name}`, meta });
	}
	return found;
}

export type RecoveryStore = Pick<SessionStore, 'listSessions' | 'sessionDir' | 'loadChunks' | 'appendChunk' | 'deleteSession'>;

/** 起動時に示す未完了セッション。読めないセッションはsessionを持たない。 */
export interface RecoveryCandidate {
	sessionId: string;
	session?: SessionRecord;
	/** 読めない理由。ファイル名と位置だけで、内容は含めない。 */
	error?: string;
	reconciliation?: ChunkReconciliation;
	/** 作業音声を削除済み。文字起こしは作業領域とノートにある。 */
	workAudioDeleted?: boolean;
}

/** completed以外のセッションと、読めないセッションを返す。照合結果は表示用で、キューは変更しない。 */
export async function findRecoveryCandidates(store: RecoveryStore): Promise<RecoveryCandidate[]> {
	const candidates: RecoveryCandidate[] = [];
	for (const entry of await store.listSessions()) {
		const candidate = await inspect(store, entry);
		if (candidate !== undefined) {
			candidates.push(candidate);
		}
	}
	return candidates;
}

async function inspect(store: RecoveryStore, entry: SessionListEntry): Promise<RecoveryCandidate | undefined> {
	if ('error' in entry) {
		return { sessionId: entry.sessionId, error: entry.error.message };
	}
	const { session } = entry;
	if (session.state === 'completed') {
		return undefined;
	}
	try {
		const found = await scanChunkFiles(store.sessionDir(session.sessionId));
		const records = await store.loadChunks(session.sessionId);
		return {
			sessionId: session.sessionId,
			session,
			reconciliation: reconcileChunks(session.sessionId, records, found ?? [], session.settings.whisper.silenceThresholdDbfs),
			workAudioDeleted: found === undefined,
		};
	} catch (error) {
		if (error instanceof SessionDataError) {
			return { sessionId: session.sessionId, session, error: error.message };
		}
		throw error;
	}
}

/** 再処理の前に、通知前に終了したチャンクをキューへ補う。 */
export async function applyReconciliation(store: RecoveryStore, session: SessionRecord): Promise<ChunkReconciliation> {
	const found = (await scanChunkFiles(store.sessionDir(session.sessionId))) ?? [];
	const result = reconcileChunks(session.sessionId, await store.loadChunks(session.sessionId), found, session.settings.whisper.silenceThresholdDbfs);
	for (const chunk of result.added) {
		await store.appendChunk(session.sessionId, chunk);
	}
	return result;
}
