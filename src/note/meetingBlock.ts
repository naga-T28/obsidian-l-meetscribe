import { isValidStorageId } from '../session/records';

// lmsブロックの本文の解析と、ブロックへのID・セッションIDの記録。
// 出力領域はoutputArea.tsが扱う。ここではブロックの中だけを扱う。
// 変更は本文全体ではなく範囲の置換（TextEdit）で返す。Editorのトランザクションと
// Vault.processのどちらでも、最新の本文から求めた同じ変更を適用できるようにするため。

/** 本文のfromからtoまでをtextで置き換える。位置は文字数（UTF-16）のオフセット。 */
export interface TextEdit {
	from: number;
	to: number;
	text: string;
}

/** 重ならない変更を後ろから適用する。 */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
	let result = text;
	for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
		result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
	}
	return result;
}

export interface MeetingBlockSource {
	/** 形式が正しいIDだけを返す。 */
	id: string | undefined;
	/** このブロックで録音したセッション。1ブロックにつき1セッションで、新しい録音には新しいブロックを使う。 */
	session: string | undefined;
	/** IDの行以外も含めて空のブロックか。IDは空のブロックにだけ付ける。 */
	empty: boolean;
}

export function parseMeetingBlock(source: string): MeetingBlockSource {
	return { id: findField(source, 'id'), session: findField(source, 'session'), empty: source.trim() === '' };
}

function findField(source: string, key: string): string | undefined {
	let value: string | undefined;
	for (const line of source.split('\n')) {
		const match = new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`).exec(line);
		if (match?.[1] !== undefined && isValidStorageId(match[1])) {
			value = match[1];
		}
	}
	return value;
}

/** ノートの本文を行に分け、各行の開始オフセットを持つ。 */
export interface Line {
	text: string;
	/** 行頭のオフセット。 */
	start: number;
	/** 改行を含まない行末のオフセット。 */
	end: number;
}

export function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (const lineText of text.split('\n')) {
		lines.push({ text: lineText, start, end: start + lineText.length });
		start += lineText.length + 1;
	}
	return lines;
}

export interface LocatedBlock {
	/** 開きフェンスと閉じフェンスの行番号。 */
	openLine: number;
	closeLine: number;
	source: MeetingBlockSource;
}

/** ノート内のlmsブロックを出現順に返す。閉じフェンスのないブロックは含めない。 */
export function findMeetingBlocks(lines: readonly Line[]): LocatedBlock[] {
	const blocks: LocatedBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const fence = /^\s*(`{3,}|~{3,})\s*lms\s*$/.exec(lines[i]?.text ?? '');
		if (fence?.[1] === undefined) {
			continue;
		}
		const close = fence[1];
		const openLine = i;
		for (i += 1; i < lines.length && !(lines[i]?.text ?? '').trim().startsWith(close); i++) {
			// 閉じフェンスまで進める。
		}
		if (i >= lines.length) {
			break;
		}
		const body = lines.slice(openLine + 1, i).map((line) => line.text);
		blocks.push({ openLine, closeLine: i, source: parseMeetingBlock(body.join('\n')) });
	}
	return blocks;
}

/** ノート内のlmsブロックのIDを出現順に返す。複製で重複したIDの検出に使う。 */
export function findMeetingBlockIds(text: string): string[] {
	return findMeetingBlocks(splitLines(text)).flatMap((block) => (block.source.id === undefined ? [] : [block.source.id]));
}

export type NoteErrorCode = 'blockChanged' | 'blockMissing' | 'duplicateBlock' | 'sessionMismatch' | 'boundaryBroken' | 'noteMissing' | 'notSaved';

/** ノートの状態が想定と違い、書き込みを止めた。内容は含めない。codeは会議ブロックの案内に使う。 */
export class NoteWriteError extends Error {
	constructor(
		readonly code: NoteErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'NoteWriteError';
	}
}

/** IDのブロックを1つだけ見つける。見つからない、または重複していれば書き込みを止める。 */
export function locateBlock(lines: readonly Line[], blockId: string): LocatedBlock {
	const matches = findMeetingBlocks(lines).filter((block) => block.source.id === blockId);
	if (matches.length > 1) {
		throw new NoteWriteError('duplicateBlock', 'このノートに同じIDの会議ブロックが複数あります。複製したブロックを削除してください。');
	}
	const block = matches[0];
	if (block === undefined) {
		throw new NoteWriteError('blockMissing', 'ノートに会議ブロックが見つかりません。');
	}
	return block;
}

/**
 * 指定した行範囲の空のlmsブロックにIDの行を加える変更を返す。
 * 行範囲は描画時のものなので、最新の本文で空のlmsブロックのままかを確かめ、違えば書き換えない。
 */
export function insertBlockId(text: string, lineStart: number, lineEnd: number, id: string): TextEdit {
	const lines = splitLines(text);
	const opening = lines[lineStart];
	const closing = lines[lineEnd];
	const fence = /^\s*(`{3,}|~{3,})\s*lms\s*$/.exec(opening?.text ?? '');
	const inner = lines.slice(lineStart + 1, lineEnd);
	if (
		opening === undefined ||
		closing === undefined ||
		fence?.[1] === undefined ||
		!closing.text.trim().startsWith(fence[1]) ||
		lineEnd <= lineStart ||
		inner.some((line) => line.text.trim() !== '')
	) {
		throw new NoteWriteError('blockChanged', '会議ブロックが描画後に変更されました。表示が更新されてから、もう一度操作してください。');
	}
	// 空行を含む中身をIDの行で置き換える。
	return { from: opening.end + 1, to: closing.start, text: `id: ${id}\n` };
}

/** ブロックにセッションIDを記録する変更を返す。同じセッションが記録済みなら変更しない。 */
export function recordBlockSession(lines: readonly Line[], blockId: string, sessionId: string): TextEdit[] {
	const block = locateBlock(lines, blockId);
	if (block.source.session === sessionId) {
		return [];
	}
	if (block.source.session !== undefined) {
		throw new NoteWriteError('sessionMismatch', 'この会議ブロックには別の録音が記録されています。新しい空のlmsブロックを使ってください。');
	}
	const closing = lines[block.closeLine];
	if (closing === undefined) {
		throw new NoteWriteError('blockMissing', 'ノートに会議ブロックが見つかりません。');
	}
	return [{ from: closing.start, to: closing.start, text: `session: ${sessionId}\n` }];
}
