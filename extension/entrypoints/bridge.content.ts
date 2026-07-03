/**
 * Source B — DOM ad signals, plus the MAIN-world <-> ISOLATED-world bridge (docs/SPEC.md §3.2).
 *
 * Runs in the default ISOLATED world, so it has access to `browser.*` APIs. Two jobs:
 * 1. Validate postMessages coming from interceptor.content.ts (origin + session-token
 *    check) and forward the resulting PlayerResponseEvent to background.ts. Also tracks
 *    the latest content-time sample from the MAIN-world sampler (never forwarded to
 *    background.ts on its own — it only ever rides along on a DomAdEvent).
 * 2. Own a MutationObserver on `#movie_player` watching for the `ad-showing` /
 *    `ad-interrupting` classes and ad badge elements, emitting DomAdEvent (SPEC §3.2,
 *    source B) to background.ts.
 *
 * All CSS selectors and JSON paths come from utils/selectors.ts — never inline here
 * (CLAUDE.md).
 */
import {
  bridgeChannel,
  bridgeMessageTypes,
  domAdStateClasses,
  runtimeMessageKinds,
  selectors,
  YT_NAVIGATE_FINISH_EVENT,
} from '../utils/selectors';
import { isPlayerResponseEventShape, isRecord } from '../utils/types';
import type { DomAdEvent, DomAdEventKind } from '../utils/types';

declare global {
  interface Window {
    __adsauditorBridgeLoaded?: boolean;
  }
}

const MOVIE_PLAYER_ATTACH_RETRY_MS = 500;
const MOVIE_PLAYER_ATTACH_MAX_RETRIES = 30; // ~15s window covering the initial load

function getWatchUrlVideoId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('v');
  } catch {
    return null;
  }
}

function main(ctx: InstanceType<typeof ContentScriptContext>): void {
  if (window.__adsauditorBridgeLoaded) return;
  window.__adsauditorBridgeLoaded = true;

  // ---------------------------------------------------------------------------------
  // Session token: generated here (ISOLATED world), handed to interceptor.content.ts
  // (MAIN world) via a DOM dataset attribute — JS globals are not shared across worlds,
  // but the DOM is (SPEC §3.2).
  // ---------------------------------------------------------------------------------
  const SESSION_TOKEN =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  document.documentElement.dataset[bridgeChannel.tokenDatasetKey] = SESSION_TOKEN;

  // Latest content-time sample from the MAIN-world sampler (null = unknown/stale, e.g.
  // right after a navigation — see interceptor.content.ts's yt-navigate-finish handler).
  let lastKnownContentTimeSeconds: number | null = null;

  function forwardDomAdEvent(kind: DomAdEventKind): void {
    const event: DomAdEvent = {
      source: 'DOM',
      kind,
      watchUrlVideoId: getWatchUrlVideoId(),
      contentTimeSeconds: lastKnownContentTimeSeconds,
      capturedAt: Date.now(),
    };
    browser.runtime.sendMessage({ kind: runtimeMessageKinds.domAdEvent, event }).catch(() => {
      // Extension context can be invalidated (reload during dev, or tab closing
      // mid-flight); this is a fire-and-forget forward, nothing useful to recover here.
    });
  }

  // ---------------------------------------------------------------------------------
  // postMessage validation (MAIN -> ISOLATED): source, origin, channel, and session
  // token are all checked before anything is trusted (SPEC §3.2).
  // ---------------------------------------------------------------------------------
  ctx.addEventListener(window, 'message', (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data: unknown = event.data;
    if (!isRecord(data)) return;
    if (data.channel !== bridgeChannel.name) return;
    if (data.token !== SESSION_TOKEN) return;

    if (data.type === bridgeMessageTypes.playerResponse) {
      // Deep shape validation at the first trust boundary: MAIN-world messages are
      // forgeable by page scripts (the token is page-readable by design), and one
      // malformed event persisted into a session would poison classify() permanently.
      if (isPlayerResponseEventShape(data.payload)) {
        browser.runtime
          .sendMessage({ kind: runtimeMessageKinds.playerResponseEvent, event: data.payload })
          .catch(() => {
            // See forwardDomAdEvent above: fire-and-forget, nothing to recover here.
          });
      }
      return;
    }

    if (data.type === bridgeMessageTypes.contentTimeSample) {
      const payload = data.payload;
      if (
        isRecord(payload) &&
        (typeof payload.contentTimeSeconds === 'number' || payload.contentTimeSeconds === null)
      ) {
        lastKnownContentTimeSeconds = payload.contentTimeSeconds;
      }
    }
  });

  // ---------------------------------------------------------------------------------
  // Source B: MutationObserver on #movie_player for ad-state class transitions and ad
  // badge sightings.
  // ---------------------------------------------------------------------------------
  let movieObserverAttached = false;
  let previousAdStateClasses = new Set<string>();
  const seenBadgeClassNames = new Set<string>();

  function classListToSet(el: Element): Set<string> {
    return new Set(Array.from(el.classList));
  }

  /**
   * Resets per-video-session tracking state. Called on first attach AND again on every
   * subsequent yt-navigate-finish (spike lesson (a): a first-attach-only observer lost
   * all DOM data when the session started on the homepage and the element didn't exist
   * yet at that point).
   *
   * Also closes spike lesson (b): an ad already showing at the moment we (re)attach
   * produces no mutation to react to (this missed a preroll in the spike) — reading the
   * CURRENT classList here and synthesizing a start event for any ad-state class already
   * present fixes that, including the "autoplay to next video with an instant preroll"
   * case on a plain per-navigation reset.
   */
  function primeObserverState(el: Element): void {
    previousAdStateClasses = classListToSet(el);
    seenBadgeClassNames.clear();
    for (const cls of domAdStateClasses) {
      if (previousAdStateClasses.has(cls)) {
        forwardDomAdEvent(`${cls}-start` as DomAdEventKind);
      }
    }
  }

  function handleClassMutation(el: Element): void {
    const current = classListToSet(el);
    for (const cls of domAdStateClasses) {
      const was = previousAdStateClasses.has(cls);
      const is = current.has(cls);
      if (was !== is) {
        forwardDomAdEvent(`${cls}-${is ? 'start' : 'end'}` as DomAdEventKind);
      }
    }
    previousAdStateClasses = current;
  }

  function maybeForwardBadgeSighting(node: Element): void {
    // SVG elements expose `className` as an SVGAnimatedString, not a plain string —
    // fall back to getAttribute('class') when it's not a string.
    const className =
      typeof node.className === 'string' ? node.className : (node.getAttribute('class') ?? '');
    if (!className) return;
    // Dedupe per video session (spike lesson (c): the spike logged 168 duplicate
    // sightings of 24 useful events without this).
    if (seenBadgeClassNames.has(className)) return;
    seenBadgeClassNames.add(className);
    forwardDomAdEvent('ad-badge-seen');
  }

  let activeObserver: MutationObserver | null = null;
  let observedElement: Element | null = null;

  function setupMovieObserver(el: Element): void {
    primeObserverState(el);
    observedElement = el;

    const observer = new MutationObserver((mutations) => {
      let classChanged = false;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          classChanged = true;
        }
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const element = node as Element;
            if (element.matches(selectors.adBadgeElements)) maybeForwardBadgeSighting(element);
            element.querySelectorAll(selectors.adBadgeElements).forEach(maybeForwardBadgeSighting);
          });
        }
      }
      if (classChanged) handleClassMutation(el);
    });

    observer.observe(el, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    activeObserver = observer;
    ctx.onInvalidated(() => observer.disconnect());
  }

  function attachMovieObserver(retriesLeft: number): void {
    if (movieObserverAttached) return;
    const el = document.getElementById(selectors.moviePlayerId);
    if (el) {
      movieObserverAttached = true;
      setupMovieObserver(el);
      return;
    }
    if (retriesLeft <= 0) {
      console.warn(
        '[AdsAuditor] #movie_player not found in this attempt window; will retry on next navigation.',
      );
      return;
    }
    ctx.setTimeout(() => attachMovieObserver(retriesLeft - 1), MOVIE_PLAYER_ATTACH_RETRY_MS);
  }
  attachMovieObserver(MOVIE_PLAYER_ATTACH_MAX_RETRIES);

  function notifyPageNavigated(): void {
    // background.ts uses this to stop attributing videoId-less beacons to a session
    // whose watch page the tab has left (see runtimeMessageKinds.pageNavigated).
    browser.runtime
      .sendMessage({
        kind: runtimeMessageKinds.pageNavigated,
        pageVideoId: getWatchUrlVideoId(),
      })
      .catch(() => {
        // Fire-and-forget, same as the event forwards above.
      });
  }
  notifyPageNavigated();

  // --- SPA navigation: re-attempt attach (no-op once attached) + re-prime state --
  ctx.addEventListener(document, YT_NAVIGATE_FINISH_EVENT, () => {
    notifyPageNavigated();

    // YouTube can tear down and recreate #movie_player across some navigations; an
    // observer bound to a disconnected element would go silent for the rest of the tab
    // with no recovery (§1.2 review finding). Detect and re-attach.
    if (movieObserverAttached && observedElement && !observedElement.isConnected) {
      activeObserver?.disconnect();
      activeObserver = null;
      observedElement = null;
      movieObserverAttached = false;
    }

    const wasAlreadyAttached = movieObserverAttached;
    attachMovieObserver(MOVIE_PLAYER_ATTACH_MAX_RETRIES); // covers "session started on the homepage" (spike lesson (a))
    if (wasAlreadyAttached && movieObserverAttached) {
      // setupMovieObserver() already primed state on a fresh attach above; only
      // re-prime here for a navigation on an ALREADY-attached observer, to avoid
      // double-emitting a start event for the same still-showing ad-state class.
      const el = document.getElementById(selectors.moviePlayerId);
      if (el) primeObserverState(el);
    }
  });
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  main,
});
