import { constants, promises as fs } from 'fs';
import { basename, join } from 'path';

// Whisperモデルの一覧と、使用前の確認。

const MODEL_FILE_PATTERN = /^ggml-.+\.bin$/;
/** whisper.cppのモデルファイルの先頭にある`GGML_FILE_MAGIC`（0x67676d6c）のリトルエンディアン表記。 */
const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67]);

/** モデルフォルダ直下の`ggml-*.bin`をファイル名順に返す。ファイル名だけで使えると判断しない。 */
export async function listWhisperModels(modelDir: string): Promise<string[]> {
	const entries = await fs.readdir(modelDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && MODEL_FILE_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * 使用モデルを読み取れ、ggml形式の先頭を持つかを確認する。問題があれば利用者へ示す文言を返す。
 * whisper-cliでの読み込みは開始を数秒以上遅らせるため行わない。読み込めないモデルは最初のチャンクの失敗として記録される。
 */
export async function checkWhisperModel(modelDir: string, model: string): Promise<string | undefined> {
	if (model === '') {
		return 'Whisperの使用モデルが選択されていません。';
	}
	// 設定値をパスとして連結するため、フォルダ外を指す名前を拒否する。
	if (basename(model) !== model || !MODEL_FILE_PATTERN.test(model)) {
		return 'Whisperの使用モデルはモデルフォルダ内のggml-*.binを選んでください。';
	}
	const path = join(modelDir, model);
	try {
		await fs.access(path, constants.R_OK);
		const handle = await fs.open(path, 'r');
		try {
			const head = Buffer.alloc(GGML_MAGIC.length);
			const { bytesRead } = await handle.read(head, 0, head.length, 0);
			if (bytesRead < head.length || !head.equals(GGML_MAGIC)) {
				return `Whisperモデル（${model}）はggml形式ではありません。`;
			}
		} finally {
			await handle.close();
		}
	} catch {
		return `Whisperモデル（${model}）が見つからないか、読み取れません。`;
	}
	return undefined;
}
