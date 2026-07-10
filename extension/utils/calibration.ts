/**
 * Pure NO_SIGNAL calibration logic (docs/ROADMAP.md §1.3, SPEC §3.4): adblock/Premium
 * suspicion, control-video outcomes, and rewatch tracking. Same purity discipline as
 * classifier.ts — no browser/DB imports. The actual probes (bait fetch, masthead DOM
 * read, storage reads/writes) live in bridge.content.ts and background.ts; this module
 * only turns their raw results into decisions so those decisions stay unit-testable.
 */
import type { ClassificationResult, ObserverInvalidCause, ObserverValidity } from './types';

/**
 * Judgment calls, not measured constants — re-examine both once §2.5 beta-tester data
 * exists and before Phase 2 consensus thresholds freeze (ROADMAP §1.3 note).
 *
 * POSITIVE_EVIDENCE_WINDOW_MS: how long a single confirmed ADS_SERVED observation keeps
 * this browser "calibrated" before it must see another one to stay VALID.
 * REWATCH_WINDOW_MS: how long a videoId stays "recently watched" for rewatch-frequency-
 * capping purposes (spike/RESULTS.md §3.5).
 */
export const POSITIVE_EVIDENCE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h
export const REWATCH_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export const ADBLOCK_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const ADBLOCK_INCONCLUSIVE_RETRY_MS = 6 * 60 * 60 * 1000; // 6h
export const PREMIUM_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const PROBE_TIMEOUT_MS = 10 * 1000; // 10s

/** Result of one adblock bait-vs-control fetch pair (bridge.content.ts probes it). */
export type ProbeOutcome = 'resolved' | 'rejected' | 'timeout';

export type AdblockStatus = 'clear' | 'blocked' | 'inconclusive';

/**
 * Local-only calibration snapshot (never leaves the browser — see ClassifierContext's
 * doc comment in utils/types.ts). Persisted by background.ts under
 * `local:adsauditor_calibration`; defaults to all-null (never checked yet).
 */
export interface CalibrationState {
  adblock: { status: AdblockStatus; checkedAt: number } | null;
  premium: { detected: boolean; checkedAt: number } | null;
  lastPositiveEvidenceAt: number | null;
  lastControlFailureAt: number | null;
}

export const EMPTY_CALIBRATION_STATE: CalibrationState = {
  adblock: null,
  premium: null,
  lastPositiveEvidenceAt: null,
  lastControlFailureAt: null,
};

/**
 * Pure truth table for one adblock probe round (SPEC §3.4). `bait` targets a canonical
 * EasyList URL (utils/selectors.ts adblockProbe.baitUrl); `control` targets a YouTube
 * endpoint no blocklist touches (adblockProbe.controlUrl).
 *
 * - bait resolved → the request went through: 'clear' (regardless of control — if the
 *   bait made it, there is no blocker to detect).
 * - bait rejected + control resolved → the network is fine but the bait specifically was
 *   blocked: 'blocked'.
 * - bait rejected + control rejected → BOTH failed: this is offline / captive portal /
 *   general network failure, not evidence of an adblocker. Must never read as 'blocked'
 *   (that would poison observerValid for a browser that isn't running a blocker at all).
 * - bait timeout → blockers reject fast (they intercept synchronously); a hang instead
 *   is a network pathology (slow DNS, congestion), not adblock signal: 'inconclusive'.
 *
 * KNOWN BLIND SPOT (this pure function cannot see it — background.ts's glue corrects
 * for it): uBlock Origin's default filter lists REDIRECT the bait URL to a local
 * neutered stub instead of cancelling it outright, so `fetch()` still resolves and this
 * truth table alone reads it as 'clear' even though the most common blocker is active.
 * background.ts independently observes `webRequest.onBeforeRedirect` for the bait
 * request and overrides a 'clear' verdict to 'blocked' when a redirect was seen — see
 * that file's `mergeCalibrationResult`. This function's truth table itself is
 * unchanged/unaware of that override, by design (it stays pure and browser-free).
 */
export function interpretAdblockProbe(bait: ProbeOutcome, control: ProbeOutcome): AdblockStatus {
  if (bait === 'resolved') return 'clear';
  if (bait === 'timeout') return 'inconclusive';
  // bait === 'rejected'
  if (control === 'resolved') return 'blocked';
  return 'inconclusive'; // control also failed (rejected or timeout): can't attribute to adblock
}

/**
 * Priority order, first match wins (SPEC §3.4). Conclusive check results (adblock,
 * premium) do NOT expire into "unknown" — staleness only drives background.ts's re-run
 * cadence (ADBLOCK_CHECK_TTL_MS / PREMIUM_CHECK_TTL_MS), never this function's verdict.
 * The only path to VALID is a recent ADS_SERVED observation on ANY video (4) — not just
 * a control video, and rewatches count too: ads observed despite rewatch-frequency
 * capping are, if anything, stronger evidence the observer can receive ads, not weaker.
 */
export function resolveObserverValidity(
  calibration: CalibrationState,
  nowMs: number,
): ObserverValidity {
  if (calibration.adblock?.status === 'blocked') {
    return { valid: false, cause: 'adblock-suspected' };
  }
  if (calibration.premium?.detected) {
    return { valid: false, cause: 'premium-suspected' };
  }
  if (
    calibration.lastControlFailureAt !== null &&
    (calibration.lastPositiveEvidenceAt === null ||
      calibration.lastControlFailureAt > calibration.lastPositiveEvidenceAt)
  ) {
    // Recovery is automatic: any later ADS_SERVED advances lastPositiveEvidenceAt past
    // this failure, so a fixed browser doesn't stay flagged forever.
    return { valid: false, cause: 'calibration-failed' };
  }
  if (
    calibration.lastPositiveEvidenceAt !== null &&
    nowMs - calibration.lastPositiveEvidenceAt <= POSITIVE_EVIDENCE_WINDOW_MS
  ) {
    return { valid: true };
  }
  return { valid: false, cause: 'uncalibrated' };
}

/**
 * 'fail' fires only when a control video was watched fresh (not a capped rewatch) and
 * classify() read a playable response with zero ad evidence of any kind — i.e. exactly
 * the classifier branches that require a real player-response read (playabilityStatus
 * OK, `latestPlayerResponse` present) AND found no placement/DOM/beacon evidence:
 * NO_ADS (context was already valid+fresh) or NO_SIGNAL with cause 'uncalibrated' /
 * 'calibration-failed' (context was invalid, but the classifier still reached the
 * "no evidence" fall-through — see classifier.ts's decision order: 'no-player-response'
 * and 'anomalous-beacon-only' both return BEFORE the validity gate, so they cannot mean
 * "zero evidence read"; 'adblock-suspected'/'premium-suspected'/'recent-rewatch' are
 * excluded by the isControlVideo/!recentlyWatched guards on this function, and in any
 * case a suspected-adblock/Premium session isn't a trustworthy negative control result).
 *
 * 'pass' fires when the control video showed ADS_SERVED, as expected.
 * Everything else (UNAVAILABLE, no-player-response, anomalous-beacon-only, a rewatch, a
 * non-control video) is 'not-applicable' — not evidence either way.
 */
export function evaluateControlOutcome(
  result: ClassificationResult,
  isControlVideo: boolean,
  recentlyWatched: boolean,
): 'pass' | 'fail' | 'not-applicable' {
  if (!isControlVideo) return 'not-applicable';

  if (result.state === 'ADS_SERVED') return 'pass';

  if (recentlyWatched) return 'not-applicable'; // spike constraint: calibration needs fresh watches

  const zeroEvidenceCauses: ReadonlyArray<ObserverInvalidCause> = [
    'uncalibrated',
    'calibration-failed',
  ];
  const isZeroEvidenceNoSignal =
    result.state === 'NO_SIGNAL' &&
    result.noSignalCause !== undefined &&
    (zeroEvidenceCauses as readonly string[]).includes(result.noSignalCause);

  if (result.state === 'NO_ADS' || isZeroEvidenceNoSignal) return 'fail';

  return 'not-applicable';
}

/** REWATCH_WINDOW_MS-bounded lookup: was this exact videoId watched by this browser
 * recently (spike constraint: rewatch-frequency-capped ad placements make absence
 * worthless as evidence)? */
export function isRecentlyWatched(
  index: Record<string, number>,
  videoId: string,
  nowMs: number,
): boolean {
  const lastWatchedAt = index[videoId];
  return lastWatchedAt !== undefined && nowMs - lastWatchedAt <= REWATCH_WINDOW_MS;
}

/** Self-bounding prune: drop entries older than REWATCH_WINDOW_MS so the rewatch index
 * never grows unbounded (no separate cap needed — unlike LocalHistoryEntry's 50-entry
 * cap, this index's entries expire on their own). */
export function pruneRewatchIndex(
  index: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const pruned: Record<string, number> = {};
  for (const [videoId, watchedAt] of Object.entries(index)) {
    if (nowMs - watchedAt <= REWATCH_WINDOW_MS) {
      pruned[videoId] = watchedAt;
    }
  }
  return pruned;
}
