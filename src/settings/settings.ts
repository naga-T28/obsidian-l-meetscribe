import { asRecord } from '../json';
import {
	type OpenAIModelLimits,
	type WhisperLanguage,
	validateChunkSeconds,
	validateOllamaUrl,
	validateOpenAIModelLimits,
	validatePositiveInteger,
	validateSilenceThresholdDbfs,
	validateSpeakerLabel,
	validateWhisperModelLanguage,
} from './validation';

export const SETTINGS_SCHEMA_VERSION = 1;

export type SummaryProviderId = 'openai' | 'ollama';

/** Ollamaのモデル別上書き。未指定の項目は検証用初期値を使う。 */
export interface OllamaModelOverride {
	contextTokens?: number;
	chunkChars?: number;
}

export interface LMeetscribeSettings {
	schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
	/** 作業領域をVaultごとに分けるID。初回読み込み時に発行する。設定画面には表示しない。空文字は未発行。 */
	vaultId: string;
	whisper: {
		executablePath: string;
		modelDir: string;
		/** モデルフォルダ内のファイル名。空文字は未選択。 */
		model: string;
		language: WhisperLanguage;
		chunkSeconds: number;
		silenceThresholdDbfs: number;
	};
	recording: {
		/** 入力デバイスのUID。空文字は録音開始時のシステム既定入力。 */
		microphoneDeviceUid: string;
		/** 出力デバイスのUID。空文字はすべての出力。 */
		outputDeviceUid: string;
	};
	summary: {
		provider: SummaryProviderId;
		autoSummarize: boolean;
		openai: {
			/** SecretStorageの参照ID。キーの値はここに保存しない。 */
			apiKeySecretId: string;
			model: string;
			modelLimits: Record<string, OpenAIModelLimits>;
		};
		ollama: {
			url: string;
			model: string;
			thinking: boolean;
			modelOverrides: Record<string, OllamaModelOverride>;
		};
	};
	display: {
		selfLabel: string;
		otherLabel: string;
		showTimestamps: boolean;
	};
}

/** 既定のWhisperモデル。日本語に使える多言語モデルで、精度と速度の釣り合いがよい。`scripts/setup.sh`も同じモデルを取得する。 */
export const DEFAULT_WHISPER_MODEL = 'ggml-large-v3-turbo.bin';

// 8,192トークン・4,000字は仮の初期値。実機での速度とメモリの計測後に見直す。
export const OLLAMA_DEFAULT_CONTEXT_TOKENS = 8192;
export const OLLAMA_DEFAULT_CHUNK_CHARS = 4000;

export function createDefaultSettings(): LMeetscribeSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		vaultId: '',
		whisper: {
			executablePath: '',
			modelDir: '',
			model: DEFAULT_WHISPER_MODEL,
			language: 'ja',
			chunkSeconds: 10,
			silenceThresholdDbfs: -70,
		},
		recording: {
			microphoneDeviceUid: '',
			outputDeviceUid: '',
		},
		summary: {
			provider: 'openai',
			autoSummarize: true,
			openai: {
				apiKeySecretId: '',
				model: '',
				modelLimits: {},
			},
			ollama: {
				url: 'http://localhost:11434',
				model: '',
				thinking: false,
				modelOverrides: {},
			},
		},
		display: {
			selfLabel: '自分',
			otherLabel: '相手',
			showTimestamps: true,
		},
	};
}

export class UnsupportedSettingsVersionError extends Error {
	constructor(version: unknown) {
		super(`設定のスキーマ版 ${String(version)} には対応していません。新しい版のプラグインで保存された可能性があります。`);
		this.name = 'UnsupportedSettingsVersionError';
	}
}

/**
 * loadDataの結果を検証し、欠けた項目と不正な値を初期値で補う。
 * 型に定義していない項目は捨てるため、誤って混入した秘密情報もdata.jsonへ書き戻さない。
 * 新しいスキーマ版のデータは上書きで失わないよう、読み込みを拒否する。
 */
export function parseSettings(raw: unknown): LMeetscribeSettings {
	const defaults = createDefaultSettings();
	if (raw === null || raw === undefined) {
		return defaults;
	}
	const root = asRecord(raw);
	if (root.schemaVersion !== undefined && root.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
		throw new UnsupportedSettingsVersionError(root.schemaVersion);
	}

	const whisper = asRecord(root.whisper);
	const recording = asRecord(root.recording);
	const summary = asRecord(root.summary);
	const openai = asRecord(summary.openai);
	const ollama = asRecord(summary.ollama);
	const display = asRecord(root.display);
	const d = defaults;

	const settings: LMeetscribeSettings = {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		vaultId: stringOr(root.vaultId, d.vaultId, validateStorageId),
		whisper: {
			executablePath: stringOr(whisper.executablePath, d.whisper.executablePath),
			modelDir: stringOr(whisper.modelDir, d.whisper.modelDir),
			model: stringOr(whisper.model, d.whisper.model),
			language: oneOf(whisper.language, ['ja', 'en', 'auto'] as const, d.whisper.language),
			chunkSeconds: numberOr(whisper.chunkSeconds, d.whisper.chunkSeconds, validateChunkSeconds),
			silenceThresholdDbfs: numberOr(whisper.silenceThresholdDbfs, d.whisper.silenceThresholdDbfs, validateSilenceThresholdDbfs),
		},
		recording: {
			microphoneDeviceUid: stringOr(recording.microphoneDeviceUid, d.recording.microphoneDeviceUid),
			outputDeviceUid: stringOr(recording.outputDeviceUid, d.recording.outputDeviceUid),
		},
		summary: {
			provider: oneOf(summary.provider, ['openai', 'ollama'] as const, d.summary.provider),
			autoSummarize: booleanOr(summary.autoSummarize, d.summary.autoSummarize),
			openai: {
				apiKeySecretId: stringOr(openai.apiKeySecretId, d.summary.openai.apiKeySecretId, validateStorageId),
				model: stringOr(openai.model, d.summary.openai.model),
				modelLimits: parseOpenAIModelLimits(openai.modelLimits),
			},
			ollama: {
				url: stringOr(ollama.url, d.summary.ollama.url, validateOllamaUrl),
				model: stringOr(ollama.model, d.summary.ollama.model),
				thinking: booleanOr(ollama.thinking, d.summary.ollama.thinking),
				modelOverrides: parseOllamaModelOverrides(ollama.modelOverrides),
			},
		},
		display: {
			selfLabel: stringOr(display.selfLabel, d.display.selfLabel, validateSpeakerLabel),
			otherLabel: stringOr(display.otherLabel, d.display.otherLabel, validateSpeakerLabel),
			showTimestamps: booleanOr(display.showTimestamps, d.display.showTimestamps),
		},
	};
	// 英語専用モデルと日本語・自動判定の組み合わせは文字起こしに使えないため、モデルを未選択に戻す。
	if (validateWhisperModelLanguage(settings.whisper.model, settings.whisper.language) !== undefined) {
		settings.whisper.model = '';
	}
	return settings;
}

/** SecretStorageのIDとvaultIdは英小文字・数字・ハイフンに限る。vaultIdはパスの一部になる。 */
function validateStorageId(value: string): string | undefined {
	return value === '' || /^[a-z0-9-]+$/.test(value) ? undefined : '不正なID';
}

function parseOpenAIModelLimits(value: unknown): Record<string, OpenAIModelLimits> {
	// Object.fromEntriesは「__proto__」などのキーもデータとして扱うため、プロトタイプを汚染しない。
	return Object.fromEntries(
		Object.entries(asRecord(value)).flatMap(([model, entry]) => {
			const { contextTokens, outputReserveTokens } = asRecord(entry);
			if (typeof contextTokens !== 'number' || typeof outputReserveTokens !== 'number') {
				return [];
			}
			const limits = { contextTokens, outputReserveTokens };
			return validateOpenAIModelLimits(limits) === undefined ? [[model, limits]] : [];
		}),
	);
}

function parseOllamaModelOverrides(value: unknown): Record<string, OllamaModelOverride> {
	return Object.fromEntries(
		Object.entries(asRecord(value)).flatMap(([model, entry]) => {
			const { contextTokens, chunkChars } = asRecord(entry);
			const override: OllamaModelOverride = {};
			if (isPositiveInteger(contextTokens)) {
				override.contextTokens = contextTokens;
			}
			if (isPositiveInteger(chunkChars)) {
				override.chunkChars = chunkChars;
			}
			return Object.keys(override).length > 0 ? [[model, override]] : [];
		}),
	);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && validatePositiveInteger(value, '') === undefined;
}

function stringOr(value: unknown, fallback: string, validate?: (value: string) => string | undefined): string {
	if (typeof value !== 'string' || validate?.(value) !== undefined) {
		return fallback;
	}
	return value;
}

function numberOr(value: unknown, fallback: number, validate: (value: number) => string | undefined): number {
	if (typeof value !== 'number' || validate(value) !== undefined) {
		return fallback;
	}
	return value;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.find((candidate) => candidate === value) ?? fallback;
}

// モデル名をキーにした記録の読み書き。モデル名は利用者の入力なので、
// 「__proto__」などのキーでもプロトタイプを参照・変更しないよう自前のプロパティだけを扱う。

export function getModelEntry<T>(record: Record<string, T>, model: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, model) ? record[model] : undefined;
}

export function withModelEntry<T>(record: Record<string, T>, model: string, value: T | undefined): Record<string, T> {
	const entries = Object.entries(record).filter(([key]) => key !== model);
	return Object.fromEntries(value === undefined ? entries : [...entries, [model, value]]);
}

/** Ollamaモデルで実際に使うコンテキスト長と分割文字数。上書きがなければ初期値を使う。 */
export function getOllamaModelLimits(ollama: LMeetscribeSettings['summary']['ollama'], model: string): Required<OllamaModelOverride> {
	const override = getModelEntry(ollama.modelOverrides, model);
	return {
		contextTokens: override?.contextTokens ?? OLLAMA_DEFAULT_CONTEXT_TOKENS,
		chunkChars: override?.chunkChars ?? OLLAMA_DEFAULT_CHUNK_CHARS,
	};
}
