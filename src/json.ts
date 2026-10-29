// 実行時に検証するJSON値の共通判定。

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
