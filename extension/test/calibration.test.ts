/**
 * utils/calibration.ts unit tests (ROADMAP §1.3): resolveObserverValidity's priority
 * matrix, interpretAdblockProbe's full truth table, evaluateControlOutcome's control-
 * video pass/fail/not-applicable logic, and the rewatch-index helpers.
 *
 * All timestamps are fixed literals — no Date.now() — so these tests are deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  ADBLOCK_CHECK_TTL_MS,
  EMPTY_CALIBRATION_STATE,
  evaluateControlOutcome,
  interpretAdblockProbe,
  isRecentlyWatched,
  POSITIVE_EVIDENCE_WINDOW_MS,
  pruneRewatchIndex,
  resolveObserverValidity,
  REWATCH_WINDOW_MS,
} from '../utils/calibration';
import type { CalibrationState, ProbeOutcome } from '../utils/calibration';
import { CONTROL_VIDEOS, isControlVideo } from '../utils/control-videos';
import type { ClassificationResult, NoSignalCause } from '../utils/types';

// Fixed reference instant used throughout — never Date.now().
const NOW = 10_000_000_000;

function calibration(overrides: Partial<CalibrationState> = {}): CalibrationState {
  return { ...EMPTY_CALIBRATION_STATE, ...overrides };
}

describe('resolveObserverValidity — priority matrix', () => {
  it('all-null calibration state → invalid uncalibrated', () => {
    expect(resolveObserverValidity(EMPTY_CALIBRATION_STATE, NOW)).toEqual({
      valid: false,
      cause: 'uncalibrated',
    });
  });

  it('adblock blocked alone → invalid adblock-suspected', () => {
    const state = calibration({ adblock: { status: 'blocked', checkedAt: NOW } });
    expect(resolveObserverValidity(state, NOW)).toEqual({
      valid: false,
      cause: 'adblock-suspected',
    });
  });

  it('premium detected alone → invalid premium-suspected', () => {
    const state = calibration({ premium: { detected: true, checkedAt: NOW } });
    expect(resolveObserverValidity(state, NOW)).toEqual({
      valid: false,
      cause: 'premium-suspected',
    });
  });

  it('adblock blocked AND premium detected → adblock-suspected wins (priority)', () => {
    const state = calibration({
      adblock: { status: 'blocked', checkedAt: NOW },
      premium: { detected: true, checkedAt: NOW },
    });
    expect(resolveObserverValidity(state, NOW)).toEqual({
      valid: false,
      cause: 'adblock-suspected',
    });
  });

  it('control failure with no positive evidence at all → invalid calibration-failed', () => {
    const state = calibration({ lastControlFailureAt: NOW - 1_000 });
    expect(resolveObserverValidity(state, NOW)).toEqual({
      valid: false,
      cause: 'calibration-failed',
    });
  });

  it('control failure THEN later positive evidence → valid (automatic recovery)', () => {
    const state = calibration({
      lastControlFailureAt: NOW - 5_000,
      lastPositiveEvidenceAt: NOW - 1_000, // later than the failure, within the window
    });
    expect(resolveObserverValidity(state, NOW)).toEqual({ valid: true });
  });

  it('positive evidence THEN later control failure → invalid calibration-failed', () => {
    const state = calibration({
      lastPositiveEvidenceAt: NOW - 5_000,
      lastControlFailureAt: NOW - 1_000, // later than the positive evidence
    });
    expect(resolveObserverValidity(state, NOW)).toEqual({
      valid: false,
      cause: 'calibration-failed',
    });
  });

  describe('POSITIVE_EVIDENCE_WINDOW_MS boundary (use the exported constant, never a literal)', () => {
    it('1ms inside the window → valid', () => {
      const state = calibration({
        lastPositiveEvidenceAt: NOW - POSITIVE_EVIDENCE_WINDOW_MS + 1,
      });
      expect(resolveObserverValidity(state, NOW)).toEqual({ valid: true });
    });

    it('exactly at the window boundary (elapsed === window, inclusive <=) → valid', () => {
      const state = calibration({
        lastPositiveEvidenceAt: NOW - POSITIVE_EVIDENCE_WINDOW_MS,
      });
      expect(resolveObserverValidity(state, NOW)).toEqual({ valid: true });
    });

    it('1ms past the window boundary → invalid uncalibrated', () => {
      const state = calibration({
        lastPositiveEvidenceAt: NOW - POSITIVE_EVIDENCE_WINDOW_MS - 1,
      });
      expect(resolveObserverValidity(state, NOW)).toEqual({
        valid: false,
        cause: 'uncalibrated',
      });
    });
  });

  it("adblock 'inconclusive' never invalidates on its own (co-exists with a valid verdict)", () => {
    const state = calibration({
      adblock: { status: 'inconclusive', checkedAt: NOW },
      lastPositiveEvidenceAt: NOW, // fresh, well within window
    });
    expect(resolveObserverValidity(state, NOW)).toEqual({ valid: true });
  });

  it("adblock 'clear' never invalidates on its own (co-exists with a valid verdict)", () => {
    const state = calibration({
      adblock: { status: 'clear', checkedAt: NOW },
      lastPositiveEvidenceAt: NOW,
    });
    expect(resolveObserverValidity(state, NOW)).toEqual({ valid: true });
  });

  it('premium detected:false never invalidates (co-exists with a valid verdict)', () => {
    const state = calibration({
      premium: { detected: false, checkedAt: NOW },
      lastPositiveEvidenceAt: NOW,
    });
    expect(resolveObserverValidity(state, NOW)).toEqual({ valid: true });
  });
});

describe('interpretAdblockProbe — full truth table', () => {
  it.each([
    ['resolved', 'resolved', 'clear'],
    ['resolved', 'rejected', 'clear'],
    ['resolved', 'timeout', 'clear'],
    ['rejected', 'resolved', 'blocked'],
    ['rejected', 'rejected', 'inconclusive'],
    ['rejected', 'timeout', 'inconclusive'],
    ['timeout', 'resolved', 'inconclusive'],
    ['timeout', 'rejected', 'inconclusive'],
    ['timeout', 'timeout', 'inconclusive'],
  ] as const)('bait=%s, control=%s → %s', (bait, control, expected) => {
    expect(interpretAdblockProbe(bait as ProbeOutcome, control as ProbeOutcome)).toBe(expected);
  });

  it('bait timeout is never blocked, even when control rejects (blockers reject fast)', () => {
    expect(interpretAdblockProbe('timeout', 'rejected')).not.toBe('blocked');
  });
});

describe('evaluateControlOutcome', () => {
  function classificationResult(
    state: ClassificationResult['state'],
    noSignalCause?: NoSignalCause,
  ): ClassificationResult {
    return {
      state,
      noSignalCause,
      midrollPlacementCount: 0,
      videoDurationS: 1920,
      midrollDensityPerMinute: null,
    };
  }

  it('control + fresh + NO_ADS → fail', () => {
    const result = classificationResult('NO_ADS');
    expect(evaluateControlOutcome(result, true, false)).toBe('fail');
  });

  it("control + fresh + NO_SIGNAL('uncalibrated') → fail", () => {
    const result = classificationResult('NO_SIGNAL', 'uncalibrated');
    expect(evaluateControlOutcome(result, true, false)).toBe('fail');
  });

  it("control + fresh + NO_SIGNAL('calibration-failed') → fail", () => {
    const result = classificationResult('NO_SIGNAL', 'calibration-failed');
    expect(evaluateControlOutcome(result, true, false)).toBe('fail');
  });

  it.each([
    'no-player-response',
    'anomalous-beacon-only',
    'adblock-suspected',
    'premium-suspected',
    'recent-rewatch',
  ] as const)(
    "control + fresh + NO_SIGNAL('%s') → not-applicable (no playable response read)",
    (cause) => {
      const result = classificationResult('NO_SIGNAL', cause);
      expect(evaluateControlOutcome(result, true, false)).toBe('not-applicable');
    },
  );

  it('control + RECENTLY WATCHED + NO_ADS → not-applicable (rewatch evidence is worthless)', () => {
    const result = classificationResult('NO_ADS');
    expect(evaluateControlOutcome(result, true, true)).toBe('not-applicable');
  });

  it('control + fresh + ADS_SERVED → pass', () => {
    const result = classificationResult('ADS_SERVED');
    expect(evaluateControlOutcome(result, true, false)).toBe('pass');
  });

  it('control + ADS_SERVED still passes even when marked recently watched', () => {
    // ADS_SERVED is checked before the recentlyWatched gate — a positive result is
    // always informative, rewatch or not.
    const result = classificationResult('ADS_SERVED');
    expect(evaluateControlOutcome(result, true, true)).toBe('pass');
  });

  it('NON-control video + ADS_SERVED → not-applicable', () => {
    const result = classificationResult('ADS_SERVED');
    expect(evaluateControlOutcome(result, false, false)).toBe('not-applicable');
  });

  it('NON-control video + NO_ADS → not-applicable', () => {
    const result = classificationResult('NO_ADS');
    expect(evaluateControlOutcome(result, false, false)).toBe('not-applicable');
  });
});

describe('isRecentlyWatched', () => {
  it('present, watched within the 24h window → true', () => {
    const index = { abc123: NOW - 1_000 };
    expect(isRecentlyWatched(index, 'abc123', NOW)).toBe(true);
  });

  it('present, exactly at the REWATCH_WINDOW_MS boundary (elapsed === window, inclusive <=) → true', () => {
    const index = { abc123: NOW - REWATCH_WINDOW_MS };
    expect(isRecentlyWatched(index, 'abc123', NOW)).toBe(true);
  });

  it('present, 1ms past the REWATCH_WINDOW_MS boundary → false', () => {
    const index = { abc123: NOW - REWATCH_WINDOW_MS - 1 };
    expect(isRecentlyWatched(index, 'abc123', NOW)).toBe(false);
  });

  it('absent videoId → false', () => {
    const index = { someOtherId: NOW - 1_000 };
    expect(isRecentlyWatched(index, 'abc123', NOW)).toBe(false);
  });
});

describe('pruneRewatchIndex', () => {
  it('drops entries older than REWATCH_WINDOW_MS and keeps fresh ones', () => {
    const index = {
      fresh: NOW - 1_000,
      atBoundary: NOW - REWATCH_WINDOW_MS,
      stale: NOW - REWATCH_WINDOW_MS - 1,
    };
    const pruned = pruneRewatchIndex(index, NOW);
    expect(pruned).toEqual({ fresh: NOW - 1_000, atBoundary: NOW - REWATCH_WINDOW_MS });
  });

  it('returns a new object and does not mutate the input', () => {
    const index = { fresh: NOW - 1_000, stale: NOW - REWATCH_WINDOW_MS - 1 };
    const original = { ...index };
    const pruned = pruneRewatchIndex(index, NOW);
    expect(pruned).not.toBe(index);
    expect(index).toEqual(original); // input untouched, stale entry still present on it
  });

  it('an all-fresh index prunes to an equivalent (but distinct) object', () => {
    const index = { a: NOW - 1_000, b: NOW - 2_000 };
    const pruned = pruneRewatchIndex(index, NOW);
    expect(pruned).toEqual(index);
    expect(pruned).not.toBe(index);
  });

  it('an empty index prunes to an empty object', () => {
    expect(pruneRewatchIndex({}, NOW)).toEqual({});
  });
});

describe('CONTROL_VIDEOS / isControlVideo', () => {
  it('has exactly 9 seeded entries', () => {
    expect(CONTROL_VIDEOS).toHaveLength(9);
  });

  it('isControlVideo is true for a seeded id and false for an unknown id', () => {
    expect(isControlVideo('iYlODtkyw_I')).toBe(true);
    expect(isControlVideo('not-a-real-video-id')).toBe(false);
  });
});

// Sanity check that TTL/timeout constants referenced in calibration.ts's doc comments
// are exported and positive — guards against an accidental 0/undefined regression that
// would silently disable the adblock/premium re-check cadence.
describe('exported constants', () => {
  it('ADBLOCK_CHECK_TTL_MS is a positive duration', () => {
    expect(ADBLOCK_CHECK_TTL_MS).toBeGreaterThan(0);
  });
});
