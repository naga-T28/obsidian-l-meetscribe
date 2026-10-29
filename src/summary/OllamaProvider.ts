import { lookup as dnsLookup, type LookupAddress } from 'dns';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { isIP } from 'net';
import { isRecord } from '../json';
import { validateOllamaUrl } from '../settings/validation';
import type { GenerateRequest, GenerateResult, ProviderErrorKind, ProviderLimits, SummaryProvider } from './SummaryProvider';

// 同じMacのOllamaでの要約。文字起こしをMacの外へ出さないため、接続先はループバックに限り、リダイレクトを追わない。
// 本文は、モデル詳細でローカル実行を確認できたモデルにだけ送る。

/** 一覧・詳細の取得の期限。 */
export const OLLAMA_INFO_TIMEOUT_MS = 10_000;
/** 1回の要約の期限。ローカルモデルは遅いため長めにする。実機での計測までの暫定値。 */
export const OLLAMA_CHAT_TIMEOUT_MS = 300_000;
/** 応答の大きさの上限。想定外の応答でメモリを使い切らないため。 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type OllamaFailure = 'notLoopback' | 'redirect' | 'unreachable' | 'timeout' | 'aborted' | 'http' | 'invalidResponse';

/** メッセージには本文を含めない。 */
export class OllamaError extends Error {
	constructor(
		readonly kind: OllamaFailure,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = 'OllamaError';
	}
}

export interface OllamaRequest {
	baseUrl: string;
	method: 'GET' | 'POST';
	path: '/api/tags' | '/api/show' | '/api/chat';
	body?: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** 2xxならJSONを返し、それ以外はOllamaErrorを投げる。 */
export type OllamaTransport = (request: OllamaRequest) => Promise<unknown>;

/** 127.0.0.0/8と::1だけをループバックとして扱う。 */
export function isLoopbackAddress(address: string): boolean {
	if (isIP(address) === 4) {
		return address.startsWith('127.');
	}
	return address === '::1' || address === '::ffff:127.0.0.1' || /^::ffff:127\./.test(address);
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 名前解決の結果がループバックでなければ接続しない。localhostが外部のアドレスを指す設定への備え。 */
function loopbackLookup(hostname: string, options: object, callback: LookupCallback): void {
	dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error !== null) {
			callback(error, []);
			return;
		}
		const allowed = addresses.filter((entry) => isLoopbackAddress(entry.address));
		if (allowed.length === 0 || allowed.length !== addresses.length) {
			callback(Object.assign(new Error('接続先がループバックアドレスではありません。'), { code: 'ENOTLOOPBACK' }), []);
			return;
		}
		if ('all' in options && options.all === true) {
			callback(null, allowed);
		} else {
			const [first] = allowed;
			callback(null, first?.address ?? '', first?.family);
		}
	});
}

/** Node.jsのHTTPクライアントでの実装。 */
export const nodeOllamaTransport: OllamaTransport = (request) => {
	const problem = validateOllamaUrl(request.baseUrl);
	if (problem !== undefined) {
		return Promise.reject(new OllamaError('notLoopback', problem));
	}
	const url = new URL(request.path, request.baseUrl);
	const body = request.body === undefined ? undefined : JSON.stringify(request.body);
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void): void => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				request.signal?.removeEventListener('abort', onAbort);
				action();
			}
		};
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const req = send(
			url,
			{
				method: request.method,
				headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
				lookup: loopbackLookup,
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400) {
					// 転送先を追わない。ループバック以外へ本文が送られる経路を作らないため。
					res.resume();
					req.destroy();
					finish(() => reject(new OllamaError('redirect', `Ollamaがリダイレクト（HTTP ${status}）を返したため、接続を中止しました。`, status)));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_RESPONSE_BYTES) {
						req.destroy();
						finish(() => reject(new OllamaError('invalidResponse', 'Ollamaの応答が大きすぎます。')));
						return;
					}
					chunks.push(chunk);
				});
				res.on('end', () => {
					let json: unknown;
					try {
						json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
					} catch {
						finish(() => reject(new OllamaError(status >= 200 && status < 300 ? 'invalidResponse' : 'http', `Ollamaの応答を読めません（HTTP ${status}）。`, status)));
						return;
					}
					if (status < 200 || status >= 300) {
						finish(() => reject(new OllamaError('http', `OllamaがHTTP ${status}を返しました。`, status)));
						return;
					}
					finish(() => resolve(json));
				});
				res.on('error', () => finish(() => reject(new OllamaError('unreachable', 'Ollamaとの通信が途切れました。'))));
			},
		);
		const timer = window.setTimeout(() => {
			req.destroy();
			finish(() => reject(new OllamaError('timeout', `Ollamaが${Math.round(request.timeoutMs / 1000)}秒以内に応答しませんでした。`)));
		}, request.timeoutMs);
		const onAbort = (): void => {
			req.destroy();
			finish(() => reject(new OllamaError('aborted', '要約を中断しました。')));
		};
		request.signal?.addEventListener('abort', onAbort);
		if (request.signal?.aborted === true) {
			onAbort();
		}
		req.on('error', (error: NodeJS.ErrnoException) => {
			const kind = error.code === 'ENOTLOOPBACK' ? 'notLoopback' : 'unreachable';
			const message = kind === 'notLoopback' ? '接続先がループバックアドレスではありません。' : 'Ollamaに接続できません。Ollamaが起動しているか確認してください。';
			finish(() => reject(new OllamaError(kind, message)));
		});
		req.end(body);
	});
};

/** 外部で実行されるモデル（クラウドモデル）の印。モデル名ではなく、APIの応答の項目で判定する。 */
function isRemoteEntry(value: Record<string, unknown>): boolean {
	return value.remote_host !== undefined || value.remote_model !== undefined;
}

/** インストール済みのモデル名。外部で実行されると分かったモデルは含めない。 */
export async function listOllamaModels(baseUrl: string, transport: OllamaTransport = nodeOllamaTransport): Promise<string[]> {
	const json = await transport({ baseUrl, method: 'GET', path: '/api/tags', timeoutMs: OLLAMA_INFO_TIMEOUT_MS });
	if (!isRecord(json) || !Array.isArray(json.models)) {
		throw new OllamaError('invalidResponse', 'Ollamaのモデル一覧の形式が正しくありません。');
	}
	const names: string[] = [];
	for (const entry of json.models as unknown[]) {
		if (isRecord(entry) && typeof entry.name === 'string' && entry.name !== '' && !isRemoteEntry(entry)) {
			names.push(entry.name);
		}
	}
	return names.sort((a, b) => a.localeCompare(b));
}

export interface OllamaModelDetails {
	/** ローカル実行を確認できた。falseなら本文を送らない。 */
	local: boolean;
	/** モデルが扱える最大のコンテキスト長。分からなければundefined。 */
	contextLength?: number;
	/** `capabilities`にthinkingがある。 */
	thinking: boolean;
}

/**
 * `/api/show`の応答から、ローカル実行かどうかとコンテキスト長・thinkingの対応を読む。
 * 外部実行の印がなく、モデル本体の情報（`model_info`のコンテキスト長）がある場合だけローカルとみなす。
 */
export function parseModelDetails(json: unknown): OllamaModelDetails {
	if (!isRecord(json)) {
		return { local: false, thinking: false };
	}
	let contextLength: number | undefined;
	if (isRecord(json.model_info)) {
		for (const [key, value] of Object.entries(json.model_info)) {
			if (key.endsWith('.context_length') && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
				contextLength = value;
			}
		}
	}
	const capabilities = Array.isArray(json.capabilities) ? (json.capabilities as unknown[]) : [];
	const details: OllamaModelDetails = {
		local: !isRemoteEntry(json) && contextLength !== undefined,
		thinking: capabilities.includes('thinking'),
	};
	if (contextLength !== undefined) {
		details.contextLength = contextLength;
	}
	return details;
}

export async function getOllamaModelDetails(baseUrl: string, model: string, transport: OllamaTransport = nodeOllamaTransport): Promise<OllamaModelDetails> {
	return parseModelDetails(await transport({ baseUrl, method: 'POST', path: '/api/show', body: { model }, timeoutMs: OLLAMA_INFO_TIMEOUT_MS }));
}

export interface OllamaProviderOptions {
	baseUrl: string;
	model: string;
	limits: Required<Pick<ProviderLimits, 'contextTokens' | 'outputReserveTokens' | 'chunkChars'>>;
	/** モデルがthinkingに対応している場合だけ送る値。対応していなければundefined。 */
	think?: boolean;
	transport?: OllamaTransport;
	timeoutMs?: number;
}

export class OllamaProvider implements SummaryProvider {
	readonly id = 'ollama';
	/** ローカルモデルは常に部分要約と統合の2段階を通す。小さいモデルでは長い入力を一度に要約すると質が落ちやすいため。 */
	readonly alwaysSplit = true;
	readonly model: string;
	readonly limits: ProviderLimits;

	constructor(private readonly options: OllamaProviderOptions) {
		this.model = options.model;
		this.limits = { ...options.limits };
	}

	async generate(request: GenerateRequest): Promise<GenerateResult> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages: [
				{ role: 'system', content: request.instructions },
				{ role: 'user', content: request.input },
			],
			stream: false,
			options: { num_ctx: this.limits.contextTokens, num_predict: request.maxOutputTokens },
		};
		if (this.options.think !== undefined) {
			body.think = this.options.think;
		}
		let json: unknown;
		try {
			json = await (this.options.transport ?? nodeOllamaTransport)({
				baseUrl: this.options.baseUrl,
				method: 'POST',
				path: '/api/chat',
				body,
				timeoutMs: this.options.timeoutMs ?? OLLAMA_CHAT_TIMEOUT_MS,
				signal: request.signal,
			});
		} catch (error) {
			if (error instanceof OllamaError) {
				return { ok: false, kind: providerKind(error), message: error.status === undefined ? '' : `HTTP ${error.status}` };
			}
			throw error;
		}
		return parseChatResponse(json);
	}
}

function providerKind(error: OllamaError): ProviderErrorKind {
	switch (error.kind) {
		case 'timeout':
			return 'timeout';
		case 'aborted':
			return 'aborted';
		case 'http':
			return error.status === 404 ? 'invalidModel' : 'server';
		case 'invalidResponse':
			return 'server';
		default:
			return 'network';
	}
}

/** `message.content`だけを使い、thinkingの内容は使わない。出力上限で切れた応答は未完了にする。 */
export function parseChatResponse(json: unknown): GenerateResult {
	if (!isRecord(json) || !isRecord(json.message) || typeof json.message.content !== 'string') {
		return { ok: false, kind: 'server', message: '応答の形式が正しくありません。' };
	}
	if (json.done_reason === 'length') {
		return { ok: false, kind: 'incomplete', message: 'length' };
	}
	const text = json.message.content.trim();
	return text === '' ? { ok: false, kind: 'empty', message: '' } : { ok: true, text };
}
