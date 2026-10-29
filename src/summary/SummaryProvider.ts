import type { LMeetscribeSettings } from '../settings/settings';

// 要約の実行先の境界。HTTPの呼び出しはOpenAIProvider・OllamaProviderが担い、
// 分割・統合・進捗・入力の固定は共通処理（Summarizer）が担う。

export interface ProviderLimits {
	/** 指示・入力・出力を合わせたコンテキスト長（トークン）。 */
	contextTokens: number;
	/** 出力のために空けておくトークン数。リクエストの出力上限にも使う。 */
	outputReserveTokens: number;
	/** 1回の部分要約に渡す入力の文字数の目安。トークン数とは別に守る。 */
	chunkChars?: number;
}

export interface GenerateRequest {
	instructions: string;
	input: string;
	maxOutputTokens: number;
	signal: AbortSignal;
}

/**
 * contextExceeded: 実行先が入力の上限超過を返した。共通処理は分割を縮小して実行し直す。
 * それ以外は失敗として記録し、自動で実行先を変えない。
 */
export type ProviderErrorKind =
	| 'auth'
	| 'invalidModel'
	| 'rateLimited'
	| 'server'
	| 'network'
	| 'timeout'
	| 'refused'
	| 'incomplete'
	| 'empty'
	| 'contextExceeded'
	| 'aborted';

/** messageには入力・出力の本文とAPIキーを含めない。 */
export type GenerateResult = { ok: true; text: string } | { ok: false; kind: ProviderErrorKind; message: string };

export interface SummaryProvider {
	readonly id: 'openai' | 'ollama';
	readonly model: string;
	readonly limits: ProviderLimits;
	/** 入力が上限に収まっても、部分要約と統合の2段階を通す（Ollamaで使う）。 */
	readonly alwaysSplit: boolean;
	generate(request: GenerateRequest): Promise<GenerateResult>;
}

/** 要約設定から実行先を用意する。APIキー・モデルの未設定などで実行できなければ、省略の理由を返す。 */
export type ResolveProvider = (settings: LMeetscribeSettings['summary']) => Promise<{ provider: SummaryProvider } | { skip: string }>;
