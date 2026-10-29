import { constants, promises as fs } from 'fs';

// 設定値の検証。設定画面と読み込み時の補正の両方で使う。
// 検証に失敗した場合は利用者へ表示する文言を返し、成功した場合はundefinedを返す。

export type WhisperLanguage = 'ja' | 'en' | 'auto';

// 録音ヘルパーが受け付けるチャンク長の範囲。範囲外は録音開始で拒否されるため、設定の時点で弾く。
export const MIN_CHUNK_SECONDS = 0.1;
export const MAX_CHUNK_SECONDS = 600;

export function validateChunkSeconds(value: number): string | undefined {
	if (!Number.isFinite(value) || value < MIN_CHUNK_SECONDS || value > MAX_CHUNK_SECONDS) {
		return `チャンク長は${MIN_CHUNK_SECONDS}〜${MAX_CHUNK_SECONDS}秒で指定してください。`;
	}
	return undefined;
}

export function validateSilenceThresholdDbfs(value: number): string | undefined {
	if (!Number.isFinite(value) || value > 0) {
		return '無音しきい値は0以下のdBFS値を指定してください。';
	}
	return undefined;
}

export function validatePositiveInteger(value: number, label: string): string | undefined {
	if (!Number.isSafeInteger(value) || value <= 0) {
		return `${label}は1以上の整数を指定してください。`;
	}
	return undefined;
}

/** OllamaへはループバックのHTTP接続だけを許可する。外部ホストへ本文を送らないため。 */
export function validateOllamaUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return 'URLの形式が正しくありません。';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'URLはhttpまたはhttpsで指定してください。';
	}
	if (url.username !== '' || url.password !== '') {
		return 'URLに認証情報を含めないでください。';
	}
	if (!isLoopbackHost(url.hostname)) {
		return 'Ollama URLはこのMacのループバックアドレス（localhost、127.0.0.1、[::1]）だけを指定できます。';
	}
	if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
		return 'URLにはパスやクエリを含めず、ホストとポートだけを指定してください。';
	}
	return undefined;
}

function isLoopbackHost(hostname: string): boolean {
	if (hostname === 'localhost' || hostname === '[::1]') {
		return true;
	}
	// URLはIPv4表記を正規化するため、4つの10進数に分解できる値だけを判定すればよい。
	const octets = hostname.split('.');
	return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** ggml-base.en.bin、ggml-base.en-q5_1.binなどの英語専用モデルを判定する。 */
export function isEnglishOnlyWhisperModel(modelFileName: string): boolean {
	const stem = modelFileName.replace(/\.bin$/, '');
	return /\.en(?:-|$)/.test(stem);
}

export function validateWhisperModelLanguage(modelFileName: string, language: WhisperLanguage): string | undefined {
	if (modelFileName !== '' && isEnglishOnlyWhisperModel(modelFileName) && language !== 'en') {
		return '英語専用モデル（.en）は言語「en」でのみ使用できます。';
	}
	return undefined;
}

export interface OpenAIModelLimits {
	contextTokens: number;
	outputReserveTokens: number;
}

/** 未知のモデルでは両方の値を必須とし、出力予約量はコンテキスト長未満に限る。 */
export function validateOpenAIModelLimits(limits: Partial<OpenAIModelLimits> | undefined): string | undefined {
	if (limits?.contextTokens === undefined || limits.outputReserveTokens === undefined) {
		return 'このモデルのコンテキスト長と出力予約トークン数を入力してください。';
	}
	const error =
		validatePositiveInteger(limits.contextTokens, 'コンテキスト長') ??
		validatePositiveInteger(limits.outputReserveTokens, '出力予約トークン数');
	if (error !== undefined) {
		return error;
	}
	if (limits.outputReserveTokens >= limits.contextTokens) {
		return '出力予約トークン数はコンテキスト長より小さくしてください。';
	}
	return undefined;
}

export function validateSpeakerLabel(value: string): string | undefined {
	if (value.trim() === '') {
		return '話者ラベルを入力してください。';
	}
	return undefined;
}

export async function checkExecutableFile(path: string): Promise<string | undefined> {
	if (path.trim() === '') {
		return '実行ファイルが未設定です。';
	}
	try {
		const info = await fs.stat(path);
		if (!info.isFile()) {
			return '指定したパスはファイルではありません。';
		}
		await fs.access(path, constants.X_OK);
	} catch {
		return '実行ファイルが見つからないか、実行できません。';
	}
	return undefined;
}

export async function checkReadableDirectory(path: string): Promise<string | undefined> {
	if (path.trim() === '') {
		return 'フォルダが未設定です。';
	}
	try {
		const info = await fs.stat(path);
		if (!info.isDirectory()) {
			return '指定したパスはフォルダではありません。';
		}
		// 一覧の取得にはフォルダの読み取りと検索の両方の権限が要る。
		await fs.access(path, constants.R_OK | constants.X_OK);
	} catch {
		return 'フォルダが見つからないか、読み取れません。';
	}
	return undefined;
}
