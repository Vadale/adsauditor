/**
 * Pure classifier: events -> observed state (docs/SPEC.md §3.2, §3.3).
 *
 * This file and the server-side consensus function are the most-tested code in the
 * repo (CLAUDE.md) and must stay pure: no browser APIs, no DB/network imports. Every
 * dependency comes in as a plain argument so the function can be driven entirely from
 * Vitest fixtures (extension/test/fixtures/). Importing utils/selectors.ts and
 * utils/types.ts is fine — both are plain data with no browser/DB dependency of their
 * own.
 *
 * NO_SIGNAL calibration (adblock bait-fetch, Premium heuristic, control-video
 * calibration, local rewatch history) lives in utils/calibration.ts (ROADMAP §1.3):
 * this module only consumes the resulting `observerValidity` / `recentlyWatched` fields
 * via ClassifierContext, and never ranks the four ObserverInvalidCause values against
 * each other — that priority order is calibration.ts's resolveObserverValidity's job.
 */
import { adPlacementKinds } from './selectors';
import type {
  AdEvidenceDetail,
  AdPlacementItem,
  ClassificationResult,
  ClassifierContext,
  DetectionEvent,
  DomAdEvent,
  EvidenceSource,
  NoSignalCause,
  PlayerResponseEvent,
} from './types';

/**
 * Heuristic thresholds for typing anomaly-path (source A absent) DOM ad starts by
 * content time. These are classify()-internal typing heuristics, NOT the server-side
 * green/yellow density thresholds from spike/RESULTS.md §4 — those apply only when
 * source A placements are present and are computed/calibrated server-side (SPEC §1.1).
 */
const PREROLL_CONTENT_TIME_THRESHOLD_S = 5;
const POSTROLL_CONTENT_TIME_EPSILON_S = 3;

function isPlayerResponseEvent(event: DetectionEvent): event is PlayerResponseEvent {
  return event.source === 'PLAYER_RESPONSE';
}

function isDomAdEvent(event: DetectionEvent): event is DomAdEvent {
  return event.source === 'DOM';
}

/**
 * "Strong" DOM evidence (field bug 2026-07-11): any DomAdEventKind OTHER than
 * 'ad-badge-seen'. The ad-showing/ad-interrupting class transitions only toggle during
 * a REAL ad break; 'ad-badge-seen' alone is weak/ambient — YouTube ships empty
 * `ytp-ad-*` DOM scaffolding even on non-monetized videos where no ad ever plays, and a
 * badge sighting alone cannot tell that scaffolding apart from a real ad UI. Badge
 * sightings used to also cover "an ad was already showing when the observer attached"
 * (no start transition to react to), but bridge.content.ts's attach-time classList
 * priming now synthesizes a real start event for that case directly, so badges are no
 * longer needed to close that gap.
 */
function isStrongDomEvent(event: DomAdEvent): boolean {
  return event.kind !== 'ad-badge-seen';
}

function isBeaconEvent(event: DetectionEvent): boolean {
  return event.source === 'BEACON';
}

function computeMidrollDensity(midrolls: number, durationS: number): number | null {
  if (durationS <= 0) return null;
  return midrolls / (durationS / 60);
}

interface PlacementCounts {
  preroll: boolean;
  midrolls: number;
  postroll: boolean;
}

/** Source A: derive preroll/midrolls/postroll straight from adPlacements[].kind. */
function summarizePlacementCounts(placements: AdPlacementItem[]): PlacementCounts {
  let preroll = false;
  let midrolls = 0;
  let postroll = false;
  for (const placement of placements) {
    if (placement.kind === adPlacementKinds.start) preroll = true;
    else if (placement.kind === adPlacementKinds.milliseconds) midrolls += 1;
    else if (placement.kind === adPlacementKinds.end) postroll = true;
    // AD_PLACEMENT_KIND_SELF_START and any unrecognized kind (including the 2-character
    // garbage values a substring-matched, non-canonical endpoint can produce — see
    // PLAYER_ENDPOINT_PATHNAME in utils/selectors.ts) are intentionally left uncounted.
  }
  return { preroll, midrolls, postroll };
}

/**
 * Anomaly path (SPEC §3.2 table row 4): source A gave us nothing, so type each strong
 * DOM ad-start event as preroll/midroll/postroll using its content-time sample instead.
 * Callers only ever pass STRONG DOM events here (isStrongDomEvent) — 'ad-badge-seen'
 * sightings never reach this function (field bug 2026-07-11: a badge-only fallback used
 * to treat any badge-with-no-start as a preroll, which is exactly what misread YouTube's
 * empty `ytp-ad-*` scaffolding on non-monetized videos as a real ad; that fallback has
 * been removed rather than special-cased, since strong events are real ad-state class
 * transitions and bridge.content.ts's attach-time priming already synthesizes a start
 * for an ad already showing when the observer attaches).
 *
 * ad-showing and ad-interrupting toggle as a PAIR for the same ad break (spike exports
 * show millisecond-identical start timestamps), so counting both classes would double
 * every break: prefer ad-showing starts and fall back to ad-interrupting starts only
 * when no ad-showing transition was captured.
 */
function typeDomEventsByContentTime(domAdEvents: DomAdEvent[], durationS: number): PlacementCounts {
  const showingStarts = domAdEvents.filter((event) => event.kind === 'ad-showing-start');
  const starts =
    showingStarts.length > 0
      ? showingStarts
      : domAdEvents.filter((event) => event.kind === 'ad-interrupting-start');
  let preroll = false;
  let midrolls = 0;
  let postroll = false;

  for (const event of starts) {
    const t = event.contentTimeSeconds;
    if (t !== null && t <= PREROLL_CONTENT_TIME_THRESHOLD_S) {
      preroll = true;
    } else if (t !== null && durationS > 0 && t >= durationS - POSTROLL_CONTENT_TIME_EPSILON_S) {
      postroll = true;
    } else {
      // Includes the "content time unknown" case: the AdEvidence schema (SPEC §3.3) has
      // no "unknown position" slot, so an ad start we can't place precisely is
      // conservatively counted as a mid-roll.
      midrolls += 1;
    }
  }

  return { preroll, midrolls, postroll };
}

/** Attaches the calibration fields (ROADMAP §1.2) that every ClassificationResult carries. */
function finalize(
  base: {
    state: ClassificationResult['state'];
    evidence?: AdEvidenceDetail;
    noSignalCause?: NoSignalCause;
  },
  midrolls: number,
  context: ClassifierContext,
): ClassificationResult {
  return {
    ...base,
    midrollPlacementCount: midrolls,
    videoDurationS: context.durationS,
    midrollDensityPerMinute: computeMidrollDensity(midrolls, context.durationS),
  };
}

/**
 * classify(events, context) implements SPEC §3.2's cross-reference table:
 *
 * | A (placement) | B (DOM) | C (beacon) | Interpretation |
 * |---|---|---|---|
 * | present | seen | seen | ADS_SERVED, maximum confidence |
 * | present | not seen | — | ADS_SERVED (decision made, playback not observed) |
 * | absent | not seen | absent | NO_ADS only if the observer is valid |
 * | absent | seen | seen | Anomaly (SSAI suspected) -> ADS_SERVED, B/C take precedence |
 * | — | — | blocked/failed | Suspected adblock -> NO_SIGNAL (observerValidity.valid=false upstream) |
 *
 * "B (DOM) seen" in this table means STRONG DOM evidence only (isStrongDomEvent — any
 * DomAdEventKind other than 'ad-badge-seen': the ad-showing/ad-interrupting class
 * transitions, which only toggle during a real ad break). Field bug 2026-07-11: badge
 * sightings alone are weak/ambient — YouTube ships empty `ytp-ad-*` DOM scaffolding even
 * on non-monetized videos where no ad ever plays, so a badge-only sighting used to
 * falsely satisfy "B seen" and flip a truthful zero-placement response to ADS_SERVED via
 * the anomaly row. Now: badge-only sightings (source A absent, no strong B) neither
 * satisfy "B seen" in row 2/4's `sources` list nor the anomaly row's ADS_SERVED trigger
 * — they produce NO_SIGNAL('anomalous-ad-ui-only') instead (see that cause's own doc
 * comment in utils/types.ts), which OUTRANKS both the beacon-only NO_SIGNAL below and
 * the observer-validity/rewatch/NO_ADS fall-through: an ambiguous ambient DOM signal
 * proves neither presence nor absence of an ad, so a confident verdict either way would
 * be as dishonest as the original bug.
 *
 * "A absent, B not seen, C seen" is NOT a row in the table: a beacon alone (no
 * placement, no ad UI) cannot distinguish an in-player impression from unrelated ad
 * traffic, so it never produces ADS_SERVED — it becomes NO_SIGNAL
 * ('anomalous-beacon-only'), preserved for diagnostics.
 *
 * Observer validity (SPEC §3.2 row 3) gates ONLY the NO_ADS verdict: positive
 * placement/strong-DOM evidence is trustworthy regardless of calibration — an observed
 * placement cannot be an adblock artifact (invariant 5 concerns false NO_ADS, not
 * false ADS_SERVED). Badge-only ambient evidence is the one exception: it is never
 * trustworthy enough to produce EITHER a positive or a negative verdict, regardless of
 * observer validity.
 */
export function classify(
  events: DetectionEvent[],
  context: ClassifierContext,
): ClassificationResult {
  const playerResponseEvents = events
    .filter(isPlayerResponseEvent)
    // Ad creatives serve their OWN player response through the identical
    // /youtubei/v1/player endpoint; videoId !== pageVideoId is the only reliable
    // discriminator (see types.ts PlayerResponseEvent doc, spike-verified). Defensive
    // here even though callers (background.ts) are expected to have already filtered
    // these out, so fixtures can feed raw, unfiltered capture data directly.
    .filter(
      (event) =>
        event.videoId === null || event.pageVideoId === null || event.videoId === event.pageVideoId,
    );

  const latestPlayerResponse =
    playerResponseEvents.length > 0 ? playerResponseEvents[playerResponseEvents.length - 1] : null;

  if (!latestPlayerResponse) {
    return finalize({ state: 'NO_SIGNAL', noSignalCause: 'no-player-response' }, 0, context);
  }

  if (
    latestPlayerResponse.playabilityStatus !== null &&
    latestPlayerResponse.playabilityStatus !== 'OK'
  ) {
    return finalize({ state: 'UNAVAILABLE' }, 0, context);
  }

  // One watch yields several player responses for the same video (initial + confirmation
  // read + refetches): concatenating their placements would multiply the midroll count
  // by the number of captures (a spike session showed 11 placement-bearing responses →
  // 14 real midrolls misread as 154). Counts come from the LATEST placement-bearing
  // response only; preroll/postroll are unioned across responses because a refetch can
  // legitimately drop the preroll placement (rewatch capping, spike/RESULTS.md §3.5).
  const perEventCounts = playerResponseEvents
    .filter((event) => event.adPlacements.length > 0)
    .map((event) => summarizePlacementCounts(event.adPlacements));
  const placementsPresent = perEventCounts.length > 0;

  const domAdEvents = events.filter(isDomAdEvent);
  const strongDomEvents = domAdEvents.filter(isStrongDomEvent);
  // domAdSeen counts ANY DOM event including badge-only sightings — needed below to
  // distinguish "no DOM signal at all" (falls through to the beacon-only/NO_ADS checks)
  // from "only weak/ambient badge sightings" (field bug 2026-07-11: its own branch).
  const domAdSeen = domAdEvents.length > 0;
  const strongDomSeen = strongDomEvents.length > 0;
  const beaconSeen = events.some(isBeaconEvent);

  if (placementsPresent) {
    const latestCounts = perEventCounts[perEventCounts.length - 1];
    const preroll = perEventCounts.some((counts) => counts.preroll);
    const midrolls = latestCounts.midrolls;
    const postroll = perEventCounts.some((counts) => counts.postroll);
    const sources: EvidenceSource[] = ['PLAYER_RESPONSE'];
    // Field bug 2026-07-11: only STRONG DOM evidence contributes the 'DOM' source —
    // badge-only sightings must not inflate confidence or the §1.6 popup's "playback
    // observed" headline (utils/evidence-summary.ts's adPlaybackObserved).
    if (strongDomSeen) sources.push('DOM');
    if (beaconSeen) sources.push('BEACON');
    return finalize(
      {
        state: 'ADS_SERVED',
        evidence: { preroll, midrolls, postroll, sources, ssaiAnomalySuspected: false },
      },
      midrolls,
      context,
    );
  }

  if (strongDomSeen) {
    // SPEC §3.2 table row 4: placements absent but STRONG ad UI was observed — likely
    // SSAI or a player-response format change. B evidence takes precedence over A's
    // silence (C may corroborate). Badge-only sightings never reach this branch (field
    // bug 2026-07-11) — see the branch below for that case.
    const { preroll, midrolls, postroll } = typeDomEventsByContentTime(
      strongDomEvents,
      context.durationS,
    );
    const sources: EvidenceSource[] = ['DOM'];
    if (beaconSeen) sources.push('BEACON');
    return finalize(
      {
        state: 'ADS_SERVED',
        evidence: { preroll, midrolls, postroll, sources, ssaiAnomalySuspected: true },
      },
      midrolls,
      context,
    );
  }

  if (domAdSeen) {
    // Field bug 2026-07-11: placements absent, only WEAK (badge-only) DOM evidence —
    // YouTube's empty `ytp-ad-*` scaffolding on non-monetized videos matches
    // 'ad-badge-seen' with no ad ever playing. This ambiguous ambient signal proves
    // neither presence nor absence of an ad, so it must win over BOTH the beacon-only
    // NO_SIGNAL below and the observer-validity/rewatch/NO_ADS fall-through further down
    // — regardless of whether a beacon also fired, and regardless of observer validity
    // (a confident NO_ADS here would be exactly as dishonest as the ADS_SERVED bug was).
    return finalize({ state: 'NO_SIGNAL', noSignalCause: 'anomalous-ad-ui-only' }, 0, context);
  }

  if (beaconSeen) {
    // Not a SPEC §3.2 table row: a beacon with no placement and no ad UI cannot
    // distinguish an in-player impression from unrelated ad traffic. Never ADS_SERVED;
    // kept as a distinct NO_SIGNAL cause because a systematic rise in beacon-only
    // sessions is an early indicator of an SSAI rollout or a beacon-attribution bug.
    return finalize({ state: 'NO_SIGNAL', noSignalCause: 'anomalous-beacon-only' }, 0, context);
  }

  // Absence-of-evidence verdicts below this line are only meaningful for a calibrated
  // observer on a fresh watch (SPEC §3.2 row 3, invariant 5). Observer invalidity still
  // outranks recent-rewatch: an invalid observer's rewatch is primarily an invalid
  // observer, and calibration.ts's resolveObserverValidity has already resolved which
  // of the four ObserverInvalidCause values applies — classify() just relays it.
  if (!context.observerValidity.valid) {
    return finalize(
      { state: 'NO_SIGNAL', noSignalCause: context.observerValidity.cause },
      0,
      context,
    );
  }

  if (context.recentlyWatched) {
    // Rewatch frequency capping strips ad placements server-side (spike/RESULTS.md
    // §3.5): an absence of evidence on a rewatched video is NOT NO_ADS evidence.
    return finalize({ state: 'NO_SIGNAL', noSignalCause: 'recent-rewatch' }, 0, context);
  }

  return finalize({ state: 'NO_ADS' }, 0, context);
}
