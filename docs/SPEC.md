# AdsAuditor — Project Document (v2, revised)

**Open source observatory of YouTube ad delivery**
*Browser extension + crowdsourced database + public dashboard*

> This document replaces v1 ("YouTube AdsAuditor"). It corrects the detection mechanism
> (technically wrong in v1), reverses the distribution strategy, redefines the value
> proposition, and adds the missing parts: state taxonomy, the NO_SIGNAL state, creator
> verification, privacy/GDPR, and robustness to SSAI.

---

## 1. Vision and problem

YouTube's demonetization algorithm (the "yellow icon", limited monetization) is a black
box. No one — creators, advertisers, viewers — can see which videos or topics get
limited, when, or how much.

Instead of *predicting* the algorithm (impossible), this project **observes what the
algorithm actually does**: whether and which ads are being served on each video, measured
from the browser of the person watching. Any single observation is noisy; thousands of
aggregated observations become the most accurate existing map of the real state of
monetization on YouTube.

### 1.1 Semantic honesty: what we actually measure

The tool **does not read the YouTube Studio icon** (technically impossible for other
people's videos). It measures **ad delivery**: which ads Google's ad system decides to
serve on a video, as observed by real viewers. It is a strong proxy but not identical to
the Studio icon:

| Studio icon | Observable ad delivery |
|---|---|
| Green | Regular ads, mid-rolls present on videos ≥ 8 min |
| Yellow (limited) | Sporadic or absent ads (yellow does NOT mean zero ads) |
| Channel outside the Partner Program | **Ads present regardless** (since late 2020 YouTube monetizes non-YPP channels too and keeps all the revenue) |
| Made for Kids | Ads limited by design, not by "censorship" |

All project communication (UI, dashboard, README) uses the language "ad delivery
status", never "the creator earns / doesn't earn". The conversion into "probable yellow
icon" happens only server-side, with calibrated thresholds and an explicit confidence
level, and becomes *certain* only with creator confirmation (Ground Truth).

### 1.2 Who it's for (revised value proposition)

v1 said "the creator monitors their own videos" — weak: for their *own* videos the
creator already has the icon in Studio. The real value is:

1. **Transparency on other people's videos** — the status YouTube hides: competitive
   intelligence for creators ("this topic gets green, this one doesn't"), investigations
   for journalists and researchers.
2. **The aggregated map** — real-time trends: which topics/categories are being limited
   today, history per video and per topic.
3. **For your own videos: the viewer-side view** — the one thing Studio doesn't show:
   "green icon but almost no ads actually served" (an advertiser demand / RPM problem),
   geographic differences in delivery.

---

## 2. Overall architecture

Three independent components, all open source:

```
┌────────────────────────┐      opt-in      ┌──────────────────────┐
│   EXTENSION (client)   │   observations   │  BACKEND (Supabase)  │
│  Chrome/Edge/Firefox   │ ───────────────► │  ingest + consensus  │
│    local detection     │                  │    + trust score     │
│    100% functional     │  public status   │     + public API     │
│  even without network  │ ◄─────────────── │                      │
└────────────────────────┘                  └───────────┬──────────┘
                                                        │ API read-only
                                            ┌───────────▼────────────┐
                                            │    DASHBOARD (web)     │
                                            │     trend, search,     │
                                            │  creator verification  │
                                            └────────────────────────┘
```

- **The extension works entirely locally** even if the user declines the opt-in:
  diagnosis of the current video + local history. The backend is additive, never
  mandatory.
- **The database is public** (read access) like SponsorBlock's: anyone can verify it,
  download it, build on top of it.

---

## 3. Detection mechanism (the heart of the project)

### 3.1 Why v1 was wrong

v1 planned to "read the ad servers' responses" using `chrome.webRequest` /
`declarativeNetRequest`. **This is not possible**: `webRequest` (in MV3 as in MV2)
exposes request URLs and headers, **never response bodies**; `declarativeNetRequest` is
for blocking/modifying, not observing. Detection has to happen **inside the page**, where
the data is in plain sight.

### 3.2 Three-source signal architecture (redundant)

No single source is reliable over time (YouTube changes its markup and is experimenting
with server-side ad insertion). We use **three independent sources** that confirm each
other; a verdict requires agreement between at least two.

#### Source A — Player Response (the ad decision) · *primary signal*

The YouTube player receives the video's configuration in a JSON object (the *player
response*) that contains, if the video serves ads, the fields **`adPlacements[]`**,
**`adSlots[]`**, and **`playerAds[]`**. The `adPlacements` also specify the slot type
(pre-roll / mid-roll with offset in milliseconds / post-roll): it is the **complete
structure of the ad decision**, available even before any ad starts.

The player response arrives via three paths, and all three must be intercepted (YouTube
is an SPA: the first path only fires on a full page load):

1. **`window.ytInitialPlayerResponse`** — embedded in the watch page's HTML on the
   first load.
2. **`fetch` to `/youtubei/v1/player`** — an InnerTube call made on every internal
   navigation (next video, click from the homepage, etc.).
3. **`document.getElementById('movie_player').getPlayerResponse()`** — a method exposed
   by the player element itself; useful as an on-demand confirmation read.

**How to intercept it (Manifest V3):** a content script declared with
`"world": "MAIN"` (Chrome ≥ 111, Firefox ≥ 128) runs in the page's JavaScript context and
can:
- read `ytInitialPlayerResponse` on page load;
- wrap `window.fetch` (and `XMLHttpRequest` as a fallback) to clone the responses to
  `/youtubei/v1/player` without altering them;
- listen for YouTube's SPA events (`yt-navigate-finish`, `yt-page-data-updated`) to
  reset state on every video change.

The MAIN world has no access to the `chrome.*` APIs: it communicates with a second
content script in the ISOLATED world via `window.postMessage` (with strict `origin`
checking and a session token), which forwards to the service worker via
`chrome.runtime.sendMessage`.

Also extracted from the player response: `playabilityStatus` (OK / LOGIN_REQUIRED /
UNPLAYABLE / ERROR → RED state), `videoDetails` (videoId, duration — critical for the
8-minute mid-roll eligibility —, isLiveContent), microformat (visibility, familySafe).

#### Source B — DOM signals (the ad that actually plays) · *confirmation + anti-SSAI*

A `MutationObserver` on the `#movie_player` element detects:
- the **`ad-showing`** / **`ad-interrupting`** classes (present while a spot is
  playing);
- the ad's UI elements (the "Ad"/"Sponsored" badge, the Skip button, `.ytp-ad-*`
  overlays).

This source counts ads **actually played** during viewing (pre-roll watched, mid-roll
watched at minute X). It is the most durable source long-term: even if YouTube moved
everything server-side (SSAI), the interface must still show the user they're watching an
ad (countdown, Skip button, badge) — so the DOM signal survives. CSS selectors change
over time: they must be kept in an updatable configuration module and covered by tests.

**Strong vs. weak B evidence** (field-verified 2026-07-11): the two kinds of B signal
are not equally trustworthy. The `ad-showing`/`ad-interrupting` class transitions toggle
only while a real spot plays — they are **strong** evidence. Sightings of `.ytp-ad-*`
elements are **weak**: YouTube ships empty `ytp-ad-*` scaffolding in the player even on
videos that serve no ads at all (observed on non-monetized channels), so an element
sighting alone cannot distinguish real ad UI from inert scaffolding. Only strong B
evidence satisfies "B seen" in the cross-reference table below; weak-only B evidence
yields NO_SIGNAL (`anomalous-ad-ui-only`) — it proves neither ad presence nor absence,
so it blocks both the ADS_SERVED and the NO_ADS verdict.

#### Source C — Network beacons (impression tracking) · *independent confirmation*

With the `webRequest` permission in **observation-only** mode (allowed in MV3 without
`webRequestBlocking`; we only look at URLs, never bodies) the service worker detects:
- pings to **`youtube.com/api/stats/ads`** — these fire only when an ad impression
  actually happens;
- requests to **`youtube.com/pagead/*`**, **`googleads.g.doubleclick.net`**,
  **`googlesyndication.com`**.

MV3 note: `webRequest` listeners must be registered synchronously at the top level of
the service worker (events wake the worker, but only if the registration is static).

#### Cross-referencing the sources

| A (placement) | B (DOM) | C (beacon) | Interpretation |
|---|---|---|---|
| present | seen | seen | ADS_SERVED, maximum confidence |
| present | not seen (short viewing) | — | ADS_SERVED (decision made, playback not observed) |
| absent | not seen | absent | NO_ADS **only if the observer is valid** (see 3.4) |
| absent | seen | seen | Anomaly (likely SSAI or format change) → diagnostic log, signal B/C takes precedence |
| — | — | blocked/failed | Suspected adblock → NO_SIGNAL |

### 3.3 Taxonomy of observed states (client)

The extension reports **observed facts**, never interpretations:

- **`ADS_SERVED`** — with detail: `{preroll: bool, midrolls: n, postroll: bool, sources: [...]}`
- **`NO_ADS`** — player response read correctly, no placements, no ad seen, no beacon,
  valid observer
- **`NO_SIGNAL`** — the observer cannot produce valid data (Premium, adblock, failed
  calibration): **nothing is sent**, or it is sent flagged for diagnostics only
- **`UNAVAILABLE`** — `playabilityStatus` ≠ OK (removed, private, region-blocked,
  age-restricted)

Attached context (bare minimum): video duration, live yes/no, logged-in yes/no, country
hint at national granularity, extension version. **Never**: history, search queries,
watch time, identity.

### 3.4 NO_SIGNAL detection (the part v1 didn't have)

Without this, every Premium or adblock user pollutes the database with false "NO_ADS"
records. Three checks:

1. **Adblock**: `fetch` of a known ad "bait URL" from the extension context; if it fails
   with a client-blocking error, an adblocker is active → NO_SIGNAL.
2. **Premium**: masthead heuristic (the "Premium" badge in the logo) + systematic
   absence of placements.
3. **Self-calibration with control videos** (the decisive check): the server publishes
   a small rotating list of videos *known to be monetized* (confirmed by verified
   creators). If the observer never sees ad signals even on those, it is marked
   NO_SIGNAL regardless of the cause — including causes we can't yet imagine. This is the
   mechanism that makes the system honest by construction.

### 3.5 Robustness to Server-Side Ad Insertion (SSAI)

As of mid-2026 YouTube is testing server-side ad insertion (single stream, ads invisible
at the network level) — wide rollout estimated within 6–12 months. Impact:

- Source C degrades (beacons could change or disappear).
- Source A needs to be re-verified over time (the player still has to know where the
  slots are to show the countdown/Skip button → it's plausible some form of placement
  remains exposed).
- **Source B survives**: the ad UI has to exist for legal and UX reasons.

The project is designed to lose sources without dying: the classifier accepts any subset
of sources and reports which ones were active (`sources` in the payload), so the server
can recalibrate thresholds when the signal mix changes.

---

## 4. Backend: from noise to data (inference and consensus)

### 4.1 Public states (computed, never directly observed)

The server aggregates observations from the last 30 days, weighted by trust score,
excluding NO_SIGNAL, deduplicated by (observer, video, 24h):

| Public state | v1 rule (thresholds to calibrate in Phase 0/2) |
|---|---|
| `ADS_RUNNING` (green) | ≥ 3 distinct observers, ad share ≥ 70%, mid-rolls seen if video ≥ 8 min |
| `LIMITED_SUSPECTED` (suspected yellow) | ad share between 10% and 70%, or video ≥ 8 min with ads but never a mid-roll |
| `NO_ADS_OBSERVED` | ad share ≤ 10% across ≥ 3 observers over ≥ 48 h |
| `UNKNOWN` | insufficient data |
| `CONFIRMED_GREEN` / `CONFIRMED_LIMITED` | verified creator confirmation (valid for 30 days, then decays to the computed state) |

Every state always exposes: observer count, time window, confidence. The dashboard never
shows a bare "yellow" without context.

### 4.2 Trust score and anti-troll

Model inspired by SponsorBlock:
- every install has a **pseudonymous ID** (UUID generated locally, no account);
- initial trust 1.0, range [0.1 – 5.0]: rises when observations agree with the
  subsequent consensus, falls when they systematically diverge;
- below threshold → **shadowban** (observations are accepted but ignored);
- **cross-verification**: a state only becomes public with ≥ 3 observers with distinct
  IP hashes (see §6);
- rate limit per observer and per IP hash; creator confirmations require a verified
  channel (§5).

### 4.3 Cold start and calibration

Before public launch, the database is *seeded* with a calibration set: videos with a
known state (own channels + demonetizations publicly reported by creators). This is used
to: tune the thresholds in §4.1, feed the control videos in §3.4, and avoid launching an
empty or wrong public list.

---

## 5. Ground Truth: creator confirmation

The most valuable data point: a creator saying "Studio flags me yellow". But without
ownership verification it's the main attack vector (a troll "confirming" someone else's
video). Verification flow **without OAuth** (v1, zero Google review friction):

1. The creator enters the channel URL on the dashboard and receives a token
   (`adsauditor-verify-a8f3…`).
2. They temporarily add it to the **channel description**.
3. The server verifies via the YouTube Data API (`channels.list`, public read, 1 quota
   unit) and marks the channel as verified, linking it to the pseudonymous ID.
4. The creator removes the token. From that point on they can confirm the Studio status
   of videos on *their* channel (from the extension popup or the dashboard).

In v2, Google OAuth (`youtube.readonly`) can be added for a one-click flow.

---

## 6. Privacy and GDPR (by design, not just words)

- **Local by default**: without explicit opt-in on first launch, no byte leaves the
  browser. Consent is revocable from the options page.
- **Minimal payload**: video ID (public) + observed state + minimal context (§3.3).
  Never full URLs, never history, never the user's Google identifiers.
- **IP**: used only for anti-abuse/cross-verification. The Edge Function computes
  `HMAC(IP, daily_salt)` and discards the raw IP; the hash lives for 30 days. IP is
  personal data in the EU: this processing must be disclosed.
- **Mandatory documents** before public launch: privacy policy (also required by the
  Chrome Web Store for extensions that transmit data) + a "what we collect" page in the
  README with the exact payload schema.
- **Radical transparency**: extension code, server code, and DB schema are public; the
  aggregated database is downloadable.

## 7. Distribution (reversed from v1)

v1 assumed "Google will never accept us → GitHub only". Two mistakes:

1. **`.crx` files from GitHub don't install** on Chrome for Windows/macOS (blocked
   outside the store for years, except under enterprise policy). Only "load unpacked" in
   developer mode would remain: a warning on every launch, no auto-update → dead
   adoption.
2. **Precedent says otherwise**: SponsorBlock, Return YouTube Dislike, and even several
   commercial "Monetization Checker" extensions (TubeLab, LenosTube, NexLev) have lived
   on the Chrome Web Store for years. A passive observer is less invasive than an
   adblocker.

Corrected strategy:
- **Primary channel**: Chrome Web Store (+ Edge Add-ons, more permissive review).
- **Firefox AMO**: parallel publication; Mozilla also allows signed self-distribution →
  a real fallback.
- **GitHub**: source of truth for the code, release zips for developers/power users, and
  plan B if the store rejects the extension (at that point the "load unpacked" guide
  becomes the channel, accepting the friction).
- Store compliance: clear opt-in, privacy policy, minimal permissions, no "YouTube" in
  the name (trademark violation → automatic rejection). Working name: **AdsAuditor**;
  alternatives to evaluate: *AdLens*, *AdWitness*, *OpenAdsObservatory*.

## 8. Zero-cost stack

| Component | Technology | Cost |
|---|---|---|
| Extension | TypeScript + WXT (multi-browser MV3 build) | €0 |
| Code + releases + CI | GitHub + GitHub Actions | €0 |
| Backend | Supabase free tier (Postgres + Edge Functions + RLS) | €0 |
| Dashboard | Next.js on Vercel (or Netlify) free tier | €0 |
| Video metadata | YouTube Data API v3, API key, 10,000 units/day | €0 |
| Domain (optional) | — | ~€10/year |

Costs only start once success is achieved (tens of thousands of active users) — at that
point: donations (GitHub Sponsors), sponsors, a possible dashboard "Pro" tier.

## 9. License

- **Code** (extension + server + dashboard): **AGPL-3.0** — anyone can use and fork it,
  but forks that offer the service must stay open (protects the project from closed
  clones exploiting the database).
- **Aggregated database**: **ODbL** or CC BY-SA — free reuse with attribution and
  share-alike.

## 10. Risks and mitigations

| Risk | Probability | Mitigation |
|---|---|---|
| The signal doesn't separate green/yellow | to verify **before anything else** | Phase 0: validation spike on videos with a known state. Go/no-go gate. |
| SSAI eliminates network signals | medium, 6–18 months | Three-source architecture; the DOM source survives (§3.5) |
| YouTube changes markup/JSON fields | certain, recurring | Selectors and paths in updatable config modules; fixture-based tests; open source community |
| Chrome Web Store rejection | low (favorable precedent) | Firefox AMO + Edge + GitHub as fallback plans |
| Data poisoning / trolling | medium | Trust score, cross-verification, shadowban, rate limit, confirmations only from verified channels |
| Cold start (few users → useless data) | high | Calibration seed; targeted launch on creator communities; immediate local value even without network |
| Sampling bias in the "map" | structural | Honest communication: the map covers what users watch, with explicit coverage counters |
| YouTube ToS | gray area but with solid precedent | Passive observation during real browsing (no automated scraping, no bots); same category as SponsorBlock/RYD |

## 11. What this project does NOT do (keep in the README)

- Does not read the Studio icon of other people's videos (impossible): it **estimates**
  it and states it as an estimate.
- Does not distinguish "the creator earns" from "YouTube monetizes the video" (non-YPP
  channels).
- Does not explain *why* a video is limited: it shows aggregated correlations, not
  causes.
- Does not block, modify, or inject ads. It only observes.
- Does not track users. Ever.
