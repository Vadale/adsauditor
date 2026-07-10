/**
 * classify() unit tests: one case per row of the SPEC §3.2 cross-reference table, plus
 * the NO_SIGNAL discipline cases (invariant 5) and the regression cases from the
 * §1.2 review (placement-count multiplication, paired DOM start double-count).
 *
 * Placement `kind` strings are the literal field-verified YouTube values (Phase 0
 * spike), intentionally not imported from selectors.ts: if the constants there drift,
 * these tests must fail.
 *
 * Fixture-driven tests against the raw spike exports land in ROADMAP §1.5.
 *
 * The last describe block ("field bug 2026-07-11") encodes the AGREED FIX for an
 * owner-reported bug and is EXPECTED TO FAIL against the current classifier.ts — see
 * that block's own comment and test/fixtures/field-badge-scaffolding-I3oUjpmda7g.json.
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../utils/classifier';
import type {
  AdPlacementItem,
  BeaconEvent,
  ClassifierContext,
  DomAdEvent,
  DomAdEventKind,
  PlayerResponseEvent,
} from '../utils/types';

const VIDEO_ID = 'dQw4w9WgXcQ';

function placement(kind: string, offsetStartMs: number | null = null): AdPlacementItem {
  return { kind, offsetStartMs, offsetEndMs: null };
}

/** 1 preroll + `midrolls` midrolls + 1 postroll, the green signature from the spike. */
function greenPlacements(midrolls: number): AdPlacementItem[] {
  return [
    placement('AD_PLACEMENT_KIND_START'),
    ...Array.from({ length: midrolls }, (_, i) =>
      placement('AD_PLACEMENT_KIND_MILLISECONDS', (i + 1) * 120_000),
    ),
    placement('AD_PLACEMENT_KIND_END'),
  ];
}

function playerResponse(overrides: Partial<PlayerResponseEvent> = {}): PlayerResponseEvent {
  return {
    source: 'PLAYER_RESPONSE',
    capturePath: 'initial',
    pageVideoId: VIDEO_ID,
    videoId: VIDEO_ID,
    durationSeconds: 1920,
    playabilityStatus: 'OK',
    isLiveContent: false,
    isLoggedIn: true,
    adPlacements: [],
    adSlots: [],
    playerAds: [],
    capturedAt: 1_000,
    ...overrides,
  };
}

function domEvent(kind: DomAdEventKind, contentTimeSeconds: number | null): DomAdEvent {
  return { source: 'DOM', kind, watchUrlVideoId: VIDEO_ID, contentTimeSeconds, capturedAt: 2_000 };
}

function beacon(): BeaconEvent {
  return { source: 'BEACON', kind: 'STATS_ADS', capturedAt: 3_000 };
}

function context(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    durationS: 1920,
    isLive: false,
    isLoggedIn: true,
    countryHint: null,
    extensionVersion: '0.0.0-test',
    observerValidity: { valid: true },
    recentlyWatched: false,
    ...overrides,
  };
}

describe('classify — SPEC §3.2 cross-reference table', () => {
  it('row 1: placements + DOM + beacon → ADS_SERVED with all three sources', () => {
    const result = classify(
      [
        playerResponse({ adPlacements: greenPlacements(14) }),
        domEvent('ad-showing-start', 0),
        beacon(),
      ],
      context(),
    );
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence).toMatchObject({
      preroll: true,
      midrolls: 14,
      postroll: true,
      ssaiAnomalySuspected: false,
    });
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE', 'DOM', 'BEACON']);
  });

  it('row 2: placements only (short viewing, no ad played) → ADS_SERVED', () => {
    const result = classify([playerResponse({ adPlacements: greenPlacements(3) })], context());
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE']);
    expect(result.evidence?.ssaiAnomalySuspected).toBe(false);
  });

  it('row 3: no placements, no DOM, no beacon, valid fresh observer → NO_ADS', () => {
    const result = classify([playerResponse()], context());
    expect(result.state).toBe('NO_ADS');
  });

  it('row 4 (anomaly): no placements but DOM saw ads → ADS_SERVED flagged as SSAI-suspect', () => {
    const result = classify(
      [
        playerResponse(),
        domEvent('ad-showing-start', 0),
        domEvent('ad-showing-start', 700),
        beacon(),
      ],
      context(),
    );
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence).toMatchObject({
      preroll: true,
      midrolls: 1,
      ssaiAnomalySuspected: true,
    });
    expect(result.evidence?.sources).toEqual(['DOM', 'BEACON']);
  });

  it('row 5 (blocked/failed): no player response at all → NO_SIGNAL', () => {
    const result = classify([], context());
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('no-player-response');
  });

  it('playabilityStatus !== OK → UNAVAILABLE', () => {
    const result = classify([playerResponse({ playabilityStatus: 'LOGIN_REQUIRED' })], context());
    expect(result.state).toBe('UNAVAILABLE');
  });
});

describe('classify — NO_SIGNAL discipline (invariant 5)', () => {
  it('absence on a recently rewatched video → NO_SIGNAL recent-rewatch, never NO_ADS', () => {
    const result = classify([playerResponse()], context({ recentlyWatched: true }));
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('recent-rewatch');
  });

  it.each([
    'adblock-suspected',
    'premium-suspected',
    'calibration-failed',
    'uncalibrated',
  ] as const)(
    'absence with an invalid observer (%s) → NO_SIGNAL with that exact cause, never NO_ADS',
    (cause) => {
      const result = classify(
        [playerResponse()],
        context({ observerValidity: { valid: false, cause } }),
      );
      expect(result.state).toBe('NO_SIGNAL');
      expect(result.noSignalCause).toBe(cause);
    },
  );

  it('an invalid observer cause wins over recent-rewatch (invalidity is ranked first)', () => {
    const result = classify(
      [playerResponse()],
      context({
        observerValidity: { valid: false, cause: 'uncalibrated' },
        recentlyWatched: true,
      }),
    );
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('uncalibrated');
  });

  it('positive placements still classify ADS_SERVED even for an invalid observer', () => {
    const result = classify(
      [playerResponse({ adPlacements: greenPlacements(2) })],
      context({ observerValidity: { valid: false, cause: 'uncalibrated' } }),
    );
    expect(result.state).toBe('ADS_SERVED');
  });

  it('beacon-only (no placements, no DOM) → NO_SIGNAL anomalous-beacon-only, never ADS_SERVED', () => {
    const result = classify([playerResponse(), beacon()], context());
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('anomalous-beacon-only');
  });
});

describe('classify — §1.2 review regressions', () => {
  it('multiple player responses for the same watch do not multiply midroll counts', () => {
    const events = [
      playerResponse({ capturePath: 'initial', adPlacements: greenPlacements(14) }),
      playerResponse({
        capturePath: 'fetch',
        adPlacements: greenPlacements(14),
        capturedAt: 1_100,
      }),
      playerResponse({
        capturePath: 'getPlayerResponse',
        adPlacements: greenPlacements(14),
        capturedAt: 1_200,
      }),
    ];
    const result = classify(events, context());
    expect(result.evidence?.midrolls).toBe(14);
    expect(result.midrollPlacementCount).toBe(14);
  });

  it('a refetch that drops the preroll keeps preroll=true (union) and takes the latest midroll count', () => {
    const events = [
      playerResponse({ adPlacements: greenPlacements(14) }),
      // Rewatch capping stripped the preroll on the refetch (spike RESULTS §3.5)
      playerResponse({
        capturePath: 'getPlayerResponse',
        adPlacements: greenPlacements(14).filter((p) => p.kind !== 'AD_PLACEMENT_KIND_START'),
        capturedAt: 1_500,
      }),
    ];
    const result = classify(events, context());
    expect(result.evidence?.preroll).toBe(true);
    expect(result.evidence?.midrolls).toBe(14);
  });

  it('paired ad-showing/ad-interrupting starts count as ONE ad break on the anomaly path', () => {
    const result = classify(
      [
        playerResponse(),
        // The pair fires with millisecond-identical timestamps (spike-verified)
        domEvent('ad-showing-start', 700),
        domEvent('ad-interrupting-start', 700),
      ],
      context(),
    );
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence?.midrolls).toBe(1);
  });

  it('an ad creative player response (videoId ≠ pageVideoId) never contributes placements', () => {
    const result = classify(
      [
        playerResponse(),
        playerResponse({ videoId: 'adCreative01', adPlacements: greenPlacements(5) }),
      ],
      context(),
    );
    expect(result.state).toBe('NO_ADS'); // creative's placements filtered out, absence stands
  });
});

/**
 * FIELD BUG (owner report, 2026-07-11): on two non-monetized videos (I3oUjpmda7g,
 * j61hDDHfphM — Elisa True Crime "uncensored" playlist; channel publicly states no
 * monetization, no ad played), the popup showed ADS_SERVED "Preroll: yes · 0
 * mid-roll(s)" with the SSAI-anomaly note. Diagnosis: a player response WAS captured
 * (playability OK, zero placements — truthful for a non-monetized video), but YouTube's
 * player DOM contains empty ytp-ad-* scaffolding elements even with no ad playing;
 * bridge.content.ts's 'ad-badge-seen' sightings matched that scaffolding, and the OLD
 * badge-only→preroll rule in classifier.ts's typeDomEventsByContentTime (source A
 * absent + any DOM event with no matching *-start ⇒ treat as a preroll) flipped the
 * verdict to ADS_SERVED via SPEC §3.2 row 4 — even though nothing was ever actually
 * shown to the viewer.
 *
 * AGREED FIX encoded below (NOT YET SHIPPED — see CLAUDE.md: every field bug becomes a
 * test fixture before it is fixed):
 *   1. "Strong" DOM evidence = any DomAdEventKind OTHER than 'ad-badge-seen' (the
 *      ad-showing/ad-interrupting class transitions, which only toggle during a real
 *      ad break). 'ad-badge-seen' alone is weak/ambient.
 *   2. Placements present → ADS_SERVED as before, but `sources` includes 'DOM' ONLY
 *      when strong DOM evidence exists — badge-only no longer contributes the DOM
 *      source (it was also silently inflating the §1.6 "playback observed" headline).
 *   3. A absent + strong DOM → ADS_SERVED with ssaiAnomalySuspected, unchanged (SPEC
 *      §3.2 row 4). The badge-only→preroll rule is REMOVED entirely: bridge.content.ts's
 *      attach-time classList priming already covers "ad already showing when the
 *      observer attached" with a synthesized real start event.
 *   4. A absent + badge sightings ONLY (no strong DOM), with or without a beacon → a
 *      NEW NoSignalCause, 'anomalous-ad-ui-only' — NEVER ADS_SERVED. Critically, this
 *      BLOCKS the NO_ADS fall-through even for an otherwise valid, fresh (non-rewatch)
 *      observer: an ambiguous ambient DOM signal proves neither presence nor absence of
 *      an ad, so a confident NO_ADS would be just as dishonest as the ADS_SERVED bug was.
 *   5. A absent + beacons only, no DOM at all → NO_SIGNAL 'anomalous-beacon-only',
 *      unchanged (already covered above in "NO_SIGNAL discipline").
 *
 * 'anomalous-ad-ui-only' does not exist on the NoSignalCause union in utils/types.ts yet
 * — deliberately not added here (production code is out of scope for a test-first field
 * bug fixture). Referencing it as a plain string literal below is intentional: it may or
 * may not satisfy `tsc --noEmit` depending on how strictly `toBe`'s generic narrows
 * against `NoSignalCause | undefined`, but it does NOT block `vitest run` either way —
 * Vitest transpiles test files via esbuild without type-checking them (the same
 * reasoning test/storage-payload.test.ts's header comment documents for its `satisfies`
 * gate), which is what lets these tests actually RUN and FAIL for the right reason
 * (current classifier.ts still returns ADS_SERVED) instead of being silently skipped.
 */
describe('classify — FIELD BUG 2026-07-11: ad-badge-seen scaffolding must not flip ADS_SERVED', () => {
  it('A absent + badge-only DOM, valid fresh observer → NO_SIGNAL anomalous-ad-ui-only (REPLACES the old "anomaly preroll" expectation — that was the bug)', () => {
    const result = classify([playerResponse(), domEvent('ad-badge-seen', 0)], context());
    expect(result.noSignalCause).toBe('anomalous-ad-ui-only');
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.state).not.toBe('ADS_SERVED');
    expect(result.state).not.toBe('NO_ADS');
  });

  it('A absent + badge-only DOM + a beacon, valid fresh observer → still NO_SIGNAL anomalous-ad-ui-only (badge-only blocks the fall-through even with a beacon present)', () => {
    const result = classify([playerResponse(), domEvent('ad-badge-seen', 0), beacon()], context());
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('anomalous-ad-ui-only');
  });

  it('placements present + badge-only DOM (no strong evidence) → ADS_SERVED, but sources EXCLUDE DOM', () => {
    const result = classify(
      [playerResponse({ adPlacements: greenPlacements(2) }), domEvent('ad-badge-seen', 0)],
      context(),
    );
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE']);
  });

  it('placements present + a real ad-showing-start → sources INCLUDE DOM (strong evidence still counts)', () => {
    const result = classify(
      [playerResponse({ adPlacements: greenPlacements(2) }), domEvent('ad-showing-start', 700)],
      context(),
    );
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE', 'DOM']);
  });

  it('A absent + a real ad-showing-start AND a badge sighting → still ADS_SERVED anomaly (strong evidence wins over ambient badge noise)', () => {
    const result = classify(
      [playerResponse(), domEvent('ad-showing-start', 700), domEvent('ad-badge-seen', 0)],
      context(),
    );
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence?.ssaiAnomalySuspected).toBe(true);
  });
});
