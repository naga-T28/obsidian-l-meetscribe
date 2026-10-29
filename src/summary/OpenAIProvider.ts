import { isRecord } from '../json';
import type { OpenAIModelLimits } from '../settings/validation';
import type { GenerateRequest, GenerateResult, ProviderErrorKind, ProviderLimits, SummaryProvider } from './SummaryProvider';

// OpenAI Responses APIでの要約。送信先は公式ホストだけに固定し、APIキーはこのホストにだけ使う。

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** 1回のリクエストの待機の期限。実機での計測までの暫定値。 */
export const OPENAI_TIMEOUT_MS = 120_000;
/** 429・5xxの応答が確定した場合の再試行の回数。 */
const MAX_RETRIES = 2;
/** Retry-Afterがない場合の待ち時間（1回目・2回目）。 */
const BACKOFF_MS = [2_000, 8_000] as const;
/** これより長いRetry-Afterは待たずに失敗にする。要約全体が長く止まるため。 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * 検証済みモデルのコンテキスト長と出力予約量。まだ検証したモデルがないため空。
 * プリセットにないモデルは、設定画面で入力した値を使う。
 */
export const OPENAI_MODEL_PRESETS: Readonly<Record<string, OpenAIModelLimits>> = {};

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

/** HTTPの送信。Obsidianでは`requestUrl`（`throw: false`）で実装する。通信できなければ例外を投げる。 */
export type HttpPost = (request: { url: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>;

export interface OpenAIProviderOptions {
	apiKey: string;
	model: string;
	limits: OpenAIModelLimits;
	post: HttpPost;
	timeoutMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
}

export class OpenAIProvider implements SummaryProvider {
	readonly id = 'openai';
	readonly alwaysSplit = false;
	readonly model: string;
	readonly limits: ProviderLimits;

	constructor(private readonly options: OpenAIProviderOptions) {
		this.model = options.model;
		this.limits = { contextTokens: options.limits.contextTokens, outputReserveTokens: options.limits.outputReserveTokens };
	}

	async generate(request: GenerateRequest): Promise<GenerateResult> {
		const body = JSON.stringify({
			model: this.model,
			instructions: request.instructions,
			input: request.input,
			max_output_tokens: request.maxOutputTokens,
			// APIのレスポンス保存を無効にする。サービス全体の無保持を保証する指定ではない。
			store: false,
		});
		for (let attempt = 0; ; attempt++) {
			if (request.signal.aborted) {
				return failure('aborted', '');
			}
			let response: HttpResponse;
			try {
				response = await this.send(body, request.signal);
			} catch (error) {
				// 送信済みかどうか分からないため、自動で送り直さない。
				if (error instanceof WaitAborted) {
					return failure(error.kind, '');
				}
				return failure('network', '');
			}
			const result = parseResponse(response);
			if (result.ok || !isRetryable(response.status) || attempt >= MAX_RETRIES) {
				return result;
			}
			const delay = retryDelay(response.headers, attempt, this.options.now?.() ?? Date.now());
			if (delay === undefined) {
				return result;
			}
			try {
				await (this.options.sleep ?? sleep)(delay, request.signal);
			} catch {
				return failure('aborted', '');
			}
		}
	}

	/**
	 * 期限か中断で待機を打ち切る。`requestUrl`には取り消しがないため、送信済みの処理は止まらない。
	 * 打ち切った後に届いたレスポンスは使わない。
	 */
	private send(body: string, signal: AbortSignal): Promise<HttpResponse> {
		const timeoutMs = this.options.timeoutMs ?? OPENAI_TIMEOUT_MS;
		return new Promise<HttpResponse>((resolve, reject) => {
			let settled = false;
			const finish = (action: () => void): void => {
				if (!settled) {
					settled = true;
					window.clearTimeout(timer);
					signal.removeEventListener('abort', onAbort);
					action();
				}
			};
			const timer = window.setTimeout(() => finish(() => reject(new WaitAborted('timeout'))), timeoutMs);
			const onAbort = (): void => finish(() => reject(new WaitAborted('aborted')));
			signal.addEventListener('abort', onAbort);
			this.options
				.post({
					url: OPENAI_RESPONSES_URL,
					headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
					body,
				})
				.then(
					(response) => finish(() => resolve(response)),
					(error: unknown) => finish(() => reject(error instanceof Error ? error : new Error('通信に失敗しました。'))),
				);
		});
	}
}

class WaitAborted extends Error {
	constructor(readonly kind: 'timeout' | 'aborted') {
		super(kind);
		this.name = 'WaitAborted';
	}
}

function failure(kind: ProviderErrorKind, message: string): GenerateResult {
	return { ok: false, kind, message };
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500;
}

/** Retry-After（秒またはHTTP日付）を優先する。長すぎる指定ではundefinedを返し、再試行しない。 */
export function retryDelay(headers: Record<string, string>, attempt: number, now: number): number | undefined {
	const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]?.trim();
	let delay: number | undefined;
	if (header !== undefined && /^\d+$/.test(header)) {
		delay = Number(header) * 1000;
	} else if (header !== undefined && !Number.isNaN(Date.parse(header))) {
		delay = Math.max(0, Date.parse(header) - now);
	}
	delay ??= BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? MAX_RETRY_AFTER_MS;
	return delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

/**
 * レスポンスを実行時に検証する。`output`の`type: message`から`output_text`を集める。
 * 拒否・未完了・空出力は失敗にする。メッセージにはステータスとエラーコードだけを含め、本文を含めない。
 */
export function parseResponse(response: HttpResponse): GenerateResult {
	let json: unknown;
	try {
		json = JSON.parse(response.text) as unknown;
	} catch {
		json = undefined;
	}
	if (response.status < 200 || response.status >= 300) {
		return failure(classifyError(response.status, errorCode(json)), describeStatus(response.status, errorCode(json)));
	}
	if (!isRecord(json) || !Array.isArray(json.output)) {
		return failure('server', '応答の形式が正しくありません。');
	}
	if (json.status === 'incomplete') {
		const reason = isRecord(json.incomplete_details) && typeof json.incomplete_details.reason === 'string' ? safeCode(json.incomplete_details.reason) : undefined;
		return failure('incomplete', reason ?? '');
	}
	if (json.status !== 'completed') {
		return failure('server', `応答の状態: ${typeof json.status === 'string' ? (safeCode(json.status) ?? '不明') : '不明'}`);
	}
	const texts: string[] = [];
	let refused = false;
	for (const item of json.output as unknown[]) {
		if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
			continue;
		}
		for (const part of item.content as unknown[]) {
			if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
				texts.push(part.text);
			} else if (isRecord(part) && part.type === 'refusal') {
				refused = true;
			}
		}
	}
	if (refused) {
		return failure('refused', '');
	}
	const text = texts.join('').trim();
	return text === '' ? failure('empty', '') : { ok: true, text };
}

function errorCode(json: unknown): string | undefined {
	if (!isRecord(json) || !isRecord(json.error)) {
		return undefined;
	}
	const { code, type } = json.error;
	return safeCode(typeof code === 'string' ? code : typeof type === 'string' ? type : undefined);
}

/** APIのエラーコードは英小文字と下線の識別子だけを使う。それ以外は本文を含みうるため捨てる。 */
function safeCode(value: string | undefined): string | undefined {
	return value !== undefined && /^[a-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function classifyError(status: number, code: string | undefined): ProviderErrorKind {
	if (status === 401 || status === 403) {
		return 'auth';
	}
	if (code === 'context_length_exceeded') {
		return 'contextExceeded';
	}
	if (status === 404 || code === 'model_not_found') {
		return 'invalidModel';
	}
	if (status === 429) {
		return 'rateLimited';
	}
	return 'server';
}

function describeStatus(status: number, code: string | undefined): string {
	return code === undefined ? `HTTP ${status}` : `HTTP ${status} ${code}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			window.clearTimeout(timer);
			reject(new Error('aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
