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
    observerValid: true,
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

  it('absence with an invalid observer → NO_SIGNAL observer-invalid, never NO_ADS', () => {
    const result = classify([playerResponse()], context({ observerValid: false }));
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('observer-invalid');
  });

  it('positive placements still classify ADS_SERVED even for an invalid observer', () => {
    const result = classify(
      [playerResponse({ adPlacements: greenPlacements(2) })],
      context({ observerValid: false }),
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

  it('badge-only DOM evidence (ad already showing at attach) → anomaly preroll', () => {
    const result = classify([playerResponse(), domEvent('ad-badge-seen', 0)], context());
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence).toMatchObject({ preroll: true, ssaiAnomalySuspected: true });
  });
});
