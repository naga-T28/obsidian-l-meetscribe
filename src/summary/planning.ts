// 要約の入力の分割と、統合の組み分け。コンテキスト長に収まることを保証するため、トークン数は上限で見積もる。

/** 1回のリクエストで指示・入力のほかに見込むトークン数（メッセージの区切りなど）。 */
export const REQUEST_OVERHEAD_TOKENS = 64;

/**
 * トークン数の上限の見積もり。バイト単位のBPE（OpenAI）やバイトへの退避を持つ分割器では、
 * 1トークンは1バイト以上を表すため、UTF-8のバイト数を超えない。日本語では実際の約3倍と大きめになる。
 */
export function estimateTokens(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}

export interface Budget {
	/** 入力に使えるトークン数。 */
	tokens: number;
	/** 入力の文字数の上限。指定がなければ制限しない。 */
	chars?: number;
}

/** 指示と出力予約を除いた、入力に使えるトークン数。 */
export function inputBudget(contextTokens: number, outputReserveTokens: number, instructions: string, scale: number): number {
	return Math.floor((contextTokens - outputReserveTokens - estimateTokens(instructions) - REQUEST_OVERHEAD_TOKENS) * scale);
}

export function fits(text: string, budget: Budget): boolean {
	return estimateTokens(text) <= budget.tokens && (budget.chars === undefined || [...text].length <= budget.chars);
}

export class PlanningError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlanningError';
	}
}

/**
 * 文字起こしを発言（行）の境界で分ける。1つの発言が上限を超える場合だけ、その発言の本文を分ける。
 * 内容は切り捨てない。各部分を改行で連結すると元の行の並びに戻る。
 */
export function splitTranscript(text: string, budget: Budget): string[] {
	if (budget.tokens <= 0 || (budget.chars !== undefined && budget.chars <= 0)) {
		throw new PlanningError('コンテキスト長が指示と出力予約に対して小さすぎます。コンテキスト長を増やすか、出力予約を減らしてください。');
	}
	const lines = text.split('\n').filter((line) => line.trim() !== '');
	const parts: string[] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length > 0) {
			parts.push(current.join('\n'));
			current = [];
		}
	};
	for (const line of lines) {
		if (!fits(line, budget)) {
			flush();
			parts.push(...splitLongText(line, budget));
			continue;
		}
		if (!fits([...current, line].join('\n'), budget)) {
			flush();
		}
		current.push(line);
	}
	flush();
	return parts;
}

/** 上限に収まる最長の先頭部分を取り、その中に文末があれば文末で区切る。 */
function splitLongText(text: string, budget: Budget): string[] {
	const pieces: string[] = [];
	let rest = [...text];
	while (rest.length > 0) {
		let length = 0;
		let bytes = 0;
		while (length < rest.length && (budget.chars === undefined || length < budget.chars)) {
			const next = bytes + Buffer.byteLength(rest[length] ?? '', 'utf8');
			if (next > budget.tokens) {
				break;
			}
			bytes = next;
			length += 1;
		}
		if (length === 0) {
			throw new PlanningError('コンテキスト長が小さすぎて、発言を1文字も入れられません。');
		}
		if (length < rest.length) {
			const head = rest.slice(0, length).join('');
			const sentenceEnd = Math.max(...['。', '！', '？', '. ', '! ', '? '].map((mark) => head.lastIndexOf(mark)));
			// 文末が後半にある場合だけ使う。前の方で区切ると部分が細かくなりすぎる。
			if (sentenceEnd >= head.length / 2) {
				length = [...head.slice(0, sentenceEnd + 1)].length;
			}
		}
		pieces.push(rest.slice(0, length).join(''));
		rest = rest.slice(length);
	}
	return pieces;
}

export const MERGE_SEPARATOR = '\n\n---\n\n';

/**
 * 部分要約を、1回の統合に収まるように順に組み分ける。全体が収まれば1組になる。
 * どの組にも2件以上をまとめられない場合は、統合しても件数が減らないため失敗にする。
 */
export function groupForMerge(items: readonly string[], budget: Budget): string[][] {
	const groups: string[][] = [];
	let current: string[] = [];
	for (const item of items) {
		if (!fits(item, budget)) {
			throw new PlanningError('部分要約が統合の入力上限を超えました。コンテキスト長を増やすか、出力予約を減らしてください。');
		}
		if (current.length > 0 && !fits([...current, item].join(MERGE_SEPARATOR), budget)) {
			groups.push(current);
			current = [];
		}
		current.push(item);
	}
	if (current.length > 0) {
		groups.push(current);
	}
	// 組の数が件数と同じなら、統合しても件数が減らず終わらない。
	if (groups.length > 1 && groups.length === items.length) {
		throw new PlanningError('統合の入力上限が小さく、部分要約をまとめられません。コンテキスト長を増やすか、出力予約を減らしてください。');
	}
	return groups;
}
