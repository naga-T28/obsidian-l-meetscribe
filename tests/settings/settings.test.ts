import { describe, expect, it } from 'vitest';
import {
	createDefaultSettings,
	getModelEntry,
	getOllamaModelLimits,
	parseSettings,
	SETTINGS_SCHEMA_VERSION,
	UnsupportedSettingsVersionError,
	withModelEntry,
} from '../../src/settings/settings';

describe('parseSettings', () => {
	it('データがなければ初期値を返す', () => {
		expect(parseSettings(null)).toEqual(createDefaultSettings());
		expect(parseSettings(undefined)).toEqual(createDefaultSettings());
	});

	it('既定の初期値を持つ', () => {
		const settings = createDefaultSettings();
		expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
		expect(settings.whisper.language).toBe('ja');
		expect(settings.whisper.model).toBe('ggml-large-v3-turbo.bin');
		expect(settings.whisper.chunkSeconds).toBe(10);
		expect(settings.whisper.silenceThresholdDbfs).toBe(-70);
		expect(settings.recording).toEqual({ microphoneDeviceUid: '', outputDeviceUid: '' });
		expect(settings.summary.provider).toBe('openai');
		expect(settings.summary.autoSummarize).toBe(true);
		expect(settings.summary.ollama.url).toBe('http://localhost:11434');
		expect(settings.summary.ollama.thinking).toBe(false);
		expect(settings.display).toEqual({ selfLabel: '自分', otherLabel: '相手', showTimestamps: true });
	});

	it('欠けた項目を初期値で補い、保存済みの値を保つ', () => {
		const settings = parseSettings({ schemaVersion: 1, whisper: { model: 'ggml-base.bin', chunkSeconds: 15 } });
		expect(settings.whisper.model).toBe('ggml-base.bin');
		expect(settings.whisper.chunkSeconds).toBe(15);
		expect(settings.whisper.language).toBe('ja');
		expect(settings.summary).toEqual(createDefaultSettings().summary);
	});

	it('型や制約に合わない値を初期値に戻す', () => {
		const settings = parseSettings({
			whisper: { chunkSeconds: 0, language: 'fr', silenceThresholdDbfs: '-70' },
			recording: { microphoneDeviceUid: 42, outputDeviceUid: null },
			summary: { provider: 'gemini', ollama: { url: 'http://example.com:11434' } },
			display: { selfLabel: '' },
		});
		const defaults = createDefaultSettings();
		expect(settings.whisper.chunkSeconds).toBe(defaults.whisper.chunkSeconds);
		expect(settings.whisper.language).toBe(defaults.whisper.language);
		expect(settings.whisper.silenceThresholdDbfs).toBe(defaults.whisper.silenceThresholdDbfs);
		expect(settings.recording).toEqual(defaults.recording);
		expect(settings.summary.provider).toBe('openai');
		expect(settings.summary.ollama.url).toBe(defaults.summary.ollama.url);
		expect(settings.display.selfLabel).toBe('自分');
	});

	it('配列や文字列などオブジェクト以外のデータを初期値として扱う', () => {
		expect(parseSettings([])).toEqual(createDefaultSettings());
		expect(parseSettings('broken')).toEqual(createDefaultSettings());
	});

	it('vaultIdを保ち、パスに使えない値は未発行に戻す', () => {
		expect(parseSettings({ vaultId: '0b6c1f9e-1234-4abc-8def-000000000000' }).vaultId).toBe('0b6c1f9e-1234-4abc-8def-000000000000');
		expect(parseSettings({ vaultId: '../other' }).vaultId).toBe('');
	});

	it('新しいスキーマ版のデータを拒否する', () => {
		expect(() => parseSettings({ schemaVersion: 2 })).toThrow(UnsupportedSettingsVersionError);
	});

	it('英語専用モデルと日本語の組み合わせではモデルを未選択に戻す', () => {
		expect(parseSettings({ whisper: { model: 'ggml-base.en.bin', language: 'ja' } }).whisper.model).toBe('');
		expect(parseSettings({ whisper: { model: 'ggml-base.en.bin', language: 'en' } }).whisper.model).toBe('ggml-base.en.bin');
	});

	it('モデル別の上書きのうち正しい値だけを残す', () => {
		const settings = parseSettings({
			summary: {
				openai: {
					modelLimits: {
						good: { contextTokens: 128000, outputReserveTokens: 4000 },
						reversed: { contextTokens: 1000, outputReserveTokens: 2000 },
						partial: { contextTokens: 1000 },
					},
				},
				ollama: {
					modelOverrides: {
						'gemma:4b': { contextTokens: 16384 },
						'qwen:8b': { chunkChars: 3000, contextTokens: -1 },
						broken: { contextTokens: 'big' },
					},
				},
			},
		});
		expect(settings.summary.openai.modelLimits).toEqual({ good: { contextTokens: 128000, outputReserveTokens: 4000 } });
		expect(settings.summary.ollama.modelOverrides).toEqual({ 'gemma:4b': { contextTokens: 16384 }, 'qwen:8b': { chunkChars: 3000 } });
	});
});

describe('APIキーの保存', () => {
	it('data.jsonへ書く値にはキーの参照IDだけを含める', () => {
		const secret = 'sk-test-0000000000';
		const settings = parseSettings({
			apiKey: secret,
			summary: { openai: { apiKey: secret, apiKeySecretId: 'openai-key' } },
		});
		const saved = JSON.stringify(settings);
		expect(settings.summary.openai.apiKeySecretId).toBe('openai-key');
		expect(saved).not.toContain(secret);
	});

	it('SecretStorageのID形式でない値を参照IDとして保存しない', () => {
		const secret = 'sk-test-0000000000';
		const settings = parseSettings({ summary: { openai: { apiKeySecretId: secret.toUpperCase() } } });
		expect(settings.summary.openai.apiKeySecretId).toBe('');
	});
});

describe('モデル別の記録', () => {
	it('__proto__などのモデル名でもプロトタイプを変更しない', () => {
		const limits = { contextTokens: 1000, outputReserveTokens: 100 };
		const record = withModelEntry({}, '__proto__', limits);
		expect(getModelEntry(record, '__proto__')).toEqual(limits);
		expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
		expect(getModelEntry({}, 'toString')).toBeUndefined();
	});

	it('undefinedを渡すと記録を削除する', () => {
		const record = withModelEntry({ a: 1, b: 2 }, 'a', undefined);
		expect(record).toEqual({ b: 2 });
	});

	it('Ollamaの上書きがない項目は初期値を使う', () => {
		const settings = createDefaultSettings();
		settings.summary.ollama.modelOverrides = { 'gemma:4b': { chunkChars: 3000 } };
		expect(getOllamaModelLimits(settings.summary.ollama, 'gemma:4b')).toEqual({ contextTokens: 8192, chunkChars: 3000 });
		expect(getOllamaModelLimits(settings.summary.ollama, 'other')).toEqual({ contextTokens: 8192, chunkChars: 4000 });
	});
});
