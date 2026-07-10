/**
 * Service worker: per-tab VideoSession state, source C (webRequest beacons), storage
 * (docs/SPEC.md §3.2, docs/ROADMAP.md §1.2, §1.3).
 *
 * MV3 constraint: webRequest listeners must be registered synchronously at the top
 * level of this file — the service worker can be terminated and woken by events, but
 * only listeners declared statically at startup are re-attached on wake. runtime.onMessage
 * and tabs.onRemoved are registered synchronously here too, for the same reason.
 *
 * No network calls of any kind originate from this file: telemetry is Phase 2, opt-in
 * (CLAUDE.md invariant 1). Everything below reads/writes chrome.storage only. The
 * adblock bait fetch and Premium DOM probe (ROADMAP §1.3) run in bridge.content.ts,
 * which has a real tab/page context; this file only schedules them (calibrationDueQuery)
 * and records their results (calibrationResult).
 */
import { classify } from '../utils/classifier';
import {
  EMPTY_CALIBRATION_STATE,
  evaluateControlOutcome,
  isRecentlyWatched,
  pruneRewatchIndex,
  resolveObserverValidity,
  ADBLOCK_CHECK_TTL_MS,
  ADBLOCK_INCONCLUSIVE_RETRY_MS,
  PREMIUM_CHECK_TTL_MS,
  PROBE_TIMEOUT_MS,
} from '../utils/calibration';
import type { AdblockStatus, CalibrationState } from '../utils/calibration';
import { isControlVideo } from '../utils/control-videos';
import {
  adblockProbe,
  beaconUrlFragments,
  beaconUrlMatchPatterns,
  googlesyndicationRedirectMatchPattern,
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
  /** Snapshot taken ONCE at session creation from the rewatch index (ROADMAP §1.3) —
   * never recomputed later, since this session's own flush will mark the video as
   * watched, which must not retroactively make the session that just started it look
   * like a rewatch of itself. */
  recentlyWatched: boolean;
  startedAt: number;
  /** Guards the session-end control-video evaluation (ROADMAP §1.3) so a session is
   * scored against CONTROL_VIDEOS at most once, even though up to three termination
   * points (new video replaces it, tab navigates off it, tab closes) can each observe
   * the same session ending. */
  controlEvaluated: boolean;
}

type PersistedSessions = Record<string, VideoSessionState>;

const SESSION_STORAGE_KEY = 'session:adsauditor_sessions' as const;
const LOCAL_SESSIONS_FALLBACK_KEY = 'local:adsauditor_sessions_fallback' as const;
const LOCAL_HISTORY_KEY = 'local:adsauditor_history' as const;
const CALIBRATION_STORAGE_KEY = 'local:adsauditor_calibration' as const;
const REWATCH_INDEX_STORAGE_KEY = 'local:adsauditor_rewatch_index' as const;

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
  const now = Date.now();
  return new Map(
    Object.entries(persisted).map(([tabId, session]) => [
      Number(tabId),
      {
        ...session,
        // Sessions persisted before ROADMAP §1.3 lack these fields entirely (older
        // stored JSON, not merely `undefined` on an otherwise-typed object). Default
        // conservatively: recentlyWatched=true (never let a resurrected session with
        // unknown history masquerade as a fresh, calibration-eligible watch),
        // startedAt=now, controlEvaluated=false (allow one more end-of-session check).
        recentlyWatched: session.recentlyWatched ?? true,
        startedAt: session.startedAt ?? now,
        controlEvaluated: session.controlEvaluated ?? false,
      },
    ]),
  );
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

// ---------------------------------------------------------------------------------
// Calibration state (ROADMAP §1.3): local-only, never sent as telemetry (see
// ClassifierContext's doc comment in utils/types.ts).
// ---------------------------------------------------------------------------------
async function readCalibrationState(): Promise<CalibrationState> {
  return (
    (await storage.getItem<CalibrationState>(CALIBRATION_STORAGE_KEY)) ?? EMPTY_CALIBRATION_STATE
  );
}

async function writeCalibrationState(next: CalibrationState): Promise<void> {
  await storage.setItem(CALIBRATION_STORAGE_KEY, next);
}

async function readRewatchIndex(): Promise<Record<string, number>> {
  return (await storage.getItem<Record<string, number>>(REWATCH_INDEX_STORAGE_KEY)) ?? {};
}

async function writeRewatchIndex(next: Record<string, number>): Promise<void> {
  await storage.setItem(REWATCH_INDEX_STORAGE_KEY, next);
}

/** Read-modify-write of calibration.lastControlFailureAt, done as a single queued task
 * (see enqueueWrite) so it can never race with the flush path's own calibration
 * read-modify-write of lastPositiveEvidenceAt. */
async function recordControlFailure(): Promise<void> {
  enqueueWrite(async () => {
    const calibration = await readCalibrationState();
    await writeCalibrationState({ ...calibration, lastControlFailureAt: Date.now() });
  });
}

function buildClassifierContext(
  session: VideoSessionState,
  calibration: CalibrationState,
): ClassifierContext {
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
    observerValidity: resolveObserverValidity(calibration, Date.now()),
    recentlyWatched: session.recentlyWatched,
  };
}

/** Builds a brand-new session for `videoId`, snapshotting `recentlyWatched` from the
 * rewatch index ONCE at creation time (ROADMAP §1.3) — see VideoSessionState's doc
 * comment for why this must not be recomputed later. */
function createFreshSession(
  videoId: string | null,
  now: number,
  rewatchIndex: Record<string, number>,
): VideoSessionState {
  return {
    videoId,
    currentPageVideoId: videoId,
    events: [],
    updatedAt: now,
    recentlyWatched: videoId !== null ? isRecentlyWatched(rewatchIndex, videoId, now) : false,
    startedAt: now,
    controlEvaluated: false,
  };
}

/**
 * Session-end control-video evaluation (ROADMAP §1.3, SPEC §3.4's calibration
 * backstop): runs classify() one final time over a session about to end (its video is
 * being replaced by a new one in the same tab, the tab navigated off its watch page, or
 * the tab closed) and records a control-video failure. Guarded by
 * session.controlEvaluated so a session is scored at most once even though all three
 * termination points can observe the same session object ending.
 *
 * 'pass' needs no handling here — a passing control video is ADS_SERVED, and the flush
 * path already advanced lastPositiveEvidenceAt for that classification.
 */
async function evaluateSessionEndControl(session: VideoSessionState): Promise<void> {
  if (session.controlEvaluated) return;
  session.controlEvaluated = true;
  try {
    const calibration = await readCalibrationState();
    const context = buildClassifierContext(session, calibration);
    const result = classify(session.events, context);
    const outcome = evaluateControlOutcome(
      result,
      session.videoId !== null && isControlVideo(session.videoId),
      session.recentlyWatched,
    );
    if (outcome === 'fail') {
      await recordControlFailure();
    }
  } catch (err) {
    console.error('[AdsAuditor] Session-end control evaluation failed', err);
  }
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
  // Loaded once per batch (not once per tab): every tab in this flush is classified
  // against the SAME calibration snapshot, and any ADS_SERVED result found along the
  // way advances it in-memory for the remaining tabs in this same batch too.
  const calibration = await readCalibrationState();
  const now = Date.now();
  const rewatchIndex = pruneRewatchIndex(await readRewatchIndex(), now);

  for (const tabId of tabIds) {
    // One tab's failure (e.g. a malformed event that slipped past validation) must not
    // abort the remaining tabs' flushes — pendingTabFlushes was already cleared, so a
    // batch-wide throw would silently lose them (§1.2 review finding).
    try {
      const session = sessions.get(tabId);
      if (!session || !session.videoId) continue;
      const result = classify(session.events, buildClassifierContext(session, calibration));
      await appendLocalHistory(session.videoId, result);

      if (result.state === 'ADS_SERVED') {
        calibration.lastPositiveEvidenceAt = Date.now();
      }
      rewatchIndex[session.videoId] = Date.now();
    } catch (err) {
      console.error(`[AdsAuditor] Flush failed for tab ${tabId}`, err);
    }
  }

  await writeCalibrationState(calibration);
  await writeRewatchIndex(rewatchIndex);
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

  const isNewVideoForTab = Boolean(incomingVideoId) && incomingVideoId !== existing?.videoId;

  if (isNewVideoForTab && existing) {
    // The outgoing session's video is about to be discarded from the map (replaced
    // below) — this is termination point (a) of the session-end control evaluation
    // (ROADMAP §1.3). Fire-and-forget: it only reads calibration state and, on
    // failure, enqueues a calibration write; nothing here needs to block the new
    // session from being created.
    void evaluateSessionEndControl(existing);
  }

  let session: VideoSessionState;
  if (isNewVideoForTab || !existing) {
    const now = Date.now();
    // Read the rewatch index ONCE, before this session (or any flush of it) can write
    // into that same index — see VideoSessionState.recentlyWatched's doc comment. Local
    // history is NOT used here: its 50-entry cap and self-append make it the wrong
    // source for this check (ROADMAP §1.3).
    const rewatchIndex = incomingVideoId ? await readRewatchIndex() : {};
    session = createFreshSession(incomingVideoId, now, rewatchIndex);
  } else {
    session = existing;
  }

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
 * video's watch page, which is what closes the session to further beacon attribution.
 * Also termination point (b) of the session-end control evaluation (ROADMAP §1.3): the
 * tab moving off the session video's watch page ends that session just as surely as a
 * new video replacing it would. */
async function handlePageNavigated(tabId: number, pageVideoId: string | null): Promise<void> {
  const sessions = await getSessionsMap();
  const session = sessions.get(tabId);
  if (!session) return;

  if (session.videoId !== null && pageVideoId !== session.videoId) {
    await evaluateSessionEndControl(session);
  }

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

// ---------------------------------------------------------------------------------
// Calibration scheduling (ROADMAP §1.3): bridge.content.ts asks whether it's due to run
// the adblock and/or Premium probes; this service worker is the sole source of truth
// for "due" (cached timestamps) and dedupes concurrent tabs via an in-memory CLAIM
// TIMESTAMP per check (not a plain boolean — see the comment on CLAIM_MAX_AGE_MS below
// for why a boolean is unsafe here).
// ---------------------------------------------------------------------------------
let adblockCheckClaimedAt: number | null = null;
let premiumCheckClaimedAt: number | null = null;

/**
 * A claim older than this is treated as abandoned and the check becomes claimable
 * again. Without this expiry, a plain "in-flight" boolean would get stuck true forever
 * once claimed, because the matching calibrationResult that resets it can fail to
 * arrive: the tab closes mid-probe, the content-script context invalidates during the
 * Premium retry loop (navigation, extension reload), or runtime.sendMessage itself
 * rejects. A stuck flag would permanently suppress that check for the rest of the
 * service worker's lifetime — which webRequest/message traffic can keep alive
 * indefinitely, i.e. effectively forever. PROBE_TIMEOUT_MS bounds the adblock fetch
 * pair; the Premium retry loop runs for PREMIUM_CHECK_MAX_RETRIES * ~500ms (~10s,
 * bridge.content.ts) — either way a several-second margin comfortably covers both.
 */
const CLAIM_STALE_MARGIN_MS = 5000;
const CLAIM_MAX_AGE_MS = PROBE_TIMEOUT_MS + CLAIM_STALE_MARGIN_MS;

function isClaimActive(claimedAt: number | null, now: number): boolean {
  return claimedAt !== null && now - claimedAt <= CLAIM_MAX_AGE_MS;
}

async function handleCalibrationDueQuery(
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const calibration = await readCalibrationState().catch((err) => {
    console.warn(
      '[AdsAuditor] Reading calibration state for calibrationDueQuery failed; defaulting to uncalibrated',
      err,
    );
    return EMPTY_CALIBRATION_STATE;
  });
  const now = Date.now();

  const adblockDue =
    !isClaimActive(adblockCheckClaimedAt, now) &&
    (calibration.adblock === null ||
      now - calibration.adblock.checkedAt > ADBLOCK_CHECK_TTL_MS ||
      (calibration.adblock.status === 'inconclusive' &&
        now - calibration.adblock.checkedAt > ADBLOCK_INCONCLUSIVE_RETRY_MS));

  const premiumDue =
    !isClaimActive(premiumCheckClaimedAt, now) &&
    (calibration.premium === null || now - calibration.premium.checkedAt > PREMIUM_CHECK_TTL_MS);

  if (adblockDue) adblockCheckClaimedAt = now;
  if (premiumDue) premiumCheckClaimedAt = now;

  sendResponse({ runAdblockCheck: adblockDue, runPremiumCheck: premiumDue });
}

/**
 * Independent redirect-based adblock signal (ROADMAP §1.3 fix): uBlock Origin's default
 * filter lists REDIRECT pagead2.googlesyndication.com/pagead/js/adsbygoogle.js to a
 * local neutered stub instead of cancelling the request outright, so the bait fetch in
 * bridge.content.ts still "resolves" and interpretAdblockProbe's pure truth table alone
 * would read the single most common blocker as 'clear'. `details.url` here is the
 * ORIGINAL request being redirected away from (our bait request, carrying
 * adblockProbe.markerParam) — not the redirect target, which is some blocker-internal
 * or extension-local stub URL that never contains our marker.
 *
 * LIMITATION: this is in-memory only. If the service worker is suspended between this
 * redirect firing and the matching calibrationResult arriving, the observation is lost
 * and the override below doesn't apply — acceptable, since control-video calibration
 * (SPEC §3.4) is the backstop for exactly this kind of missed detection.
 */
let lastBaitRedirectSeenAt: number | null = null;
const BAIT_REDIRECT_OVERRIDE_WINDOW_MS = 30 * 1000;

/** Validates and merges a partial calibration update from bridge.content.ts. Read and
 * write happen inside ONE queued task (enqueueWrite at the call site) so this can never
 * race with the flush path's own read-modify-write of lastPositiveEvidenceAt or
 * recordControlFailure's of lastControlFailureAt.
 *
 * `receivedAt` is stamped by the caller at message-receipt time and used as this
 * result's `checkedAt` — the content script's own checkedAt is never trusted (it could
 * be NaN/Infinity/clock-skewed-into-the-future, any of which would make the TTL
 * due-check in handleCalibrationDueQuery permanently false and brick recalibration). */
async function mergeCalibrationResult(
  message: Record<string, unknown>,
  receivedAt: number,
): Promise<void> {
  const calibration = await readCalibrationState();
  let next: CalibrationState = calibration;

  const adblock = message.adblock;
  if (
    isRecord(adblock) &&
    (adblock.status === 'clear' ||
      adblock.status === 'blocked' ||
      adblock.status === 'inconclusive')
  ) {
    let status: AdblockStatus = adblock.status;
    if (
      status === 'clear' &&
      lastBaitRedirectSeenAt !== null &&
      receivedAt - lastBaitRedirectSeenAt <= BAIT_REDIRECT_OVERRIDE_WINDOW_MS
    ) {
      // See lastBaitRedirectSeenAt's doc comment above: a redirected-not-cancelled bait
      // request looks 'clear' to interpretAdblockProbe alone.
      status = 'blocked';
    }
    next = { ...next, adblock: { status, checkedAt: receivedAt } };
  }

  const premium = message.premium;
  if (isRecord(premium) && typeof premium.detected === 'boolean') {
    next = { ...next, premium: { detected: premium.detected, checkedAt: receivedAt } };
  }

  if (next !== calibration) {
    await writeCalibrationState(next);
  }
}

export default defineBackground(() => {
  // MV3: registered synchronously at top level (CLAUDE.md, SPEC §3.2). Observation
  // only — no `blocking` extraInfoSpec, no declarativeNetRequest, URLs only, never
  // request/response bodies (CLAUDE.md invariant 6).
  browser.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      // Never returns a BlockingResponse (no `cancel`/`redirectUrl`) — observation only.
      if (details.tabId < 0) return undefined; // not associated with a tab (e.g. prefetch); nothing to attribute this to
      // Our own adblock-probe bait fetch (ROADMAP §1.3) originates in a real tab, so it
      // has a valid tabId and matches the googlesyndication beacon pattern above — the
      // tabId<0 guard does NOT catch it. Drop it before it's misread as a real ad
      // impression. The generate_204 control fetch matches no beacon pattern and needs
      // no guard.
      if (details.url.includes(adblockProbe.markerParam)) return undefined;
      const kind = classifyBeaconUrl(details.url);
      if (!kind) return undefined; // defensive: the filter below should already guarantee a match
      const event: BeaconEvent = { source: 'BEACON', kind, capturedAt: Date.now() };
      void handleIncomingEvent(details.tabId, event);
      return undefined;
    },
    { urls: [...beaconUrlMatchPatterns] },
  );

  // MV3: registered synchronously at top level, same as onBeforeRequest above.
  // Observation only: no `redirectUrl` returned, nothing about the redirect is altered.
  // See lastBaitRedirectSeenAt's doc comment (ROADMAP §1.3 fix) for why this listener
  // exists — briefly, uBlock Origin's default lists REDIRECT (not cancel) our adblock
  // bait request, which would otherwise be misread as 'clear'.
  browser.webRequest.onBeforeRedirect.addListener(
    (details): void => {
      // details.url is the ORIGINAL request being redirected away from (our bait
      // request, carrying adblockProbe.markerParam) — not the redirect target.
      if (details.url.includes(adblockProbe.markerParam)) {
        lastBaitRedirectSeenAt = Date.now();
      }
    },
    { urls: [googlesyndicationRedirectMatchPattern] },
  );

  // Registered synchronously for the same MV3 wake-reliability reason as above.
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRecord(message) || typeof message.kind !== 'string') return undefined;
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId < 0) return undefined;

    if (
      message.kind === runtimeMessageKinds.playerResponseEvent &&
      isPlayerResponseEventShape(message.event)
    ) {
      void handleIncomingEvent(tabId, message.event);
      return undefined;
    }
    if (message.kind === runtimeMessageKinds.domAdEvent && isDomAdEventShape(message.event)) {
      void handleIncomingEvent(tabId, message.event);
      return undefined;
    }
    if (
      message.kind === runtimeMessageKinds.pageNavigated &&
      (typeof message.pageVideoId === 'string' || message.pageVideoId === null)
    ) {
      void handlePageNavigated(tabId, message.pageVideoId);
      return undefined;
    }
    if (message.kind === runtimeMessageKinds.calibrationDueQuery) {
      // Async response: sendResponse-callback + `return true` pattern, for cross-browser
      // MV3 safety (works identically against Chrome's native callback API and
      // Firefox's promise-polyfilled one — see ROADMAP §1.3 design).
      void handleCalibrationDueQuery(sendResponse);
      return true;
    }
    if (message.kind === runtimeMessageKinds.calibrationResult) {
      // Claim timestamps are ephemeral in-memory state, not persisted — clear them as
      // soon as a result arrives so the NEXT calibrationDueQuery reflects reality
      // without waiting on the write queue (the CLAIM_MAX_AGE_MS expiry above is only
      // the fallback for when no result ever arrives at all).
      if ('adblock' in message) adblockCheckClaimedAt = null;
      if ('premium' in message) premiumCheckClaimedAt = null;
      // Stamped once, here, at message-receipt time — never the content script's own
      // checkedAt (see mergeCalibrationResult's doc comment).
      const receivedAt = Date.now();
      enqueueWrite(() => mergeCalibrationResult(message, receivedAt));
      return undefined;
    }
    // Fire-and-forget: bridge.content.ts does not await a response for the above kinds.
    return undefined;
  });

  // Stale-fallback hygiene (§1.2 review finding): the local fallback for session state
  // only exists to bridge a storage.session outage; on a fresh browser start it must
  // not resurrect dead sessions onto reused tab ids.
  browser.runtime.onStartup.addListener(() => {
    void storage.removeItem(LOCAL_SESSIONS_FALLBACK_KEY).catch(() => undefined);
  });

  // Registered synchronously; drops a tab's in-memory + persisted session once it closes.
  // Termination point (c) of the session-end control evaluation (ROADMAP §1.3): a
  // closed tab ends its session just as surely as a navigation away or a new video.
  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const sessions = await getSessionsMap();
      const session = sessions.get(tabId);
      if (session) {
        await evaluateSessionEndControl(session);
      }
      if (sessions.delete(tabId)) {
        enqueueWrite(() => persistSessionsMap(sessions));
      }
    })();
  });
});
