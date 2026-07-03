/**
 * Source A — Player Response interception (docs/SPEC.md §3.2).
 *
 * Runs in the page's MAIN world so it can read `window.ytInitialPlayerResponse`, wrap
 * `window.fetch` to observe `/youtubei/v1/player` calls, and read on-demand from
 * `document.getElementById('movie_player').getPlayerResponse()`. It also owns the
 * content-time sampler (source B needs it): `getCurrentTime()`/`getVideoData()` are
 * plain JS properties YouTube attaches to the #movie_player custom element in ITS OWN
 * realm, not native DOM/IDL members — an ISOLATED-world script looking at the "same"
 * element sees a different wrapper and does NOT see those methods (spike-verified).
 *
 * The MAIN world has no access to the `chrome.*` / `browser.*` APIs: this script talks
 * to bridge.content.ts (ISOLATED world) exclusively via `window.postMessage`, with
 * strict `origin` checking and a session token published by bridge.content.ts on a DOM
 * dataset attribute (JS globals are not shared across worlds, but the DOM is).
 *
 * Observation only (CLAUDE.md invariant 6): `window.fetch` is wrapped to read a *clone*
 * of the response; the original response returned to page code is never modified,
 * delayed, or blocked.
 */
import {
  bridgeChannel,
  bridgeMessageTypes,
  domAdStateClasses,
  jsonPaths,
  PLAYER_ENDPOINT_PATHNAME,
  selectors,
  YT_NAVIGATE_FINISH_EVENT,
} from '../utils/selectors';
import type {
  AdPlacementItem,
  AdSlotItem,
  CapturePath,
  PlayerAdItem,
  PlayerResponseEvent,
} from '../utils/types';

declare global {
  interface Window {
    ytInitialPlayerResponse?: unknown;
    ytcfg?: { get?: (key: string) => unknown };
    __adsauditorInterceptorLoaded?: boolean;
  }
}

/** YouTube attaches these as plain JS properties on the #movie_player custom element,
 * readable only from the MAIN world (see file header). Not native DOM/IDL members. */
interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
  getCurrentTime?: () => number;
  getVideoData?: () => { video_id?: string };
}

const INITIAL_PLAYER_RESPONSE_RETRY_MS = 300;
const INITIAL_PLAYER_RESPONSE_MAX_RETRIES = 20; // ~6s window: ytInitialPlayerResponse may not exist yet at document_start
const CONFIRMATION_READ_DELAY_MS = 4000; // let the (new) video's player response settle before the on-demand read
const CONTENT_TIME_POLL_MS = 500; // granularity for the "last known content time" sample (SPEC §3.2)
const BRIDGE_TOKEN_RETRY_MS = 200;
const BRIDGE_TOKEN_MAX_RETRIES = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Player-response numeric fields (durations, ms offsets) are serialized as strings in
 * the real JSON (field-verified in the Phase 0 spike) — never assume `typeof === 'number'`. */
function readNumberLike(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getPageVideoIdFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('v');
  } catch {
    return null;
  }
}

function readLoggedInState(): boolean | null {
  try {
    const value = window.ytcfg?.get?.(jsonPaths.ytcfgLoggedInKey);
    return typeof value === 'boolean' ? value : null;
  } catch (err) {
    console.warn('[AdsAuditor] Failed to read LOGGED_IN from ytcfg', err);
    return null;
  }
}

function getMoviePlayerElement(): YouTubePlayerElement | null {
  return document.getElementById(selectors.moviePlayerId) as YouTubePlayerElement | null;
}

// ---------------------------------------------------------------------------------
// Player response extraction (source A). Property chains mirror utils/selectors.ts
// jsonPaths — keep both in sync when YouTube changes shape.
// ---------------------------------------------------------------------------------

function extractAdPlacementItem(raw: unknown): AdPlacementItem {
  if (!isRecord(raw)) return { kind: null, offsetStartMs: null, offsetEndMs: null };

  // Renderer path field-verified 2026-07-02 (spike/RESULTS.md §2: jsonPaths.adPlacementRendererConfig);
  // flat path (jsonPaths.adPlacementFlatConfig) kept as a fallback for other YouTube
  // surfaces/experiments.
  const rendererHolder = isRecord(raw.adPlacementRenderer)
    ? raw.adPlacementRenderer.config
    : undefined;
  const rendererConfig = isRecord(rendererHolder) ? rendererHolder.adPlacementConfig : undefined;
  const flatConfig = raw.adPlacementConfig;
  const config = isRecord(rendererConfig)
    ? rendererConfig
    : isRecord(flatConfig)
      ? flatConfig
      : null;
  const offset = config && isRecord(config.adTimeOffset) ? config.adTimeOffset : null;

  return {
    kind: config ? readString(config.kind) : null,
    offsetStartMs: offset ? readNumberLike(offset.offsetStartMilliseconds) : null,
    offsetEndMs: offset ? readNumberLike(offset.offsetEndMilliseconds) : null,
  };
}

function extractAdSlotItem(raw: unknown): AdSlotItem {
  if (!isRecord(raw)) return { slotType: null };
  const renderer = isRecord(raw.adSlotRenderer) ? raw.adSlotRenderer : null;
  const metadata = renderer && isRecord(renderer.adSlotMetadata) ? renderer.adSlotMetadata : null;
  return { slotType: metadata ? readString(metadata.slotType) : null };
}

function extractPlayerAdItem(raw: unknown): PlayerAdItem {
  // playerAds entries are typically a single-key wrapper naming the ad type (real schema
  // still to be confirmed — see spike/RESULTS.md); cheap best-effort type proxy.
  const keys = isRecord(raw) ? Object.keys(raw) : [];
  return { type: keys[0] ?? null };
}

function buildPlayerResponseEvent(raw: unknown, capturePath: CapturePath): PlayerResponseEvent {
  const pr = isRecord(raw) ? raw : {};
  const videoDetails = isRecord(pr.videoDetails) ? pr.videoDetails : {};
  const playabilityStatus = isRecord(pr.playabilityStatus) ? pr.playabilityStatus : {};
  const adPlacementsRaw = Array.isArray(pr.adPlacements) ? pr.adPlacements : [];
  const adSlotsRaw = Array.isArray(pr.adSlots) ? pr.adSlots : [];
  const playerAdsRaw = Array.isArray(pr.playerAds) ? pr.playerAds : [];

  return {
    source: 'PLAYER_RESPONSE',
    capturePath,
    pageVideoId: getPageVideoIdFromUrl(),
    videoId: readString(videoDetails.videoId),
    durationSeconds: readNumberLike(videoDetails.lengthSeconds),
    playabilityStatus: readString(playabilityStatus.status),
    isLiveContent: readBoolean(videoDetails.isLiveContent),
    isLoggedIn: readLoggedInState(),
    adPlacements: adPlacementsRaw.map(extractAdPlacementItem),
    adSlots: adSlotsRaw.map(extractAdSlotItem),
    playerAds: playerAdsRaw.map(extractPlayerAdItem),
    capturedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------------
// postMessage bridge (MAIN -> ISOLATED), origin + session-token validated on both ends.
// ---------------------------------------------------------------------------------

function readSessionToken(): string | undefined {
  return document.documentElement?.dataset?.[bridgeChannel.tokenDatasetKey];
}

function postToBridge(
  type: string,
  payload: unknown,
  retriesLeft = BRIDGE_TOKEN_MAX_RETRIES,
): void {
  const token = readSessionToken();
  if (!token) {
    if (retriesLeft <= 0) {
      console.warn('[AdsAuditor] Giving up: bridge session token never appeared.');
      return;
    }
    setTimeout(() => postToBridge(type, payload, retriesLeft - 1), BRIDGE_TOKEN_RETRY_MS);
    return;
  }
  window.postMessage({ channel: bridgeChannel.name, token, type, payload }, window.location.origin);
}

function emitPlayerResponseEvent(raw: unknown, capturePath: CapturePath): void {
  try {
    postToBridge(bridgeMessageTypes.playerResponse, buildPlayerResponseEvent(raw, capturePath));
  } catch (err) {
    console.warn('[AdsAuditor] Failed to build/send player response event', err);
  }
}

function main(): void {
  if (window.__adsauditorInterceptorLoaded) return;
  window.__adsauditorInterceptorLoaded = true;

  // --- Path 1: window.ytInitialPlayerResponse (full page load only) --------------
  function waitForInitialPlayerResponse(retriesLeft: number): void {
    const pr = window.ytInitialPlayerResponse;
    if (pr) {
      emitPlayerResponseEvent(pr, 'initial');
      return;
    }
    if (retriesLeft <= 0) return; // not a watch page, or it never appeared — fine.
    setTimeout(
      () => waitForInitialPlayerResponse(retriesLeft - 1),
      INITIAL_PLAYER_RESPONSE_RETRY_MS,
    );
  }
  waitForInitialPlayerResponse(INITIAL_PLAYER_RESPONSE_MAX_RETRIES);

  // --- Path 2: fetch to /youtubei/v1/player (fires on every SPA navigation) ------
  function extractRequestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    try {
      return String(input);
    } catch {
      return '';
    }
  }

  function getRequestPathname(url: string): string | null {
    try {
      return new URL(url, window.location.origin).pathname;
    } catch {
      return null;
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((...args: Parameters<typeof window.fetch>) => {
    const fetchPromise = originalFetch(...args);
    try {
      const url = extractRequestUrl(args[0]);
      const pathname = getRequestPathname(url);

      // EXACT pathname match only — see PLAYER_ENDPOINT_PATHNAME doc in
      // utils/selectors.ts for why a substring match is wrong here.
      if (pathname === PLAYER_ENDPOINT_PATHNAME) {
        fetchPromise
          .then((response) => response.clone().json())
          .then((data) => emitPlayerResponseEvent(data, 'fetch'))
          .catch((err) => {
            console.warn('[AdsAuditor] Failed to parse /youtubei/v1/player response as JSON', err);
          });
      }
    } catch (err) {
      console.warn('[AdsAuditor] fetch interception error', err);
    }
    return fetchPromise; // always the original, unaltered response — never delayed or modified
  }) as typeof window.fetch;

  // --- Path 3: movie_player.getPlayerResponse() on-demand confirmation read ------
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleConfirmationRead(delayMs: number): void {
    if (confirmationTimer) clearTimeout(confirmationTimer);
    confirmationTimer = setTimeout(() => {
      const el = getMoviePlayerElement();
      if (el && typeof el.getPlayerResponse === 'function') {
        try {
          const pr = el.getPlayerResponse();
          if (pr) emitPlayerResponseEvent(pr, 'getPlayerResponse');
        } catch (err) {
          console.warn('[AdsAuditor] getPlayerResponse confirmation read failed', err);
        }
      }
    }, delayMs);
  }
  scheduleConfirmationRead(CONFIRMATION_READ_DELAY_MS); // covers the first video too

  // ---------------------------------------------------------------------------------
  // Content-time sampler: samples getCurrentTime() every CONTENT_TIME_POLL_MS, but only
  // while #movie_player is NOT in an ad state — during an ad, getCurrentTime() describes
  // the ad creative, not the content (spike-verified). Each sample is relayed to
  // bridge.content.ts (ISOLATED), which cannot call getCurrentTime() itself (see file
  // header) but keeps the latest one to attribute DOM ad-start events as
  // preroll/midroll/postroll.
  // ---------------------------------------------------------------------------------
  function isElementInAdState(el: Element): boolean {
    return domAdStateClasses.some((cls) => el.classList.contains(cls));
  }

  function sampleContentTimeIfNotInAd(): void {
    const el = getMoviePlayerElement();
    if (!el || isElementInAdState(el) || typeof el.getCurrentTime !== 'function') return;
    try {
      const t = el.getCurrentTime();
      if (typeof t === 'number' && Number.isFinite(t)) {
        postToBridge(bridgeMessageTypes.contentTimeSample, { contentTimeSeconds: t });
      }
    } catch {
      // Player not ready yet; ignore, next poll will retry.
    }
  }
  setInterval(sampleContentTimeIfNotInAd, CONTENT_TIME_POLL_MS);

  // --- SPA navigation: reset per-video MAIN-world state --------------------------
  document.addEventListener(YT_NAVIGATE_FINISH_EVENT, () => {
    // Explicitly tell the bridge its last-known content time is stale: without this, an
    // ad that starts immediately on the NEW video (e.g. autoplay-to-next with an instant
    // preroll) would otherwise be attributed the PREVIOUS video's last sampled content
    // time — silently mistyped as a mid-roll instead of a preroll. The next
    // sampleContentTimeIfNotInAd() tick repopulates it with a fresh, correct value.
    postToBridge(bridgeMessageTypes.contentTimeSample, { contentTimeSeconds: null });
    scheduleConfirmationRead(CONFIRMATION_READ_DELAY_MS);
  });
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main,
});
