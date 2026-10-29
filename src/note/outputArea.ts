import { createHash } from 'crypto';
import type { TranscriptLine } from '../transcription/TranscriptMerger';
import { type Line, locateBlock, NoteWriteError, recordBlockSession, splitLines, type TextEdit } from './meetingBlock';

// 会議ブロックの上の出力領域。上から要約・文字起こしの順に置き、文字起こしをブロックの直前にする。
// 領域は開始・終了マーカーの行で囲み、セッションIDで特定する。
// 管理領域の外と、文字起こし領域の既存行には触れない。

export type AreaKind = 'transcript' | 'summary';

export function areaMarker(sessionId: string, kind: AreaKind, edge: 'start' | 'end'): string {
	return `<!-- lms:${sessionId}:${kind}:${edge} -->`;
}

export interface Area {
	/** 開始・終了マーカーの行番号。 */
	startLine: number;
	endLine: number;
}

/** 領域がなければundefined。マーカーの片方だけ、重複、順序の逆転は境界の欠損として書き込みを止める。 */
export function findArea(lines: readonly Line[], sessionId: string, kind: AreaKind): Area | undefined {
	const starts = indexesOf(lines, areaMarker(sessionId, kind, 'start'));
	const ends = indexesOf(lines, areaMarker(sessionId, kind, 'end'));
	if (starts.length === 0 && ends.length === 0) {
		return undefined;
	}
	const [startLine] = starts;
	const [endLine] = ends;
	if (starts.length !== 1 || ends.length !== 1 || startLine === undefined || endLine === undefined || endLine < startLine) {
		throw new NoteWriteError('boundaryBroken', 'ノートの出力領域の境界（lmsの管理コメント）が欠けているか重複しています。書き込みを止めました。');
	}
	return { startLine, endLine };
}

function indexesOf(lines: readonly Line[], marker: string): number[] {
	return lines.flatMap((line, index) => (line.text.trim() === marker ? [index] : []));
}

function requireArea(lines: readonly Line[], sessionId: string, kind: AreaKind): Area {
	const area = findArea(lines, sessionId, kind);
	if (area === undefined) {
		throw new NoteWriteError('boundaryBroken', 'ノートに出力領域が見つかりません。書き込みを止めました。');
	}
	return area;
}

/**
 * 録音開始時の変更。ブロックへセッションIDを記録し、文字起こしの領域がなければブロックの直前に作る。
 * 再起動後など領域があれば作り直さない。
 */
export function prepareEdits(text: string, blockId: string, sessionId: string): TextEdit[] {
	const lines = splitLines(text);
	const edits = recordBlockSession(lines, blockId, sessionId);
	if (findArea(lines, sessionId, 'transcript') !== undefined) {
		return edits;
	}
	const opening = lines[locateBlock(lines, blockId).openLine];
	if (opening === undefined) {
		throw new NoteWriteError('blockMissing', 'ノートに会議ブロックが見つかりません。');
	}
	const area = [
		areaMarker(sessionId, 'transcript', 'start'),
		'## 文字起こし',
		areaMarker(sessionId, 'transcript', 'end'),
	];
	// 開きフェンスの行頭に挿入する。セッションIDの記録（ブロックの内側）とは範囲が重ならない。
	edits.push({ from: opening.start, to: opening.start, text: `${area.join('\n')}\n` });
	return edits;
}

/** 追記する文字起こしの行。1行ごとに改行で終わる。 */
export function formatTranscriptLines(lines: readonly TranscriptLine[], showTimestamps: boolean): string {
	return lines.map((line) => `${formatTranscriptLine(line, showTimestamps)}\n`).join('');
}

export function formatTranscriptLine(line: TranscriptLine, showTimestamps: boolean): string {
	const time = showTimestamps ? `[${formatOffset(line.startMs)}] ` : '';
	return `- ${time}**${line.speaker}**: ${neutralizeText(line.text)}`;
}

/** 文字起こし領域の終了マーカーの直前に本文を追加する変更を返す。既存の行には触れない。 */
export function appendTranscriptEdit(text: string, sessionId: string, body: string): TextEdit {
	const lines = splitLines(text);
	const end = lines[requireArea(lines, sessionId, 'transcript').endLine];
	if (end === undefined) {
		throw new NoteWriteError('boundaryBroken', 'ノートに出力領域が見つかりません。書き込みを止めました。');
	}
	return { from: end.start, to: end.start, text: body };
}

/** 文字起こし領域に本文がそのまま含まれるか。追記がディスク上のノートに保存されたことの確認に使う。境界が壊れていれば止める。 */
export function transcriptAreaIncludes(text: string, sessionId: string, body: string): boolean {
	const lines = splitLines(text);
	const area = findArea(lines, sessionId, 'transcript');
	const start = area === undefined ? undefined : lines[area.startLine];
	const end = area === undefined ? undefined : lines[area.endLine];
	return start !== undefined && end !== undefined && text.slice(start.end + 1, end.start).includes(body);
}

/** セッション開始からの経過時間をHH:MM:SSで表す。 */
export function formatOffset(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/**
 * 認識結果を1行に収め、管理コメントとして解釈されないようにする。
 * 文字の削除・連結はせず、改行を空白に、コメントの開始をHTML文字参照に置き換えるだけにする。
 */
function neutralizeText(text: string): string {
	return text.replace(/\r?\n/g, ' ').replace(/<!--/g, '&lt;!--');
}

/** 要約へ渡す文字起こし。利用者の編集を含む領域の中身から、管理コメントと見出しを除く。 */
export function readTranscriptArea(text: string, sessionId: string): string {
	const lines = splitLines(text);
	const area = requireArea(lines, sessionId, 'transcript');
	return lines
		.slice(area.startLine + 1, area.endLine)
		.map((line) => line.text.replace(/<!--[\s\S]*?-->/g, '').trimEnd())
		.filter((line) => line.trim() !== '' && line.trim() !== '## 文字起こし')
		.join('\n');
}

/** 要約領域の中身（マーカーの行を除く）。領域がなければundefined。 */
export function readSummaryArea(text: string, sessionId: string): string | undefined {
	const lines = splitLines(text);
	const area = findArea(lines, sessionId, 'summary');
	return area === undefined ? undefined : areaContent(lines, area);
}

function areaContent(lines: readonly Line[], area: Area): string {
	return lines
		.slice(area.startLine + 1, area.endLine)
		.map((line) => line.text)
		.join('\n')
		.trim();
}

export function hashSummary(content: string): string {
	return `sha256-${createHash('sha256').update(content.trim()).digest('hex')}`;
}

export interface SummaryWrite {
	edit: TextEdit;
	/** 置き換えた場合は新しい内容のハッシュ。別案として追記した場合はundefined（以前の記録を残す）。 */
	hash: string | undefined;
}

/**
 * 要約領域へ要約を書く変更を返す。領域がなければ文字起こし領域の直前に作る。
 * 領域が空か、最後に書いた内容のまま（lastHashと一致）なら置き換える。
 * 利用者が編集していれば置き換えず、末尾へ別案として追記する。完了済みのタスクも編集として扱われ、未完了に戻らない。
 */
export function writeSummaryEdit(text: string, sessionId: string, summary: string, lastHash: string | undefined, label: string): SummaryWrite {
	const lines = splitLines(text);
	const body = summary.trim();
	const area = findArea(lines, sessionId, 'summary');
	if (area === undefined) {
		const transcript = requireArea(lines, sessionId, 'transcript');
		const start = lines[transcript.startLine];
		if (start === undefined) {
			throw new NoteWriteError('boundaryBroken', 'ノートに出力領域が見つかりません。書き込みを止めました。');
		}
		const block = [areaMarker(sessionId, 'summary', 'start'), body, areaMarker(sessionId, 'summary', 'end')].join('\n');
		return { edit: { from: start.start, to: start.start, text: `${block}\n` }, hash: hashSummary(body) };
	}
	const start = lines[area.startLine];
	const end = lines[area.endLine];
	if (start === undefined || end === undefined) {
		throw new NoteWriteError('boundaryBroken', 'ノートに出力領域が見つかりません。書き込みを止めました。');
	}
	const current = areaContent(lines, area);
	if (current === '' || (lastHash !== undefined && hashSummary(current) === lastHash)) {
		return { edit: { from: start.end + 1, to: end.start, text: `${body}\n` }, hash: hashSummary(body) };
	}
	return { edit: { from: end.start, to: end.start, text: `\n---\n\n**${label}**\n\n${body}\n` }, hash: undefined };
}
