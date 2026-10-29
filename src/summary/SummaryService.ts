import { createHash } from 'crypto';
import type { Summarizer, SummaryListener, SummaryOutcome, SummaryProgress } from '../session/ports';
import type { SessionRecord, SummaryRun } from '../session/records';
import type { SessionStore } from '../session/SessionStore';
import type { LMeetscribeSettings } from '../settings/settings';
import { estimateTokens, fits, groupForMerge, inputBudget, MERGE_SEPARATOR, PlanningError, splitTranscript, type Budget } from './planning';
import {
	DIRECT_INSTRUCTIONS,
	FINAL_MERGE_INSTRUCTIONS,
	INTERMEDIATE_MERGE_INSTRUCTIONS,
	normalizeSummary,
	PARTIAL_INSTRUCTIONS,
	wrapInput,
} from './prompts';
import type { GenerateResult, ProviderErrorKind, ResolveProvider, SummaryProvider } from './SummaryProvider';

/** 実行先が入力の上限超過を返した時に、分割を縮小して実行し直す倍率。 */
const RETRY_SCALES = [1, 0.5, 0.25] as const;

const ERROR_LABELS: Readonly<Record<ProviderErrorKind, string>> = {
	auth: '認証に失敗しました。APIキーを確認してください。',
	invalidModel: 'モデルを使用できません。モデル名を確認してください。',
	rateLimited: '利用上限に達しました。時間をおいて手動で要約してください。',
	server: '要約の実行先でエラーが起きました。時間をおいて手動で要約してください。',
	network: '要約の実行先に接続できません。',
	timeout: '要約の実行先が時間内に応答しませんでした。',
	refused: 'モデルが要約を拒否しました。',
	incomplete: 'モデルの出力が途中で終わりました。',
	empty: 'モデルの出力が空でした。',
	contextExceeded: '入力がモデルの上限を超えました。コンテキスト長の設定を確認してください。',
	aborted: '要約を中断しました。',
};

export interface SummaryServiceOptions {
	store: Pick<SessionStore, 'loadChunks' | 'saveSummary'>;
	/** ノートの文字起こし領域（NoteWriter.readTranscript）。境界が壊れていれば例外を投げる。 */
	readTranscript(notePath: string, sessionId: string): Promise<string>;
	resolveProvider: ResolveProvider;
	createRunId(): string;
}

/** 新しい実行や中断で、この実行の結果を使わなくなった。 */
class SupersededError extends Error {
	constructor() {
		super('新しい要約の実行に置き換えられました。');
		this.name = 'SupersededError';
	}
}

class ProviderFailure extends Error {
	constructor(readonly kind: ProviderErrorKind, message: string) {
		super(message);
		this.name = 'ProviderFailure';
	}
}

interface ActiveRun {
	runId: string;
	controller: AbortController;
}

/**
 * 実行先に依存しない要約の共通処理。
 * 入力の固定、発言の境界での分割、段階的な統合、進捗の記録を行い、HTTPはSummaryProviderに任せる。
 */
export class SummaryService implements Summarizer {
	/** セッションごとの最新の実行。これ以外の実行の結果は保存しない。 */
	private readonly active = new Map<string, ActiveRun>();

	constructor(private readonly options: SummaryServiceOptions) {}

	async summarize(session: SessionRecord, settings: LMeetscribeSettings['summary'], listener?: SummaryListener): Promise<SummaryOutcome> {
		const { sessionId } = session;
		const chunks = await this.options.store.loadChunks(sessionId);
		// 失敗したチャンクは除外済み（停止後に会議を完了させる）。未処理のチャンクが残る間だけ要約しない。
		if (chunks.some((chunk) => chunk.state === 'pending')) {
			return { status: 'skipped', reason: '未処理の文字起こしが残っているため、要約しません。' };
		}
		let input: string;
		try {
			input = await this.options.readTranscript(session.notePath, sessionId);
		} catch (error) {
			return { status: 'failed', reason: `文字起こし領域を読めません: ${describe(error)}` };
		}
		if (input.trim() === '') {
			return { status: 'skipped', reason: '文字起こしが空のため、要約しません。' };
		}
		const resolved = await this.options.resolveProvider(settings);
		if ('skip' in resolved) {
			return { status: 'skipped', reason: resolved.skip };
		}
		const { provider } = resolved;

		// 以前の実行を打ち切り、遅れて返った結果を使わないようにする。
		this.active.get(sessionId)?.controller.abort();
		const run: ActiveRun = { runId: this.options.createRunId(), controller: new AbortController() };
		this.active.set(sessionId, run);
		const record: SummaryRun = {
			runId: run.runId,
			provider: provider.id,
			model: provider.model,
			status: 'running',
			progress: { completed: 0, total: 0 },
			inputHash: `sha256-${createHash('sha256').update(input).digest('hex')}`,
			input,
			settings: structuredClone(settings),
		};
		try {
			await this.options.store.saveSummary(sessionId, record);
			const result = await this.run(sessionId, run, provider, input, async (progress) => {
				record.progress = progress;
				listener?.progress({ ...progress });
				await this.save(sessionId, run, record);
			});
			record.status = 'success';
			record.result = result;
			await this.save(sessionId, run, record);
			return { status: 'success' };
		} catch (error) {
			if (error instanceof SupersededError) {
				return { status: 'failed', reason: error.message };
			}
			const reason = error instanceof ProviderFailure ? ERROR_LABELS[error.kind] + (error.message === '' ? '' : `（${error.message}）`) : describe(error);
			record.status = 'failed';
			record.reason = reason;
			await this.save(sessionId, run, record).catch(() => undefined);
			return { status: 'failed', reason };
		} finally {
			if (this.active.get(sessionId) === run) {
				this.active.delete(sessionId);
			}
		}
	}

	/** プラグインの終了時に呼ぶ。実行中の要約を打ち切り、後から返った結果を保存しない。 */
	cancelAll(): void {
		for (const run of this.active.values()) {
			run.controller.abort();
		}
		this.active.clear();
	}

	/** 実行先が上限超過を返したら、分割を小さくして最初からやり直す。 */
	private async run(
		sessionId: string,
		run: ActiveRun,
		provider: SummaryProvider,
		input: string,
		report: (progress: SummaryProgress) => Promise<void>,
	): Promise<string> {
		let lastError: ProviderFailure | undefined;
		for (const scale of RETRY_SCALES) {
			try {
				return await new Plan(provider, scale, (instructions, text) => this.generate(sessionId, run, provider, instructions, text), report).execute(input);
			} catch (error) {
				if (error instanceof ProviderFailure && error.kind === 'contextExceeded') {
					lastError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastError ?? new ProviderFailure('contextExceeded', '');
	}

	private async generate(sessionId: string, run: ActiveRun, provider: SummaryProvider, instructions: string, input: string): Promise<string> {
		this.ensureCurrent(sessionId, run);
		let result: GenerateResult;
		try {
			result = await provider.generate({ instructions, input, maxOutputTokens: provider.limits.outputReserveTokens, signal: run.controller.signal });
		} catch (error) {
			this.ensureCurrent(sessionId, run);
			throw error;
		}
		// 待っている間に中断・再実行された場合は、成功していても結果を使わない。
		this.ensureCurrent(sessionId, run);
		if (!result.ok) {
			throw new ProviderFailure(result.kind, result.message);
		}
		return result.text;
	}

	private ensureCurrent(sessionId: string, run: ActiveRun): void {
		if (this.active.get(sessionId) !== run || run.controller.signal.aborted) {
			throw new SupersededError();
		}
	}

	private async save(sessionId: string, run: ActiveRun, record: SummaryRun): Promise<void> {
		this.ensureCurrent(sessionId, run);
		await this.options.store.saveSummary(sessionId, structuredClone(record));
	}
}

type Generate = (instructions: string, input: string) => Promise<string>;

/** 1回の実行の分割・統合の手順。進捗は済んだリクエスト数と、見込みのリクエスト数で表す。 */
class Plan {
	private completed = 0;
	private total = 0;

	constructor(
		private readonly provider: SummaryProvider,
		private readonly scale: number,
		private readonly generate: Generate,
		private readonly report: (progress: SummaryProgress) => Promise<void>,
	) {}

	async execute(transcript: string): Promise<string> {
		const directBudget = this.budget(DIRECT_INSTRUCTIONS);
		if (!this.provider.alwaysSplit && fits(transcript, directBudget)) {
			this.total = 1;
			await this.report({ completed: 0, total: 1 });
			return this.finish(await this.step(DIRECT_INSTRUCTIONS, wrapInput('transcript', transcript)));
		}
		const parts = splitTranscript(transcript, this.budget(PARTIAL_INSTRUCTIONS));
		// 統合は少なくとも1回行う。段数は部分要約の長さで決まるため、分かった時点で増やす。
		this.total = parts.length + 1;
		await this.report({ completed: 0, total: this.total });
		let notes: string[] = [];
		for (const part of parts) {
			notes.push(await this.step(PARTIAL_INSTRUCTIONS, wrapInput('transcript', part)));
		}
		for (;;) {
			const groups = groupForMerge(notes, this.budget(FINAL_MERGE_INSTRUCTIONS));
			if (groups.length === 1) {
				return this.finish(await this.step(FINAL_MERGE_INSTRUCTIONS, wrapInput('notes', notes.join(MERGE_SEPARATOR))));
			}
			// 途中の統合の分だけ見込みを増やす。最後の1回はすでに数えている。
			// 件数は毎回減る（groupForMergeが保証する）ため、このループは終わる。
			const intermediate = groupForMerge(notes, this.budget(INTERMEDIATE_MERGE_INSTRUCTIONS));
			this.total += intermediate.length;
			const merged: string[] = [];
			for (const group of intermediate) {
				merged.push(await this.step(INTERMEDIATE_MERGE_INSTRUCTIONS, wrapInput('notes', group.join(MERGE_SEPARATOR))));
			}
			notes = merged;
		}
	}

	private budget(instructions: string): Budget {
		const { contextTokens, outputReserveTokens, chunkChars } = this.provider.limits;
		const budget: Budget = { tokens: inputBudget(contextTokens, outputReserveTokens, instructions, this.scale) };
		if (chunkChars !== undefined) {
			budget.chars = Math.floor(chunkChars * this.scale);
		}
		if (budget.tokens <= estimateTokens(MERGE_SEPARATOR)) {
			throw new PlanningError('コンテキスト長が指示と出力予約に対して小さすぎます。コンテキスト長を増やすか、出力予約を減らしてください。');
		}
		return budget;
	}

	private async step(instructions: string, input: string): Promise<string> {
		const text = await this.generate(instructions, input);
		this.completed += 1;
		await this.report({ completed: this.completed, total: this.total });
		return text;
	}

	private finish(text: string): string {
		const summary = normalizeSummary(text);
		if (summary === undefined) {
			throw new Error('要約の出力に「要約・決定事項・タスク・未解決の論点」の見出しがそろっていません。手動で要約し直してください。');
		}
		return summary;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
