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
 * 3. Run the ROADMAP §1.3 calibration probes when background.ts says they're due: the
 *    adblock bait-vs-control fetch and the Premium masthead-badge DOM check. Both need a
 *    real tab/page context, which is why they live here rather than in the service
 *    worker.
 *
 * All CSS selectors and JSON paths come from utils/selectors.ts — never inline here
 *.
 */
import { PROBE_TIMEOUT_MS, interpretAdblockProbe } from '../utils/calibration';
import type { ProbeOutcome } from '../utils/calibration';
import {
  adblockProbe,
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

const PREMIUM_CHECK_RETRY_MS = 500;
const PREMIUM_CHECK_MAX_RETRIES = 20; // ~10s window for the masthead to render

/** Real YouTube ad UI uses a small, fixed set of `.ytp-ad-*` class names
 * (spike-verified) — this cap only exists to bound a hostile page script that mutates
 * the DOM under `#movie_player` with attacker-minted unique class names matching
 * selectors.adBadgeElements, which would otherwise grow seenBadgeClassNames (and the
 * resulting per-sighting `ad-badge-seen` forwards to background.ts) without bound
 * (security audit finding M2). Per-video-session, not permanent: primeObserverState()
 * clears the set on every yt-navigate-finish. */
const MAX_SEEN_BADGE_CLASS_NAMES = 200;

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

  /**
   * Every runtime.sendMessage in this file goes through here. An extension
   * reload/update — including the user toggling "Allow in incognito", which reloads
   * the extension — orphans content scripts already injected into open tabs: their
   * next runtime.* call throws SYNCHRONOUSLY ("Extension context invalidated") instead
   * of returning a rejected promise, so a plain `.catch()` never sees it and it
   * surfaces as an uncaught page error (field report 2026-07-11, YouTube search page).
   * Reading ctx.isValid doubles as WXT's invalidation trigger: once the context is
   * dead it aborts every ctx-registered listener/timer and disconnects the
   * MutationObserver, so the orphaned script goes fully quiet.
   */
  function sendToBackground(message: Record<string, unknown>): Promise<unknown> | null {
    if (!ctx.isValid) return null;
    try {
      return browser.runtime.sendMessage(message);
    } catch {
      // Synchronous invalidation throw — nothing to recover; ctx teardown follows.
      return null;
    }
  }

  function forwardDomAdEvent(kind: DomAdEventKind): void {
    const event: DomAdEvent = {
      source: 'DOM',
      kind,
      watchUrlVideoId: getWatchUrlVideoId(),
      contentTimeSeconds: lastKnownContentTimeSeconds,
      capturedAt: Date.now(),
    };
    void sendToBackground({ kind: runtimeMessageKinds.domAdEvent, event })?.catch(() => {
      // Fire-and-forget: the tab can close mid-flight; nothing useful to recover here.
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
        void sendToBackground({
          kind: runtimeMessageKinds.playerResponseEvent,
          event: data.payload,
        })?.catch(() => {
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
    if (seenBadgeClassNames.size >= MAX_SEEN_BADGE_CLASS_NAMES) {
      // See MAX_SEEN_BADGE_CLASS_NAMES's doc comment: once full, stop forwarding NEW
      // badge sightings for the rest of this video session rather than growing the
      // dedupe set (and the resulting message volume to background.ts) without bound.
      return;
    }
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
    void sendToBackground({
      kind: runtimeMessageKinds.pageNavigated,
      pageVideoId: getWatchUrlVideoId(),
    })?.catch(() => {
      // Fire-and-forget, same as the event forwards above.
    });
  }

  // ---------------------------------------------------------------------------------
  // ROADMAP §1.3 calibration probes: background.ts is the source of truth for "is a
  // check due" (cached timestamps + TTLs); this content script only runs the probes it
  // is told to run and reports the raw result back.
  // ---------------------------------------------------------------------------------
  function sendCalibrationResult(payload: Record<string, unknown>): void {
    void sendToBackground({ kind: runtimeMessageKinds.calibrationResult, ...payload })?.catch(
      () => {
        // Fire-and-forget, same as the event forwards above.
      },
    );
  }

  /** GET, no-cors/no-credentials/no-cache (SPEC §3.4 adblock probe): we only care
   * whether the request resolved, was rejected (blocked, DNS failure, ...), or hung past
   * PROBE_TIMEOUT_MS — never the (opaque, unreadable in no-cors mode) response body. */
  function runProbeFetch(url: string): Promise<ProbeOutcome> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    return fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((): ProbeOutcome => 'resolved')
      .catch((): ProbeOutcome => (controller.signal.aborted ? 'timeout' : 'rejected'))
      .finally(() => clearTimeout(timeoutId));
  }

  function runAdblockProbe(): void {
    Promise.all([runProbeFetch(adblockProbe.baitUrl), runProbeFetch(adblockProbe.controlUrl)])
      .then(([bait, control]) => {
        const status = interpretAdblockProbe(bait, control);
        sendCalibrationResult({ adblock: { status, checkedAt: Date.now() } });
      })
      .catch((err) => {
        console.warn('[AdsAuditor] Adblock probe failed unexpectedly', err);
      });
  }

  /** Reuses the movie-player attach retry pattern (ctx.setTimeout, so pending retries
   * are cleaned up automatically if the content script context is invalidated
   * mid-retry). Stops as soon as the badge selector matches, or after
   * PREMIUM_CHECK_MAX_RETRIES — whichever comes first; a non-match at that point is
   * reported as `detected: false` (selectors.ts documents the false-negative tradeoff of
   * the still-unverified selector; SPEC §3.4's control-video calibration is the
   * backstop). No logged-in gating: logged-out browsing cannot be Premium ad-free
   * browsing, so `detected: false` is truthful in that case too (deliberate
   * simplification, ROADMAP §1.3).
   */
  function checkPremiumBadge(retriesLeft: number): void {
    const detected = document.querySelector(selectors.mastheadPremiumBadge) !== null;
    if (detected || retriesLeft <= 0) {
      sendCalibrationResult({ premium: { detected, checkedAt: Date.now() } });
      return;
    }
    ctx.setTimeout(() => checkPremiumBadge(retriesLeft - 1), PREMIUM_CHECK_RETRY_MS);
  }

  function requestCalibrationDue(): void {
    const query = sendToBackground({ kind: runtimeMessageKinds.calibrationDueQuery });
    if (!query) return; // orphaned context — no probes on a dead extension's behalf
    query
      .then((response: unknown) => {
        if (!isRecord(response)) return;
        if (response.runAdblockCheck === true) runAdblockProbe();
        if (response.runPremiumCheck === true) checkPremiumBadge(PREMIUM_CHECK_MAX_RETRIES);
      })
      .catch(() => {
        // background.ts may be waking from suspension / unreachable; nothing to recover
        // here, and the next due-query (next navigation) will retry.
      });
  }

  notifyPageNavigated();
  requestCalibrationDue();

  /**
   * Shared by the yt-navigate-finish listener and the bfcache 'pageshow' listener below
   * (ROADMAP §1.6): a bfcache restore resurrects the page without re-running
   * document_start scripts or ever firing yt-navigate-finish (that event is specific to
   * YouTube's own SPA router, which a bfcache restore bypasses entirely), so it needs
   * exactly the same recovery as an ordinary SPA navigation — re-announce the page,
   * re-check calibration due-ness, and re-attach/re-prime the MutationObserver if
   * YouTube tore down and recreated #movie_player while the page was frozen.
   */
  function handleNavigationOrRestore(): void {
    notifyPageNavigated();
    requestCalibrationDue();

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
  }

  // --- SPA navigation: re-attempt attach (no-op once attached) + re-prime state --
  ctx.addEventListener(document, YT_NAVIGATE_FINISH_EVENT, handleNavigationOrRestore);

  // --- bfcache restore: treat exactly like a fresh navigation (ROADMAP §1.6) -----
  // See interceptor.content.ts's matching 'pageshow' listener for the same rationale:
  // event.persisted === true means this 'pageshow' fired because the page was restored
  // from the back/forward cache, not a normal load.
  ctx.addEventListener(window, 'pageshow', (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    handleNavigationOrRestore();
  });
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  main,
});
