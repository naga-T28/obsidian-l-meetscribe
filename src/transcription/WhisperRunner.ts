import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { isRecord } from '../json';
import type { WhisperLanguage } from '../settings/validation';

// whisper-cliを1チャンクずつ起動し、JSON出力を検証して区間を返す。
// 標準出力の表示文字列には依存せず、-ojで書かれたファイルだけを読む。

/** タイムアウト・中断でSIGTERMを送ってから、SIGKILLへ切り替えるまでの時間。 */
const KILL_GRACE_MS = 5000;

export interface WhisperRequest {
	executablePath: string;
	modelPath: string;
	wavPath: string;
	language: WhisperLanguage;
	/** `-of`へ渡す出力ファイルの接頭辞。`<接頭辞>.json`が書かれる。 */
	outputPrefix: string;
	/** チャンクの長さ。区間がこの範囲に収まるかを確かめる。 */
	durationMs: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** チャンク先頭からのミリ秒で表した区間。 */
export interface WhisperSegment {
	startMs: number;
	endMs: number;
	text: string;
}

export type WhisperFailure = 'exit' | 'timeout' | 'output' | 'aborted';

/** メッセージには文字起こしの内容を含めない。 */
export class WhisperError extends Error {
	constructor(
		readonly reason: WhisperFailure,
		message: string,
	) {
		super(message);
		this.name = 'WhisperError';
	}
}

export type RunWhisper = (request: WhisperRequest) => Promise<WhisperSegment[]>;

export async function runWhisper(request: WhisperRequest): Promise<WhisperSegment[]> {
	const outputPath = `${request.outputPrefix}.json`;
	// 前回の試行の出力を今回の結果として読まないよう、起動前に消す。
	await fs.rm(outputPath, { force: true });
	await runProcess(request);
	let text: string;
	try {
		text = await fs.readFile(outputPath, 'utf8');
	} catch {
		throw new WhisperError('output', 'whisper-cliがJSONファイルを出力しませんでした。');
	}
	try {
		return parseWhisperOutput(text, request.durationMs);
	} finally {
		// 結果は呼び出し側が作業領域の記録へ保存する。重複した内容を残さない。
		await fs.rm(outputPath, { force: true });
	}
}

function runProcess(request: WhisperRequest): Promise<void> {
	if (request.signal?.aborted === true) {
		return Promise.reject(new WhisperError('aborted', '文字起こしを中断しました。'));
	}
	const args = ['-m', request.modelPath, '-f', request.wavPath, '-l', request.language, '-oj', '-of', request.outputPrefix];
	return new Promise((resolve, reject) => {
		// 標準出力・標準エラーには認識結果が含まれるため読まない。
		const child = spawn(request.executablePath, args, { shell: false, stdio: 'ignore' });
		let stopping: WhisperError | undefined;
		let killTimer: number | undefined;
		const stop = (error: WhisperError): void => {
			if (stopping !== undefined) {
				return;
			}
			stopping = error;
			child.kill('SIGTERM');
			killTimer = window.setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
		};
		const timeout = window.setTimeout(
			() => stop(new WhisperError('timeout', `whisper-cliが${Math.round(request.timeoutMs / 1000)}秒以内に終了しませんでした。`)),
			request.timeoutMs,
		);
		const onAbort = (): void => stop(new WhisperError('aborted', '文字起こしを中断しました。'));
		request.signal?.addEventListener('abort', onAbort);
		const cleanup = (): void => {
			window.clearTimeout(timeout);
			window.clearTimeout(killTimer);
			request.signal?.removeEventListener('abort', onAbort);
		};
		child.once('error', () => {
			cleanup();
			reject(new WhisperError('exit', 'whisper-cliを起動できませんでした。'));
		});
		child.once('exit', (code, signal) => {
			cleanup();
			if (stopping !== undefined) {
				reject(stopping);
			} else if (code !== 0) {
				const status = signal !== null ? `シグナル${signal}` : `終了コード${code ?? '不明'}`;
				reject(new WhisperError('exit', `whisper-cliが異常終了しました（${status}）。`));
			} else {
				resolve();
			}
		});
	});
}

/**
 * whisper-cliは時刻を10ミリ秒単位で切り上げ、チャンク長を少し超える終了時刻を返すことがある（例: 10,000ミリ秒のチャンクで10,020）。
 * この程度のはみ出しはチャンク長に切り詰める。
 */
const OFFSET_TOLERANCE_MS = 1000;

/**
 * `transcription[].offsets.from/to`をミリ秒として読む。`0 ≤ 開始 ≤ 終了`で、チャンク長からのはみ出しが許容範囲内でなければ失敗にする。
 * 許容範囲内のはみ出しはチャンク長に切り詰める。
 */
export function parseWhisperOutput(text: string, durationMs: number): WhisperSegment[] {
	let root: unknown;
	try {
		root = JSON.parse(text) as unknown;
	} catch {
		// JSON.parseのメッセージには内容の一部が含まれるため使わない。
		throw new WhisperError('output', 'whisper-cliのJSONを読み込めません。');
	}
	const transcription = isRecord(root) ? root.transcription : undefined;
	if (!Array.isArray(transcription)) {
		throw new WhisperError('output', 'whisper-cliのJSONにtranscriptionがありません。');
	}
	const segments: WhisperSegment[] = [];
	transcription.forEach((entry: unknown, index) => {
		const offsets = isRecord(entry) ? entry.offsets : undefined;
		const from = isRecord(offsets) ? offsets.from : undefined;
		const to = isRecord(offsets) ? offsets.to : undefined;
		const segmentText = isRecord(entry) ? entry.text : undefined;
		if (typeof from !== 'number' || typeof to !== 'number' || typeof segmentText !== 'string') {
			throw new WhisperError('output', `whisper-cliのJSONの${index + 1}番目の区間に必須の値がありません。`);
		}
		if (!(from >= 0 && from <= to && to <= durationMs + OFFSET_TOLERANCE_MS)) {
			throw new WhisperError('output', `whisper-cliの${index + 1}番目の区間がチャンクの範囲外です。`);
		}
		const trimmed = segmentText.trim();
		// 認識結果のない区間はノートへ出す内容がない。
		if (trimmed !== '') {
			segments.push({ startMs: Math.min(from, durationMs), endMs: Math.min(to, durationMs), text: trimmed });
		}
	});
	return segments;
}
