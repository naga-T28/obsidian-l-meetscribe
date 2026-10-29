import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	checkExecutableFile,
	checkReadableDirectory,
	isEnglishOnlyWhisperModel,
	validateChunkSeconds,
	validateOllamaUrl,
	validateOpenAIModelLimits,
	validatePositiveInteger,
	validateSilenceThresholdDbfs,
	validateSpeakerLabel,
	validateWhisperModelLanguage,
} from '../../src/settings/validation';

describe('validateChunkSeconds', () => {
	it.each([0, -1, 0.09, 600.1, Number.NaN, Number.POSITIVE_INFINITY])('%sを拒否する', (value) => {
		expect(validateChunkSeconds(value)).toBeDefined();
	});

	it.each([0.1, 0.5, 10, 600])('%sを受け付ける', (value) => {
		expect(validateChunkSeconds(value)).toBeUndefined();
	});
});

describe('validateSilenceThresholdDbfs', () => {
	it('0以下を受け付け、正の値を拒否する', () => {
		expect(validateSilenceThresholdDbfs(-70)).toBeUndefined();
		expect(validateSilenceThresholdDbfs(0)).toBeUndefined();
		expect(validateSilenceThresholdDbfs(0.1)).toBeDefined();
		expect(validateSilenceThresholdDbfs(Number.NaN)).toBeDefined();
	});
});

describe('validatePositiveInteger', () => {
	it('1以上の整数だけを受け付ける', () => {
		expect(validatePositiveInteger(1, 'x')).toBeUndefined();
		expect(validatePositiveInteger(0, 'x')).toBeDefined();
		expect(validatePositiveInteger(1.5, 'x')).toBeDefined();
	});
});

describe('validateOllamaUrl', () => {
	it.each(['http://localhost:11434', 'http://127.0.0.1:11434', 'http://127.1.2.3:11434/', 'http://[::1]:11434', 'https://localhost:11434'])(
		'ループバックの%sを受け付ける',
		(url) => {
			expect(validateOllamaUrl(url)).toBeUndefined();
		},
	);

	it.each([
		'http://192.168.1.10:11434',
		'http://example.com:11434',
		'http://localhost.example.com:11434',
		'http://127.0.0.1.example.com',
		'http://0.0.0.0:11434',
		'http://[::ffff:8.8.8.8]:11434',
		'http://user:pass@localhost:11434',
		'http://localhost:11434/api',
		'http://localhost:11434/?q=1',
		'ftp://localhost:11434',
		'localhost:11434',
		'',
	])('非ループバックまたは不正な%sを拒否する', (url) => {
		expect(validateOllamaUrl(url)).toBeDefined();
	});
});

describe('英語専用モデル', () => {
	it.each(['ggml-base.en.bin', 'ggml-tiny.en-q5_1.bin', 'ggml-medium.en-q8_0.bin'])('%sを英語専用と判定する', (name) => {
		expect(isEnglishOnlyWhisperModel(name)).toBe(true);
	});

	it.each(['ggml-base.bin', 'ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3.bin'])('%sを多言語と判定する', (name) => {
		expect(isEnglishOnlyWhisperModel(name)).toBe(false);
	});

	it('英語専用モデルを日本語・自動判定と組み合わせない', () => {
		expect(validateWhisperModelLanguage('ggml-base.en.bin', 'ja')).toBeDefined();
		expect(validateWhisperModelLanguage('ggml-base.en.bin', 'auto')).toBeDefined();
		expect(validateWhisperModelLanguage('ggml-base.en.bin', 'en')).toBeUndefined();
		expect(validateWhisperModelLanguage('ggml-base.bin', 'ja')).toBeUndefined();
		expect(validateWhisperModelLanguage('', 'ja')).toBeUndefined();
	});
});

describe('validateOpenAIModelLimits', () => {
	it('未入力の値があれば拒否する', () => {
		expect(validateOpenAIModelLimits(undefined)).toBeDefined();
		expect(validateOpenAIModelLimits({ contextTokens: 128000 })).toBeDefined();
		expect(validateOpenAIModelLimits({ outputReserveTokens: 4000 })).toBeDefined();
	});

	it('出力予約量がコンテキスト長以上なら拒否する', () => {
		expect(validateOpenAIModelLimits({ contextTokens: 8000, outputReserveTokens: 8000 })).toBeDefined();
		expect(validateOpenAIModelLimits({ contextTokens: 8000, outputReserveTokens: 7999 })).toBeUndefined();
	});

	it('0以下や小数を拒否する', () => {
		expect(validateOpenAIModelLimits({ contextTokens: 0, outputReserveTokens: -1 })).toBeDefined();
		expect(validateOpenAIModelLimits({ contextTokens: 8000.5, outputReserveTokens: 100 })).toBeDefined();
		expect(validateOpenAIModelLimits({ contextTokens: Number.NaN, outputReserveTokens: 100 })).toBeDefined();
	});
});

describe('validateSpeakerLabel', () => {
	it('空白だけのラベルを拒否する', () => {
		expect(validateSpeakerLabel(' ')).toBeDefined();
		expect(validateSpeakerLabel('自分')).toBeUndefined();
	});
});

describe('ファイルシステムの確認', () => {
	let dir: string;
	let executable: string;
	let plainFile: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lms-settings-'));
		executable = join(dir, 'whisper-cli');
		plainFile = join(dir, 'plain.txt');
		await writeFile(executable, '#!/bin/sh\n');
		await chmod(executable, 0o755);
		await writeFile(plainFile, '');
		await chmod(plainFile, 0o644);
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('実行可能なファイルだけを受け付ける', async () => {
		expect(await checkExecutableFile(executable)).toBeUndefined();
		expect(await checkExecutableFile(plainFile)).toBeDefined();
		expect(await checkExecutableFile(dir)).toBeDefined();
		expect(await checkExecutableFile(join(dir, 'missing'))).toBeDefined();
		expect(await checkExecutableFile('')).toBeDefined();
	});

	it('読み取れるフォルダだけを受け付ける', async () => {
		expect(await checkReadableDirectory(dir)).toBeUndefined();
		expect(await checkReadableDirectory(plainFile)).toBeDefined();
		expect(await checkReadableDirectory(join(dir, 'missing'))).toBeDefined();
		expect(await checkReadableDirectory('')).toBeDefined();
	});
});
