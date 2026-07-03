/**
 * Service worker: per-tab VideoSession state, source C (webRequest beacons), storage
 * (docs/SPEC.md §3.2, docs/ROADMAP.md §1.2).
 *
 * MV3 constraint: webRequest listeners must be registered synchronously at the top
 * level of this file — the service worker can be terminated and woken by events, but
 * only listeners declared statically at startup are re-attached on wake. runtime.onMessage
 * and tabs.onRemoved are registered synchronously here too, for the same reason.
 *
 * No network calls of any kind originate from this file: telemetry is Phase 2, opt-in
 * (CLAUDE.md invariant 1). Everything below reads/writes chrome.storage only.
 */
import { classify } from '../utils/classifier';
import {
  beaconUrlFragments,
  beaconUrlMatchPatterns,
  runtimeMessageKinds,
} from '../utils/selectors';
import { isDomAdEventShape, isPlayerResponseEventShape, isRecord } from '../utils/types';
import type {
  BeaconEvent,
  BeaconKind,
  ClassificationResult,
  ClassifierContext,
  DetectionEvent,
  LocalHistoryEntry,
  PlayerResponseEvent,
} from '../utils/types';

/** In-memory, per-tab accumulation of this video's detection events. Not exported —
 * purely a service-worker-internal bookkeeping shape, unlike the shared types in
 * utils/types.ts. */
interface VideoSessionState {
  videoId: string | null;
  /** The page the tab is on right now (v= param, null off watch pages), fed by the
   * bridge's navigation messages. Beacons carry no videoId, so they are attributed to
   * the session ONLY while this still equals videoId — otherwise homepage display-ad
   * traffic (masthead → doubleclick/googlesyndication) would rewrite the previous
   * video's verdict. */
  currentPageVideoId: string | null;
  events: DetectionEvent[];
  updatedAt: number;
}

type PersistedSessions = Record<string, VideoSessionState>;

const SESSION_STORAGE_KEY = 'session:adsauditor_sessions' as const;
const LOCAL_SESSIONS_FALLBACK_KEY = 'local:adsauditor_sessions_fallback' as const;
const LOCAL_HISTORY_KEY = 'local:adsauditor_history' as const;

const FLUSH_DEBOUNCE_MS = 250;
const MAX_HISTORY_ENTRIES = 50; // ROADMAP §1.4 local history cap

function isPlayerResponseEvent(event: DetectionEvent): event is PlayerResponseEvent {
  return event.source === 'PLAYER_RESPONSE';
}

// ---------------------------------------------------------------------------------
// tabId -> VideoSessionState, lazily rehydrated from storage on service-worker wake
// (MV3: the worker is ephemeral, so this in-memory map must survive suspension via
// storage round-trips instead of assuming it's always warm).
// ---------------------------------------------------------------------------------
let sessionsMapPromise: Promise<Map<number, VideoSessionState>> | null = null;

async function readPersistedSessions(): Promise<PersistedSessions> {
  try {
    // A successful read that finds nothing (fresh worker, fresh browser session) must
    // NOT fall through to the local fallback: after a browser restart the session store
    // is legitimately empty, while the fallback may hold stale sessions from a previous
    // run that would be resurrected onto reused tab ids.
    return (await storage.getItem<PersistedSessions>(SESSION_STORAGE_KEY)) ?? {};
  } catch (err) {
    console.warn('[AdsAuditor] Reading chrome.storage.session failed; falling back to local', err);
  }
  try {
    return (await storage.getItem<PersistedSessions>(LOCAL_SESSIONS_FALLBACK_KEY)) ?? {};
  } catch (err) {
    console.warn('[AdsAuditor] Reading local session fallback failed', err);
    return {};
  }
}

async function rehydrateSessionsMap(): Promise<Map<number, VideoSessionState>> {
  const persisted = await readPersistedSessions();
  return new Map(Object.entries(persisted).map(([tabId, session]) => [Number(tabId), session]));
}

function getSessionsMap(): Promise<Map<number, VideoSessionState>> {
  if (!sessionsMapPromise) sessionsMapPromise = rehydrateSessionsMap();
  return sessionsMapPromise;
}

async function persistSessionsMap(sessions: Map<number, VideoSessionState>): Promise<void> {
  const record: PersistedSessions = Object.fromEntries(sessions);
  try {
    await storage.setItem(SESSION_STORAGE_KEY, record);
    // The fallback only exists to bridge a session-storage outage; once the primary
    // write succeeds again, stale fallback data must not survive to a later restart.
    await storage.removeItem(LOCAL_SESSIONS_FALLBACK_KEY);
  } catch (err) {
    console.warn('[AdsAuditor] chrome.storage.session write failed; falling back to local', err);
    await storage.setItem(LOCAL_SESSIONS_FALLBACK_KEY, record);
  }
}

// ---------------------------------------------------------------------------------
// Always-settling write queue (spike lesson: a rejected write must not poison the
// chain — every subsequent write would otherwise be silently dropped for the rest of
// the service worker's lifetime).
// ---------------------------------------------------------------------------------
let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue.then(task).catch((err) => {
    console.error('[AdsAuditor] Storage write failed', err);
  });
}

async function appendLocalHistory(videoId: string, result: ClassificationResult): Promise<void> {
  const existing = (await storage.getItem<LocalHistoryEntry[]>(LOCAL_HISTORY_KEY)) ?? [];
  const withoutThisVideo = existing.filter((entry) => entry.videoId !== videoId);
  const entry: LocalHistoryEntry = {
    videoId,
    observedAt: Date.now(),
    state: result.state,
    evidence: result.evidence,
    noSignalCause: result.noSignalCause,
  };
  const next = [entry, ...withoutThisVideo].slice(0, MAX_HISTORY_ENTRIES);
  await storage.setItem(LOCAL_HISTORY_KEY, next);
}

function buildClassifierContext(session: VideoSessionState): ClassifierContext {
  const playerResponseEvents = session.events.filter(isPlayerResponseEvent);
  const latest =
    playerResponseEvents.length > 0 ? playerResponseEvents[playerResponseEvents.length - 1] : null;

  return {
    durationS: latest?.durationSeconds ?? 0,
    isLive: latest?.isLiveContent ?? false,
    isLoggedIn: latest?.isLoggedIn ?? false,
    // No local geo resolution in Phase 1 (SPEC §3.3's country hint is populated
    // server-side from the ingest IP in Phase 2) — never fabricate it here.
    countryHint: null,
    extensionVersion: browser.runtime.getManifest().version,
    // TODO(§1.3): replace both with real adblock/Premium/control-video calibration and
    // local rewatch-history checks. Until those land, the observer is conservatively
    // assumed INVALID (invariant 5): positive ADS_SERVED evidence still flows through
    // (the classifier's validity gate only guards the NO_ADS branch), while absences
    // surface as NO_SIGNAL('observer-invalid') instead of unverifiable NO_ADS.
    observerValid: false,
    recentlyWatched: false,
  };
}

// ---------------------------------------------------------------------------------
// Debounced flush: batches bursts of events (e.g. the initial/fetch/getPlayerResponse
// trio on one navigation) into a single classify() + storage round trip per tab.
// ---------------------------------------------------------------------------------
const pendingTabFlushes = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(tabId: number): void {
  pendingTabFlushes.add(tabId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const tabIds = Array.from(pendingTabFlushes);
    pendingTabFlushes.clear();
    enqueueWrite(() => flushTabs(tabIds));
  }, FLUSH_DEBOUNCE_MS);
}

async function flushTabs(tabIds: number[]): Promise<void> {
  const sessions = await getSessionsMap();
  for (const tabId of tabIds) {
    // One tab's failure (e.g. a malformed event that slipped past validation) must not
    // abort the remaining tabs' flushes — pendingTabFlushes was already cleared, so a
    // batch-wide throw would silently lose them (§1.2 review finding).
    try {
      const session = sessions.get(tabId);
      if (!session || !session.videoId) continue;
      const result = classify(session.events, buildClassifierContext(session));
      await appendLocalHistory(session.videoId, result);
    } catch (err) {
      console.error(`[AdsAuditor] Flush failed for tab ${tabId}`, err);
    }
  }
  await persistSessionsMap(sessions);
}

async function handleIncomingEvent(tabId: number, event: DetectionEvent): Promise<void> {
  if (event.source === 'PLAYER_RESPONSE') {
    // Off-watch-page captures (pageVideoId null) are homepage/feed hover prefetches of
    // OTHER videos: appended to the previous video's session they would flip its verdict
    // with someone else's placements (or its playability). Drop them outright.
    if (event.pageVideoId === null) return;
    // Ad creatives serve their OWN player response through the identical
    // /youtubei/v1/player endpoint; videoId !== pageVideoId is the discriminator
    // (spike-verified). classify() defends against this too (so fixtures can feed raw
    // capture data), but filtering here keeps stored sessions clean.
    if (event.videoId !== null && event.videoId !== event.pageVideoId) return;
  }

  const sessions = await getSessionsMap();
  const existing = sessions.get(tabId);

  if (event.source === 'BEACON') {
    // Beacons carry no videoId: they are only attributable while the tab is still on
    // the session video's watch page (see VideoSessionState.currentPageVideoId).
    if (!existing || existing.videoId === null) return;
    if (existing.currentPageVideoId !== existing.videoId) return;
    existing.events.push(event);
    existing.updatedAt = Date.now();
    scheduleFlush(tabId);
    return;
  }

  const incomingVideoId =
    event.source === 'PLAYER_RESPONSE' ? event.pageVideoId : event.watchUrlVideoId;

  const session: VideoSessionState =
    incomingVideoId && incomingVideoId !== existing?.videoId
      ? {
          videoId: incomingVideoId,
          currentPageVideoId: incomingVideoId,
          events: [],
          updatedAt: Date.now(),
        } // new video for this tab
      : (existing ?? {
          videoId: incomingVideoId,
          currentPageVideoId: incomingVideoId,
          events: [],
          updatedAt: Date.now(),
        });

  if (event.source === 'PLAYER_RESPONSE') {
    session.currentPageVideoId = event.pageVideoId;
  }
  session.events.push(event);
  session.updatedAt = Date.now();
  sessions.set(tabId, session);

  scheduleFlush(tabId);
}

/** bridge.content.ts reports every page navigation (runtimeMessageKinds.pageNavigated):
 * the only signal — within invariant-7 permissions — that a tab left the session
 * video's watch page, which is what closes the session to further beacon attribution. */
async function handlePageNavigated(tabId: number, pageVideoId: string | null): Promise<void> {
  const sessions = await getSessionsMap();
  const session = sessions.get(tabId);
  if (!session) return;
  session.currentPageVideoId = pageVideoId;
  session.updatedAt = Date.now();
  enqueueWrite(() => persistSessionsMap(sessions));
}

// ---------------------------------------------------------------------------------
// Source C: beacon URL classification. beaconUrlMatchPatterns (the webRequest filter
// below) and beaconUrlFragments (used here) both live in utils/selectors.ts.
// ---------------------------------------------------------------------------------
function classifyBeaconUrl(rawUrl: string): BeaconKind | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.hostname === beaconUrlFragments.youtubeHostname &&
    url.pathname.startsWith(beaconUrlFragments.statsAdsPath)
  ) {
    return 'STATS_ADS';
  }
  if (
    url.hostname === beaconUrlFragments.youtubeHostname &&
    url.pathname.startsWith(beaconUrlFragments.pageadPath)
  ) {
    return 'PAGEAD';
  }
  if (url.hostname.endsWith(beaconUrlFragments.doubleclickHostnameSuffix)) return 'DOUBLECLICK';
  if (url.hostname.endsWith(beaconUrlFragments.googlesyndicationHostnameSuffix))
    return 'GOOGLESYNDICATION';
  return null;
}

export default defineBackground(() => {
  // MV3: registered synchronously at top level (CLAUDE.md, SPEC §3.2). Observation
  // only — no `blocking` extraInfoSpec, no declarativeNetRequest, URLs only, never
  // request/response bodies (CLAUDE.md invariant 6).
  browser.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      // Never returns a BlockingResponse (no `cancel`/`redirectUrl`) — observation only.
      if (details.tabId < 0) return undefined; // not associated with a tab (e.g. prefetch); nothing to attribute this to
      const kind = classifyBeaconUrl(details.url);
      if (!kind) return undefined; // defensive: the filter below should already guarantee a match
      const event: BeaconEvent = { source: 'BEACON', kind, capturedAt: Date.now() };
      void handleIncomingEvent(details.tabId, event);
      return undefined;
    },
    { urls: [...beaconUrlMatchPatterns] },
  );

  // Registered synchronously for the same MV3 wake-reliability reason as above.
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isRecord(message) || typeof message.kind !== 'string') return;
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId < 0) return;

    if (
      message.kind === runtimeMessageKinds.playerResponseEvent &&
      isPlayerResponseEventShape(message.event)
    ) {
      void handleIncomingEvent(tabId, message.event);
      return;
    }
    if (message.kind === runtimeMessageKinds.domAdEvent && isDomAdEventShape(message.event)) {
      void handleIncomingEvent(tabId, message.event);
      return;
    }
    if (
      message.kind === runtimeMessageKinds.pageNavigated &&
      (typeof message.pageVideoId === 'string' || message.pageVideoId === null)
    ) {
      void handlePageNavigated(tabId, message.pageVideoId);
    }
    // Fire-and-forget: bridge.content.ts does not await a response.
  });

  // Stale-fallback hygiene (§1.2 review finding): the local fallback for session state
  // only exists to bridge a storage.session outage; on a fresh browser start it must
  // not resurrect dead sessions onto reused tab ids.
  browser.runtime.onStartup.addListener(() => {
    void storage.removeItem(LOCAL_SESSIONS_FALLBACK_KEY).catch(() => undefined);
  });

  // Registered synchronously; drops a tab's in-memory + persisted session once it closes.
  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const sessions = await getSessionsMap();
      if (sessions.delete(tabId)) {
        enqueueWrite(() => persistSessionsMap(sessions));
      }
    })();
  });
});
