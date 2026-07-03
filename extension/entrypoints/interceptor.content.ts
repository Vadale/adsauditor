/**
 * Source A — Player Response interception (docs/SPEC.md §3.2).
 *
 * Runs in the page's MAIN world so it can read `window.ytInitialPlayerResponse`, wrap
 * `window.fetch` to observe `/youtubei/v1/player` calls, and read on-demand from
 * `document.getElementById('movie_player').getPlayerResponse()`.
 *
 * The MAIN world has no access to `chrome.*` / `browser.*` APIs: this script must talk
 * to bridge.content.ts (ISOLATED world) exclusively via `window.postMessage`, with
 * strict `origin` checking and a shared session token (never trust unauthenticated
 * postMessages on a page as adversarial as youtube.com).
 *
 * TODO(§1.2): read ytInitialPlayerResponse on load; wrap window.fetch (and XHR as a
 * fallback) to clone /youtubei/v1/player responses without altering them; listen for
 * yt-navigate-finish / yt-page-data-updated to reset state per video; emit typed
 * PlayerResponseEvent objects via postMessage with the session token from bridge.content.ts.
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  main() {
    // TODO(§1.2): implement player response capture. Intentionally a no-op until then.
  },
});
