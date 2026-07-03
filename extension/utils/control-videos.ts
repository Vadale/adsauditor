/**
 * NO_SIGNAL self-calibration list (docs/SPEC.md §3.4): a small set of videos known to
 * be monetized. If the observer never sees an ad signal even on these, it is marked
 * NO_SIGNAL regardless of cause — this is what makes the system honest by construction.
 *
 * TODO(§1.3): populate from spike/RESULTS.md (project owner supplies the list; this
 * file intentionally ships empty). TODO(§2.4): once the backend exists, this list moves
 * server-side (public control-videos endpoint, 24h cache) and this file becomes the
 * local fallback used before first sync.
 */
import type { ObservedState } from './types';

export interface ControlVideo {
  videoId: string;
  expectedState: Extract<ObservedState, 'ADS_SERVED'>;
  note?: string;
}

export const CONTROL_VIDEOS: ControlVideo[] = [];
