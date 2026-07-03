/**
 * Shared types for the extension (docs/SPEC.md §3.3).
 *
 * TODO(§1.2): extend AdEvidence with per-source detail (source A placements, source B
 * DOM ads, source C beacons) as classifier.ts is implemented. Keep this file free of
 * browser/DB imports — classifier.ts and the consensus function depend on it and must
 * stay pure.
 */

/**
 * Observed states reported by the client — facts, not interpretations (SPEC §3.3).
 * The extension never reports an inferred "yellow icon"; that inference happens only
 * server-side (SPEC §1.1, §4.1).
 */
export type ObservedState = 'ADS_SERVED' | 'NO_ADS' | 'NO_SIGNAL' | 'UNAVAILABLE';

/** Which of the three independent signal sources contributed to an observation (SPEC §3.2). */
export type EvidenceSource = 'PLAYER_RESPONSE' | 'DOM' | 'BEACON';

/**
 * Detail attached to an ADS_SERVED observation (SPEC §3.3):
 * `{preroll, midrolls, postroll, sources}`.
 */
export interface AdEvidence {
  preroll: boolean;
  midrolls: number;
  postroll: boolean;
  sources: EvidenceSource[];
}

/**
 * Minimal context attached to an observation (SPEC §3.3). This is the bare minimum:
 * never history, watch time, search queries, or identity beyond the local pseudonymous
 * UUID (which is not part of this type — it lives with the observer record).
 */
export interface VideoContext {
  durationS: number;
  isLive: boolean;
  isLoggedIn: boolean;
  /** National-granularity hint only (e.g. "IT"), never precise geolocation. */
  countryHint: string | null;
  extensionVersion: string;
}
