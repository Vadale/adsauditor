/**
 * Service worker: per-tab VideoSession state, source C (webRequest beacons), storage
 * (docs/SPEC.md §3.2, docs/ROADMAP.md §1.2).
 *
 * MV3 constraint: webRequest listeners must be registered synchronously at the top
 * level of this file — the service worker can be terminated and woken by events, but
 * only listeners declared statically at startup are re-attached on wake.
 */
export default defineBackground(() => {
  // TODO(§1.2): tabId -> VideoSession map. Message handlers receiving A (player
  // response) and B (DOM) events forwarded by bridge.content.ts.
  // TODO(§1.2): browser.webRequest.onBeforeRequest.addListener(...) registered here,
  // synchronously, observing (never blocking) requests to:
  //   - youtube.com/api/stats/ads
  //   - youtube.com/pagead/*
  //   - googleads.g.doubleclick.net
  //   - *.googlesyndication.com
  // No declarativeNetRequest, no request/response body access — URLs only.
});
