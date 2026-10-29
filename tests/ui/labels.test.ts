import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../../src/session/RecordingSession';
import { describeFailure, formatElapsed, otherSilenceWarning } from '../../src/ui/labels';

function snapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
	return {
		sessionId: 's-1',
		blockId: 'b-1',
		notePath: 'a.md',
		startedAt: '2026-10-29T00:00:00.000Z',
		state: 'recording',
		transcription: { queued: 0, processed: 0, failed: 0 },
		otherSilentMs: 0,
		diskSpaceLow: false,
		...overrides,
	};
}

describe('describeFailure', () => {
	it('コードに応じた次の操作を示す', () => {
		const { summary, guidance } = describeFailure({ stage: 'start', message: 'denied', code: 'microphoneDenied' });

		expect(summary).toBe('録音の開始に失敗しました: denied');
		expect(guidance).toMatch(/マイク.*Obsidianを許可/);
	});

	it('未知のコードでは処理段階に応じた案内にする', () => {
		expect(describeFailure({ stage: 'transcription', message: 'x', code: 'unknown' }).guidance).toMatch(/再試行/);
	});
});

describe('otherSilenceWarning', () => {
	it('録音中に60秒以上の無音で警告し、権限の拒否とは断定しない', () => {
		expect(otherSilenceWarning(snapshot({ otherSilentMs: 59_999 }))).toBeUndefined();
		const warning = otherSilenceWarning(snapshot({ otherSilentMs: 60_000 }));
		expect(warning).toMatch(/確認してください/);
		expect(warning).not.toMatch(/拒否/);
	});

	it('録音中でなければ警告しない', () => {
		expect(otherSilenceWarning(snapshot({ state: 'draining', otherSilentMs: 120_000 }))).toBeUndefined();
	});
});

describe('formatElapsed', () => {
	it('時・分・秒で表す', () => {
		expect(formatElapsed('2026-10-29T00:00:00.000Z', new Date('2026-10-29T01:02:03.900Z'))).toBe('1:02:03');
	});
});
