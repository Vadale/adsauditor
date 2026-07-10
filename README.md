# AdsAuditor

> **Status: Phase 1 (extension MVP) — code-complete, not yet released.** The
> three-source detection engine (`docs/ROADMAP.md` §1.2), NO_SIGNAL self-calibration
> (§1.3), and the popup/badge/options UI in English and Italian (§1.4) are implemented,
> reviewed, and covered by 102 unit tests, including fixtures captured from real
> player-response data in the Phase 0 spike (§1.5). What is still outstanding is the
> §1.5 **manual** release checklist on Chrome and Firefox — the gate for tagging
> `v0.1.0`. Nothing is published to a store yet, there is no tagged release, and no data
> leaves the browser except the two calibration probes described below and in
> [`docs/PRIVACY.md`](docs/PRIVACY.md).

Open source observatory of YouTube ad delivery: a browser extension (Chrome, Edge,
Firefox — Manifest V3) that detects whether a video is actually serving ads, plus an
opt-in crowdsourced database and a public dashboard that map monetization/limitation
trends across YouTube.

## Vision

- YouTube's demonetization algorithm is a black box; nobody outside YouTube can see
  which videos or topics get limited, when, or how much.
- Instead of *predicting* the algorithm, AdsAuditor **observes what it actually does**:
  which ads get served on a video, as measured from real viewers' browsers.
- A single observation is noisy. Thousands of aggregated, crowdsourced observations
  become the most accurate existing map of real monetization on YouTube.
- The tool never reads the YouTube Studio icon (impossible for other people's videos):
  it measures **ad delivery**, a strong but explicitly imperfect proxy for it.
- The extension is 100% useful with telemetry off: local-first diagnosis of the video
  you're watching, zero account required, and zero telemetry — no data about you or
  what you watch ever leaves the browser. The only network requests the extension makes
  are two small, payload-free self-calibration probes (an ad-bait fetch and a
  connectivity control, at most once a day) needed to tell "this browser can't see ads"
  apart from "this video has no ads" — see [`docs/PRIVACY.md`](docs/PRIVACY.md) for the
  exact URLs and cadence.
- Sending observations to the shared database is opt-in, off by default, and revocable.
- The aggregated database and dashboard are public and downloadable, like SponsorBlock's.
- All project communication uses honest language — "ad delivery status", confidence
  levels, observer counts — never "the creator earns/doesn't earn" as fact.
- Three independent, redundant signal sources (player response, DOM, network beacons)
  keep the system working even as YouTube changes markup or rolls out server-side ad
  insertion.
- Full specification: `docs/SPEC.md`. Execution plan and phase gates: `docs/ROADMAP.md`.

## What this project does NOT do

- Does not read the Studio icon of other people's videos (impossible): it **estimates**
  it and states it as an estimate.
- Does not distinguish "the creator earns" from "YouTube monetizes the video" (non-YPP
  channels).
- Does not explain *why* a video is limited: it shows aggregated correlations, not
  causes.
- Does not block, modify, or inject ads. It only observes.
- Does not track users. Ever.

## Repo layout

| Path | Contents |
|---|---|
| `extension/` | The browser extension. WXT + TypeScript, Manifest V3, builds for Chrome and Firefox. The only component with real code right now. |
| `server/` | Supabase project (schema migrations, Edge Functions). Empty placeholder — arrives in Phase 2. |
| `dashboard/` | Public Next.js dashboard. Empty placeholder — arrives in Phase 3. |
| `spike/` | Phase 0 throwaway measurement extension + collected dataset. Results in `spike/RESULTS.md`. |
| `docs/` | `SPEC.md` (source of truth for design decisions), `ROADMAP.md` (phases, gates, build prompts), and `PRIVACY.md` (what the extension collects, today and in Phase 2). |
| `.github/workflows/` | CI (lint/test/build on pushes to `main` and on pull requests) and Release (build + GitHub Release on `v*` tags). |

Phase 0's validation results — the measured signal thresholds that feed the classifier
and consensus logic — live in [`spike/RESULTS.md`](spike/RESULTS.md).

## Quick start (developers)

Requirements: Node.js >= 20.12 (required by WXT), npm. Developed and verified locally
with Node v26.0.0; CI is pinned to Node 22 for reproducibility — both satisfy WXT's
`engines` requirement, so either works.

```bash
git clone <this-repo>
cd <cloned-directory>/extension
npm install

# Development (hot-reloading, opens a temp browser profile)
npm run dev            # Chrome
npm run dev:firefox    # Firefox

# Production build, both targets
npm run build           # -> extension/.output/chrome-mv3, extension/.output/firefox-mv3
npm run zip              # -> extension/.output/*.zip, ready to load or ship

# Quality checks
npm run lint
npm run format:check
npm run typecheck
npm test
```

### Load unpacked

- **Chrome/Edge**: `chrome://extensions` → enable Developer mode → "Load unpacked" →
  select `extension/.output/chrome-mv3`.
- **Firefox**: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" →
  select `extension/.output/firefox-mv3/manifest.json`.

## License

- **Code** (extension, server, dashboard): [AGPL-3.0](LICENSE). Forks that offer the
  service must stay open — this protects the project from closed clones exploiting the
  crowdsourced database.
- **Aggregated dataset** (once it exists, Phase 2+): ODbL — free reuse with attribution
  and share-alike.
