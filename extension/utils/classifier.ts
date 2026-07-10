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
 * Anomaly path (SPEC §3.2 table row 4): source A gave us nothing, so type each DOM
 * ad-start event as preroll/midroll/postroll using its content-time sample instead.
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

  if (starts.length === 0 && domAdEvents.length > 0) {
    // Badge sightings with no start transition: the "ad already showing when the
    // observer attached" gap the Phase 0 spike documented (bridge.content.ts's
    // attach-time classList read closes this going forward, but this defends against
    // any session that still hits it — e.g. a dropped start message). Attach happens
    // early in the page/session lifecycle, so an already-showing ad at that moment is
    // overwhelmingly likely to be the preroll.
    preroll = true;
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
 * "A absent, B not seen, C seen" is NOT a row in the table: a beacon alone (no
 * placement, no ad UI) cannot distinguish an in-player impression from unrelated ad
 * traffic, so it never produces ADS_SERVED — it becomes NO_SIGNAL
 * ('anomalous-beacon-only'), preserved for diagnostics.
 *
 * Observer validity (SPEC §3.2 row 3) gates ONLY the NO_ADS verdict: positive
 * placement/DOM evidence is trustworthy regardless of calibration — an observed
 * placement cannot be an adblock artifact (invariant 5 concerns false NO_ADS, not
 * false ADS_SERVED).
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
  const domAdSeen = domAdEvents.length > 0;
  const beaconSeen = events.some(isBeaconEvent);

  if (placementsPresent) {
    const latestCounts = perEventCounts[perEventCounts.length - 1];
    const preroll = perEventCounts.some((counts) => counts.preroll);
    const midrolls = latestCounts.midrolls;
    const postroll = perEventCounts.some((counts) => counts.postroll);
    const sources: EvidenceSource[] = ['PLAYER_RESPONSE'];
    if (domAdSeen) sources.push('DOM');
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

  if (domAdSeen) {
    // SPEC §3.2 table row 4: placements absent but the ad UI was observed — likely
    // SSAI or a player-response format change. B evidence takes precedence over A's
    // silence (C may corroborate).
    const { preroll, midrolls, postroll } = typeDomEventsByContentTime(
      domAdEvents,
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
