/**
 * bucketRelativeTime() unit tests (docs/ROADMAP.md §1.4/§1.5): pure function, no browser
 * dependency (utils/relative-time.ts), so it is driven directly with fixed timestamps —
 * no Date.now(), no mocks. Boundaries are asserted exactly as implemented (diffMs < N,
 * strictly-less-than on every threshold; Math.floor for the count), not as originally
 * "intended", per docs/ROADMAP.md §1.5's "pin actual behavior" instruction.
 */
import { describe, expect, it } from 'vitest';
import { bucketRelativeTime } from '../utils/relative-time';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Fixed epoch anchor: any real instant works since bucketRelativeTime only ever looks at
// the difference, but pinning one avoids the appearance of relying on Date.now().
const NOW_MS = 1_800_000_000_000; // 2027-01-15T06:40:00.000Z

describe('bucketRelativeTime — seconds/minutes boundary at 60s', () => {
  it('0ms difference → relativeJustNow', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS)).toEqual({ key: 'relativeJustNow' });
  });

  it('59999ms (just under 1 minute) → still relativeJustNow', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - (MINUTE_MS - 1))).toEqual({
      key: 'relativeJustNow',
    });
  });

  it('exactly 60000ms → relativeMinutesAgo, count 1 (the < boundary flips here)', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - MINUTE_MS)).toEqual({
      key: 'relativeMinutesAgo',
      count: 1,
    });
  });

  it('90000ms → relativeMinutesAgo, count 1 (floor, not round)', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - 90_000)).toEqual({
      key: 'relativeMinutesAgo',
      count: 1,
    });
  });
});

describe('bucketRelativeTime — minutes/hours boundary at 60 minutes', () => {
  it('3599999ms (just under 1 hour) → relativeMinutesAgo, count 59', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - (HOUR_MS - 1))).toEqual({
      key: 'relativeMinutesAgo',
      count: 59,
    });
  });

  it('exactly HOUR_MS → relativeHoursAgo, count 1', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - HOUR_MS)).toEqual({
      key: 'relativeHoursAgo',
      count: 1,
    });
  });

  it('2.5 hours → relativeHoursAgo, count 2 (floor)', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - 2.5 * HOUR_MS)).toEqual({
      key: 'relativeHoursAgo',
      count: 2,
    });
  });
});

describe('bucketRelativeTime — hours/days boundary at 24 hours', () => {
  it('86399999ms (just under 24 hours) → relativeHoursAgo, count 23', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - (DAY_MS - 1))).toEqual({
      key: 'relativeHoursAgo',
      count: 23,
    });
  });

  it('exactly DAY_MS → relativeDaysAgo, count 1', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - DAY_MS)).toEqual({
      key: 'relativeDaysAgo',
      count: 1,
    });
  });

  it('10 days → relativeDaysAgo, count 10', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - 10 * DAY_MS)).toEqual({
      key: 'relativeDaysAgo',
      count: 10,
    });
  });

  it('does not roll over into a "weeks"/"months" bucket — arbitrarily large gaps stay relativeDaysAgo', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS - 400 * DAY_MS)).toEqual({
      key: 'relativeDaysAgo',
      count: 400,
    });
  });
});

describe('bucketRelativeTime — future timestamps clamp to "now" (as implemented, Math.max(0, ...))', () => {
  it('thenMs strictly after nowMs → clamped to relativeJustNow, not a negative count', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS + 5_000)).toEqual({ key: 'relativeJustNow' });
  });

  it('thenMs far in the future (nowMs/thenMs passed in the wrong order) → still relativeJustNow', () => {
    expect(bucketRelativeTime(NOW_MS, NOW_MS + 10 * DAY_MS)).toEqual({ key: 'relativeJustNow' });
  });
});
