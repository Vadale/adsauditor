/**
 * buildLocalExport() invariant tests (docs/SPEC.md , invariant 2 (docs/INVARIANTS.md) spirit):
 * this payload is explicitly SHAREABLE — the owner/beta testers hand this file to the dev
 * loop manually (utils/local-export.ts's own doc comment) — so its schema is locked the
 * same invariant-style way test/storage-payload.test.ts locks LocalHistoryEntry/
 * VideoContext: a compile-time exhaustive key table PLUS runtime Object.keys assertions.
 *
 * Same two-layer reasoning as storage-payload.test.ts: the `satisfies` table below is a
 * `tsc --noEmit` (npm run typecheck) gate, not something `vitest run` observes by itself;
 * the runtime assertions are what make `npm test` alone catch a schema drift.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_CALIBRATION_STATE } from '../utils/calibration';
import type { CalibrationState } from '../utils/calibration';
import { buildLocalHistoryEntry } from '../utils/local-history';
import { buildLocalExport } from '../utils/local-export';
import type { ClassificationResult, LocalHistoryEntry } from '../utils/types';

// ---------------------------------------------------------------------------------
// 1. Compile-time exhaustive key table (tsc --noEmit / npm run typecheck gate).
// ---------------------------------------------------------------------------------

/** Breaks `npm run typecheck` the moment buildLocalExport's return shape gains or loses
 * a field. utils/local-export.ts's own doc comment requires a schemaVersion bump on any
 * change here — this table is the mechanical enforcement of that rule. */
const LOCAL_EXPORT_KEYS = {
  format: true,
  schemaVersion: true,
  extensionVersion: true,
  exportedAt: true,
  calibration: true,
  history: true,
} satisfies Record<keyof ReturnType<typeof buildLocalExport>, true>;

describe('buildLocalExport invariant — compile-time exhaustive key table', () => {
  // Same caveat as storage-payload.test.ts: this assertion just gives `vitest run`
  // something to report; the real gate is the `satisfies` clause above, enforced by
  // `npm run typecheck`, not by this thrown-or-not assertion.
  it('LOCAL_EXPORT_KEYS lists exactly the 6 documented LocalExport keys', () => {
    expect(Object.keys(LOCAL_EXPORT_KEYS).sort()).toEqual(
      [
        'calibration',
        'exportedAt',
        'extensionVersion',
        'format',
        'history',
        'schemaVersion',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------
// 2. Runtime assertions (the part `vitest run` alone catches).
// ---------------------------------------------------------------------------------

const EXPORTED_AT_MS = 1_700_000_000_000;
const EXTENSION_VERSION = '0.1.0';

const REPRESENTATIVE_HISTORY: LocalHistoryEntry[] = [
  {
    videoId: 'dQw4w9WgXcQ',
    observedAt: 1_699_999_000_000,
    state: 'ADS_SERVED',
    evidence: {
      preroll: true,
      midrolls: 3,
      postroll: true,
      sources: ['PLAYER_RESPONSE', 'DOM'],
      ssaiAnomalySuspected: false,
    },
    noSignalCause: undefined,
    durationS: 1920,
  },
];

const REPRESENTATIVE_CALIBRATION: CalibrationState = {
  ...EMPTY_CALIBRATION_STATE,
  lastPositiveEvidenceAt: 1_699_999_000_000,
};

describe('buildLocalExport invariant — runtime shape and values', () => {
  it("format is the literal 'adsauditor-local-export' (hardcoded here, not the imported constant, to actually pin the value)", () => {
    const result = buildLocalExport(
      REPRESENTATIVE_HISTORY,
      REPRESENTATIVE_CALIBRATION,
      EXTENSION_VERSION,
      EXPORTED_AT_MS,
    );
    expect(result.format).toBe('adsauditor-local-export');
  });

  it('schemaVersion is the literal 1', () => {
    const result = buildLocalExport(
      REPRESENTATIVE_HISTORY,
      REPRESENTATIVE_CALIBRATION,
      EXTENSION_VERSION,
      EXPORTED_AT_MS,
    );
    expect(result.schemaVersion).toBe(1);
  });

  it('exportedAt is the exact ISO-8601 string for the given ms', () => {
    const result = buildLocalExport(
      REPRESENTATIVE_HISTORY,
      REPRESENTATIVE_CALIBRATION,
      EXTENSION_VERSION,
      EXPORTED_AT_MS,
    );
    expect(result.exportedAt).toBe(new Date(EXPORTED_AT_MS).toISOString());
  });

  it('has exactly the 6 documented keys and nothing more', () => {
    const result = buildLocalExport(
      REPRESENTATIVE_HISTORY,
      REPRESENTATIVE_CALIBRATION,
      EXTENSION_VERSION,
      EXPORTED_AT_MS,
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        'calibration',
        'exportedAt',
        'extensionVersion',
        'format',
        'history',
        'schemaVersion',
      ].sort(),
    );
  });

  it('passes history and calibration through by reference, without mutating either', () => {
    const historyArg: LocalHistoryEntry[] = [...REPRESENTATIVE_HISTORY];
    const calibrationArg: CalibrationState = { ...REPRESENTATIVE_CALIBRATION };
    const historySnapshot = JSON.parse(JSON.stringify(historyArg)) as unknown;
    const calibrationSnapshot = JSON.parse(JSON.stringify(calibrationArg)) as unknown;

    const result = buildLocalExport(historyArg, calibrationArg, EXTENSION_VERSION, EXPORTED_AT_MS);

    // Same reference, not a copy — buildLocalExport is a plain pass-through for these two.
    expect(result.history).toBe(historyArg);
    expect(result.calibration).toBe(calibrationArg);
    // And genuinely untouched, not just re-attached.
    expect(JSON.parse(JSON.stringify(historyArg))).toEqual(historySnapshot);
    expect(JSON.parse(JSON.stringify(calibrationArg))).toEqual(calibrationSnapshot);
  });

  it('a history entry built via buildLocalHistoryEntry retains durationS in the export, and a JSON round-trip keeps only the documented keys', () => {
    const classificationResult: ClassificationResult = {
      state: 'ADS_SERVED',
      evidence: {
        preroll: true,
        midrolls: 2,
        postroll: false,
        sources: ['PLAYER_RESPONSE'],
        ssaiAnomalySuspected: false,
      },
      // Calibration-only detail (ROADMAP §1.2) — must never leak into the export, same
      // invariant test/storage-payload.test.ts enforces for LocalHistoryEntry alone.
      midrollPlacementCount: 2,
      videoDurationS: 1234,
      midrollDensityPerMinute: 2 / (1234 / 60),
    };
    const historyEntry = buildLocalHistoryEntry(
      'dQw4w9WgXcQ',
      classificationResult,
      1_699_999_000_000,
    );

    const result = buildLocalExport(
      [historyEntry],
      REPRESENTATIVE_CALIBRATION,
      EXTENSION_VERSION,
      EXPORTED_AT_MS,
    );

    expect(result.history[0].durationS).toBe(1234);

    const roundTripped = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(Object.keys(roundTripped).sort()).toEqual(
      [
        'calibration',
        'exportedAt',
        'extensionVersion',
        'format',
        'history',
        'schemaVersion',
      ].sort(),
    );
    // noSignalCause is undefined on an ADS_SERVED entry, so JSON drops it — same
    // documented behavior as test/storage-payload.test.ts's ADS_SERVED round-trip case.
    const roundTrippedHistory = roundTripped.history as Record<string, unknown>[];
    expect(Object.keys(roundTrippedHistory[0]).sort()).toEqual(
      ['durationS', 'evidence', 'observedAt', 'state', 'videoId'].sort(),
    );
    expect(roundTrippedHistory[0].durationS).toBe(1234);
  });
});
