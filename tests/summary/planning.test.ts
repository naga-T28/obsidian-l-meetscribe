import { describe, expect, it } from 'vitest';
import { estimateTokens, groupForMerge, MERGE_SEPARATOR, PlanningError, splitTranscript } from '../../src/summary/planning';

const line = (index: number, text = '架空の発言です。'): string => `- [00:00:${String(index).padStart(2, '0')}] **自分**: ${text}`;

describe('estimateTokens', () => {
	it('UTF-8のバイト数を上限として使う', () => {
		expect(estimateTokens('abc')).toBe(3);
		expect(estimateTokens('会議')).toBe(6);
	});
});

describe('splitTranscript', () => {
	it('収まる文字起こしは1つにする', () => {
		const text = [line(1), line(2)].join('\n');
		expect(splitTranscript(text, { tokens: 10_000 })).toEqual([text]);
	});

	it('発言の境界で分け、行を切らない', () => {
		const lines = Array.from({ length: 10 }, (_, index) => line(index));
		const budget = { tokens: estimateTokens([lines[0], lines[1], lines[2]].join('\n')) };
		const parts = splitTranscript(lines.join('\n'), budget);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.every((part) => estimateTokens(part) <= budget.tokens)).toBe(true);
		expect(parts.join('\n')).toBe(lines.join('\n'));
	});

	it('文字数の上限もトークン数とは別に守る', () => {
		const lines = Array.from({ length: 6 }, (_, index) => line(index));
		const parts = splitTranscript(lines.join('\n'), { tokens: 100_000, chars: [...lines[0]!].length * 2 + 1 });
		expect(parts).toHaveLength(3);
	});

	it('上限を超える1つの発言だけを、文末を優先して分ける', () => {
		const long = line(1, 'あ'.repeat(30) + '。' + 'い'.repeat(30) + '。');
		const text = [line(0), long, line(2)].join('\n');
		const budget = { tokens: estimateTokens(long) - 10 };
		const parts = splitTranscript(text, budget);
		expect(parts.every((part) => estimateTokens(part) <= budget.tokens)).toBe(true);
		// 切り捨てずに、元の文字がすべて残る。
		expect(parts.join('').replaceAll('\n', '')).toBe(text.replaceAll('\n', ''));
		expect(parts.some((part) => part.endsWith('あ。'))).toBe(true);
	});

	it('入力に使える量がなければ失敗する', () => {
		expect(() => splitTranscript(line(1), { tokens: 0 })).toThrow(PlanningError);
	});
});

describe('groupForMerge', () => {
	it('全体が収まれば1組にする', () => {
		expect(groupForMerge(['a', 'b', 'c'], { tokens: 1000 })).toEqual([['a', 'b', 'c']]);
	});

	it('統合の入力を超える場合は組に分ける', () => {
		const item = 'x'.repeat(10);
		const budget = { tokens: estimateTokens([item, item].join(MERGE_SEPARATOR)) };
		expect(groupForMerge([item, item, item, item, item], budget)).toEqual([[item, item], [item, item], [item]]);
	});

	it('2件ずつもまとめられず件数が減らない場合と、1件が上限を超える場合は失敗する', () => {
		expect(() => groupForMerge(['x'.repeat(10), 'y'.repeat(10)], { tokens: 15 })).toThrow(PlanningError);
		expect(() => groupForMerge(['x'.repeat(20)], { tokens: 15 })).toThrow(PlanningError);
	});
});
