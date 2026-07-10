/**
 * Shared types for the extension (docs/SPEC.md §3.3).
 *
 * Keep this file free of browser/DB imports — classifier.ts and the consensus function
 * depend on it and must stay pure.
 */

/**
 * Observed states reported by the client — facts, not interpretations (SPEC §3.3).
 * The extension never reports an inferred "yellow icon"; that inference happens only
 * server-side (SPEC §1.1, §4.1).
 */
export type ObservedState = 'ADS_SERVED' | 'NO_ADS' | 'NO_SIGNAL' | 'UNAVAILABLE';

/** Which of the three independent signal sources contributed to an observation (SPEC §3.2). */
export type EvidenceSource = 'PLAYER_RESPONSE' | 'DOM' | 'BEACON';

/**
 * Detail attached to an ADS_SERVED observation (SPEC §3.3):
 * `{preroll, midrolls, postroll, sources}`.
 */
export interface AdEvidence {
  preroll: boolean;
  midrolls: number;
  postroll: boolean;
  sources: EvidenceSource[];
}

/**
 * Minimal context attached to an observation (SPEC §3.3). This is the bare minimum:
 * never history, watch time, search queries, or identity beyond the local pseudonymous
 * UUID (which is not part of this type — it lives with the observer record).
 *
 * This is the schema that becomes (a subset of) the Phase 2 telemetry payload. Do not
 * add fields here for classifier-only or local-storage-only needs — see
 * ClassifierContext and LocalHistoryEntry below for where those belong instead
 * (CLAUDE.md invariant 2: a test must fail if the sent payload gains fields).
 */
export interface VideoContext {
  durationS: number;
  isLive: boolean;
  isLoggedIn: boolean;
  /** National-granularity hint only (e.g. "IT"), never precise geolocation. */
  countryHint: string | null;
  extensionVersion: string;
}

// ---------------------------------------------------------------------------------
// Detection events (SPEC §3.2's three independent sources). classify() consumes a
// DetectionEvent[] built by background.ts from PlayerResponseEvent (source A, forwarded
// by interceptor.content.ts via bridge.content.ts), DomAdEvent (source B, emitted by
// bridge.content.ts's MutationObserver), and BeaconEvent (source C, observed directly by
// background.ts's webRequest listener).
// ---------------------------------------------------------------------------------

/** How a PlayerResponseEvent's data was captured — the three paths in SPEC §3.2. */
export type CapturePath = 'initial' | 'fetch' | 'getPlayerResponse';

/** One extracted entry of the player response's `adPlacements[]` (SPEC §3.2, source A). */
export interface AdPlacementItem {
  /** e.g. AD_PLACEMENT_KIND_START / _MILLISECONDS / _END — see utils/selectors.ts adPlacementKinds. */
  kind: string | null;
  offsetStartMs: number | null;
  offsetEndMs: number | null;
}

/** One extracted entry of the player response's `adSlots[]` (SPEC §3.2, source A). */
export interface AdSlotItem {
  slotType: string | null;
}

/** One extracted entry of the player response's `playerAds[]` (SPEC §3.2, source A). */
export interface PlayerAdItem {
  type: string | null;
}

/**
 * Source A: one player response read, from any of the three capture paths (SPEC §3.2).
 *
 * `videoId` and `pageVideoId` are BOTH required to correctly attribute this event: an ad
 * creative's own player response flows through the exact same `/youtubei/v1/player`
 * endpoint as the content video's, and the only reliable way to tell them apart is
 * comparing `videoId` (this response's own `videoDetails.videoId`) against `pageVideoId`
 * (the watch URL's `v=` query parameter at capture time) — field-verified in the Phase 0
 * spike. classify() and background.ts both apply this filter defensively.
 */
export interface PlayerResponseEvent {
  source: 'PLAYER_RESPONSE';
  capturePath: CapturePath;
  pageVideoId: string | null;
  videoId: string | null;
  durationSeconds: number | null;
  playabilityStatus: string | null;
  isLiveContent: boolean | null;
  isLoggedIn: boolean | null;
  adPlacements: AdPlacementItem[];
  adSlots: AdSlotItem[];
  playerAds: PlayerAdItem[];
  capturedAt: number;
}

/** Raw DOM transition/sighting kinds observed on #movie_player (SPEC §3.2, source B). */
export type DomAdEventKind =
  | 'ad-showing-start'
  | 'ad-showing-end'
  | 'ad-interrupting-start'
  | 'ad-interrupting-end'
  | 'ad-badge-seen';

/**
 * Source B: one DOM ad signal (SPEC §3.2). `contentTimeSeconds` is the last-known
 * CONTENT playback time sampled by the MAIN-world interceptor before the ad started —
 * never a fresh read taken during the ad itself, which would report the ad creative's
 * own timeline (spike-verified: getCurrentTime()/getVideoData() describe the ad during
 * playback, not the content). classify() uses it, together with the classifier
 * context's durationS, to attribute the event as preroll / midroll / postroll.
 */
export interface DomAdEvent {
  source: 'DOM';
  kind: DomAdEventKind;
  watchUrlVideoId: string | null;
  contentTimeSeconds: number | null;
  capturedAt: number;
}

/** Which beacon endpoint fired (SPEC §3.2, source C). URL only, never a request body. */
export type BeaconKind = 'STATS_ADS' | 'PAGEAD' | 'DOUBLECLICK' | 'GOOGLESYNDICATION';

/** Source C: one observed beacon request (SPEC §3.2). No URL is retained past classification. */
export interface BeaconEvent {
  source: 'BEACON';
  kind: BeaconKind;
  capturedAt: number;
}

/** Union of every event classify() can receive — SPEC §3.2's three independent sources. */
export type DetectionEvent = PlayerResponseEvent | DomAdEvent | BeaconEvent;

// ---------------------------------------------------------------------------------
// Runtime shape guards (ROADMAP §1.2 review round). Used at both the MAIN -> ISOLATED
// postMessage boundary (bridge.content.ts, before forwarding) and the content ->
// background runtime-message boundary (background.ts, before persisting into a
// session) to validate-and-drop malformed events. A malformed event that slips through
// (e.g. `adPlacements: [null]` instead of `AdPlacementItem[]`) would otherwise throw
// inside classify() on every future flush of that tab, permanently poisoning its
// session. Pure, no browser dependency — safe to import from any world/context.
// ---------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNumberOrNull(value: unknown): value is number | null {
  return typeof value === 'number' || value === null;
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return typeof value === 'boolean' || value === null;
}

function isAdPlacementItemShape(value: unknown): value is AdPlacementItem {
  return (
    isRecord(value) &&
    isStringOrNull(value.kind) &&
    isNumberOrNull(value.offsetStartMs) &&
    isNumberOrNull(value.offsetEndMs)
  );
}

function isAdSlotItemShape(value: unknown): value is AdSlotItem {
  return isRecord(value) && isStringOrNull(value.slotType);
}

function isPlayerAdItemShape(value: unknown): value is PlayerAdItem {
  return isRecord(value) && isStringOrNull(value.type);
}

const CAPTURE_PATHS: readonly CapturePath[] = ['initial', 'fetch', 'getPlayerResponse'];

/** Deep shape validation: every field's runtime type is checked, not just the `source`
 * discriminant — arrays must actually be arrays of well-shaped items, strings must be
 * string-or-null (never e.g. a number that happens to coerce). */
export function isPlayerResponseEventShape(value: unknown): value is PlayerResponseEvent {
  return (
    isRecord(value) &&
    value.source === 'PLAYER_RESPONSE' &&
    typeof value.capturePath === 'string' &&
    (CAPTURE_PATHS as readonly string[]).includes(value.capturePath) &&
    isStringOrNull(value.pageVideoId) &&
    isStringOrNull(value.videoId) &&
    isNumberOrNull(value.durationSeconds) &&
    isStringOrNull(value.playabilityStatus) &&
    isBooleanOrNull(value.isLiveContent) &&
    isBooleanOrNull(value.isLoggedIn) &&
    Array.isArray(value.adPlacements) &&
    value.adPlacements.every(isAdPlacementItemShape) &&
    Array.isArray(value.adSlots) &&
    value.adSlots.every(isAdSlotItemShape) &&
    Array.isArray(value.playerAds) &&
    value.playerAds.every(isPlayerAdItemShape) &&
    typeof value.capturedAt === 'number'
  );
}

const DOM_AD_EVENT_KINDS: readonly DomAdEventKind[] = [
  'ad-showing-start',
  'ad-showing-end',
  'ad-interrupting-start',
  'ad-interrupting-end',
  'ad-badge-seen',
];

export function isDomAdEventShape(value: unknown): value is DomAdEvent {
  return (
    isRecord(value) &&
    value.source === 'DOM' &&
    typeof value.kind === 'string' &&
    (DOM_AD_EVENT_KINDS as readonly string[]).includes(value.kind) &&
    isStringOrNull(value.watchUrlVideoId) &&
    isNumberOrNull(value.contentTimeSeconds) &&
    typeof value.capturedAt === 'number'
  );
}

// ---------------------------------------------------------------------------------
// classify() output (SPEC §3.2 cross-reference table, §3.3 taxonomy).
// ---------------------------------------------------------------------------------

/**
 * Why this observer (this browser, right now) is not trusted for a NO_ADS verdict
 * (SPEC §3.4, ROADMAP §1.3). Computed by utils/calibration.ts's resolveObserverValidity
 * from local-only calibration state (adblock bait-fetch, Premium heuristic,
 * control-video outcomes) — never derived from or sent as telemetry.
 */
export type ObserverInvalidCause =
  /** The adblock bait-vs-control probe (utils/calibration.ts interpretAdblockProbe)
   * came back 'blocked'. */
  | 'adblock-suspected'
  /** The YouTube Premium masthead badge was detected (utils/selectors.ts
   * mastheadPremiumBadge) — Premium sessions can be genuinely ad-free. */
  | 'premium-suspected'
  /** A control video (utils/control-videos.ts) came back with zero ad evidence on a
   * fresh (non-rewatch) watch — SPEC §3.4's calibration backstop. Automatically clears
   * once a later ADS_SERVED observation advances lastPositiveEvidenceAt past it. */
  | 'calibration-failed'
  /** No recent positive control observation exists yet (or it aged out of
   * POSITIVE_EVIDENCE_WINDOW_MS) — the default state for a browser that hasn't proven
   * it can see ads at all. */
  | 'uncalibrated';

/** `{ valid: true }` — the observer is calibrated and a NO_ADS verdict is trustworthy —
 * or `{ valid: false; cause }` naming which check failed (ROADMAP §1.3). */
export type ObserverValidity = { valid: true } | { valid: false; cause: ObserverInvalidCause };

/** Why classify() returned NO_SIGNAL (SPEC §3.4). */
export type NoSignalCause =
  /** No player response was ever captured for this video (page not fully loaded, wrong
   * page, or the bridge never relayed one). */
  | 'no-player-response'
  /** A beacon fired with no placement and no ad UI — not a SPEC §3.2 table row. Cannot
   * distinguish an in-player impression from unrelated ad traffic, so it never counts
   * as ADS_SERVED; tracked separately because a systematic rise in beacon-only sessions
   * is an early SSAI-rollout / beacon-attribution warning. */
  | 'anomalous-beacon-only'
  /** No ad evidence was found, but this browser watched this exact video recently.
   * Rewatch frequency capping strips ad placements server-side (spike/RESULTS.md §3.5,
   * §5), so an absence of evidence here is NOT NO_ADS evidence. */
  | 'recent-rewatch'
  /** Context says this observer failed adblock/Premium/control-video calibration
   * (SPEC §3.4, ROADMAP §1.3) — see ObserverInvalidCause for which specific check. */
  | ObserverInvalidCause;

/**
 * ADS_SERVED detail (SPEC §3.3's `{preroll, midrolls, postroll, sources}`), extended
 * with the SSAI-anomaly flag from SPEC §3.2's cross-reference table row 4.
 */
export interface AdEvidenceDetail extends AdEvidence {
  /** True when source A placements were absent but source B and/or C still observed an
   * ad (SPEC §3.2 table row 4: likely SSAI or a player-response format change; B/C take
   * precedence over A's silence). False whenever source A placements were present. */
  ssaiAnomalySuspected: boolean;
}

export interface ClassificationResult {
  state: ObservedState;
  /** Present only when state === 'ADS_SERVED'. */
  evidence?: AdEvidenceDetail;
  /** Present only when state === 'NO_SIGNAL'. */
  noSignalCause?: NoSignalCause;
  /**
   * Calibration detail exposed regardless of state (ROADMAP §1.2): midroll placement
   * count (0 when none observed), the context's video duration, and midrolls-per-minute
   * density. Feeds spike/RESULTS.md §4 threshold recalibration server-side; classify()
   * itself makes no green/yellow determination (SPEC §1.1) — that inference happens only
   * server-side, with calibrated thresholds.
   */
  midrollPlacementCount: number;
  videoDurationS: number;
  midrollDensityPerMinute: number | null;
}

/**
 * Local-only classifier input: extends the telemetry-safe VideoContext (SPEC §3.3) with
 * two fields the classifier needs to apply NO_SIGNAL discipline (SPEC §3.4) but that
 * must NEVER be part of any payload leaving the browser. Both are computed by
 * utils/calibration.ts (adblock bait-fetch, Premium heuristic, control-video
 * calibration, local rewatch history — ROADMAP §1.3) and are local-only, never sent.
 */
export interface ClassifierContext extends VideoContext {
  /** Computed by utils/calibration.ts's resolveObserverValidity; local-only, never
   * leaves the browser (SPEC §3.4). */
  observerValidity: ObserverValidity;
  /** True when this browser watched this exact video recently (spike/RESULTS.md §3.5). */
  recentlyWatched: boolean;
}

// ---------------------------------------------------------------------------------
// Local-only storage shape (ROADMAP §1.2 background.ts writes it; §1.4 popup reads it).
// ---------------------------------------------------------------------------------

/**
 * One entry of the local "last 50 videos observed" history (ROADMAP §1.4), persisted to
 * chrome.storage.local. This is a LOCAL STORAGE shape, not a telemetry payload: it may
 * carry more than SPEC §3.3's minimal schema. When Phase 2 telemetry is implemented, it
 * MUST build its own separate minimal object from scratch — never serialize this type
 * directly onto the wire (CLAUDE.md invariant 2).
 */
export interface LocalHistoryEntry {
  videoId: string;
  observedAt: number;
  state: ObservedState;
  evidence?: AdEvidenceDetail;
  noSignalCause?: NoSignalCause;
}
