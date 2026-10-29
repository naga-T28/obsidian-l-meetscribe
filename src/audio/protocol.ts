import { isRecord } from '../json';
import type { Track } from '../session/records';

// 録音ヘルパーとのJSON Linesプロトコル v1。ヘルパー側の実装は native/MeetingAudioHelper/Sources/MeetingAudioCore/Protocol.swift にある。
// ヘルパーの出力は実行時に検証し、型に合わない行はHelperProtocolErrorとして拒否する。

export const HELPER_PROTOCOL_VERSION = 1;

export interface DeviceInfo {
	uid: string;
	name: string;
	inputChannels: number;
	outputChannels: number;
	nominalSampleRate: number;
}

export type StopReason = 'stopCommand' | 'stdinClosed' | 'heartbeatTimeout' | 'signal' | 'error';

export type HelperCommand =
	| { type: 'hello'; requestId: string; protocolVersion: number }
	| { type: 'listDevices'; requestId: string }
	| {
			type: 'start';
			requestId: string;
			sessionId: string;
			/** nullは既定の入力デバイス。 */
			inputUid: string | null;
			/** nullはすべての出力。 */
			outputUid: string | null;
			chunkSeconds: number;
			workDir: string;
	  }
	| { type: 'stop'; sessionId: string }
	| { type: 'heartbeat'; sessionId: string };

export interface HelperChunkReady {
	type: 'chunkReady';
	sessionId: string;
	track: Track;
	sequence: number;
	startMs: number;
	durationMs: number;
	/** 作業領域からの相対パス。`chunks/<track>-<6桁の番号>.wav`に限る。 */
	path: string;
	rmsDbfs: number;
}

export interface HelperErrorEvent {
	type: 'error';
	code: string;
	message: string;
	retryable: boolean;
	target: string | null;
	requestId: string | null;
	sessionId: string | null;
}

export type HelperEvent =
	| { type: 'ready'; requestId: string; protocolVersion: number; helperVersion: string }
	| {
			type: 'devices';
			requestId: string;
			inputs: DeviceInfo[];
			outputs: DeviceInfo[];
			defaultInputUid: string | null;
			defaultOutputUid: string | null;
	  }
	| { type: 'started'; requestId: string; sessionId: string; inputUid: string; outputTarget: string }
	| HelperChunkReady
	| { type: 'stopped'; sessionId: string; reason: StopReason; lastSequence: Record<Track, number | null> }
	| HelperErrorEvent;

/** ヘルパーの出力がプロトコルに合わない。行の内容は含めない。 */
export class HelperProtocolError extends Error {
	constructor(detail: string) {
		super(`録音ヘルパーの応答が不正です: ${detail}`);
		this.name = 'HelperProtocolError';
	}
}

export function encodeCommand(command: HelperCommand): string {
	return `${JSON.stringify(command)}\n`;
}

/** ヘルパーが書くチャンクのパス。ヘルパーの命名規則と一致しない通知は作業領域外を指す恐れがあるため拒否する。 */
export function chunkPath(track: Track, sequence: number): string {
	return `chunks/${track}-${String(sequence).padStart(6, '0')}.wav`;
}

export function parseHelperEvent(line: string): HelperEvent {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new HelperProtocolError('JSONとして読めません。');
	}
	if (!isRecord(raw)) {
		throw new HelperProtocolError('JSONオブジェクトではありません。');
	}
	const f = new Fields(raw);
	const type = f.string('type');
	switch (type) {
		case 'ready':
			return {
				type,
				requestId: f.string('requestId'),
				protocolVersion: f.integer('protocolVersion'),
				helperVersion: f.string('helperVersion'),
			};
		case 'devices':
			return {
				type,
				requestId: f.string('requestId'),
				inputs: f.array('inputs').map(parseDevice),
				outputs: f.array('outputs').map(parseDevice),
				defaultInputUid: f.nullableString('defaultInputUid'),
				defaultOutputUid: f.nullableString('defaultOutputUid'),
			};
		case 'started':
			return {
				type,
				requestId: f.string('requestId'),
				sessionId: f.string('sessionId'),
				inputUid: f.string('inputUid'),
				outputTarget: f.string('outputTarget'),
			};
		case 'chunkReady': {
			const chunk: HelperChunkReady = {
				type,
				sessionId: f.string('sessionId'),
				track: f.track('track'),
				sequence: f.integer('sequence'),
				// ヘルパーはサンプル数からミリ秒を求める。停止時の端数のチャンクは長さが小数になる。
				startMs: f.nonNegativeNumber('startMs'),
				durationMs: f.nonNegativeNumber('durationMs'),
				path: f.string('path'),
				rmsDbfs: f.number('rmsDbfs'),
			};
			if (chunk.path !== chunkPath(chunk.track, chunk.sequence)) {
				throw new HelperProtocolError('chunkReadyのpathが規則と一致しません。');
			}
			return chunk;
		}
		case 'stopped': {
			const sequences = new Fields(f.object('lastSequence'));
			return {
				type,
				sessionId: f.string('sessionId'),
				reason: f.oneOf('reason', ['stopCommand', 'stdinClosed', 'heartbeatTimeout', 'signal', 'error']),
				lastSequence: { self: sequences.nullableInteger('self'), other: sequences.nullableInteger('other') },
			};
		}
		case 'error':
			return {
				type,
				code: f.string('code'),
				message: f.string('message'),
				retryable: f.boolean('retryable'),
				target: f.nullableString('target'),
				requestId: f.nullableString('requestId'),
				sessionId: f.nullableString('sessionId'),
			};
		default:
			throw new HelperProtocolError('未知のtypeです。');
	}
}

function parseDevice(value: unknown): DeviceInfo {
	if (!isRecord(value)) {
		throw new HelperProtocolError('デバイスの形式が正しくありません。');
	}
	const f = new Fields(value);
	return {
		uid: f.string('uid'),
		name: f.string('name'),
		inputChannels: f.integer('inputChannels'),
		outputChannels: f.integer('outputChannels'),
		nominalSampleRate: f.number('nominalSampleRate'),
	};
}

class Fields {
	constructor(private readonly raw: Record<string, unknown>) {}

	string(key: string): string {
		const value = this.raw[key];
		if (typeof value !== 'string') {
			throw invalid(key);
		}
		return value;
	}

	nullableString(key: string): string | null {
		return this.raw[key] === null ? null : this.string(key);
	}

	number(key: string): number {
		const value = this.raw[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw invalid(key);
		}
		return value;
	}

	nonNegativeNumber(key: string): number {
		const value = this.number(key);
		if (value < 0) {
			throw invalid(key);
		}
		return value;
	}

	/** 番号・時刻・チャンネル数など、0以上の整数。 */
	integer(key: string): number {
		const value = this.number(key);
		if (!Number.isSafeInteger(value) || value < 0) {
			throw invalid(key);
		}
		return value;
	}

	nullableInteger(key: string): number | null {
		return this.raw[key] === null ? null : this.integer(key);
	}

	boolean(key: string): boolean {
		const value = this.raw[key];
		if (typeof value !== 'boolean') {
			throw invalid(key);
		}
		return value;
	}

	array(key: string): unknown[] {
		const value = this.raw[key];
		if (!Array.isArray(value)) {
			throw invalid(key);
		}
		return value;
	}

	object(key: string): Record<string, unknown> {
		const value = this.raw[key];
		if (!isRecord(value)) {
			throw invalid(key);
		}
		return value;
	}

	track(key: string): Track {
		return this.oneOf(key, ['self', 'other']);
	}

	oneOf<T extends string>(key: string, values: readonly T[]): T {
		const value = this.string(key);
		const match = values.find((candidate) => candidate === value);
		if (match === undefined) {
			throw invalid(key);
		}
		return match;
	}
}

function invalid(key: string): HelperProtocolError {
	return new HelperProtocolError(`${key}の形式が正しくありません。`);
}
