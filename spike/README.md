# AdsAuditor — Phase 0 Signal Logger (spike)

> **Throwaway tooling.** This is not the AdsAuditor extension. It is a minimal,
> logging-only Manifest V3 extension built for the project's Phase 0: validating
> whether the observable signals (player response, ad DOM state) actually separate
> green (regular ads) videos from yellow/limited ones. Plain JavaScript, no build step,
> no polished UI, no telemetry, no network calls of its own. It will be deleted or
> replaced once Phase 0 is done — do not build on top of it.

## What it does

On every `youtube.com` watch page it captures a record for each of three independent
reads of the player response, plus DOM ad events, and stores everything locally in
`chrome.storage.local`:

1. **`window.ytInitialPlayerResponse`** on first page load (capture path `initial`).
2. **`fetch` calls to `/youtubei/v1/player`**, cloned and read without altering the
   response returned to the page (capture path `fetch`) — fires on every YouTube SPA
   navigation (next video, homepage click, etc.).
3. **`movie_player.getPlayerResponse()`**, read a few seconds after page load and after
   every `yt-navigate-finish` event, as a confirmation read (capture path
   `getPlayerResponse`).

For every player response captured it extracts: `videoId`, duration in seconds,
`playabilityStatus.status`, presence and contents of `adPlacements[]` / `adSlots[]` /
`playerAds[]`, `isLiveContent`, the logged-in state (best-effort, via `ytcfg`), which
capture path produced the record, and an ISO 8601 timestamp.

It also watches `#movie_player` with a `MutationObserver` for the `ad-showing` /
`ad-interrupting` classes appearing or disappearing (recording wall-clock time and the
player's current playback time, so pre-roll vs. mid-roll can be told apart later), and
logs the appearance of `.ytp-ad-*` badge/skip-button elements.

Records flow: MAIN-world content script (`interceptor.js`) → `window.postMessage`
(origin- and session-token-checked) → ISOLATED-world content script (`bridge.js`) →
`chrome.runtime.sendMessage` → service worker (`background.js`) → `chrome.storage.local`.

No `webRequest` usage in this spike (network beacons are out of scope for Phase 0 per
the roadmap). No data leaves the browser; nothing is sent to any server.

## Files

- `manifest.json` — MV3 manifest, `storage` permission + `youtube.com` host permission
  only.
- `interceptor.js` — MAIN-world content script: player response capture (all three
  paths) and the `#movie_player` DOM observer (needs the MAIN world because
  `getPlayerResponse()` / `getCurrentTime()` / `getVideoData()` are page-context methods
  not visible from an ISOLATED-world content script looking at the "same" element).
- `bridge.js` — ISOLATED-world content script: validates and relays messages to the
  service worker.
- `background.js` — service worker: appends every relayed record to
  `chrome.storage.local`.
- `popup.html` / `popup.js` — record counter, "Export JSON", "Clear data". No styling.

## How to load it

1. Open `chrome://extensions` in Chrome (or Edge/Brave — any Chromium browser with MV3
   support works the same way).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `spike/` folder.
4. Pin the extension icon if you want quick access to the popup.

Reload the extension from `chrome://extensions` after any edit to the files.

## How to use it

1. With the extension loaded, browse to videos from `spike/dataset.json` (confirmed
   green, confirmed yellow/limited, and special cases) in a normal signed-in tab, no
   adblocker.
2. Watch each video long enough to let at least a pre-roll play (a few seconds is
   usually enough for the player response signals; longer if you want DOM ad-event
   confirmation).
3. Navigate between videos using YouTube's own UI (related videos, search, etc.) so the
   SPA navigation path (`yt-navigate-finish`) gets exercised, not just fresh tabs.
4. Open the extension popup periodically to check the record counter — it should keep
   growing as you watch/navigate videos. If it stays at 0 after a video has loaded and
   played for a few seconds, something upstream is broken (check the page console for
   `[AdsAuditor Spike]` warnings) — do not proceed with a silent-zero collection run.
5. Click **Export JSON** to download all collected records as a single JSON file (for
   the analysis step in (docs/SPEC.md ).
6. Click **Clear data** to reset `chrome.storage.local` before a new collection pass
   (e.g. before repeating the run in a private/incognito window as a logged-out user).
7. For the logged-out pass (docs/SPEC.md : "a second pass in a
   private/incognito browsing window"): Chrome disables extensions in Incognito by
   default, and installing "unpacked" does not change that. Go to
   `chrome://extensions`, find this extension's card, click **Details**, and enable
   **Allow in Incognito**. Without this the extension will not run at all in the
   incognito window and the counter will silently stay at 0 for that entire pass.

## Known limitations (expected — this is a spike)

- No deduplication, no rate limiting, no schema versioning.
- Ad badge logging is throttled per class name (2s) to avoid runaway spam from DOM
  churn, not deduplicated properly.
- If YouTube's markup or JSON shape has changed since this was written, some fields may
  come back `null` or empty — that is itself useful signal for `spike/RESULTS.md`.
- Field extraction for `adPlacements` / `adSlots` / `playerAds` keeps only the
  ad-relevant fields (kind/offsets, slot type, a best-effort ad type), not the full raw
  sub-objects — deliberately, to stay well inside the `chrome.storage.local` quota
  (no `unlimitedStorage` permission) across a full collection run. If the best-effort
  field paths turn out wrong for real captures, they will come back `null`/empty rather
  than silently misleading — treat that as signal too.
- DOM ad events (`ad-showing-start` / `ad-interrupting-start` / …) attribute the content
  video via `watchUrlVideoId` (parsed from the page URL) and `lastSourceAVideoId` (the
  most recent player-response videoId), not the player's live-reported
  `playerReportedVideoId` — during an ad, the player reports the AD's own id/timeline,
  not the content video's, so that field is kept for diagnostics only.
