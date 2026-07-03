/**
 * Source B — DOM ad signals, plus the MAIN-world ↔ ISOLATED-world bridge (docs/SPEC.md §3.2).
 *
 * Runs in the default ISOLATED world, so it has access to `browser.*` APIs. Two jobs:
 * 1. Validate postMessages coming from interceptor.content.ts (origin + session-token
 *    check) and forward the resulting PlayerResponseEvent to background.ts.
 * 2. Own a MutationObserver on `#movie_player` watching for the `ad-showing` /
 *    `ad-interrupting` classes and ad badge/skip-button elements, emitting DomAdEvent
 *    (type: preroll/midroll with playback timestamp) to background.ts.
 *
 * All CSS selectors and JSON paths must come from utils/selectors.ts — never inline
 * here (CLAUDE.md).
 *
 * TODO(§1.2): window.addEventListener('message', ...) with origin + token validation;
 * new MutationObserver(...).observe(document.querySelector(selectors.moviePlayer), ...);
 * forward validated events to background.ts via browser.runtime.sendMessage.
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  main() {
    // TODO(§1.2): implement postMessage validation + DOM observation. No-op until then.
  },
});
