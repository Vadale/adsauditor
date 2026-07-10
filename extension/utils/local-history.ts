/**
 * Pure builder + merge logic for the persisted local-history entry (ROADMAP §1.4 popup
 * history, CLAUDE.md invariant 2). This is the SINGLE construction path for what
 * background.ts writes to local:adsauditor_history — kept pure (no browser imports) and
 * exported so test/storage-payload.test.ts locks the REAL persisted shape instead of a
 * hand-built stand-in. buildLocalHistoryEntry() copies exactly the documented
 * LocalHistoryEntry fields and nothing else. Of ClassificationResult's calibration
 * detail, only videoDurationS is persisted (as durationS, a deliberate §1.7 schema
 * addition for export analysis); midrollPlacementCount and midrollDensityPerMinute
 * must never be persisted here.
 */
import type { ClassificationResult, LocalHistoryEntry } from './types';

/** Cap on the local history list (ROADMAP §1.4) — the one home for this constant;
 * background.ts imports it rather than redeclaring it. */
export const MAX_HISTORY_ENTRIES = 50;

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
    // ROADMAP §1.7: deliberate schema addition — see LocalHistoryEntry's doc comment in
    // utils/types.ts for why it's optional and why test/storage-payload.test.ts's key
    // tables were updated alongside it rather than around it.
    durationS: result.videoDurationS,
  };
}

/**
 * Pure upsert (ROADMAP §1.6, owner-reported bug): drop any existing entry for the same
 * videoId, prepend the new one, cap at maxEntries — EXCEPT when the new entry is
 * NO_SIGNAL and an existing INFORMATIVE entry (state !== 'NO_SIGNAL') for that videoId
 * is already stored, in which case the list is returned UNCHANGED.
 *
 * Owner-reported scenario: rewatching a video within the rewatch window correctly
 * classifies as NO_SIGNAL('recent-rewatch') (invariant 5 — rewatch-frequency-capped ad
 * placements are not NO_ADS evidence), but that verdict says nothing new about whether
 * the video actually serves ads, whereas an earlier ADS_SERVED/NO_ADS/UNAVAILABLE
 * observation on the SAME video was informative. Before this rule, dedup-by-videoId let
 * the uninformative rewatch silently overwrite the last real observation — "if I open
 * the same video twice it can no longer tell whether there are ads" — destroying the
 * only evidence ever collected for that video. An uninformative observation must never
 * destroy the last informative verdict.
 */
export function upsertLocalHistoryEntry(
  existing: LocalHistoryEntry[],
  entry: LocalHistoryEntry,
  maxEntries: number,
): LocalHistoryEntry[] {
  const priorEntry = existing.find((e) => e.videoId === entry.videoId);
  if (entry.state === 'NO_SIGNAL' && priorEntry !== undefined && priorEntry.state !== 'NO_SIGNAL') {
    return existing;
  }
  const withoutThisVideo = existing.filter((e) => e.videoId !== entry.videoId);
  return [entry, ...withoutThisVideo].slice(0, maxEntries);
}
