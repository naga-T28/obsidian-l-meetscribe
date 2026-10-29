import { describe, expect, it } from 'vitest';
import { applyEdits, findMeetingBlockIds, insertBlockId, NoteWriteError, parseMeetingBlock } from '../../src/note/meetingBlock';

describe('parseMeetingBlock', () => {
	it('空のブロックを判定する', () => {
		expect(parseMeetingBlock('\n  \n')).toEqual({ id: undefined, session: undefined, empty: true });
	});

	it('IDの行を読む', () => {
		expect(parseMeetingBlock('id: 3f2a-b1\n')).toEqual({ id: '3f2a-b1', session: undefined, empty: false });
	});

	it('セッションIDの行を読む', () => {
		expect(parseMeetingBlock('id: b-1\nsession: s-1\n')).toEqual({ id: 'b-1', session: 's-1', empty: false });
	});

	it('形式の正しくないIDを無視する', () => {
		expect(parseMeetingBlock('id: ../x\n').id).toBeUndefined();
	});
});

describe('findMeetingBlockIds', () => {
	it('lmsブロックの中のIDだけを数える', () => {
		const text = ['id: outside', '```lms', 'id: a-1', '```', '```js', 'id: b-1', '```', '~~~lms', 'id: a-1', '~~~', '```lms', '```'].join('\n');

		expect(findMeetingBlockIds(text)).toEqual(['a-1', 'a-1']);
	});
});

describe('insertBlockId', () => {
	const note = ['# 定例', '', '```lms', '```', '', '本文'].join('\n');

	it('空のブロックにIDの行を加え、他の行を変えない', () => {
		expect(applyEdits(note, [insertBlockId(note, 2, 3, 'id-1')])).toBe(['# 定例', '', '```lms', 'id: id-1', '```', '', '本文'].join('\n'));
	});

	it('空行だけのブロックは空行をIDの行に置き換える', () => {
		const text = ['```lms', '', '```'].join('\n');

		expect(applyEdits(text, [insertBlockId(text, 0, 2, 'id-1')])).toBe(['```lms', 'id: id-1', '```'].join('\n'));
	});

	it.each([
		['行がずれた', ['本文', '# 定例', '', '```lms', '```'].join('\n')],
		['既にIDがある', ['# 定例', '', '```lms', 'id: other', '```'].join('\n')],
		['別の言語のブロック', ['# 定例', '', '```js', '```'].join('\n')],
	])('%s場合は書き換えない', (_name, text) => {
		expect(() => insertBlockId(text, 2, 3, 'id-1')).toThrow(NoteWriteError);
	});
});
