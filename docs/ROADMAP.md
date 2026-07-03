# AdsAuditor — Operational Roadmap

*Complete execution plan: phases, stack, tasks, acceptance criteria, and ready-to-use
prompts for Claude Code. Follow top to bottom; each phase has a "gate" that decides
whether to move to the next one.*

---

## Overview

| Phase | Objective | Estimated duration (part-time) | Exit gate |
|---|---|---|---|
| **0** | Signal validation spike | 1–2 days | The signal separates green/yellow → GO |
| **1** | Extension MVP, local only | 1–2 weeks | Correct diagnosis on 20 test videos |
| **2** | Backend + opt-in telemetry | 2–3 weeks | Real observations in the DB, computed consensus |
| **3** | Public dashboard | 1–2 weeks | Browsable online list with real data |
| **4** | Ground truth + trust score | 2 weeks | First verified channel, first confirmation |
| **5** | Distribution and community | ongoing | Extension published on at least one store |

Realistic total for the complete v1.0: **2–3 months part-time** working with Claude Code.

**General rule for working with the AI**: one session = one verifiable goal. Every
prompt below should be given *together with* the `docs/SPEC.md` file as context (just
having it in the repo is enough: Claude Code reads it). After each generated block: load
the extension, try it by hand, and only then move to the next prompt.

---

## PHASE 0 — Validation spike (BEFORE writing the extension)

**Why**: the only real technical risk is that the observable signals don't separate
green videos from yellow ones. This must be verified in 1–2 days, not after a month of
development.

### 0.1 Prepare the validation set
- 10–15 **confirmed-green** videos: recent videos from large, brand-safe channels
  (mid-rolls visible), plus any of your own videos with a green icon in Studio.
- 10–15 **confirmed-yellow/limited** videos: your own videos with a yellow icon (limited
  monetization), or videos from creators who have publicly reported demonetization
  (search for them on X/Reddit: "this video got demonetized").
- 3–5 **special-case** videos: made for kids, age-restricted, a channel obviously
  outside the Partner Program, live, video < 8 min.
- Save everything in `spike/dataset.json`: `{videoId, expected: "green|yellow|special", note}`.

### 0.2 Build the spike tool

> **PROMPT (Claude Code):**
> "Read docs/SPEC.md. Create a minimal, logging-only Chrome Manifest V3 extension in the
> `spike/` folder: a content script in world MAIN that (1) reads
> `window.ytInitialPlayerResponse` on load, (2) wraps `window.fetch` to clone the
> responses to `/youtubei/v1/player`, (3) reads on-demand from
> `document.getElementById('movie_player').getPlayerResponse()`. For every video extract:
> videoId, duration, `playabilityStatus.status`, presence and contents of `adPlacements`
> (with placement type: start/milliseconds/end), `adSlots`, `playerAds`. Add a
> MutationObserver on `#movie_player` that logs when the `ad-showing` or
> `ad-interrupting` classes appear. Forward everything to a service worker that saves the
> records to `chrome.storage.local`, and add an 'Export JSON' button in the popup that
> downloads all collected records. No polished UI: this is a throwaway measurement tool.
> Also give me the instructions to load it in chrome://extensions."

### 0.3 Collect and analyze
- Visit every video in the dataset (no adblock, non-Premium account), export the JSON.
- Repeat a second pass in a private/incognito browsing window (logged-out user).

> **PROMPT:** "Here are `spike/export.json` and `spike/dataset.json`. Write a Python
> script that cross-references observations against the expected state and produces a
> table: for each video → pre/mid/post placement, ads shown in the DOM, expected state.
> Then tell me: which combination of signals best separates green from yellow? Compute
> precision/recall for the rule 'green = adPlacements present + mid-roll if ≥ 8 min'."

### 0.4 GO/NO-GO gate
- **GO** if: green videos consistently show placements (≥ 80%) and yellow videos show a
  clearly different pattern (placements absent or no mid-roll).
- **NO-GO / rethink** if: no observable difference → before giving up, repeat while
  observing playback for longer (DOM signals) and from different accounts.
- Document the results in `spike/RESULTS.md`: the **thresholds measured here** become
  the parameters for the classifier (Phase 1) and for consensus (Phase 2).

---

## PHASE 1 — Extension MVP (local only)

**Objective**: an installable extension that, on any watch page, shows the
traffic-light indicator with an explanation and confidence level. Zero network, zero
server.

### 1.1 Repository setup

> **PROMPT:** "Initialize the `adsauditor` repo. Monorepo structure: `extension/` (WXT +
> TypeScript), `server/` (empty for now), `dashboard/` (empty), `spike/` (existing),
> `docs/` (already contains SPEC.md and ROADMAP.md — keep them there). Configure WXT to build Chrome and
> Firefox MV3, ESLint + Prettier, Vitest for unit tests, and a GitHub Action that runs
> lint + test + build on every push and creates a Release with the extension zip on `v*`
> tags. AGPL-3.0 license. README with the vision in 10 lines (take it from docs/SPEC.md
> §1) and the 'what we do NOT do' disclaimer (§11)."

Target extension structure:

```
extension/
  wxt.config.ts
  entrypoints/
    interceptor.content.ts    # world: MAIN  — source A (player response)
    bridge.content.ts         # ISOLATED     — postMessage bridge → runtime, DOM observer (source B)
    background.ts             # service worker: per-tab state, source C (webRequest), storage
    popup/                    # traffic-light UI
    options/                  # settings (for now: debug thresholds)
  utils/
    classifier.ts             # state machine: events → observed state  ← TESTS GO HERE
    selectors.ts              # CSS selectors and JSON paths in a single updatable module
    types.ts                  # shared types (ObservedState, AdEvidence, VideoContext)
```

### 1.2 The detection engine

> **PROMPT:** "Read docs/SPEC.md §3 (detection mechanism) and spike/RESULTS.md.
> Implement in `extension/`:
> 1. `interceptor.content.ts` (world MAIN): read `ytInitialPlayerResponse`, wrap fetch
>    for `/youtubei/v1/player`, listen on `yt-navigate-finish` for the per-video reset,
>    on-demand read from `movie_player.getPlayerResponse()`. Emit typed
>    `PlayerResponseEvent` events via postMessage with a shared session token.
> 2. `bridge.content.ts` (ISOLATED): validate origin+token of the postMessages, forward
>    them to the background script; MutationObserver on `#movie_player` for
>    `ad-showing`/`ad-interrupting` and for ad badges → `DomAdEvent` events (type:
>    preroll/midroll with playback timestamp). Selectors taken ONLY from
>    `utils/selectors.ts`.
> 3. `background.ts`: maintains a tabId→VideoSession map; receives the A and B events;
>    registers observational webRequest listeners (top-level, synchronous) for
>    `youtube.com/api/stats/ads`, `youtube.com/pagead/*`, `doubleclick.net`,
>    `googlesyndication.com` → `BeaconEvent` events (source C).
> 4. `utils/classifier.ts`: pure function `classify(events, context) → ObservedState`
>    implementing the A/B/C cross-reference table from §3.2 and the taxonomy from §3.3
>    (ADS_SERVED with detail, NO_ADS, NO_SIGNAL, UNAVAILABLE). Must be a pure function
>    with no browser dependencies: we'll test it with fixtures.
> Write minimal permissions into the manifest (webRequest, storage, host_permissions only
> for the domains listed). No telemetry: everything stays in chrome.storage.local."

### 1.3 NO_SIGNAL detection

> **PROMPT:** "Implement NO_SIGNAL detection (docs/SPEC.md §3.4): (1) bait-fetch to a
> known ad URL: if it fails with a blocking error → adblockSuspected; (2) Premium
> heuristic from the masthead; (3) set up calibration with control videos: for now the
> control video list is a static array in `utils/control-videos.ts` (I'll fill it in
> myself from the spike), and the check runs once a day, saving the result to storage. If
> any of the three checks fails, the classifier must return NO_SIGNAL with the cause."

### 1.4 UI: popup and badge

> **PROMPT:** "Create the extension popup: (a) a badge on the icon that changes color
> with the current video's state (green/yellow/gray/red); (b) a popup with: state +
> confidence level in honest language ('On this viewing: ads served, 2 mid-rolls' / 'No
> ads observed — this does NOT necessarily mean demonetized'), a list of evidence per
> source (placement / ads seen / beacon), a NO_SIGNAL notice with cause and a link to the
> options page; (c) a 'Local history' section with the last 50 videos observed from
> chrome.storage.local, with search. Dark, minimal design, text in Italian and English
> (i18n with _locales)."

### 1.5 Testing and hardening

> **PROMPT:** "Write Vitest unit tests for `classifier.ts` using the real JSON collected
> in the spike as fixtures (put them in `extension/test/fixtures/`): one case for every
> row of the §3.2 cross-reference table, plus: video < 8 min with no mid-roll, live,
> UNAVAILABLE, NO_SIGNAL for each of the three causes. Add a test that verifies the
> payload saved to storage NEVER contains fields outside the §3.3 schema."

Manual end-of-phase checklist (repeat on every release):
- [ ] known green video → green with mid-rolls detected
- [ ] known yellow video → yellow/no-ads with explanation
- [ ] private/removed video → red
- [ ] with uBlock active → NO_SIGNAL (adblock), no false yellow
- [ ] SPA navigation across 5 videos in a row → state correctly reset every time
- [ ] no outgoing network requests from the extension (verify in DevTools)

**Phase 1 gate**: all 6 items pass on Chrome and Firefox. → tag `v0.1.0`.

---

## PHASE 2 — Backend and opt-in telemetry

**Objective**: observations (only from those who consent) reach Supabase; the server
computes public states via consensus; the extension shows the community status.

### 2.1 Database schema

> **PROMPT:** "In `server/`, create the Supabase project (versioned SQL migrations).
> Schema (docs/SPEC.md §4):
> - `observers` (id uuid pseudonymous, created_at, trust_score default 1.0,
>   shadow_banned bool, last_seen);
> - `videos` (video_id pk, duration_s, is_live, first_seen, title and category_id
>   nullable — will come from the Data API);
> - `observations` (id, video_id fk, observer_id fk, observed_state enum, detail jsonb,
>   ctx jsonb, ip_hash, created_at) with unique (observer_id, video_id, day) for 24h
>   dedup;
> - `creator_confirmations` (video_id, channel_id, studio_status enum, confirmed_at,
>   expires_at);
> - `channels` (channel_id, verified_at, observer_id fk, verify_token nullable);
> - `video_status` (video_id pk, public_state enum, confidence, observer_count,
>   window_start/end, computed_at) — table materialized by the consensus job;
> - `control_videos` (video_id, expected_state, active bool).
> RLS: public read access ONLY on `video_status`, `videos`, and aggregated views; no
> direct writes from clients (only Edge Functions with the service role). Also write the
> `trending_limited` view (videos that moved to LIMITED/NO_ADS in the last 7 days,
> groupable by category)."

### 2.2 Ingest Edge Function

> **PROMPT:** "Create the `ingest` Edge Function: receives batches of observations from
> the extension. Validation: strict schema (rejects extra fields), valid video_id syntax,
> state within the enum, minimum extension version. Anti-abuse: HMAC of the IP with a
> daily salt (salt in a secret, rotated via cron; the raw IP is NEVER written), rate limit
> per observer_id and per ip_hash (max 200 observations/day), silent drop for
> shadow-banned observers. NO_SIGNAL records are counted in a metric but not written to
> `observations`. Response: always 202 (don't reveal to trolls what gets dropped)."

### 2.3 Consensus job

> **PROMPT:** "Create the `compute-status` Edge Function (scheduled hourly via pg_cron or
> Supabase cron): for every video with new observations, apply the rules from
> docs/SPEC.md §4.1 using the thresholds from spike/RESULTS.md (put them in a `config`
> table editable without a deploy), weight by trust_score, apply non-expired creator
> confirmations, write `video_status`. Then update the trust scores: +delta for those who
> agreed with the final consensus, −delta for those who diverged, clamp [0.1, 5.0],
> shadowban below 0.3 with hysteresis. Write unit tests for the consensus function with
> scenarios: unanimous, 50/50 conflict, a single troll against 5 honest observers, a
> creator confirmation that overturns the consensus."

### 2.4 Integration into the extension

> **PROMPT:** "Add to the extension: (1) a first-launch onboarding screen with EXPLICIT
> opt-in (default: off) that shows the exact schema of the payload sent, a link to the
> privacy policy, revocable from the options page; (2) a batch-send queue to the
> `ingest` Edge Function (flush every 5 min or 20 observations, retry with backoff, no
> sending if NO_SIGNAL); (3) reading the community status: on the watch page the popup
> shows, next to the local diagnosis, the public status from `video_status` (with a 1h
> local cache); (4) the control video list now comes from the server (public
> `control-videos` endpoint) with a 24h cache."

### 2.5 Calibration seed
- Load the spike dataset into `videos` + `control_videos`.
- Recruit 5–10 trusted beta testers (creators or friends) and run the system for 1–2
  weeks, comparing computed states against known reality.

**Phase 2 gate**: ≥ 500 real observations; the computed states on the calibration set's
videos match the known truth in ≥ 85% of cases. → `v0.2.0`.

---

## PHASE 3 — Public dashboard

**Objective**: the site that makes the project visible and useful even to people who
don't install anything.

Stack: **Next.js (App Router) + Vercel free tier**, data via Supabase's public
read-only API (views exposed through PostgREST). Video metadata (title, channel,
category) fetched server-side from the **YouTube Data API v3** (API key, aggressive
caching in `videos` to stay within the 10k units/day quota).

> **PROMPT:** "Create a Next.js app (App Router, TypeScript, Tailwind) in `dashboard/`.
> Pages:
> 1. `/` — overview: counters (videos observed, active observers, creator confirmations),
>    last-7-days trend per category, a 'recently moved to limited' list;
> 2. `/video/[id]` — public status with confidence, status history over time, observer
>    count, video embed, interpretation disclaimer (docs §1.1);
> 3. `/search` — lookup by video URL/ID or channel;
> 4. `/methodology` — static page: how we measure, what we can NOT know, sampling bias
>    (take the content from docs/SPEC.md §1.1, §3, §11);
> 5. `/privacy` — privacy policy.
> Data from Supabase (public views only, anon key). Missing metadata resolved
> server-side via the YouTube Data API with caching in the `videos` table. SSG/ISR
> wherever possible to stay within the free tier. Dark design consistent with the
> popup."

**Phase 3 gate**: dashboard live on a public domain with real data; an outside person
understands a video's status (and its limits) without explanations. → `v0.3.0`.

---

## PHASE 4 — Ground Truth and creator verification

> **PROMPT:** "Implement the channel verification flow (docs/SPEC.md §5), without OAuth:
> a `verify-channel` Edge Function that generates the token for a channel_id, a
> `check-verification` endpoint that reads the channel description via the YouTube Data
> API and, on a match, marks `channels.verified_at` and links the observer_id. In the
> dashboard: a `/creator` page with the guided flow (enter channel → copy token →
> verify). In the extension: if the current video's channel is the user's own verified
> channel, the popup shows 'Confirm Studio status' (green / yellow / limited) → writes to
> `creator_confirmations` with a 30-day expiry. Confirmations are weighted in the
> consensus per §4.1, and verified creators receive a trust boost."

**Phase 4 gate**: at least one channel verified end-to-end and one confirmation that
overturns or confirms a computed state. → `v0.4.0`.

---

## PHASE 5 — Distribution, community, maintenance

### 5.1 Publication (recommended order)
1. **Firefox AMO** (fast review, signed self-distribution as a fallback).
2. **Edge Add-ons**.
3. **Chrome Web Store** (one-time $5 developer account fee): listing with privacy
   policy, permission explanations, demo video. If rejected: appeal citing precedent
   (SponsorBlock, Return YouTube Dislike, the existing monetization checkers), and in
   the meantime a GitHub "load unpacked" channel documented with GIFs.
4. Automatic GitHub Release on every tag (already in CI since Phase 1).

### 5.2 Launch
- An excellent README + the `/methodology` page = the pitch.
- Launch posts where creators are: r/PartneredYouTube, r/NewTubers, X, Italian creator
  communities; angle: *"the open source map of what YouTube limits"*.
- Find 2–3 mid-size creators to cover the tool (the "competitive intelligence" use case
  sells itself).

### 5.3 Recurring maintenance
- **Selector watchdog**: a weekly canary (GitHub Action with Playwright that opens 2
  control videos with the extension loaded) that opens an issue if the signals
  disappear → an early indicator of markup changes or an SSAI rollout.
- Update `utils/selectors.ts` as isolated PRs, fast to ship.
- Monthly review of thresholds and trust (`config` table, no deploy needed).
- Triage community issues/PRs; `good-first-issue` labels on isolated modules
  (selectors, i18n, rules).

---

## Testing and quality (cross-cutting across all phases)

| Level | Tool | What it covers |
|---|---|---|
| Unit | Vitest | `classifier.ts`, consensus function, ingest validation — with real JSON fixtures from the spike |
| Integration | Local Supabase CLI | migrations, RLS (a test that verifies the anon key CANNOT write), Edge Functions |
| E2E | Playwright (chromium with `--load-extension`) | smoke test on 2 control videos: correct badge, no console errors |
| Manual | §1.5 checklist | every release, Chrome + Firefox |

Rule: **every bug found in the field becomes a test fixture** before it gets fixed.

---

## Decisions already made (don't reopen without cause)

- MV3 with a `world: MAIN` content script for interception; `webRequest` is
  observational only. No `declarativeNetRequest` (not needed: we don't block anything).
- TypeScript everywhere; WXT for the multi-browser build.
- Supabase (Postgres + Edge Functions + RLS), writes are server-side only.
- Next.js + Vercel for the dashboard.
- Opt-in default OFF; IP never persisted in plaintext; payload = §3.3 schema, nothing
  more.
- AGPL-3.0 for the code; no "YouTube" in the name.

## Things deliberately deferred (don't do before v1.0)

- Google OAuth for creator verification (the token in the description is enough).
- Mobile app, other platforms (TikTok/Instagram: not observable — closed native apps,
  encrypted traffic, no observable ad calls).
- Documented public API for third parties (comes after the schema stabilizes).
- Notification system ("your video moved to yellow") — great v1.1 feature.
- Monetizing the project (donations yes, Pro tier only once traction is proven).
