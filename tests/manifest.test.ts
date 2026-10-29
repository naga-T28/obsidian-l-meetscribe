import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest.json', () => {
	it('対応環境の前提を満たす', () => {
		expect(manifest.id).toBe('l-meetscribe');
		expect(manifest.name).toBe('L Meetscribe');
		expect(manifest.minAppVersion).toBe('1.11.4');
		expect(manifest.isDesktopOnly).toBe(true);
	});
});
