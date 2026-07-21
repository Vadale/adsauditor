/**
 * Shared chrome.storage key constants (docs/SPEC.md -§1.4).
 *
 * background.ts is the sole writer of all five keys; the popup (§1.4) and options
 * (§1.3/§1.4) pages are read-only consumers of LOCAL_HISTORY_KEY and
 * CALIBRATION_STORAGE_KEY. Centralized here (rather than duplicating the string
 * literals in each reader) so a rename can't silently drift between writer and reader.
 */
export const SESSION_STORAGE_KEY = 'session:adsauditor_sessions' as const;
export const LOCAL_SESSIONS_FALLBACK_KEY = 'local:adsauditor_sessions_fallback' as const;
export const LOCAL_HISTORY_KEY = 'local:adsauditor_history' as const;
export const CALIBRATION_STORAGE_KEY = 'local:adsauditor_calibration' as const;
export const REWATCH_INDEX_STORAGE_KEY = 'local:adsauditor_rewatch_index' as const;
