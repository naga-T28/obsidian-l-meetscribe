import { getModelEntry, getOllamaModelLimits, type LMeetscribeSettings } from '../settings/settings';
import { validateOllamaUrl, validateOpenAIModelLimits } from '../settings/validation';
import { getOllamaModelDetails, OllamaError, OllamaProvider, type OllamaTransport } from './OllamaProvider';
import { type HttpPost, OPENAI_MODEL_PRESETS, OpenAIProvider } from './OpenAIProvider';
import type { ResolveProvider, SummaryProvider } from './SummaryProvider';

export interface ProviderDependencies {
	/** SecretStorageからAPIキーを読む。値はログ・設定・ノートへ書かない。 */
	getSecret(id: string): string | null;
	post: HttpPost;
	/** 省略時はNode.jsのHTTPクライアント。 */
	ollamaTransport?: OllamaTransport;
}

/** 要約設定から実行先を用意する。実行できなければ省略の理由を返す。利用者が選んでいない送信先へ本文を送らないよう、実行先を自動で切り替えない。 */
export function createProviderResolver(dependencies: ProviderDependencies): ResolveProvider {
	return (settings) => {
		if (settings.provider === 'ollama') {
			return resolveOllama(settings.ollama, dependencies.ollamaTransport);
		}
		const { openai } = settings;
		if (openai.model.trim() === '') {
			return Promise.resolve({ skip: 'OpenAIのモデルが未設定です。設定画面でモデル名を入力してください。' });
		}
		const limits = getModelEntry(OPENAI_MODEL_PRESETS, openai.model) ?? getModelEntry(openai.modelLimits, openai.model);
		if (validateOpenAIModelLimits(limits) !== undefined || limits === undefined) {
			return Promise.resolve({ skip: `OpenAIのモデル（${openai.model}）のコンテキスト長と出力予約トークン数が未設定です。設定画面で入力してください。` });
		}
		const apiKey = openai.apiKeySecretId === '' ? null : dependencies.getSecret(openai.apiKeySecretId);
		if (apiKey === null || apiKey.trim() === '') {
			return Promise.resolve({ skip: 'OpenAIのAPIキーが未設定です。設定画面で設定してください。' });
		}
		return Promise.resolve({ provider: new OpenAIProvider({ apiKey: apiKey.trim(), model: openai.model, limits, post: dependencies.post }) });
	};
}

/** 出力予約はOllamaの設定項目にないため、コンテキスト長の1/4とする。実機での計測後に見直す。 */
export function ollamaOutputReserve(contextTokens: number): number {
	return Math.floor(contextTokens / 4);
}

/**
 * ローカル実行を確認できたモデルだけを返す。未起動・接続失敗・外部実行・確認できないモデルは、
 * 本文を送らずに省略の理由を返す。OpenAIへ切り替えない。
 */
async function resolveOllama(
	ollama: LMeetscribeSettings['summary']['ollama'],
	transport: OllamaTransport | undefined,
): Promise<{ provider: SummaryProvider } | { skip: string }> {
	const urlProblem = validateOllamaUrl(ollama.url);
	if (urlProblem !== undefined) {
		return { skip: `Ollama URL: ${urlProblem}` };
	}
	if (ollama.model === '') {
		return { skip: 'Ollamaのモデルが未選択です。設定画面でモデルを選んでください。' };
	}
	let details;
	try {
		details = await getOllamaModelDetails(ollama.url, ollama.model, transport);
	} catch (error) {
		if (error instanceof OllamaError) {
			const reason = error.kind === 'http' && error.status === 404 ? `Ollamaにモデル（${ollama.model}）がありません。` : error.message;
			return { skip: `Ollamaを利用できません: ${reason}` };
		}
		throw error;
	}
	if (!details.local) {
		return { skip: `モデル（${ollama.model}）がこのMacで実行されることを確認できないため、要約しません。ローカルのモデルを選んでください。` };
	}
	// 設定の上書きがない限り初期値を使い、モデルの最大値を超えない。
	const configured = getOllamaModelLimits(ollama, ollama.model);
	const contextTokens = Math.min(configured.contextTokens, details.contextLength ?? configured.contextTokens);
	const options: ConstructorParameters<typeof OllamaProvider>[0] = {
		baseUrl: ollama.url,
		model: ollama.model,
		limits: { contextTokens, outputReserveTokens: ollamaOutputReserve(contextTokens), chunkChars: configured.chunkChars },
	};
	// thinkingに対応したモデルにだけ指定する。対応していないモデルへ送るとエラーになるため。
	if (details.thinking) {
		options.think = ollama.thinking;
	}
	if (transport !== undefined) {
		options.transport = transport;
	}
	return { provider: new OllamaProvider(options) };
}
