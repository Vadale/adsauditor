# AdsAuditor — Privacy Policy

*Last updated: 2026-07-10, for the Phase 1 (extension MVP) code, pre-release. This
document will be revised again before Phase 2 telemetry ships (see §4 below) and again
before any store listing.*

This is the plain-English description of what the AdsAuditor browser extension does,
what it stores, and what — if anything — leaves your browser. It describes exactly what
the shipped code does today, not an aspiration. If code and this document ever disagree,
the code is the bug.

## 1. What the extension does

On YouTube watch pages, the extension observes whether the video you're watching is
serving ads: it reads the player's own ad-placement data, watches for the ad UI
(countdown, Skip button, "Sponsored" badge), and watches for the network beacons YouTube
fires when an ad impression happens. From these it derives one of four **ad delivery
states** — `ADS_SERVED`, `NO_ADS`, `NO_SIGNAL`, or `UNAVAILABLE` — for the current video
in the current tab. See `docs/SPEC.md` §3 for the full detection mechanism and §3.3 for
the exact state taxonomy.

This is diagnostic, not predictive: it is an observation of what happened during this
one viewing, not a claim about the video's YouTube Studio monetization status. See the
"what we do NOT do" section of the [README](../README.md).

## 2. What is stored — on your device only

Everything below lives in the browser's local extension storage
(`chrome.storage.local` / `chrome.storage.session`), scoped to the extension, never
synced to any account, and never read by AdsAuditor's authors or anyone else. Nothing in
this section leaves your browser today.

- **Per-tab detection sessions** — in-memory / `chrome.storage.session` bookkeeping of
  the current video's evidence (placement data, DOM ad sightings, beacon hits) for the
  tab that's open right now. Torn down when the tab navigates away or closes.
- **Local history — the last 50 observed videos** (`local:adsauditor_history`): for
  each, the video ID, the observed state, a short evidence summary (which of the three
  sources fired, mid-roll count), and a timestamp. Capped at 50 entries; the oldest is
  dropped when a 51st is added. This is what powers the popup's "local history" list and
  never travels anywhere.
- **Calibration state** (`local:adsauditor_calibration`): four fields the extension uses
  to judge whether *this browser* can currently produce trustworthy observations —
  whether the last adblock probe came back clear/blocked/inconclusive and when, whether
  a YouTube Premium badge was last detected and when, when this browser last saw a
  confirmed `ADS_SERVED` result (any video, not just a control video), and when it last
  failed a control-video check. See §3 below for what the probes are and why they exist.
  No video-specific data lives here beyond these timestamps/flags.
- **A 24-hour rewatch index** (`local:adsauditor_rewatch_index`): a map of video ID →
  last-watched timestamp, pruned automatically so it never grows unbounded. Its only
  purpose is to recognize when you're rewatching a video you already watched in the last
  24 hours, because YouTube caps how often it re-shows ads on a rewatched video — an
  absence of ads there would be meaningless as evidence, so the classifier flags it
  instead of reporting a false `NO_ADS` (`docs/SPEC.md` §3.4, ROADMAP §1.3 spike
  constraint).

None of the above is sent anywhere. Uninstalling the extension deletes all of it, since
it lives only in the browser's extension storage.

## 3. What leaves the browser today: two calibration probes, nothing else

The extension makes exactly two outgoing network requests, and only these two. Both are
required by the NO_SIGNAL discipline in `docs/SPEC.md` §3.4: without them, a browser
running an adblocker or a Premium account would silently report "no ads" as if that were
a fact about the video, when it's really a fact about the browser. Neither probe carries
any observation data, any identifier, or any cookie, and neither reads the response body
— the extension only checks whether the request itself succeeded, failed, or hung.

| Probe | URL | Purpose | Cadence |
|---|---|---|---|
| Ad-bait fetch | `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?adsauditor_probe=1` | A canonical ad-network URL that adblockers block. If it's blocked, this browser cannot see real ad signals either, and the extension marks itself `NO_SIGNAL` (adblock-suspected) instead of misreporting `NO_ADS`. | At most once per day; retried after 6 hours if the previous attempt was inconclusive (e.g. it hung rather than resolving or failing). |
| Connectivity control | `https://www.youtube.com/generate_204` | A plain YouTube endpoint no blocklist targets. Used only to tell "the network is down" apart from "the ad-bait URL specifically was blocked" — without it, a captive portal or offline browser would be misread as running an adblocker. | Fired alongside the ad-bait fetch when that check is due. |

Properties of both requests:
- No cookies are attached (`credentials: 'omit'`).
- No request carries a video ID, a user identifier, or any payload — the query
  parameter on the bait URL (`adsauditor_probe=1`) exists only so the extension's own
  network listener can recognize and discard its own probe traffic, not to identify you
  to Google.
- The response body is never read; only whether the request resolved, was rejected, or
  timed out is used.
- These are **the only** network requests the extension makes. It does not call any
  AdsAuditor server, because in Phase 1 there is no server — see §4.

The extension's manifest requests host permissions only for `youtube.com`,
`doubleclick.net`, and `googlesyndication.com` (`CLAUDE.md` invariant 7); it observes
`webRequest` traffic to those domains to detect ad beacons (source C, `docs/SPEC.md`
§3.2) but this is passive observation of requests the browser (or YouTube's page) makes
on its own — it does not originate additional requests beyond the two probes above.

## 4. What will change in Phase 2 — and won't, without your consent

Phase 2 (`docs/ROADMAP.md` §2) adds an opt-in crowdsourced backend: if you explicitly
choose to, your browser can contribute anonymous ad-delivery observations to a shared,
public database so the project can map monetization trends across YouTube. Before any
of that ships:

- Telemetry will be **off by default**. Turning it on will require an explicit,
  affirmative action on your part — not a pre-checked box.
- The first-launch/options screen will show the **exact payload schema** being sent
  (video ID, observed state, and the minimal context fields in `docs/SPEC.md` §3.3 —
  duration, live/not, logged-in/not, country at national granularity, extension
  version; never history, watch time, search queries, or an identifier beyond a local
  pseudonymous UUID).
- Consent will be **revocable** at any time from the options page.
- The server will see your IP address only transiently, inside the ingest function; it
  persists only `HMAC(IP, daily_salt)`, retained 30 days, never the raw IP
  (`docs/SPEC.md` §6, `CLAUDE.md` invariant 3).
- **This document will be rewritten and expanded before any of that code ships** — not
  after. If you're reading this and Phase 1 is still current, no telemetry code exists
  in the extension at all.

## 5. What we never collect

Regardless of phase or opt-in status, AdsAuditor never collects: your YouTube/Google
identity, your browsing history outside of the current video's ad-delivery observation,
your watch time or viewing habits, your search queries, or any identifier beyond the
local pseudonymous UUID that Phase 2's opt-in telemetry will generate on-device.

## 6. Related documents

- `docs/SPEC.md` §3.4 — NO_SIGNAL detection mechanism (why the calibration probes
  exist).
- `docs/SPEC.md` §6 — full privacy and GDPR design for the Phase 2 backend.
- [`README.md`](../README.md) — project overview and the "what we do NOT do" disclaimer.
