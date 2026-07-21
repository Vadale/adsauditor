/**
 * confidenceMessageKeyForSourceCount() / adPlaybackObserved() unit tests: pure functions, no browser dependency (utils/evidence-summary.ts).
 * confidenceMessageKeyForSourceCount pins the exact bucketing — including the defensive
 * out-of-[0,3]-range behavior the function's own doc comment describes — rather than the
 * range classify() is documented to actually produce.
 */
import { describe, expect, it } from 'vitest';
import { adPlaybackObserved, confidenceMessageKeyForSourceCount } from '../utils/evidence-summary';
import type { EvidenceSource } from '../utils/types';

describe('confidenceMessageKeyForSourceCount — the three real source counts classify() can produce', () => {
  it('3 (all of PLAYER_RESPONSE/DOM/BEACON agree) → confidenceHigh', () => {
    expect(confidenceMessageKeyForSourceCount(3)).toBe('confidenceHigh');
  });

  it('2 → confidenceMedium', () => {
    expect(confidenceMessageKeyForSourceCount(2)).toBe('confidenceMedium');
  });

  it('1 → confidenceSingle', () => {
    expect(confidenceMessageKeyForSourceCount(1)).toBe('confidenceSingle');
  });
});

describe('confidenceMessageKeyForSourceCount — defensive behavior outside the [0,3] range classify() actually produces', () => {
  it('0 sources → confidenceSingle (not a distinct "none" bucket — as implemented)', () => {
    expect(confidenceMessageKeyForSourceCount(0)).toBe('confidenceSingle');
  });

  it('4 sources (more than classify() can ever attach) → clamps to confidenceHigh, the nearest valid bucket', () => {
    expect(confidenceMessageKeyForSourceCount(4)).toBe('confidenceHigh');
  });

  it('a large out-of-range count still clamps to confidenceHigh rather than throwing', () => {
    expect(confidenceMessageKeyForSourceCount(100)).toBe('confidenceHigh');
  });

  it('a negative count clamps to confidenceSingle (the >=3 and ===2 checks both fail) rather than throwing', () => {
    expect(confidenceMessageKeyForSourceCount(-1)).toBe('confidenceSingle');
  });
});

describe('adPlaybackObserved — witnessed playback (DOM/BEACON) vs decision-only (PLAYER_RESPONSE) (ROADMAP §1.6)', () => {
  it.each([
    [['DOM'], true],
    [['BEACON'], true],
    [['PLAYER_RESPONSE'], false],
    [['PLAYER_RESPONSE', 'DOM'], true],
    [[], false],
  ] as [EvidenceSource[], boolean][])('%j → %s', (sources, expected) => {
    expect(adPlaybackObserved(sources)).toBe(expected);
  });
});
