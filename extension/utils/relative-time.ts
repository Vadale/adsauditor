/**
 * Relative-time formatting for the popup's local history rows and the options page's
 * calibration readout (ROADMAP §1.4).
 *
 * Split in two so the bucketing logic — the part with actual decisions and boundary
 * conditions worth unit-testing (tests land in §1.5) — has no browser dependency at
 * all: bucketRelativeTime() is PURE (takes/returns plain data, no `browser` reference
 * even at the type level) and formatRelativeTime() is a thin wrapper that turns a
 * bucket into display text via browser.i18n.getMessage. Neither is imported by
 * classifier.ts or utils/calibration.ts, which stay browser-free for their own reasons.
 */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The i18n message keys a relative-time bucket can resolve to (matches the `relative*`
 * keys in public/_locales/en/messages.json). */
export type RelativeTimeMessageKey =
  'relativeJustNow' | 'relativeMinutesAgo' | 'relativeHoursAgo' | 'relativeDaysAgo';

export interface RelativeTimeBucket {
  key: RelativeTimeMessageKey;
  /** The substitution for the bucket's `$1`. Absent for 'relativeJustNow', which has
   * no placeholder. */
  count?: number;
}

/**
 * Pure bucketing: decides which relative-time message applies to `thenMs` as observed
 * at `nowMs`. `thenMs` in the future (clock skew between when an entry was stamped and
 * now, or simply nowMs/thenMs passed in the wrong order) is clamped to "just now"
 * rather than producing a negative count.
 */
export function bucketRelativeTime(nowMs: number, thenMs: number): RelativeTimeBucket {
  const diffMs = Math.max(0, nowMs - thenMs);
  if (diffMs < MINUTE_MS) return { key: 'relativeJustNow' };
  if (diffMs < HOUR_MS) {
    return { key: 'relativeMinutesAgo', count: Math.floor(diffMs / MINUTE_MS) };
  }
  if (diffMs < DAY_MS) {
    return { key: 'relativeHoursAgo', count: Math.floor(diffMs / HOUR_MS) };
  }
  return { key: 'relativeDaysAgo', count: Math.floor(diffMs / DAY_MS) };
}

export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const bucket = bucketRelativeTime(nowMs, timestampMs);
  return bucket.count === undefined
    ? browser.i18n.getMessage(bucket.key)
    : browser.i18n.getMessage(bucket.key, [String(bucket.count)]);
}
