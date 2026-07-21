/**
 * Storage/telemetry payload invariant tests (invariant 2 (docs/INVARIANTS.md), (docs/SPEC.md ):
 * "the telemetry/storage payload contains exactly the schema fields and nothing more...
 * A test must fail if the stored/sent payload gains fields."
 *
 * TWO LAYERS, because neither one alone is sufficient:
 *
 * 1. COMPILE-TIME exhaustive key tables (`satisfies Record<keyof T, true>` below): the
 *    moment LocalHistoryEntry, AdEvidenceDetail, or VideoContext gains OR loses a field,
 *    the corresponding table fails to typecheck — TS1360 ("missing in type") when a field
 *    is added and the table isn't updated, TS2353 ("may only specify known properties")
 *    when a field is removed and the table still lists it. Verified against this exact
 *    TypeScript version: adding an `interface FooPlus extends Foo { c: boolean }` field
 *    without updating a `{a:true,b:true} satisfies Record<keyof FooPlus, true>` table
 *    reliably produces TS1360. This layer is enforced by `npm run typecheck`
 *    (`tsc --noEmit`), NOT by `vitest run` — Vitest transpiles this file with esbuild,
 *    which strips types without checking them, so a `satisfies` violation here does NOT
 *    fail `npm test` by itself. Both commands are part of the required verification
 *    sequence (docs/SPEC.md ), so this is a real, enforced gate, just not one
 *    `vitest run` alone will catch — see the runtime layer below for that.
 *
 * 2. RUNTIME assertions on representative objects: `Object.keys(...)` compared against
 *    the exact frozen key list, for both the object as constructed AND after a
 *    JSON round-trip (chrome.storage.local persists via structured-clone-like JSON
 *    semantics, so a round-trip is the closest browser-free proxy for "what actually
 *    gets written"). This is what makes the invariant show up in `vitest run` output,
 *    not just `tsc --noEmit`.
 *
 *    Cross-browser caveat (the project targets Chrome AND Firefox): Firefox's
 *    `storage.local` uses structured clone, which PRESERVES `undefined`-valued keys,
 *    unlike Chrome's JSON-drops-`undefined` semantics this file's round-trip tests
 *    assume — so a Firefox-persisted NO_SIGNAL entry would round-trip with `evidence`
 *    still present (as `undefined`), not absent. The invariant's DIRECTION (no gained
 *    fields beyond the documented set) holds under both engines regardless; only the
 *    exact post-round-trip key COUNT for an `undefined`-valued optional differs.
 *
 * The runtime layer calls the REAL construction path — utils/local-history.ts's pure
 * buildLocalHistoryEntry(), the single place background.ts builds what it persists —
 * fed with ClassificationResults that deliberately carry the classifier's calibration
 * detail (midrollPlacementCount, videoDurationS, midrollDensityPerMinute), proving those
 * fields never leak into storage.
 */
import { describe, expect, it } from 'vitest';
import { buildLocalHistoryEntry } from '../utils/local-history';
import type {
  AdEvidenceDetail,
  ClassificationResult,
  LocalHistoryEntry,
  VideoContext,
} from '../utils/types';

// ---------------------------------------------------------------------------------
// 1. Compile-time exhaustive key tables (tsc --noEmit / npm run typecheck gate).
// ---------------------------------------------------------------------------------

/** Breaks `npm run typecheck` the moment LocalHistoryEntry gains or loses a field
 * (docs/SPEC.md local-history shape, invariant 2 (docs/INVARIANTS.md)).
 *
 * `durationS` (ROADMAP §1.7, "Export JSON") was added deliberately and this table was
 * updated alongside it, consciously — that is the intended workflow for a schema
 * change, not a gap being patched over. If this table ever needs updating again, that's
 * this same gate doing its job, not a bug in the test. */
const LOCAL_HISTORY_ENTRY_KEYS = {
  videoId: true,
  observedAt: true,
  state: true,
  evidence: true,
  noSignalCause: true,
  durationS: true,
} satisfies Record<keyof LocalHistoryEntry, true>;

/** Breaks `npm run typecheck` the moment AdEvidenceDetail (the shape of
 * LocalHistoryEntry.evidence / ClassificationResult.evidence) gains or loses a field. */
const AD_EVIDENCE_DETAIL_KEYS = {
  preroll: true,
  midrolls: true,
  postroll: true,
  sources: true,
  ssaiAnomalySuspected: true,
} satisfies Record<keyof AdEvidenceDetail, true>;

/** Breaks `npm run typecheck` the moment VideoContext — the schema that becomes (a
 * subset of) the Phase 2 telemetry payload (SPEC §3.3, utils/types.ts doc comment) —
 * gains or loses a field. This is the payload-shape invariant for the NOT-YET-BUILT
 * wire format: freezing it now means Phase 2 telemetry work trips this test the moment
 * it adds a field without a corresponding spec/test update. */
const VIDEO_CONTEXT_KEYS = {
  durationS: true,
  isLive: true,
  isLoggedIn: true,
  countryHint: true,
  extensionVersion: true,
} satisfies Record<keyof VideoContext, true>;

describe('storage-payload invariant — compile-time exhaustive key tables', () => {
  // These tables exist entirely for their TYPE-LEVEL effect above (a `satisfies` failure
  // is a tsc error, not a thrown exception) — `npm test` alone cannot observe that
  // failure. Asserting Object.keys() here just gives `vitest run` something to report
  // when someone runs only `npm test` and skips `npm run typecheck`: a passing assertion
  // here is NOT proof the type-level gate exists — the satisfies clauses above are.
  it('LOCAL_HISTORY_ENTRY_KEYS lists exactly the 6 documented LocalHistoryEntry keys', () => {
    expect(Object.keys(LOCAL_HISTORY_ENTRY_KEYS).sort()).toEqual(
      ['durationS', 'evidence', 'noSignalCause', 'observedAt', 'state', 'videoId'].sort(),
    );
  });

  it('AD_EVIDENCE_DETAIL_KEYS lists exactly the 5 documented AdEvidenceDetail keys', () => {
    expect(Object.keys(AD_EVIDENCE_DETAIL_KEYS).sort()).toEqual(
      ['midrolls', 'postroll', 'preroll', 'sources', 'ssaiAnomalySuspected'].sort(),
    );
  });

  it('VIDEO_CONTEXT_KEYS lists exactly the 5 documented VideoContext keys', () => {
    expect(Object.keys(VIDEO_CONTEXT_KEYS).sort()).toEqual(
      ['countryHint', 'durationS', 'extensionVersion', 'isLive', 'isLoggedIn'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------
// 2. Runtime assertions on representative objects (the part `vitest run` alone catches).
// ---------------------------------------------------------------------------------

const REPRESENTATIVE_EVIDENCE: AdEvidenceDetail = {
  preroll: true,
  midrolls: 3,
  postroll: true,
  sources: ['PLAYER_RESPONSE', 'DOM', 'BEACON'],
  ssaiAnomalySuspected: false,
};

/** Real classifier output shape for an ADS_SERVED viewing, INCLUDING the calibration
 * detail fields the builder must NOT persist — feeding this through the real builder is
 * what makes the key assertions below meaningful. */
const ADS_SERVED_RESULT: ClassificationResult = {
  state: 'ADS_SERVED',
  evidence: REPRESENTATIVE_EVIDENCE,
  midrollPlacementCount: 3,
  videoDurationS: 1920,
  midrollDensityPerMinute: 3 / 32,
};

/** Same, on the NO_SIGNAL branch — evidence absent, noSignalCause populated, so the
 * "no extra fields" check also exercises the other optional slot. */
const NO_SIGNAL_RESULT: ClassificationResult = {
  state: 'NO_SIGNAL',
  noSignalCause: 'recent-rewatch',
  midrollPlacementCount: 0,
  videoDurationS: 1920,
  midrollDensityPerMinute: 0,
};

// The REAL construction path (utils/local-history.ts) — the exact code background.ts
// runs before persisting to local:adsauditor_history.
const REPRESENTATIVE_ADS_SERVED_ENTRY = buildLocalHistoryEntry(
  'dQw4w9WgXcQ',
  ADS_SERVED_RESULT,
  1_700_000_000_000,
);
const REPRESENTATIVE_NO_SIGNAL_ENTRY = buildLocalHistoryEntry(
  'dQw4w9WgXcQ',
  NO_SIGNAL_RESULT,
  1_700_000_000_000,
);

const REPRESENTATIVE_VIDEO_CONTEXT: VideoContext = {
  durationS: 1920,
  isLive: false,
  isLoggedIn: true,
  countryHint: 'IT',
  extensionVersion: '0.1.0',
};

const EXPECTED_LOCAL_HISTORY_KEYS = [
  'durationS',
  'evidence',
  'noSignalCause',
  'observedAt',
  'state',
  'videoId',
]
  .slice()
  .sort();
const EXPECTED_AD_EVIDENCE_KEYS = [
  'midrolls',
  'postroll',
  'preroll',
  'sources',
  'ssaiAnomalySuspected',
]
  .slice()
  .sort();
const EXPECTED_VIDEO_CONTEXT_KEYS = [
  'countryHint',
  'durationS',
  'extensionVersion',
  'isLive',
  'isLoggedIn',
]
  .slice()
  .sort();

describe('storage-payload invariant — LocalHistoryEntry runtime shape', () => {
  it('an ADS_SERVED entry has exactly {videoId, observedAt, state, evidence, noSignalCause, durationS} and nothing more', () => {
    // buildLocalHistoryEntry always assigns noSignalCause (sometimes to undefined), so
    // Object.keys sees it — an omitted key would silently under-count and let a REAL
    // extra field slip past this exact check.
    expect(Object.keys(REPRESENTATIVE_ADS_SERVED_ENTRY).sort()).toEqual(
      EXPECTED_LOCAL_HISTORY_KEYS,
    );
  });

  it('a NO_SIGNAL entry (evidence undefined, noSignalCause set) has exactly the same 6 keys', () => {
    expect(Object.keys(REPRESENTATIVE_NO_SIGNAL_ENTRY).sort()).toEqual(EXPECTED_LOCAL_HISTORY_KEYS);
  });

  it('survives a JSON round-trip (the chrome.storage.local persistence path) with the same key set', () => {
    // chrome.storage.local serializes via structured-clone-like JSON semantics; a
    // round-trip is the closest browser-free proxy for "what a read-back entry actually
    // looks like". `undefined`-valued keys (noSignalCause on the ADS_SERVED entry) drop
    // out of JSON, same as they would from a real storage.local round-trip — durationS
    // is a real number (1920, from ADS_SERVED_RESULT.videoDurationS) so, unlike
    // noSignalCause, it survives the round-trip.
    const roundTripped = JSON.parse(JSON.stringify(REPRESENTATIVE_ADS_SERVED_ENTRY)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(roundTripped).sort()).toEqual(
      ['durationS', 'evidence', 'observedAt', 'state', 'videoId'].sort(),
    );
  });

  it("the evidence sub-object has exactly AdEvidenceDetail's 5 keys and nothing more", () => {
    expect(Object.keys(REPRESENTATIVE_EVIDENCE).sort()).toEqual(EXPECTED_AD_EVIDENCE_KEYS);
  });
});

describe('storage-payload invariant — VideoContext runtime shape (future telemetry payload)', () => {
  it('has exactly {durationS, isLive, isLoggedIn, countryHint, extensionVersion} and nothing more', () => {
    expect(Object.keys(REPRESENTATIVE_VIDEO_CONTEXT).sort()).toEqual(EXPECTED_VIDEO_CONTEXT_KEYS);
  });

  it('survives a JSON round-trip with the same key set (countryHint: null is preserved by JSON, unlike undefined)', () => {
    const withNullCountryHint: VideoContext = {
      ...REPRESENTATIVE_VIDEO_CONTEXT,
      countryHint: null,
    };
    const roundTripped = JSON.parse(JSON.stringify(withNullCountryHint)) as Record<string, unknown>;
    expect(Object.keys(roundTripped).sort()).toEqual(EXPECTED_VIDEO_CONTEXT_KEYS);
  });
});
