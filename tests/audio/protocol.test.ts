import { describe, expect, it } from 'vitest';
import { encodeCommand, HelperProtocolError, parseHelperEvent } from '../../src/audio/protocol';

describe('parseHelperEvent', () => {
	it('チャンクのない停止通知の番号をnullで読む', () => {
		const event = parseHelperEvent(
			JSON.stringify({ type: 'stopped', sessionId: 's-1', reason: 'stdinClosed', lastSequence: { self: 4, other: null } }),
		);

		expect(event).toEqual({ type: 'stopped', sessionId: 's-1', reason: 'stdinClosed', lastSequence: { self: 4, other: null } });
	});

	it('停止時の端数のチャンクの小数の長さを読む', () => {
		// 12,345サンプル（16kHz）は771.5625ミリ秒。ヘルパーは丸めずに送る。
		const value = { type: 'chunkReady', sessionId: 's-1', track: 'other', sequence: 3, startMs: 30000, durationMs: 771.5625, path: 'chunks/other-000003.wav', rmsDbfs: -42.5 };
		expect(parseHelperEvent(JSON.stringify(value))).toEqual(value);
	});

	it.each([
		['未知のtype', { type: 'unknown' }],
		['未知の停止理由', { type: 'stopped', sessionId: 's-1', reason: 'other', lastSequence: { self: null, other: null } }],
		['負の番号', { type: 'chunkReady', sessionId: 's-1', track: 'self', sequence: -1, startMs: 0, durationMs: 1, path: 'chunks/self--00001.wav', rmsDbfs: -1 }],
		['トラックと一致しないパス', { type: 'chunkReady', sessionId: 's-1', track: 'self', sequence: 0, startMs: 0, durationMs: 1, path: 'chunks/other-000000.wav', rmsDbfs: -1 }],
		['負の長さ', { type: 'chunkReady', sessionId: 's-1', track: 'self', sequence: 0, startMs: 0, durationMs: -1, path: 'chunks/self-000000.wav', rmsDbfs: -1 }],
		['数値でないRMS', { type: 'chunkReady', sessionId: 's-1', track: 'self', sequence: 0, startMs: 0, durationMs: 1, path: 'chunks/self-000000.wav', rmsDbfs: '-1' }],
		['配列', []],
	])('%sを拒否する', (_name, value) => {
		expect(() => parseHelperEvent(JSON.stringify(value))).toThrow(HelperProtocolError);
	});

	it('拒否の理由に行の内容を含めない', () => {
		expect(() => parseHelperEvent('{"type": "secret-text"')).toThrow(/^録音ヘルパーの応答が不正です: JSONとして読めません。$/);
	});
});

describe('encodeCommand', () => {
	it('1行のJSONにする', () => {
		expect(encodeCommand({ type: 'stop', sessionId: 's-1' })).toBe('{"type":"stop","sessionId":"s-1"}\n');
	});
});
