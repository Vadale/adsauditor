# AdsAuditor — Project Guide

Open source observatory of YouTube ad delivery: a browser extension (Chrome/Edge/Firefox, Manifest V3) that detects whether a video is actually serving ads, plus an opt-in crowdsourced database (Supabase) and a public dashboard (Next.js) that map monetization/limitation trends across YouTube.

**Source-of-truth documents** (read before making design decisions):
- `docs/SPEC.md` — full project specification: detection mechanism, state taxonomy, consensus algorithm, trust score, privacy design, distribution strategy.
- `docs/ROADMAP.md` — execution plan: phases 0–5, gates, acceptance criteria, ready-to-use build prompts.

## Language Policy (mandatory)

- **Every written artifact is in English**: documentation, code, comments, commit messages, issues, PR descriptions, UI copy source strings (Italian ships as an i18n locale, never as the source language), agent definitions.
- Conversation with the project owner happens in Italian; files never do.

## Current Status

- Phase: **1 — extension MVP, started 2026-07-03 under a conditional GO** (owner-authorized; see `spike/RESULTS.md` §6). Phase 0 artifacts: `spike/` tool, `dataset.json`, `analyze.py`, `RESULTS.md` with provisional thresholds (§4) — green signature validated 2/2, yellow signature is a *hypothesis* pending §1.5 checklist + beta-tester data.
- Standing constraints from the spike: rewatch frequency capping makes absence-evidence on rewatched videos worthless (classifier must flag it); control-video calibration must use fresh videos; collection instructions for humans must use full watch URLs, never bare IDs.
- The owner runs no further manual collection; recruit beta testers for calibration (ROADMAP §2.5) before freezing Phase 2 consensus thresholds.

## Target Repository Structure

```
adsauditor/
├── CLAUDE.md                     # this file
├── README.md                     # public pitch + "what we do NOT do" disclaimer
├── LICENSE                       # AGPL-3.0
├── docs/
│   ├── SPEC.md                   # project specification (source of truth)
│   ├── ROADMAP.md                # execution plan with phases and gates
│   ├── PRIVACY.md                # privacy policy (required by stores)
│   └── METHODOLOGY.md            # how we measure, known limits, sampling bias
├── spike/                        # Phase 0 throwaway measurement extension + dataset
│   ├── dataset.json              # known-status validation videos
│   └── RESULTS.md                # measured thresholds → feed classifier & consensus
├── extension/                    # WXT + TypeScript, MV3, builds for Chrome & Firefox
│   ├── wxt.config.ts
│   ├── entrypoints/
│   │   ├── interceptor.content.ts   # world: MAIN — player response capture (signal A)
│   │   ├── bridge.content.ts        # ISOLATED — postMessage bridge + DOM observer (signal B)
│   │   ├── background.ts            # per-tab session state + webRequest beacons (signal C)
│   │   ├── popup/                   # traffic-light UI, evidence list, local history
│   │   └── options/                 # opt-in toggle, settings
│   ├── utils/
│   │   ├── classifier.ts            # pure function: events → observed state (unit-tested)
│   │   ├── selectors.ts             # ALL CSS selectors & JSON paths live here only
│   │   ├── control-videos.ts        # NO_SIGNAL self-calibration list
│   │   └── types.ts                 # shared types (ObservedState, AdEvidence, VideoContext)
│   └── test/
│       └── fixtures/                # real player-response JSON captured in the spike
├── server/                       # Supabase project
│   ├── migrations/               # versioned SQL (schema, RLS, views, config table)
│   └── functions/                # Edge Functions: ingest, compute-status, verify-channel
└── dashboard/                    # Next.js (App Router) + Tailwind, deployed on Vercel
```

## Tech Stack (decided — do not reopen without cause)

| Layer | Choice |
|---|---|
| Extension | TypeScript, WXT, Manifest V3, content script `world: MAIN` for interception, `webRequest` observational only (no blocking, no `declarativeNetRequest`) |
| Backend | Supabase free tier: Postgres + RLS + Edge Functions; writes only via Edge Functions with service role |
| Dashboard | Next.js (App Router) + Tailwind on Vercel free tier; public read-only Supabase views |
| Video metadata | YouTube Data API v3 (API key, server-side, aggressive caching, 10k units/day quota) |
| Tests | Vitest (unit), Supabase CLI (integration/RLS), Playwright with `--load-extension` (e2e smoke) |
| CI | GitHub Actions: lint + test + build on push; zip + GitHub Release on `v*` tags |
| License | AGPL-3.0 (code), ODbL (aggregated dataset) |

## Non-Negotiable Invariants

These encode the project's credibility. Violating any of them is a bug regardless of tests passing:

1. **Local-first**: the extension is fully functional with telemetry off. Opt-in is explicit, default OFF, revocable.
2. **Minimal payload**: telemetry contains only video ID, observed state, and the context schema in `docs/SPEC.md` §3.3. No history, no watch time, no user identifiers beyond the local pseudonymous UUID. A test must fail if the stored/sent payload gains fields.
3. **No raw IPs**: server sees IPs only inside the ingest function; only `HMAC(IP, daily_salt)` is persisted (30-day retention).
4. **Honest language**: UI and dashboard say "ad delivery status", never "demonetized" as a fact, never "the creator earns/doesn't earn". Inferred states always ship with confidence + observer count.
5. **NO_SIGNAL discipline**: observations from Premium/adblock/uncalibrated observers are never written as `NO_ADS`.
6. **Observation only**: the extension never blocks, modifies, or injects ads or page content.
7. **Minimal permissions**: manifest host permissions limited to youtube.com, doubleclick.net, googlesyndication.com. Any new permission requires an explicit justification in the PR.

## Coding Conventions

- TypeScript strict mode everywhere; no `any` in exported signatures.
- `classifier.ts` and the consensus function stay **pure** (no browser/DB dependencies) — they are the most-tested code in the repo.
- Everything that touches YouTube's markup or JSON shape (CSS selectors, JSON paths) lives **only** in `extension/utils/selectors.ts` so breakage from YouTube changes is a one-file fix.
- Every field bug found in production becomes a test fixture before it is fixed.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`); small, reviewable PRs — one concern each.
- Comments state constraints the code cannot express (e.g., "MV3: webRequest listeners must be registered synchronously at top level"), not narration.

## Workflow

1. Follow `docs/ROADMAP.md` phases in order; each phase has a gate — do not start the next phase before the gate passes.
2. For any non-trivial change: **architect** (if design is unclear) → **coder** → **tester** → **reviewer**; **security-auditor** before every release and on any change touching manifest permissions, telemetry, ingest, RLS, or the verification flow; **docwriter** keeps docs in sync with shipped behavior.
3. Manual release checklist (`docs/ROADMAP.md` §1.5) runs on Chrome and Firefox before every tag.

## Agent Team

Defined in `.claude/agents/`. Delegate work to them by name.

| Agent | Role | Write access |
|---|---|---|
| `architect` | Design decisions, phase planning, spec compliance | read-only |
| `coder` | Implementation of extension/server/dashboard features | yes |
| `tester` | Test authoring, fixtures, coverage of invariants | yes (tests only) |
| `reviewer` | Correctness & convention review of diffs | read-only |
| `security-auditor` | Security & privacy audit (permissions, RLS, GDPR invariants) | read-only |
| `docwriter` | English documentation, store listings, methodology pages | yes (docs only) |
