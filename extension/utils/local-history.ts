/**
 * Pure builder for the persisted local-history entry (ROADMAP §1.4 popup history,
 * CLAUDE.md invariant 2). This is the SINGLE construction path for what background.ts
 * writes to local:adsauditor_history — kept pure (no browser imports) and exported so
 * test/storage-payload.test.ts locks the REAL persisted shape instead of a hand-built
 * stand-in. It copies exactly the documented LocalHistoryEntry fields and nothing else;
 * in particular, ClassificationResult's calibration detail (midrollPlacementCount,
 * videoDurationS, midrollDensityPerMinute) must never be persisted here.
 */
import type { ClassificationResult, LocalHistoryEntry } from './types';

export function buildLocalHistoryEntry(
  videoId: string,
  result: ClassificationResult,
  observedAt: number,
): LocalHistoryEntry {
  return {
    videoId,
    observedAt,
    state: result.state,
    evidence: result.evidence,
    noSignalCause: result.noSignalCause,
  };
}
