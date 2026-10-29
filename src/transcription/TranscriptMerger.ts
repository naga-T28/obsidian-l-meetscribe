import type { ChunkRecord, SegmentRecord, Track } from '../session/records';
import type { LMeetscribeSettings } from '../settings/settings';

// 2トラックの区間を1本の文字起こしへ統合する。作業領域の記録だけから求める純粋な処理で、
// ノートへの反映（NoteWriter）は毎回最新の記録からこの結果を作り、未反映の区間だけを追記する。

export interface TranscriptLine {
	segmentId: string;
	track: Track;
	/** 区間を含む時間窓の番号。 */
	sequence: number;
	/** 入力経路で決めた話者ラベル。 */
	speaker: string;
	/** セッション開始からのミリ秒。 */
	startMs: number;
	endMs: number;
	text: string;
}

export interface MergedTranscript {
	/** 確定した時間窓の区間を、開始時刻・トラック（自分→相手）・区間の位置の順に並べたもの。 */
	lines: TranscriptLine[];
	/** 番号0からこの数の時間窓が確定している。 */
	confirmedWindows: number;
}

export interface MergeInput {
	chunks: readonly ChunkRecord[];
	segments: readonly SegmentRecord[];
	labels: Pick<LMeetscribeSettings['display'], 'selfLabel' | 'otherLabel'>;
	/** 録音が終わり、これ以上チャンクが届かない。各トラックの最後の番号より後の時間窓は、そのトラックで完了とみなす。 */
	recordingEnded: boolean;
}

const TRACK_ORDER: Readonly<Record<Track, number>> = { self: 0, other: 1 };

/**
 * 番号0から、両トラックで処理が済んだ時間窓が続く範囲だけを確定として返す。
 * 片側が無音のチャンクも、silentとして記録されていれば処理済みとして扱う。
 * 区間の本文はチャンク境界をまたいでも加工しない。
 */
export function mergeTranscript(input: MergeInput): MergedTranscript {
	const confirmedWindows = countConfirmedWindows(input.chunks, input.recordingEnded);
	// 同じ区間IDの記録は後のものを使う（再処理で上書きされた区間）。
	const segments = new Map<string, SegmentRecord>();
	for (const segment of input.segments) {
		segments.set(segment.segmentId, segment);
	}
	const lines = [...segments.values()]
		.filter((segment) => segment.sequence < confirmedWindows)
		.sort(
			(a, b) =>
				a.startMs - b.startMs ||
				TRACK_ORDER[a.track] - TRACK_ORDER[b.track] ||
				a.sequence - b.sequence ||
				a.index - b.index,
		)
		.map((segment) => ({
			segmentId: segment.segmentId,
			track: segment.track,
			sequence: segment.sequence,
			speaker: segment.track === 'self' ? input.labels.selfLabel : input.labels.otherLabel,
			startMs: segment.startMs,
			endMs: segment.endMs,
			text: segment.text,
		}));
	return { lines, confirmedWindows };
}

function countConfirmedWindows(chunks: readonly ChunkRecord[], recordingEnded: boolean): number {
	const processed: Record<Track, Set<number>> = { self: new Set(), other: new Set() };
	const lastSequence: Record<Track, number> = { self: -1, other: -1 };
	for (const chunk of chunks) {
		lastSequence[chunk.track] = Math.max(lastSequence[chunk.track], chunk.sequence);
		// 失敗したチャンクは録音中に再処理しないため、文字起こしなしの処理済みとして扱い、後の時間窓を待たせない。
		if (chunk.state === 'done' || chunk.state === 'silent' || chunk.state === 'failed') {
			processed[chunk.track].add(chunk.sequence);
		}
	}
	const windowDone = (track: Track, sequence: number): boolean =>
		processed[track].has(sequence) || (recordingEnded && sequence > lastSequence[track]);
	const total = Math.max(lastSequence.self, lastSequence.other) + 1;
	let confirmed = 0;
	while (confirmed < total && windowDone('self', confirmed) && windowDone('other', confirmed)) {
		confirmed += 1;
	}
	return confirmed;
}
