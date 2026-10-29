import { promises as fs } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from '../../src/session/records';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings, type LMeetscribeSettings } from '../../src/settings/settings';
import {
	getOllamaModelDetails,
	isLoopbackAddress,
	listOllamaModels,
	nodeOllamaTransport,
	OllamaError,
	OllamaProvider,
	parseChatResponse,
	parseModelDetails,
} from '../../src/summary/OllamaProvider';
import { createProviderResolver } from '../../src/summary/resolveProvider';
import { SummaryService } from '../../src/summary/SummaryService';

// 127.0.0.1で固定の応答を返すHTTPサーバーを立て、実際のNode.jsのHTTPクライアントで通信する。

const SUMMARY = '## 要約\n架空の会議\n## 決定事項\n- なし\n## タスク\n- なし\n## 未解決の論点\n- なし';
const LOCAL_SHOW = { capabilities: ['completion'], model_info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 131072 } };

interface Received {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
}

type Handler = (req: Received, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let received: Received[];
let handlers: Record<string, Handler>;

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
	res.end(JSON.stringify(body));
}

function chatReply(content: string, extra: Record<string, unknown> = {}): Handler {
	return (_req, res) => reply(res, 200, { model: 'local-model', message: { role: 'assistant', content }, done: true, done_reason: 'stop', ...extra });
}

async function startServer(): Promise<{ server: Server; url: string }> {
	const instance = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			const entry: Received = { method: req.method ?? '', path: req.url ?? '', body: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>) };
			received.push(entry);
			const handler = handlers[entry.path];
			if (handler === undefined) {
				reply(res, 404, { error: 'not found' });
				return;
			}
			handler(entry, res);
		});
	});
	await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
	return { server: instance, url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}` };
}

beforeAll(() => {
	vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
});

beforeEach(async () => {
	received = [];
	handlers = {};
	({ server, url: baseUrl } = await startServer());
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

describe('通信の制限', () => {
	it('ループバック以外のURLには接続しない', async () => {
		await expect(nodeOllamaTransport({ baseUrl: 'http://192.168.1.10:11434', method: 'GET', path: '/api/tags', timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'notLoopback' });
		await expect(nodeOllamaTransport({ baseUrl: 'http://example.com', method: 'GET', path: '/api/tags', timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'notLoopback' });
	});

	it('ループバックのアドレスだけを許す', () => {
		expect(isLoopbackAddress('127.0.0.1')).toBe(true);
		expect(isLoopbackAddress('127.1.2.3')).toBe(true);
		expect(isLoopbackAddress('::1')).toBe(true);
		expect(isLoopbackAddress('10.0.0.1')).toBe(false);
		expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
	});

	it('リダイレクトを追わずに拒否する', async () => {
		const target = await startServer();
		try {
			const targetReceived = received.length;
			handlers['/api/chat'] = (_req, res) => reply(res, 307, {}, { Location: `${target.url}/api/chat` });
			await expect(nodeOllamaTransport({ baseUrl, method: 'POST', path: '/api/chat', body: { model: 'm' }, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'redirect' });
			// 転送先へは送っていない（受信は元のサーバーの1件だけ）。
			expect(received.length - targetReceived).toBe(1);
		} finally {
			await new Promise((resolve) => target.server.close(resolve));
		}
	});

	it('未起動なら接続できないとして失敗する', async () => {
		const closed = await startServer();
		await new Promise((resolve) => closed.server.close(resolve));
		await expect(nodeOllamaTransport({ baseUrl: closed.url, method: 'GET', path: '/api/tags', timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'unreachable' });
	});

	it('期限を過ぎたら打ち切る', async () => {
		handlers['/api/tags'] = () => undefined;
		await expect(nodeOllamaTransport({ baseUrl, method: 'GET', path: '/api/tags', timeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' });
	});
});

describe('モデル一覧と詳細', () => {
	it('インストール済みのモデルを名前順に返し、外部実行のモデルを除く', async () => {
		handlers['/api/tags'] = (_req, res) =>
			reply(res, 200, {
				models: [
					{ name: 'qwen3:8b', size: 1 },
					{ name: 'gpt-oss:120b-cloud', remote_model: 'gpt-oss:120b', remote_host: 'https://ollama.com:443' },
					{ name: 'gemma3:4b', size: 1 },
				],
			});
		await expect(listOllamaModels(baseUrl)).resolves.toEqual(['gemma3:4b', 'qwen3:8b']);
	});

	it('外部実行の印や本体の情報がなければローカルと判定しない。名前の末尾では判定しない', () => {
		expect(parseModelDetails(LOCAL_SHOW)).toEqual({ local: true, contextLength: 131072, thinking: false });
		expect(parseModelDetails({ ...LOCAL_SHOW, remote_host: 'https://ollama.com:443' }).local).toBe(false);
		expect(parseModelDetails({ capabilities: ['completion'] }).local).toBe(false);
		expect(parseModelDetails({ ...LOCAL_SHOW, capabilities: ['completion', 'thinking'] }).thinking).toBe(true);
	});

	it('モデル詳細をPOST /api/showで取得する', async () => {
		handlers['/api/show'] = (_req, res) => reply(res, 200, LOCAL_SHOW);
		await expect(getOllamaModelDetails(baseUrl, 'gemma3:4b-cloud')).resolves.toMatchObject({ local: true });
		expect(received[0]).toMatchObject({ method: 'POST', path: '/api/show', body: { model: 'gemma3:4b-cloud' } });
	});
});

describe('OllamaProvider', () => {
	function provider(think?: boolean): OllamaProvider {
		const options: ConstructorParameters<typeof OllamaProvider>[0] = {
			baseUrl,
			model: 'local-model',
			limits: { contextTokens: 8192, outputReserveTokens: 2048, chunkChars: 4000 },
			timeoutMs: 1000,
		};
		if (think !== undefined) {
			options.think = think;
		}
		return new OllamaProvider(options);
	}

	const request = { instructions: '指示', input: '<transcript>\n架空の発言\n</transcript>', maxOutputTokens: 2048, signal: new AbortController().signal };

	it('messages・num_ctx・stream: falseを送り、本文を返す', async () => {
		handlers['/api/chat'] = chatReply(` ${SUMMARY} `, { message: { role: 'assistant', content: SUMMARY, thinking: '考えた内容' } });
		await expect(provider().generate(request)).resolves.toEqual({ ok: true, text: SUMMARY });
		expect(received[0]?.body).toEqual({
			model: 'local-model',
			messages: [
				{ role: 'system', content: '指示' },
				{ role: 'user', content: '<transcript>\n架空の発言\n</transcript>' },
			],
			stream: false,
			options: { num_ctx: 8192, num_predict: 2048 },
		});
	});

	it('thinkingに対応したモデルにだけthinkを送る', async () => {
		handlers['/api/chat'] = chatReply(SUMMARY);
		await provider(false).generate(request);
		expect(received[0]?.body?.think).toBe(false);
	});

	it('出力上限で切れた応答・空の応答・HTTPエラー・未起動・タイムアウトを失敗にする', async () => {
		expect(parseChatResponse({ message: { content: 'a' }, done_reason: 'length' })).toMatchObject({ ok: false, kind: 'incomplete' });
		expect(parseChatResponse({ message: { content: ' ' } })).toMatchObject({ ok: false, kind: 'empty' });
		handlers['/api/chat'] = (_req, res) => reply(res, 404, { error: 'model not found' });
		await expect(provider().generate(request)).resolves.toEqual({ ok: false, kind: 'invalidModel', message: 'HTTP 404' });
		handlers['/api/chat'] = () => undefined;
		await expect(provider().generate(request)).resolves.toMatchObject({ ok: false, kind: 'timeout' });
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await expect(provider().generate(request)).resolves.toMatchObject({ ok: false, kind: 'network' });
		({ server, url: baseUrl } = await startServer());
	});

	it('常に部分要約と統合の2段階を求める', () => {
		expect(provider().alwaysSplit).toBe(true);
	});
});

describe('Ollamaの実行先の解決', () => {
	let posts: number;
	const resolve = (summary: LMeetscribeSettings['summary']): ReturnType<ReturnType<typeof createProviderResolver>> =>
		createProviderResolver({
			getSecret: () => 'sk-should-not-be-used',
			post: () => {
				posts += 1;
				return Promise.reject(new Error('OpenAIへ送ってはいけない'));
			},
		})(summary);

	function settings(model = 'local-model'): LMeetscribeSettings['summary'] {
		const summary = createDefaultSettings().summary;
		summary.provider = 'ollama';
		summary.ollama.url = baseUrl;
		summary.ollama.model = model;
		return summary;
	}

	beforeEach(() => {
		posts = 0;
	});

	it('ローカル実行を確認できたモデルで、モデルの最大を超えないコンテキスト長を使う', async () => {
		handlers['/api/show'] = (_req, res) => reply(res, 200, { ...LOCAL_SHOW, model_info: { 'llama.context_length': 4096 }, capabilities: ['completion', 'thinking'] });
		const resolved = await resolve(settings());
		expect('provider' in resolved && resolved.provider.limits).toEqual({ contextTokens: 4096, outputReserveTokens: 1024, chunkChars: 4000 });
	});

	it('外部実行のモデルには本文を送らず、OpenAIへも切り替えない', async () => {
		handlers['/api/show'] = (_req, res) => reply(res, 200, { ...LOCAL_SHOW, remote_host: 'https://ollama.com:443', remote_model: 'x' });
		await expect(resolve(settings('x-cloud'))).resolves.toMatchObject({ skip: expect.stringContaining('確認できない') as string });
		expect(received.map((entry) => entry.path)).toEqual(['/api/show']);
		expect(posts).toBe(0);
	});

	it('未起動なら理由を示して省略する', async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await expect(resolve(settings())).resolves.toMatchObject({ skip: expect.stringContaining('起動') as string });
		expect(posts).toBe(0);
		({ server, url: baseUrl } = await startServer());
	});

	it('ループバック以外のURLやモデルの未選択では省略する', async () => {
		const remote = settings();
		remote.ollama.url = 'http://10.0.0.5:11434';
		await expect(resolve(remote)).resolves.toMatchObject({ skip: expect.stringContaining('ループバック') as string });
		await expect(resolve(settings(''))).resolves.toMatchObject({ skip: expect.stringContaining('未選択') as string });
		expect(received).toHaveLength(0);
	});
});

describe('SummaryServiceとOllamaProviderの結合', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'lms-ollama-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('短い入力でも部分要約と統合を通して要約を保存する', async () => {
		handlers['/api/show'] = (_req, res) => reply(res, 200, LOCAL_SHOW);
		handlers['/api/chat'] = (req, res) => {
			const messages = req.body?.messages as { content: string }[];
			const isFinal = messages[1]?.content.startsWith('<notes>') === true;
			reply(res, 200, { message: { role: 'assistant', content: isFinal ? SUMMARY : '### 要点\n- 架空の要点' }, done: true, done_reason: 'stop' });
		};
		const store = new SessionStore(join(dir, 'sessions'));
		const session: SessionRecord = {
			schemaVersion: SESSION_SCHEMA_VERSION,
			sessionId: 's-1',
			blockId: 'b-1',
			notePath: 'a.md',
			startedAt: '2026-10-29T00:00:00.000Z',
			state: 'summarizing',
			settings: createDefaultSettings(),
		};
		session.settings.summary.provider = 'ollama';
		session.settings.summary.ollama.url = baseUrl;
		session.settings.summary.ollama.model = 'local-model';
		await store.createSession(session);
		const service = new SummaryService({
			store,
			readTranscript: () => Promise.resolve('- [00:00:01] **自分**: 架空の発言です。'),
			resolveProvider: createProviderResolver({ getSecret: () => null, post: () => Promise.reject(new Error('unused')) }),
			createRunId: () => 'run-1',
		});
		await expect(service.summarize(session, session.settings.summary)).resolves.toEqual({ status: 'success' });
		expect(received.map((entry) => entry.path)).toEqual(['/api/show', '/api/chat', '/api/chat']);
		expect((await store.loadSummary('s-1'))?.provider).toBe('ollama');
	});
});

describe('OllamaError', () => {
	it('種類とステータスを持つ', () => {
		expect(new OllamaError('http', 'x', 500)).toMatchObject({ kind: 'http', status: 500 });
	});
});
