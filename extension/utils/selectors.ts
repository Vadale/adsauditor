/**
 * Every CSS selector, DOM id, event name, URL pattern, and JSON path used anywhere in
 * the extension lives here — and only here. When YouTube changes its markup or
 * player-response shape, this is the one file that needs a PR.
 *
 * Two kinds of constants live here: (1) YouTube-facing values (its DOM, its SPA events,
 * its player-response JSON shape) and (2) this extension's own MAIN-world <-> ISOLATED
 * world postMessage protocol, kept alongside them because both interceptor.content.ts
 * and bridge.content.ts need identical values and this is the one shared, browser-API-free
 * module both can import from.
 */

/** DOM ids/selectors for YouTube's player element and its ad UI (SPEC §3.2, source B). */
export const selectors = {
  /** Root player element; MutationObserver target (bridge.content.ts) and
   * document.getElementById() target for getPlayerResponse/getCurrentTime/getVideoData
   * (interceptor.content.ts — those methods only exist on the MAIN-world's own wrapper
   * around this element, see interceptor.content.ts header comment). */
  moviePlayer: '#movie_player',
  moviePlayerId: 'movie_player',
  /** Matches any of YouTube's `.ytp-ad-*` ad UI elements (badge, skip button, countdown,
   * overlay) — bridge.content.ts's badge-sighting MutationObserver callback. */
  adBadgeElements: '[class*="ytp-ad-"]',
  /**
   * YouTube Premium masthead badge (ROADMAP §1.3, SPEC §3.4 Premium heuristic).
   *
   * UNVERIFIED: there is no Premium account in the project yet, so this compound
   * selector is a best-effort guess pending a Premium beta tester / the §1.5 manual
   * checklist. A no-match degrades to `detected: false` BY DESIGN — false negatives here
   * are caught by the control-video calibration backstop (SPEC §3.4), never silently
   * trusted as "definitely not Premium". Do not tighten NO_SIGNAL discipline around this
   * selector alone.
   */
  mastheadPremiumBadge:
    'ytd-topbar-logo-renderer ytd-logo[is-premium-logo], ytd-masthead #logo [aria-label*="Premium"]',
} as const;

/** #movie_player classList values toggled while an ad is playing — bridge.content.ts's
 * MutationObserver (attribute: class) and interceptor.content.ts's ad-state check that
 * gates the content-time sampler (SPEC §3.2). */
export const domAdStateClasses = ['ad-showing', 'ad-interrupting'] as const;

/** YouTube SPA lifecycle custom event (SPEC §3.2). interceptor.content.ts uses it to
 * reset MAIN-world per-video state; bridge.content.ts uses it to re-attempt the
 * MutationObserver attach and reset its per-video dedup state. */
export const YT_NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';

/** postMessage bridge between interceptor.content.ts (MAIN) and bridge.content.ts
 * (ISOLATED) (SPEC §3.2). The session token is handed off via a DOM dataset attribute
 * because JS globals are not shared across worlds but the DOM is. */
export const bridgeChannel = {
  name: 'adsauditor',
  /** document.documentElement.dataset[tokenDatasetKey] — camelCase, becomes
   * `data-adsauditor-token` in the DOM. Written by bridge.content.ts, read (with retry)
   * by interceptor.content.ts. */
  tokenDatasetKey: 'adsauditorToken',
} as const;

/** postMessage `type` values interceptor.content.ts (MAIN) posts to bridge.content.ts
 * (ISOLATED). */
export const bridgeMessageTypes = {
  /** Carries a PlayerResponseEvent (source A); bridge.content.ts forwards it to
   * background.ts unchanged. */
  playerResponse: 'PLAYER_RESPONSE_EVENT',
  /** Carries `{ contentTimeSeconds }` from the MAIN-world content-time sampler;
   * bridge.content.ts keeps only the latest value locally to attach to DomAdEvents — it
   * is never itself forwarded to background.ts (SPEC §3.2: "include the last-known
   * content time in emitted events"). */
  contentTimeSample: 'CONTENT_TIME_SAMPLE',
} as const;

/** browser.runtime.sendMessage `kind` tags used between bridge.content.ts and
 * background.ts. Internal protocol, never exposed to the page. */
export const runtimeMessageKinds = {
  playerResponseEvent: 'ADSAUDITOR_PLAYER_RESPONSE_EVENT',
  domAdEvent: 'ADSAUDITOR_DOM_AD_EVENT',
  /** Sent by bridge.content.ts on load and on every yt-navigate-finish. background.ts
   * needs it to know when a tab LEAVES a watch page: beacons carry no videoId, and
   * without this signal homepage display-ad traffic would keep feeding the previous
   * video's session (§1.2 review finding). The `tabs` permission (which would expose
   * tab URLs directly) stays out of the manifest — invariant 7. */
  pageNavigated: 'ADSAUDITOR_PAGE_NAVIGATED',
  /** Sent by bridge.content.ts on load and on every yt-navigate-finish (ROADMAP §1.3).
   * background.ts replies with `{ runAdblockCheck, runPremiumCheck }` computed from
   * cached calibration timestamps (uses the sendResponse-callback + `return true`
   * pattern for cross-browser MV3 async-response safety). */
  calibrationDueQuery: 'ADSAUDITOR_CALIBRATION_DUE_QUERY',
  /** Sent by bridge.content.ts after running an adblock and/or Premium probe; carries a
   * partial `{ adblock?, premium? }` CalibrationState update (ROADMAP §1.3). */
  calibrationResult: 'ADSAUDITOR_CALIBRATION_RESULT',
  /** Sent by the popup (ROADMAP §1.4) with `{ tabId }` — NOT a content-script message,
   * so it carries no `sender.tab`; background.ts must handle it before the
   * `sender.tab?.id` check every other kind here relies on. Replies with
   * `{ videoId, result } | null` (sendResponse-callback + `return true`, same
   * cross-browser async pattern as calibrationDueQuery). */
  tabStateQuery: 'ADSAUDITOR_TAB_STATE_QUERY',
} as const;

/**
 * Adblock bait-vs-control probe targets (ROADMAP §1.3, SPEC §3.4). `baitUrl` is the
 * canonical EasyList-blocked adsbygoogle.js request, already covered by the existing
 * `*.googlesyndication.com` host_permissions entry (invariant 7 (docs/INVARIANTS.md) untouched —
 * no new permission needed). `markerParam` lets background.ts's webRequest listener
 * recognize and drop this self-generated request before it's misread as a real ad
 * beacon (it originates in a real tab, so the tabId<0 guard alone does not catch it).
 * `controlUrl` is a plain YouTube endpoint no blocklist targets, used to tell "network is
 * down" apart from "this specific request was blocked" (utils/calibration.ts
 * interpretAdblockProbe).
 */
export const adblockProbe = {
  baitUrl: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?adsauditor_probe=1',
  markerParam: 'adsauditor_probe',
  controlUrl: 'https://www.youtube.com/generate_204',
} as const;

/**
 * Source A network path: interceptor.content.ts's window.fetch wrap matches on this
 * EXACT pathname. A substring match also caught `/youtubei/v1/player/ad_break` and
 * `/youtubei/v1/player/heartbeat` in the field, producing garbage records (spike-verified,
 * spike/RESULTS.md §3 finding 7 / spike/interceptor.js).
 */
export const PLAYER_ENDPOINT_PATHNAME = '/youtubei/v1/player';

/**
 * YouTube video ID format: 11 characters, URL-safe base64 alphabet. This has been
 * stable since YouTube's inception — this is the one place to relax it if that ever
 * changes. Used by utils/types.ts's runtime shape guards to reject video-id fields
 * (pageVideoId, videoId, watchUrlVideoId) that don't look like a real YouTube ID —
 * part of hardening the MAIN-world postMessage trust boundary, where a hostile page
 * script can read the session token (page-readable by design) and post arbitrary
 * well-shaped events (security audit finding M2).
 */
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Source C beacon URL match patterns (Chrome match-pattern syntax) — background.ts's
 * `webRequest.onBeforeRequest` filter (SPEC §3.2). Must stay within invariant
 * 7's host permissions (youtube.com, doubleclick.net, googlesyndication.com); adding a
 * pattern here that isn't already covered by wxt.config.ts host_permissions requires the
 * explicit justification invariant 7 demands.
 */
export const beaconUrlMatchPatterns = [
  'https://www.youtube.com/api/stats/ads*',
  'https://www.youtube.com/pagead/*',
  'https://googleads.g.doubleclick.net/*',
  'https://*.googlesyndication.com/*',
] as const;

/**
 * Narrower single-pattern match, ROADMAP §1.3: background.ts's
 * `webRequest.onBeforeRedirect` listener uses this (not the full 4-pattern
 * beaconUrlMatchPatterns list) to watch for REDIRECT-style ad blocking of our own
 * adblock bait request (adblockProbe.baitUrl) specifically — see that file's
 * `mergeCalibrationResult` and utils/calibration.ts's interpretAdblockProbe doc comment
 * for why a redirected-not-cancelled bait request needs this separate signal. Already
 * covered by the existing `*.googlesyndication.com` host_permissions entry (docs/INVARIANTS.md
 * invariant 7 untouched).
 */
export const googlesyndicationRedirectMatchPattern = 'https://*.googlesyndication.com/*' as const;

/**
 * Plain substrings/hostnames used to classify a URL that already matched
 * `beaconUrlMatchPatterns` into a BeaconKind (background.ts). Kept separate from the
 * match-pattern strings above because match-pattern wildcard syntax (`*://`) is not
 * valid input for a literal `.includes()`/hostname comparison.
 */
export const beaconUrlFragments = {
  youtubeHostname: 'www.youtube.com',
  statsAdsPath: '/api/stats/ads',
  pageadPath: '/pagead/',
  doubleclickHostnameSuffix: 'doubleclick.net',
  googlesyndicationHostnameSuffix: 'googlesyndication.com',
} as const;

/**
 * JSON paths read from the player response object (SPEC §3.2, source A). Field-verified
 * during the Phase 0 spike (spike/interceptor.js, spike/RESULTS.md §2). These are
 * documentation of the exact property chains interceptor.content.ts's extraction
 * functions walk — keep both in sync when YouTube changes shape.
 */
export const jsonPaths = {
  playabilityStatus: 'playabilityStatus.status',
  videoDetailsVideoId: 'videoDetails.videoId',
  videoDetailsDurationSeconds: 'videoDetails.lengthSeconds',
  videoDetailsIsLiveContent: 'videoDetails.isLiveContent',
  /** Primary shape, field-verified 2026-07-02 (spike/RESULTS.md §2): a flat
   * `placement.adPlacementConfig` read came back with every item's kind/offsets null;
   * the real path is nested one level deeper under a renderer wrapper. */
  adPlacementRendererConfig: 'adPlacements[].adPlacementRenderer.config.adPlacementConfig',
  /** Fallback shape, checked when the renderer path above is absent — kept in case some
   * other YouTube surface/experiment uses the flatter shape. */
  adPlacementFlatConfig: 'adPlacements[].adPlacementConfig',
  adPlacementKind: 'adPlacementConfig.kind',
  adPlacementOffsetStartMs: 'adPlacementConfig.adTimeOffset.offsetStartMilliseconds',
  adPlacementOffsetEndMs: 'adPlacementConfig.adTimeOffset.offsetEndMilliseconds',
  adSlotType: 'adSlots[].adSlotRenderer.adSlotMetadata.slotType',
  /** ytcfg.get('LOGGED_IN') — interceptor.content.ts, best-effort only. */
  ytcfgLoggedInKey: 'LOGGED_IN',
} as const;

/**
 * `adPlacements[].kind` enum values observed in the field (spike/RESULTS.md §2/§3), used
 * by classifier.ts to derive preroll/midroll/postroll. AD_PLACEMENT_KIND_SELF_START's
 * meaning is not yet understood and is intentionally not mapped to any of the three by
 * classifier.ts.
 */
export const adPlacementKinds = {
  start: 'AD_PLACEMENT_KIND_START',
  milliseconds: 'AD_PLACEMENT_KIND_MILLISECONDS',
  end: 'AD_PLACEMENT_KIND_END',
  selfStart: 'AD_PLACEMENT_KIND_SELF_START',
} as const;

/** `adSlots[].adSlotRenderer.adSlotMetadata.slotType` enum values observed in the field
 * (spike/RESULTS.md §2). Not yet consumed by classifier.ts; kept for future calibration. */
export const adSlotTypes = {
  inPlayer: 'SLOT_TYPE_IN_PLAYER',
  playerBytes: 'SLOT_TYPE_PLAYER_BYTES',
  aboveFeed: 'SLOT_TYPE_ABOVE_FEED',
} as const;
