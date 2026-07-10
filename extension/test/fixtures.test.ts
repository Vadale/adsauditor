/**
 * Fixture-driven classify() tests (docs/ROADMAP.md §1.5): drives classify() with REAL
 * captures from the Phase 0 spike (spike/exports/*.json), converted to DetectionEvent[]
 * in extension/test/fixtures/*.json. Each fixture's `_meta` field documents its source
 * export, the exact record timestamps used, and any real-schema-to-type-shape
 * conversions (e.g. offset strings -> numbers) — nothing here fabricates ad evidence
 * that wasn't actually captured; see spike/RESULTS.md §2 for the human-readable summary
 * this file cross-checks against.
 *
 * classifier.test.ts already covers the SPEC §3.2 table with hand-built synthetic
 * events; this file is the real-data check ROADMAP §1.5 calls for on top of that.
 *
 * Deterministic: fixture timestamps are the real, fixed epoch-ms values captured during
 * the spike (no Date.now(), no live network — CLAUDE.md, docs/ROADMAP.md §1.5).
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../utils/classifier';
import { isDomAdEventShape, isPlayerResponseEventShape } from '../utils/types';
import type { ClassifierContext, DetectionEvent } from '../utils/types';

import greenMrBeast35mRaw from './fixtures/green-mrbeast-iYlODtkyw_I.json';
import greenMrBeast32mRaw from './fixtures/green-mrbeast-__fmDj0ZJ1Q.json';
import yellowElisaRaw from './fixtures/yellow-class-elisa-kZwWv_2SDgU.json';
import rewatchStrippedRaw from './fixtures/rewatch-stripped-iYlODtkyw_I.json';
import specialAgeRestrictedRaw from './fixtures/special-age-restricted-JM1G0BXHQyU.json';
import specialNonYppRaw from './fixtures/special-nonypp-iwW3qjvkFZE.json';

/**
 * Fixture JSON shape: a `_meta` documentation block (source export, record timestamps,
 * conversion notes — see each fixture file) alongside the real DetectionEvent[] it
 * converts to. Test-local only, not a production type.
 */
interface Fixture {
  _meta: Record<string, unknown>;
  events: DetectionEvent[];
}

/**
 * Validates every fixture event against the SAME runtime shape guards background.ts
 * applies at the content -> background message boundary (utils/types.ts's
 * isPlayerResponseEventShape / isDomAdEventShape — ROADMAP §1.2 review round). Without
 * this, a fixture with a malformed/drifted event (e.g. a hand-edit that leaves a field
 * the wrong type) could still silently reach classify() and pass — bypassing the exact
 * validation the real message boundary enforces, defeating the point of these being
 * REAL, pipeline-representative captures.
 *
 * There is no isBeaconEventShape guard in utils/types.ts: BeaconEvent never crosses the
 * postMessage/runtime-message boundary those guards protect (background.ts's own
 * webRequest listener builds it directly — see background.ts's onBeforeRequest handler).
 * None of these fixtures contain a BEACON event (the Phase 0 spike tool never captured
 * source C — see fixtures/README.md), so rather than silently skip BEACON events for
 * lack of a guard, this asserts that expectation explicitly: a BEACON event appearing in
 * a fixture fails loudly instead of passing unvalidated.
 */
function assertValidFixtureEvents(events: DetectionEvent[], fixtureName: string): void {
  events.forEach((event, index) => {
    if (event.source === 'PLAYER_RESPONSE') {
      if (!isPlayerResponseEventShape(event)) {
        throw new Error(
          `${fixtureName}: events[${index}] (PLAYER_RESPONSE) fails isPlayerResponseEventShape — ` +
            'a fixture the real message boundary would reject cannot silently pass classify() tests.',
        );
      }
    } else if (event.source === 'DOM') {
      if (!isDomAdEventShape(event)) {
        throw new Error(
          `${fixtureName}: events[${index}] (DOM) fails isDomAdEventShape — ` +
            'a fixture the real message boundary would reject cannot silently pass classify() tests.',
        );
      }
    } else {
      // Covers 'BEACON' and anything else: no shape guard exists for BeaconEvent, and no
      // fixture in this suite is expected to contain one (see this function's doc
      // comment) — fail loudly rather than let it through unvalidated.
      throw new Error(
        `${fixtureName}: events[${index}] has source '${event.source}', which no fixture in ` +
          'this suite is expected to contain (no shape guard exists for it) — remove it or add ' +
          'explicit validation before trusting it.',
      );
    }
  });
}

function toFixture(raw: unknown, fixtureName: string): Fixture {
  const fixture = raw as Fixture;
  assertValidFixtureEvents(fixture.events, fixtureName);
  return fixture;
}

const greenMrBeast35m = toFixture(greenMrBeast35mRaw, 'green-mrbeast-iYlODtkyw_I.json');
const greenMrBeast32m = toFixture(greenMrBeast32mRaw, 'green-mrbeast-__fmDj0ZJ1Q.json');
const yellowElisa = toFixture(yellowElisaRaw, 'yellow-class-elisa-kZwWv_2SDgU.json');
const rewatchStripped = toFixture(rewatchStrippedRaw, 'rewatch-stripped-iYlODtkyw_I.json');
const specialAgeRestricted = toFixture(
  specialAgeRestrictedRaw,
  'special-age-restricted-JM1G0BXHQyU.json',
);
const specialNonYpp = toFixture(specialNonYppRaw, 'special-nonypp-iwW3qjvkFZE.json');

describe('fixtures — every real event validates against the real message-boundary shape guards', () => {
  it('loaded without throwing (assertValidFixtureEvents ran for all 6 fixtures above)', () => {
    // If any fixture's events failed isPlayerResponseEventShape/isDomAdEventShape, or
    // contained a BEACON event, toFixture() above would have thrown during module load
    // and this entire test file would fail to even start — this assertion just gives
    // that outcome a named, visible test rather than a bare import-time crash.
    expect(
      [
        greenMrBeast35m,
        greenMrBeast32m,
        yellowElisa,
        rewatchStripped,
        specialAgeRestricted,
        specialNonYpp,
      ].every((fixture) => fixture.events.length > 0),
    ).toBe(true);
  });
});

/**
 * Builds a ClassifierContext the same way background.ts's buildClassifierContext does
 * (durationS/isLive/isLoggedIn from the fixture's own latest player-response event) —
 * never hand-picked separately from the real capture, so the context can't silently
 * drift from what the fixture actually contains. Only observerValidity/recentlyWatched
 * are scenario-controlled overrides: calibration is LOCAL, per-browser state, never part
 * of any capture (see ClassifierContext's doc comment in utils/types.ts), so a fixture
 * has no "real" value for them — each test picks the scenario it wants to exercise.
 */
function contextFromFixture(
  fixture: Fixture,
  overrides: Partial<Pick<ClassifierContext, 'observerValidity' | 'recentlyWatched'>> = {},
): ClassifierContext {
  const playerResponses = fixture.events.filter(
    (event): event is Extract<DetectionEvent, { source: 'PLAYER_RESPONSE' }> =>
      event.source === 'PLAYER_RESPONSE',
  );
  const latest = playerResponses.length > 0 ? playerResponses[playerResponses.length - 1] : null;
  return {
    durationS: latest?.durationSeconds ?? 0,
    isLive: latest?.isLiveContent ?? false,
    isLoggedIn: latest?.isLoggedIn ?? false,
    countryHint: null,
    extensionVersion: '0.0.0-test',
    observerValidity: { valid: true },
    recentlyWatched: false,
    ...overrides,
  };
}

describe('classify — real spike captures (green signature, ROADMAP §1.5)', () => {
  it('iYlODtkyw_I logged-out fresh watch → ADS_SERVED 1 preroll/18 midroll/1 postroll (RESULTS.md §2 row 1)', () => {
    const result = classify(greenMrBeast35m.events, contextFromFixture(greenMrBeast35m));
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence).toMatchObject({
      preroll: true,
      midrolls: 18,
      postroll: true,
      ssaiAnomalySuspected: false,
    });
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE', 'DOM']);
    expect(result.midrollPlacementCount).toBe(18);
    expect(result.videoDurationS).toBe(2104);
  });

  it('__fmDj0ZJ1Q: reload drops the preroll placement, but union across responses preserves it (RESULTS.md §2 row 3)', () => {
    const result = classify(greenMrBeast32m.events, contextFromFixture(greenMrBeast32m));
    expect(result.state).toBe('ADS_SERVED');
    expect(result.evidence).toMatchObject({
      preroll: true, // unioned: present on the FIRST read, gone on the reload
      midrolls: 14, // latest placement-bearing read
      postroll: true,
      ssaiAnomalySuspected: false,
    });
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE', 'DOM']);
    expect(result.midrollPlacementCount).toBe(14);
  });
});

describe('classify — real spike capture (candidate yellow/limited signature, uncalibrated)', () => {
  it('kZwWv_2SDgU (Elisa True Crime, 138 min): ADS_SERVED with the observed detail only, never a "yellow" verdict', () => {
    const result = classify(yellowElisa.events, contextFromFixture(yellowElisa));
    expect(result.state).toBe('ADS_SERVED');
    // The client reports facts, never the inferred green/yellow label (SPEC §1.1, §3.3):
    // there is no 'LIMITED' or 'yellow' field anywhere on ClassificationResult to assert.
    expect(result.evidence).toMatchObject({
      preroll: false,
      midrolls: 5,
      postroll: true,
      ssaiAnomalySuspected: false,
    });
    expect(result.evidence?.sources).toEqual(['PLAYER_RESPONSE', 'DOM']);
    expect(result.videoDurationS).toBe(8271);
    // RESULTS.md §3 finding 4: "midroll density 0.036/min (≈12x sparser than greens)".
    expect(result.midrollDensityPerMinute).toBeCloseTo(0.036, 2);
  });
});

describe('classify — real spike capture (rewatch-frequency capping, invariant 5)', () => {
  it('same green video, rewatched: recentlyWatched=true → NO_SIGNAL recent-rewatch, NEVER NO_ADS', () => {
    const result = classify(
      rewatchStripped.events,
      contextFromFixture(rewatchStripped, { recentlyWatched: true }),
    );
    expect(result.state).toBe('NO_SIGNAL');
    expect(result.noSignalCause).toBe('recent-rewatch');
    expect(result.state).not.toBe('NO_ADS');
  });

  it('the SAME zero-evidence events, recentlyWatched=false + valid observer → NO_ADS (why the rewatch flag matters)', () => {
    const result = classify(
      rewatchStripped.events,
      contextFromFixture(rewatchStripped, { recentlyWatched: false }),
    );
    expect(result.state).toBe('NO_ADS');
  });
});

describe('classify — real spike captures (specials)', () => {
  it('JM1G0BXHQyU (age-restricted trailer, logged-in adult, real playabilityStatus OK): valid fresh observer → NO_ADS', () => {
    // No logged-out capture of this video exists in any spike export (see this fixture's
    // _meta note): the real data never carried a non-OK playabilityStatus for it, so
    // this test does not assert an UNAVAILABLE branch for it — that would fabricate
    // evidence the spike never captured. Generic playabilityStatus !== 'OK' -> UNAVAILABLE
    // coverage already exists in classifier.test.ts with synthetic data.
    const result = classify(specialAgeRestricted.events, contextFromFixture(specialAgeRestricted));
    expect(result.state).toBe('NO_ADS');
  });

  it('iwW3qjvkFZE (channel removed from YPP, real playabilityStatus OK): valid fresh observer → NO_ADS', () => {
    const result = classify(specialNonYpp.events, contextFromFixture(specialNonYpp));
    expect(result.state).toBe('NO_ADS');
  });
});
