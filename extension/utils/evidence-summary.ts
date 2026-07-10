/**
 * Pure popup-evidence helpers (ROADMAP §1.4) — no browser imports, so they're directly
 * unit-testable (tests land in §1.5) independent of browser.i18n. Not used by
 * classifier.ts or utils/calibration.ts; this is UI-summary glue one level up from them.
 */

/** The i18n message keys the qualitative confidence line can resolve to (matches the
 * `confidence*` keys in public/_locales/en/messages.json). */
export type ConfidenceMessageKey = 'confidenceHigh' | 'confidenceMedium' | 'confidenceSingle';

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
