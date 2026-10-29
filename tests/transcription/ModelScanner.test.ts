import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkWhisperModel, listWhisperModels } from '../../src/transcription/ModelScanner';

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'lms-models-'));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('listWhisperModels', () => {
	it('ggml-*.binのファイルだけを名前順に返す', async () => {
		for (const name of ['ggml-small.bin', 'ggml-base.en.bin', 'other.bin', 'ggml-base.bin.part', 'ggml-.bin']) {
			await fs.writeFile(join(dir, name), 'lmgg');
		}
		await fs.mkdir(join(dir, 'ggml-folder.bin'));
		await expect(listWhisperModels(dir)).resolves.toEqual(['ggml-base.en.bin', 'ggml-small.bin']);
	});
});

describe('checkWhisperModel', () => {
	it('ggml形式の先頭を持つモデルを受け付ける', async () => {
		await fs.writeFile(join(dir, 'ggml-base.bin'), Buffer.from('lmgg rest'));
		await expect(checkWhisperModel(dir, 'ggml-base.bin')).resolves.toBeUndefined();
	});

	it('未選択、フォルダ外の名前、存在しないモデル、形式の違うファイルを拒否する', async () => {
		await fs.writeFile(join(dir, 'ggml-fake.bin'), 'not a model');
		await fs.writeFile(join(dir, 'ggml-short.bin'), 'lm');
		await expect(checkWhisperModel(dir, '')).resolves.toContain('選択されていません');
		await expect(checkWhisperModel(dir, '../ggml-base.bin')).resolves.toContain('モデルフォルダ内');
		await expect(checkWhisperModel(dir, 'ggml-missing.bin')).resolves.toContain('読み取れません');
		await expect(checkWhisperModel(dir, 'ggml-fake.bin')).resolves.toContain('ggml形式ではありません');
		await expect(checkWhisperModel(dir, 'ggml-short.bin')).resolves.toContain('ggml形式ではありません');
	});
});
