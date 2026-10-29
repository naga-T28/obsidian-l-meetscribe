import { promises as fs } from 'fs';
import { join } from 'path';
import type { WorkAudio } from '../session/ports';
import type { SessionRecord } from '../session/records';
import type { SessionStore } from '../session/SessionStore';

// 文字起こしの後に不要になった作業音声を削除する。音声はVaultへ保存しない。

export class WorkAudioCleaner implements WorkAudio {
	constructor(private readonly store: Pick<SessionStore, 'sessionDir'>) {}

	/** 作業音声（チャンクとWhisperの一時出力）を削除する。状態と文字起こしの記録は残す。 */
	async cleanup(session: SessionRecord): Promise<void> {
		const sessionDir = this.store.sessionDir(session.sessionId);
		await fs.rm(join(sessionDir, 'chunks'), { recursive: true, force: true });
		await fs.rm(join(sessionDir, 'transcripts'), { recursive: true, force: true });
	}
}
