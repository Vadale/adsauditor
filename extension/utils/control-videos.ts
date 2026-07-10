/**
 * NO_SIGNAL self-calibration list (docs/SPEC.md §3.4): a small set of videos known to
 * be monetized. If the observer never sees an ad signal even on these, it is marked
 * NO_SIGNAL regardless of cause — this is what makes the system honest by construction.
 *
 * Dated 2026-07-10: channel diversity was chosen over raw count so that one channel's
 * monetization change (a creator opting out of ads, a policy strike, etc.) cannot poison
 * calibration wholesale for every observer. This list is static until ROADMAP §2.4 moves
 * it server-side (public control-videos endpoint, 24h cache) — until then, every §1.5
 * manual checklist run must re-verify that at least one control video still shows ads.
 *
 * TODO(§2.4): move server-side once the backend exists; this file becomes the local
 * fallback used before first sync.
 */
import type { ObservedState } from './types';

export interface ControlVideo {
  videoId: string;
  expectedState: Extract<ObservedState, 'ADS_SERVED'>;
  /** Distinguishes spike-measured confidence from unmeasured-but-high-confidence picks
   * (large established channels virtually certain to run mid-roll ads) from
   * market-diversity picks (Italian ad market, distinct from the US-heavy remainder). */
  note: string;
}

export const CONTROL_VIDEOS: ControlVideo[] = [
  {
    videoId: 'iYlODtkyw_I',
    expectedState: 'ADS_SERVED',
    note: 'MrBeast — spike-validated 1 preroll / 18 midrolls / 1 postroll',
  },
  {
    videoId: '__fmDj0ZJ1Q',
    expectedState: 'ADS_SERVED',
    note: 'MrBeast — spike-validated 1 preroll / 14 midrolls / 1 postroll',
  },
  {
    videoId: 'mvcesPWvUIc',
    expectedState: 'ADS_SERVED',
    note: 'Veritasium — high-confidence, unmeasured',
  },
  {
    videoId: 'h0EGCnBjTVk',
    expectedState: 'ADS_SERVED',
    note: 'Mark Rober — high-confidence, unmeasured',
  },
  {
    videoId: 'PqtggjVAi8M',
    expectedState: 'ADS_SERVED',
    note: 'Kurzgesagt — high-confidence, unmeasured',
  },
  {
    videoId: 'WOzcFkld6_g',
    expectedState: 'ADS_SERVED',
    note: 'Marques Brownlee — high-confidence, unmeasured',
  },
  {
    videoId: 'l_UwsECR6cE',
    expectedState: 'ADS_SERVED',
    note: 'BBC Earth — high-confidence, unmeasured',
  },
  {
    videoId: 'Yquveld-AKI',
    expectedState: 'ADS_SERVED',
    note: 'Geopop — Italian ad market',
  },
  {
    videoId: 'y6cYgyQlDHE',
    expectedState: 'ADS_SERVED',
    note: 'Geopop — Italian ad market',
  },
];

const CONTROL_VIDEO_IDS = new Set(CONTROL_VIDEOS.map((v) => v.videoId));

export function isControlVideo(videoId: string): boolean {
  return CONTROL_VIDEO_IDS.has(videoId);
}
