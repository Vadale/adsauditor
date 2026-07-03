import { describe, expect, it } from 'vitest';
import { classify } from '../utils/classifier';

/**
 * Placeholder so CI has something real to run against classifier.ts before the
 * detection engine lands (docs/ROADMAP.md §1.2). Real fixture-driven cases — one per
 * row of the SPEC §3.2 cross-reference table, plus the edge cases listed in ROADMAP
 * §1.5 — replace this file's content in that task; they must NOT be added here as an
 * afterthought once classify() exists.
 */
describe('classifier', () => {
  it('exists and is callable', () => {
    expect(typeof classify).toBe('function');
  });

  it('is not implemented yet (tracks docs/ROADMAP.md §1.2)', () => {
    expect(() =>
      classify([], {
        durationS: 0,
        isLive: false,
        isLoggedIn: false,
        countryHint: null,
        extensionVersion: '0.0.0',
      }),
    ).toThrow();
  });
});
