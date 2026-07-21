/**
 * Pure builder for the local diagnostic export (ROADMAP §1.7, "Export JSON" — the local
 * counterpart of the Phase 0 spike tool's export button). No browser imports: the popup
 * does the actual storage reads and file download (Blob + object URL + a clicked
 * `<a download>`, no `downloads` permission); this module only shapes the payload, so
 * it's directly unit-testable on its own.
 *
 * This is a SHAREABLE payload: the owner/beta testers (ROADMAP §2.5) hand this file to
 * the dev loop manually and voluntarily, before the Phase 2 backend exists to receive
 * anything automatically. Its schema is therefore deliberately explicit and versioned
 * rather than "whatever the local storage shapes happen to be" — it contains video ids
 * and observed states from the local history, plus the four-field local calibration
 * state, and NOTHING else: no browsing context beyond what's already in history, no
 * identifiers, no telemetry (this never leaves the browser except by the user's own
 * explicit download-and-share action, which stays entirely outside invariant
 * 1's opt-in telemetry, since there is no network call anywhere in this path).
 *
 * Schema changes to this export MUST bump schemaVersion — this is a versioned file
 * format handed to humans/scripts outside the extension, not an internal storage detail
 * that can drift silently like LocalHistoryEntry can (see that type's own doc comment
 * for the parallel, but separate, invariant-2 discipline it's under).
 */
import type { CalibrationState } from './calibration';
import type { LocalHistoryEntry } from './types';

export const LOCAL_EXPORT_FORMAT = 'adsauditor-local-export' as const;
export const LOCAL_EXPORT_SCHEMA_VERSION = 1 as const;

export interface LocalExport {
  format: typeof LOCAL_EXPORT_FORMAT;
  schemaVersion: typeof LOCAL_EXPORT_SCHEMA_VERSION;
  extensionVersion: string;
  /** ISO-8601, built from exportedAtMs at construction time — a plain timestamp number
   * would be less immediately readable in a file a human is expected to open. */
  exportedAt: string;
  calibration: CalibrationState;
  /** Consumers analyzing midroll eligibility: an entry's `durationS` of 0 means
   * UNKNOWN, not a zero-length video — background.ts's classifier context defaults the
   * duration to 0 when no player response ever carried one (e.g. NO_SIGNAL
   * 'no-player-response' entries). */
  history: LocalHistoryEntry[];
}

export function buildLocalExport(
  history: LocalHistoryEntry[],
  calibration: CalibrationState,
  extensionVersion: string,
  exportedAtMs: number,
): LocalExport {
  return {
    format: LOCAL_EXPORT_FORMAT,
    schemaVersion: LOCAL_EXPORT_SCHEMA_VERSION,
    extensionVersion,
    exportedAt: new Date(exportedAtMs).toISOString(),
    calibration,
    history,
  };
}
