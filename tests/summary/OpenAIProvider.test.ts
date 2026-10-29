import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from '../../src/session/records';
import { SessionStore } from '../../src/session/SessionStore';
import { createDefaultSettings } from '../../src/settings/settings';
import { type HttpPost, type HttpResponse, OPENAI_RESPONSES_URL, OpenAIProvider, retryDelay } from '../../src/summary/OpenAIProvider';
import { createProviderResolver } from '../../src/summary/resolveProvider';
import type { GenerateRequest } from '../../src/summary/SummaryProvider';
import { SummaryService } from '../../src/summary/SummaryService';

// OpenAIの応答は、Responses APIの形を模した固定のJSONで返す。実際の通信は行わない。

const API_KEY = 'sk-test-secret-value';
const SUMMARY = '## 要約\n架空の会議\n## 決定事項\n- なし\n## タスク\n- なし\n## 未解決の論点\n- なし';

interface Sent {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, text: JSON.stringify(body) };
}

function completed(text: string): HttpResponse {
	return json(200, {
		status: 'completed',
		output: [
			{ type: 'reasoning', summary: [] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
		],
	});
}

let sent: Sent[];
let responses: (HttpResponse | Error | 'hang')[];
let sleeps: number[];

const post: HttpPost = (request) => {
	sent.push({ url: request.url, headers: request.headers, body: JSON.parse(request.body) as Record<string, unknown> });
	const next = responses.shift() ?? completed(SUMMARY);
	if (next === 'hang') {
		return new Promise(() => undefined);
	}
	return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
};

function provider(timeoutMs = 1000): OpenAIProvider {
	return new OpenAIProvider({
		apiKey: API_KEY,
		model: 'gpt-test',
		limits: { contextTokens: 100_000, outputReserveTokens: 2000 },
		post,
		timeoutMs,
		sleep: (ms) => {
			sleeps.push(ms);
			return Promise.resolve();
		},
		now: () => Date.parse('2026-10-29T00:00:00Z'),
	});
}

function request(signal = new AbortController().signal): GenerateRequest {
	return { instructions: '指示', input: '<transcript>\n架空の発言\n</transcript>', maxOutputTokens: 2000, signal };
}

beforeAll(() => {
	vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
});

beforeEach(() => {
	sent = [];
	responses = [];
	sleeps = [];
});

describe('OpenAIProvider', () => {
	it('公式ホストへ必要な項目だけを送り、output_textを取り出す', async () => {
		await expect(provider().generate(request())).resolves.toEqual({ ok: true, text: SUMMARY });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe('https://api.openai.com/v1/responses');
		expect(sent[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(sent[0]?.body).toEqual({ model: 'gpt-test', instructions: '指示', input: '<transcript>\n架空の発言\n</transcript>', max_output_tokens: 2000, store: false });
	});

	it('拒否・未完了・空出力・形式違いを失敗にする', async () => {
		responses = [
			json(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'できません' }] }] }),
			json(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }),
			json(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '  ' }] }] }),
			{ status: 200, headers: {}, text: 'not json' },
		];
		const p = provider();
		await expect(p.generate(request())).resolves.toMatchObject({ ok: false, kind: 'refused' });
		await expect(p.generate(request())).resolves.toEqual({ ok: false, kind: 'incomplete', message: 'max_output_tokens' });
		await expect(p.generate(request())).resolves.toMatchObject({ ok: false, kind: 'empty' });
		await expect(p.generate(request())).resolves.toMatchObject({ ok: false, kind: 'server' });
		expect(sent).toHaveLength(4);
	});

	it.each([
		[401, undefined, 'auth'],
		[403, undefined, 'auth'],
		[404, 'model_not_found', 'invalidModel'],
		[400, 'context_length_exceeded', 'contextExceeded'],
	])('%i（%s）は再試行せずに%sとして返す', async (status, code, kind) => {
		responses = [json(status, { error: { code, message: `本文を含むかもしれない説明 ${API_KEY}` } })];
		const result = await provider().generate(request());
		expect(result).toMatchObject({ ok: false, kind });
		expect(sent).toHaveLength(1);
		// エラーの文言にAPIキーやAPIの説明文を含めない。
		expect(JSON.stringify(result)).not.toContain(API_KEY);
		expect(JSON.stringify(result)).not.toContain('説明');
	});

	it('429はRetry-Afterを優先して待ち、再試行する', async () => {
		responses = [json(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '3' }), completed(SUMMARY)];
		await expect(provider().generate(request())).resolves.toEqual({ ok: true, text: SUMMARY });
		expect(sleeps).toEqual([3000]);
		expect(sent).toHaveLength(2);
	});

	it('5xxは最大2回まで再試行し、それでも失敗なら失敗を返す', async () => {
		responses = [json(500, {}), json(502, {}), json(503, {}), completed(SUMMARY)];
		await expect(provider().generate(request())).resolves.toMatchObject({ ok: false, kind: 'server', message: 'HTTP 503' });
		expect(sent).toHaveLength(3);
		expect(sleeps).toEqual([2000, 8000]);
	});

	it('長すぎるRetry-Afterは待たずに失敗にする', async () => {
		responses = [json(429, {}, { 'Retry-After': '600' })];
		await expect(provider().generate(request())).resolves.toMatchObject({ ok: false, kind: 'rateLimited' });
		expect(sent).toHaveLength(1);
	});

	it('期限を過ぎたら待機を打ち切り、送り直さない', async () => {
		responses = ['hang'];
		await expect(provider(50).generate(request())).resolves.toMatchObject({ ok: false, kind: 'timeout' });
		expect(sent).toHaveLength(1);
	});

	it('通信の失敗は送信済みか分からないため送り直さない', async () => {
		responses = [new Error('net::ERR_CONNECTION_RESET')];
		await expect(provider().generate(request())).resolves.toEqual({ ok: false, kind: 'network', message: '' });
		expect(sent).toHaveLength(1);
	});

	it('中断の要求で待機を打ち切る', async () => {
		responses = ['hang'];
		const controller = new AbortController();
		const running = provider().generate(request(controller.signal));
		controller.abort();
		await expect(running).resolves.toMatchObject({ ok: false, kind: 'aborted' });
	});
});

describe('retryDelay', () => {
	it('秒・HTTP日付のRetry-Afterと、ない場合の既定の待ち時間を返す', () => {
		const now = Date.parse('2026-10-29T00:00:00Z');
		expect(retryDelay({ 'Retry-After': '5' }, 0, now)).toBe(5000);
		expect(retryDelay({ 'retry-after': 'Thu, 29 Oct 2026 00:00:10 GMT' }, 0, now)).toBe(10_000);
		expect(retryDelay({}, 1, now)).toBe(8000);
	});
});

describe('createProviderResolver', () => {
	const settings = (): ReturnType<typeof createDefaultSettings>['summary'] => {
		const summary = createDefaultSettings().summary;
		summary.openai.apiKeySecretId = 'openai-key';
		summary.openai.model = 'gpt-test';
		summary.openai.modelLimits = { 'gpt-test': { contextTokens: 100_000, outputReserveTokens: 2000 } };
		return summary;
	};
	const resolve = createProviderResolver({ getSecret: (id) => (id === 'openai-key' ? API_KEY : null), post });

	it('APIキー・モデル・上限がそろえばOpenAIの実行先を返す', async () => {
		const resolved = await resolve(settings());
		expect('provider' in resolved && resolved.provider.limits).toEqual({ contextTokens: 100_000, outputReserveTokens: 2000 });
	});

	it('未設定の項目があれば理由を示して省略する', async () => {
		const noKey = settings();
		noKey.openai.apiKeySecretId = 'missing';
		const noModel = settings();
		noModel.openai.model = '';
		const noLimits = settings();
		noLimits.openai.modelLimits = {};
		await expect(resolve(noKey)).resolves.toEqual({ skip: 'OpenAIのAPIキーが未設定です。設定画面で設定してください。' });
		await expect(resolve(noModel)).resolves.toMatchObject({ skip: expect.stringContaining('モデルが未設定') as string });
		await expect(resolve(noLimits)).resolves.toMatchObject({ skip: expect.stringContaining('コンテキスト長') as string });
	});

	it('Ollamaを選んでいればOpenAIへ切り替えない', async () => {
		const ollama = settings();
		ollama.provider = 'ollama';
		const resolved = await resolve(ollama);
		expect('skip' in resolved).toBe(true);
		expect(sent).toHaveLength(0);
	});
});

describe('SummaryServiceとOpenAIProviderの結合', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'lms-openai-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('固定レスポンスで要約を保存し、送信先は公式ホストだけである', async () => {
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
		session.settings.summary.openai.apiKeySecretId = 'openai-key';
		session.settings.summary.openai.model = 'gpt-test';
		session.settings.summary.openai.modelLimits = { 'gpt-test': { contextTokens: 100_000, outputReserveTokens: 2000 } };
		await store.createSession(session);
		const service = new SummaryService({
			store,
			readTranscript: () => Promise.resolve('- [00:00:01] **自分**: 架空の発言です。'),
			resolveProvider: createProviderResolver({ getSecret: () => API_KEY, post }),
			createRunId: () => 'run-1',
		});
		await expect(service.summarize(session, session.settings.summary)).resolves.toEqual({ status: 'success' });
		expect((await store.loadSummary('s-1'))?.result).toBe(SUMMARY);
		expect(new Set(sent.map((entry) => entry.url))).toEqual(new Set([OPENAI_RESPONSES_URL]));
		// 作業領域にAPIキーを書かない。
		const files = await fs.readdir(store.sessionDir('s-1'));
		for (const file of files) {
			expect(await fs.readFile(join(store.sessionDir('s-1'), file), 'utf8')).not.toContain(API_KEY);
		}
	});
});
