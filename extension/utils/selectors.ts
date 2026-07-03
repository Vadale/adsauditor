/**
 * Every CSS selector and YouTube JSON path used anywhere in the extension lives here —
 * and only here. When YouTube changes its markup or player-response shape, this is the
 * one file that needs a PR (CLAUDE.md).
 *
 * TODO(§1.2): fill in the real selectors/paths, validated against the fixtures in
 * extension/test/fixtures/ (captured during the Phase 0 spike, see spike/RESULTS.md).
 * TODO(§5.3): keep this in sync with the weekly selector-watchdog canary.
 */

export const selectors = {
  /** Root player element; MutationObserver target for source B (SPEC §3.2). */
  moviePlayer: '#movie_player',
  // TODO(§1.2): ad-showing / ad-interrupting classes, ad badge, skip button selectors.
} as const;

export const jsonPaths = {
  // TODO(§1.2): playabilityStatus.status, adPlacements[], adSlots[], playerAds[],
  // videoDetails (videoId, duration, isLiveContent), microformat (visibility, familySafe).
} as const;
