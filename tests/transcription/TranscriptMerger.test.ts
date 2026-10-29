import { describe, expect, it } from 'vitest';
import type { ChunkRecord, ChunkState, SegmentRecord, Track } from '../../src/session/records';
import { mergeTranscript, type MergeInput } from '../../src/transcription/TranscriptMerger';

const CHUNK_MS = 10_000;

function chunk(track: Track, sequence: number, state: ChunkState = 'done'): ChunkRecord {
	return {
		track,
		sequence,
		startMs: sequence * CHUNK_MS,
		durationMs: CHUNK_MS,
		path: `chunks/${track}-${String(sequence).padStart(6, '0')}.wav`,
		rmsDbfs: -30,
		state,
		attempts: state === 'pending' ? 0 : 1,
	};
}

/** チャンク内の開始・終了時刻を受け取り、チャンク開始時刻を加えた区間を作る。 */
function segment(track: Track, sequence: number, index: number, fromMs: number, toMs: number, text = `${track}${sequence}-${index}`): SegmentRecord {
	return {
		segmentId: `${track}-${sequence}-${index}`,
		track,
		sequence,
		index,
		startMs: sequence * CHUNK_MS + fromMs,
		endMs: sequence * CHUNK_MS + toMs,
		text,
	};
}

function merge(overrides: Partial<MergeInput>): ReturnType<typeof mergeTranscript> {
	return mergeTranscript({ chunks: [], segments: [], labels: { selfLabel: '自分', otherLabel: '相手' }, recordingEnded: false, ...overrides });
}

describe('mergeTranscript', () => {
	it('セッション開始からの時刻順に並べ、入力経路の話者ラベルを付ける', () => {
		const result = merge({
			chunks: [chunk('self', 0), chunk('other', 0), chunk('self', 1), chunk('other', 1)],
			segments: [segment('self', 1, 0, 500, 2000), segment('other', 0, 0, 3000, 6000), segment('self', 0, 0, 1000, 2000)],
			labels: { selfLabel: '山田', otherLabel: '先方' },
		});
		expect(result.confirmedWindows).toBe(2);
		expect(result.lines.map((line) => [line.speaker, line.startMs, line.endMs])).toEqual([
			['山田', 1000, 2000],
			['先方', 3000, 6000],
			['山田', 10_500, 12_000],
		]);
	});

	it('同じ時刻の発言は自分、相手の順に、同じトラックでは区間の位置順に並べる', () => {
		const result = merge({
			chunks: [chunk('self', 0), chunk('other', 0)],
			segments: [segment('other', 0, 0, 1000, 2000), segment('self', 0, 1, 1000, 1000), segment('self', 0, 0, 1000, 1000)],
		});
		expect(result.lines.map((line) => line.segmentId)).toEqual(['self-0-0', 'self-0-1', 'other-0-0']);
	});

	it('片側が無音の時間窓も確定する', () => {
		const result = merge({
			chunks: [chunk('self', 0), chunk('other', 0, 'silent')],
			segments: [segment('self', 0, 0, 0, 3000)],
		});
		expect(result.confirmedWindows).toBe(1);
		expect(result.lines).toHaveLength(1);
	});

	it('片側の処理が遅れている時間窓から先は確定しない', () => {
		const result = merge({
			chunks: [chunk('self', 0), chunk('self', 1), chunk('self', 2), chunk('other', 0), chunk('other', 1, 'pending')],
			segments: [segment('self', 0, 0, 0, 1000), segment('self', 1, 0, 0, 1000), segment('self', 2, 0, 0, 1000), segment('other', 0, 0, 0, 1000)],
		});
		expect(result.confirmedWindows).toBe(1);
		expect(result.lines.map((line) => line.segmentId)).toEqual(['self-0-0', 'other-0-0']);
	});

	it('片側のチャンクが未着の時間窓は、録音中は確定しない', () => {
		const chunks = [chunk('self', 0), chunk('self', 1), chunk('other', 0)];
		expect(merge({ chunks }).confirmedWindows).toBe(1);
	});

	it('録音終了後は、各トラックの最後より後の時間窓をそのトラックで完了とみなす', () => {
		const chunks = [chunk('self', 0), chunk('self', 1), chunk('other', 0)];
		expect(merge({ chunks, recordingEnded: true }).confirmedWindows).toBe(2);
	});

	it('失敗したチャンクは文字起こしなしの処理済みとして扱い、後の時間窓を待たせない', () => {
		const chunks = [chunk('self', 0), chunk('other', 0), chunk('self', 1, 'failed'), chunk('other', 1), chunk('self', 2), chunk('other', 2)];
		expect(merge({ chunks, recordingEnded: false }).confirmedWindows).toBe(3);
	});

	it('未処理のチャンクの時間窓から先は確定しない', () => {
		const chunks = [chunk('self', 0), chunk('other', 0), chunk('self', 1, 'pending'), chunk('other', 1), chunk('self', 2), chunk('other', 2)];
		expect(merge({ chunks, recordingEnded: true }).confirmedWindows).toBe(1);
	});

	it('同じ区間IDの重複入力は1行にし、後の記録を使う', () => {
		const result = merge({
			chunks: [chunk('self', 0), chunk('other', 0)],
			segments: [segment('self', 0, 0, 0, 1000, '前回'), segment('self', 0, 0, 0, 1000, '再処理')],
		});
		expect(result.lines.map((line) => line.text)).toEqual(['再処理']);
	});

	it('チャンク境界をまたぐ文字列を加工しない', () => {
		const result = merge({
			chunks: [chunk('self', 0), chunk('other', 0), chunk('self', 1), chunk('other', 1)],
			segments: [segment('self', 0, 0, 8000, 10_000, '今日の議題は'), segment('self', 1, 0, 0, 1500, '議題は予算です')],
		});
		expect(result.lines.map((line) => line.text)).toEqual(['今日の議題は', '議題は予算です']);
	});

	it('チャンクがなければ何も確定しない', () => {
		expect(merge({ recordingEnded: true })).toEqual({ lines: [], confirmedWindows: 0 });
	});
});
