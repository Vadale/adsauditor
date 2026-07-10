/**
 * Pure popup-evidence helpers (ROADMAP §1.4/§1.6) — no browser imports, so they're
 * directly unit-testable independent of browser.i18n. Not used by classifier.ts or
 * utils/calibration.ts; this is UI-summary glue one level up from them.
 */
import type { EvidenceSource } from './types';

/** The i18n message keys the qualitative confidence line can resolve to (matches the
 * `confidence*` keys in public/_locales/en/messages.json). */
export type ConfidenceMessageKey = 'confidenceHigh' | 'confidenceMedium' | 'confidenceSingle';

/**
 * True iff source B (DOM) or source C (BEACON) corroborates an ADS_SERVED result — i.e.
 * an ad was actually witnessed playing or showing UI, not merely decided upon in the
 * player response alone (SPEC §3.2 cross-reference table row 2: "decision made,
 * playback not observed"). The ADS_SERVED state is SPEC-correct either way — this only
 * distinguishes what the popup headline can honestly claim was actually witnessed
 * (ROADMAP §1.6, owner-reported: "ads served" shown with no visible ad and no source
 * B/C corroboration overstated what was measured).
 */
export function adPlaybackObserved(sources: EvidenceSource[]): boolean {
  return sources.includes('DOM') || sources.includes('BEACON');
}

/**
 * Qualitative confidence bucketing (SPEC §3.2 / ROADMAP §1.4): derived purely from how
 * many of the three independent sources (A/B/C) agree on an ADS_SERVED result. Never a
 * percentage — nothing is calibrated yet. A count outside [0,3] (defensive only; classify()
 * never produces more than 3 or fewer than 0) clamps to the nearest valid bucket rather
 * than throwing.
 */
export function confidenceMessageKeyForSourceCount(sourceCount: number): ConfidenceMessageKey {
  if (sourceCount >= 3) return 'confidenceHigh';
  if (sourceCount === 2) return 'confidenceMedium';
  return 'confidenceSingle';
}
