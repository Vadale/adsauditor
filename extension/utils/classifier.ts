/**
 * Pure classifier: events -> observed state (docs/SPEC.md §3.2, §3.3).
 *
 * This file and the server-side consensus function are the most-tested code in the
 * repo (CLAUDE.md) and must stay pure: no browser APIs, no DB/network imports. Every
 * dependency comes in as a plain argument so the function can be driven entirely from
 * Vitest fixtures (extension/test/fixtures/).
 *
 * TODO(§1.2): implement the A/B/C cross-reference table from SPEC §3.2 and return an
 * ObservedState per §3.3 (ADS_SERVED with AdEvidence detail, NO_ADS, NO_SIGNAL,
 * UNAVAILABLE). TODO(§1.3): fold in NO_SIGNAL causes (adblock bait-fetch, Premium
 * heuristic, control-video calibration).
 */
import type { ObservedState, VideoContext } from './types';

/**
 * TODO(§1.2): replace `unknown[]` with the typed union of PlayerResponseEvent |
 * DomAdEvent | BeaconEvent once sources A/B/C are implemented.
 */
export function classify(events: unknown[], context: VideoContext): ObservedState {
  void events;
  void context;
  throw new Error('classify() is not implemented yet — see docs/ROADMAP.md §1.2');
}
