/** Shared trailing-window grammar for stats projections. Bounds are [start, end). */
export function statsWindow(
  value: string,
  endMs: number,
): { startMs: number; endMs: number; durationMs: number } | null {
  const matched = /^([1-9][0-9]*)(m|h|d)$/u.exec(value);
  if (matched === null) return null;
  const units: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const duration = Number(matched[1]) * (units[matched[2]!] ?? 0);
  if (!Number.isSafeInteger(duration) || duration > endMs) return null;
  return { startMs: endMs - duration, endMs, durationMs: duration };
}
