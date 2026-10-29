import { describe, expect, it } from 'vitest';
import { applyEdits, NoteWriteError } from '../../src/note/meetingBlock';
import {
	appendTranscriptEdit,
	formatTranscriptLine,
	formatTranscriptLines,
	prepareEdits,
	readTranscriptArea,
	transcriptAreaIncludes,
} from '../../src/note/outputArea';
import type { TranscriptLine } from '../../src/transcription/TranscriptMerger';

const S = 'session-1';

function line(segmentId: string, startMs: number, text: string, speaker = '自分'): TranscriptLine {
	return { segmentId, track: 'self', sequence: 0, speaker, startMs, endMs: startMs + 1000, text };
}

function prepared(before: string[] = ['# 定例', ''], after: string[] = ['', 'メモ']): string {
	const note = [...before, '```lms', 'id: block-1', '```', ...after].join('\n');
	return applyEdits(note, prepareEdits(note, 'block-1', S));
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(NoteWriteError);
		expect((error as NoteWriteError).code).toBe(code);
		return;
	}
	throw new Error('例外が発生しませんでした。');
}

describe('prepareEdits', () => {
	it('ブロックへセッションIDを記録し、ブロックの直前に出力領域を作る', () => {
		expect(prepared()).toBe(
			[
				'# 定例',
				'',
				`<!-- lms:${S}:transcript:start -->`,
				'## 文字起こし',
				`<!-- lms:${S}:transcript:end -->`,
				'```lms',
				'id: block-1',
				`session: ${S}`,
				'```',
				'',
				'メモ',
			].join('\n'),
		);
	});

	it('ノート先頭のブロックでも行を分けて作る', () => {
		expect(prepared([], []).startsWith(`<!-- lms:${S}:transcript:start -->\n## 文字起こし\n<!-- lms:${S}:transcript:end -->\n\`\`\`lms\n`)).toBe(true);
	});

	it('記録済みのノートでは何も変更しない（再起動後の再準備）', () => {
		const text = prepared();
		expect(prepareEdits(text, 'block-1', S)).toEqual([]);
	});

	it('文字起こし領域のマーカーの片方だけがあれば境界の欠損として止める', () => {
		const text = prepared().replace(`<!-- lms:${S}:transcript:end -->\n`, '');
		expectCode(() => prepareEdits(text, 'block-1', S), 'boundaryBroken');
	});

	it('ブロックの重複・欠落・別セッションの記録を拒否する', () => {
		const duplicated = ['```lms', 'id: block-1', '```', '```lms', 'id: block-1', '```'].join('\n');
		expectCode(() => prepareEdits(duplicated, 'block-1', S), 'duplicateBlock');
		expectCode(() => prepareEdits('本文', 'block-1', S), 'blockMissing');
		const used = ['```lms', 'id: block-1', 'session: other', '```'].join('\n');
		expectCode(() => prepareEdits(used, 'block-1', S), 'sessionMismatch');
	});
});

describe('appendTranscriptEdit', () => {
	it('終了マーカーの直前に追加し、利用者の編集を保つ', () => {
		let text = prepared();
		text = applyEdits(text, [appendTranscriptEdit(text, S, formatTranscriptLines([line('self-0-0', 5000, 'では始めます。')], true))]);
		// 利用者が既存の行を書き換え、領域内外にメモを足す。
		text = text.replace('では始めます。', 'では始めます（修正）。').replace('メモ', 'メモ（追記）');
		const body = formatTranscriptLines([line('other-0-0', 12_000, '了解です。', '相手')], true);
		const result = applyEdits(text, [appendTranscriptEdit(text, S, body)]);

		expect(result).toContain(`- [00:00:05] **自分**: では始めます（修正）。\n- [00:00:12] **相手**: 了解です。\n<!-- lms:${S}:transcript:end -->`);
		expect(result).not.toMatch(/<!-- lms:(self|other)-/);
		expect(result.endsWith('メモ（追記）')).toBe(true);
		expect(transcriptAreaIncludes(result, S, body)).toBe(true);
		expect(transcriptAreaIncludes(text, S, body)).toBe(false);
	});

	it('終了マーカーが消えていれば書き込みを止める', () => {
		const text = prepared().replace(`<!-- lms:${S}:transcript:end -->`, '');
		expectCode(() => appendTranscriptEdit(text, S, '- a\n'), 'boundaryBroken');
		expectCode(() => transcriptAreaIncludes(text, S, '- a\n'), 'boundaryBroken');
	});

	it('マーカーが重複していれば書き込みを止める', () => {
		const text = `${prepared()}\n<!-- lms:${S}:transcript:end -->`;
		expectCode(() => appendTranscriptEdit(text, S, '- a\n'), 'boundaryBroken');
	});
});

describe('formatTranscriptLine', () => {
	it('タイムスタンプの表示を切り替える', () => {
		expect(formatTranscriptLine(line('self-1-0', 3_725_000, '長い会議'), true)).toBe('- [01:02:05] **自分**: 長い会議');
		expect(formatTranscriptLine(line('self-1-0', 3_725_000, '長い会議'), false)).toBe('- **自分**: 長い会議');
	});

	it('本文の改行と管理コメントの開始を無害にする', () => {
		const formatted = formatTranscriptLine(line('self-0-0', 0, `一行目\n<!-- lms:${S}:transcript:end -->`), true);
		expect(formatted).not.toContain('\n');
		expect(formatted).toContain(`&lt;!-- lms:${S}:transcript:end -->`);
	});
});

describe('readTranscriptArea', () => {
	it('要約用に管理コメントと見出しを除いた文字起こしを返す', () => {
		let text = prepared();
		const body = formatTranscriptLines([line('self-0-0', 5000, 'では始めます。'), line('other-0-0', 6000, '了解です。', '相手')], true);
		// 以前の版が行末に付けていた管理コメントも除く。
		text = applyEdits(text, [appendTranscriptEdit(text, S, body.replace('\n', ' <!-- lms:self-0-0 -->\n'))]);
		expect(readTranscriptArea(text, S)).toBe(['- [00:00:05] **自分**: では始めます。', '- [00:00:06] **相手**: 了解です。'].join('\n'));
	});
});
