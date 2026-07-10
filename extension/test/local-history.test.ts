/**
 * buildLocalHistoryEntry() / upsertLocalHistoryEntry() unit tests (docs/ROADMAP.md
 * §1.6/§1.7): pure functions, no browser dependency (utils/local-history.ts).
 *
 * upsertLocalHistoryEntry is the owner-reported-bug fix: an uninformative NO_SIGNAL
 * observation (e.g. a rewatch within the rewatch window) must never overwrite the last
 * INFORMATIVE observation (ADS_SERVED / NO_ADS / UNAVAILABLE) for the same video — see
 * that function's doc comment in utils/local-history.ts for the full scenario.
 */
import { describe, expect, it } from 'vitest';
import { buildLocalHistoryEntry, upsertLocalHistoryEntry } from '../utils/local-history';
import type { ClassificationResult, LocalHistoryEntry, ObservedState } from '../utils/types';

/** Small builder so each test states only what it's varying (videoId/state/observedAt),
 * matching classifier.test.ts's helper-function style. evidence/noSignalCause default to
 * whatever's consistent with `state`, overridable for tests that need a specific
 * noSignalCause (e.g. distinguishing an "old" NO_SIGNAL from a "new" one). */
function entry(
  videoId: string,
  state: ObservedState,
  observedAt: number,
  overrides: Partial<LocalHistoryEntry> = {},
): LocalHistoryEntry {
  return {
    videoId,
    observedAt,
    state,
    evidence:
      state === 'ADS_SERVED'
        ? {
            preroll: true,
            midrolls: 1,
            postroll: false,
            sources: ['PLAYER_RESPONSE'],
            ssaiAnomalySuspected: false,
          }
        : undefined,
    noSignalCause: state === 'NO_SIGNAL' ? 'uncalibrated' : undefined,
    ...overrides,
  };
}

describe('buildLocalHistoryEntry — durationS (ROADMAP §1.7 schema addition)', () => {
  it('copies durationS from result.videoDurationS, not any other field', () => {
    const result: ClassificationResult = {
      state: 'NO_ADS',
      midrollPlacementCount: 0,
      videoDurationS: 754,
      midrollDensityPerMinute: 0,
    };
    const built = buildLocalHistoryEntry('dQw4w9WgXcQ', result, 1_700_000_000_000);
    expect(built.durationS).toBe(754);
  });
});

describe('upsertLocalHistoryEntry — informative vs uninformative merge (ROADMAP §1.6)', () => {
  it('an informative entry replaces an existing informative entry for the same video (prepended, old dropped)', () => {
    const oldEntry = entry('videoX', 'ADS_SERVED', 1_000);
    const newEntry = entry('videoX', 'NO_ADS', 2_000);
    const result = upsertLocalHistoryEntry([oldEntry], newEntry, 50);
    expect(result).toEqual([newEntry]);
  });

  it('a NO_SIGNAL entry does NOT replace an existing informative entry for the same video — list returned unchanged, same order', () => {
    const untouchedY = entry('videoY', 'ADS_SERVED', 500);
    const informativeX = entry('videoX', 'ADS_SERVED', 1_000);
    const untouchedZ = entry('videoZ', 'NO_ADS', 700);
    const existing = [untouchedY, informativeX, untouchedZ];
    const noSignalEntry = entry('videoX', 'NO_SIGNAL', 2_000, { noSignalCause: 'recent-rewatch' });

    const result = upsertLocalHistoryEntry(existing, noSignalEntry, 50);

    // Literal same reference: the implementation returns `existing` itself in this
    // branch (see utils/local-history.ts) — a `toBe` here proves that, not just that an
    // equivalent-looking array was rebuilt.
    expect(result).toBe(existing);
    expect(result).toEqual([untouchedY, informativeX, untouchedZ]);
  });

  it('a NO_SIGNAL entry DOES replace an existing NO_SIGNAL entry for the same video', () => {
    const oldNoSignal = entry('videoX', 'NO_SIGNAL', 1_000, { noSignalCause: 'uncalibrated' });
    const newNoSignal = entry('videoX', 'NO_SIGNAL', 2_000, { noSignalCause: 'recent-rewatch' });
    const result = upsertLocalHistoryEntry([oldNoSignal], newNoSignal, 50);
    expect(result).toEqual([newNoSignal]);
  });

  it('an informative entry replaces an existing NO_SIGNAL entry for the same video', () => {
    const oldNoSignal = entry('videoX', 'NO_SIGNAL', 1_000, { noSignalCause: 'uncalibrated' });
    const informative = entry('videoX', 'ADS_SERVED', 2_000);
    const result = upsertLocalHistoryEntry([oldNoSignal], informative, 50);
    expect(result).toEqual([informative]);
  });

  it('an entry for a NEW videoId is prepended, existing entries kept', () => {
    const existingY = entry('videoY', 'ADS_SERVED', 1_000);
    const newX = entry('videoX', 'NO_ADS', 2_000);
    const result = upsertLocalHistoryEntry([existingY], newX, 50);
    expect(result).toEqual([newX, existingY]);
  });

  it('respects maxEntries: the oldest (last) entry is dropped once the cap is exceeded', () => {
    const first = entry('videoA', 'ADS_SERVED', 1_000); // will become the oldest
    const second = entry('videoB', 'NO_ADS', 2_000);
    const incoming = entry('videoC', 'UNAVAILABLE', 3_000); // new video, prepended
    const result = upsertLocalHistoryEntry([first, second], incoming, 2);
    expect(result).toEqual([incoming, first]); // second/videoB (oldest-by-position) dropped
    expect(result.length).toBe(2);
  });

  it('empty existing list: the new entry becomes the sole entry', () => {
    const onlyEntry = entry('videoX', 'ADS_SERVED', 1_000);
    const result = upsertLocalHistoryEntry([], onlyEntry, 50);
    expect(result).toEqual([onlyEntry]);
  });

  it('does not mutate the input array', () => {
    const existingY = entry('videoY', 'ADS_SERVED', 1_000);
    const existing = [existingY];
    const existingSnapshot = [...existing];
    upsertLocalHistoryEntry(existing, entry('videoX', 'NO_ADS', 2_000), 50);
    expect(existing).toEqual(existingSnapshot);
    expect(existing.length).toBe(1);
  });
});
