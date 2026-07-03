# Phase 0 Spike — Results

Date: 2026-07-02/03 · Observer: 1 (project owner, Italy, residential network, Chrome + spike extension) · Analysis: `spike/analyze.py`

## 1. What was collected

| Export | Time (UTC) | Tool version | Session | Usable |
|---|---|---|---|---|
| `smoke-test-2026-07-02.json` | 20:17 | pre-fix (broken kind extraction) | logged-in | only as tool-debugging evidence |
| `…20-32-56…json` | 20:29 | pre-fix (stale reload) | logged-in | same |
| `…20-42-17…json` | 20:34–20:42 | **fixed** | logged-in + logged-out (incognito) | **yes** |
| `…21-05-37…json` | 20:53–21:03 | **fixed** | logged-in | **yes** |

Coverage vs. `dataset.json`: **6 videos measured of 29 labeled** (2 green, 2 specials, plus 2 off-dataset Elisa True Crime videos that map to the yellow class). All high-confidence yellow entries (Soft White Underbelly, FUNKER530) and 13 of 15 greens remain unmeasured. The owner has declared collection closed.

## 2. Per-video results (fixed-tool exports only)

| Video | Label (conf.) | Session | Placements pre/mid/post | adSlots | DOM ads played | playability |
|---|---|---|---|---|---|---|
| `iYlODtkyw_I` MrBeast 35m | green (high) | logged-out | **1/18/1** | PLAYER_BYTES, ABOVE_FEED, IN_PLAYER | midrolls at 775s/857s/1198s; preroll badge | OK |
| `iYlODtkyw_I` (rewatched ≥3×) | green (high) | logged-in | **absent** | – | none | OK |
| `__fmDj0ZJ1Q` MrBeast 32m | green (high) | logged-in | **1/14/1** (first load) → 0/14/1 (reload 5 min later) | full set on reload | midrolls played at 707s and 781s | OK |
| `kZwWv_2SDgU` Elisa True Crime 138m | yellow-class (low, off-dataset) | logged-in | **0/5/1** — no preroll placement | full set | one ad at t=0 (from adSlots) | OK |
| `TpTn5qhvXW8` Elisa True Crime 56m (2022) | yellow-class (low, off-dataset) | logged-in | **absent** | none | none | OK |
| `JM1G0BXHQyU` age-restricted trailer | special (high) | logged-in (adult) | **absent** | none | none | OK |
| `iwW3qjvkFZE` ZGN (channel removed from YPP 04/2026) | special (high) | logged-in | **absent** | none | none | OK |

## 3. Findings

1. **Signal A (player response) works and is rich.** In a real browser the full ad decision materializes: green videos carry `1 preroll + N midrolls + 1 postroll` placements plus `adSlots`. Midroll placement density on greens: **0.44–0.51/min** (14 mids/32min, 18/35min).
2. **Signal B (DOM) works and cross-confirms.** `ad-showing` start/end pairs carried correct content-time after the mid-roll attribution fix; every DOM ad matches a placement-bearing player response. Known gap: a preroll already playing when the observer attaches produces no start event (badge elements still betray it) — fix noted for Phase 1.
3. **Candidate green rule holds: 2/2.** `green = placements present + midroll placements if ≥ 8 min` → TP 2, FP 0, FN 0 (precision 1.0, recall 1.0, **n = 2**).
4. **Candidate yellow signature observed (uncalibrated).** Elisa True Crime, brutal-case content: recent video = **no preroll placement, midroll density 0.036/min (≈12× sparser than greens)**; older video = no placements at all. Exactly the "sporadic or absent" pattern SPEC §1.1 predicts for limited videos. Single channel, low-confidence labels: direction, not proof.
5. **Rewatch frequency capping is real and visible in-data.** The same green video lost its preroll placement on a reload 5 minutes later, and dropped to zero placements after 3–4 rewatches (logged-in). This explains the false "the account gets no ads" scare during smoke testing. **Consequences:** (a) absence evidence from a rewatch is worthless — the client should flag observations of videos in its recent local history; (b) control-video calibration (SPEC §3.4) must use videos the observer hasn't recently watched; (c) the existing consensus dedup (observer, video, 24h) is the right call.
6. **Specials behave as designed.** Age-restricted (logged-in adult): zero placements. Channel removed from YPP for inauthentic content: zero placements — note this contradicts the "YouTube may serve ads on non-YPP channels anyway" assumption for at least this enforcement category (n = 1).
7. **Server-side probing cannot substitute for in-browser measurement.** During dataset construction, logged-out datacenter fetches returned exactly one generic preroll placement for *every* video (MrBeast = Cocomelon = everything). Confirms the extension-in-real-browser architecture is the only viable measurement channel.
8. **Every measured video matched its expected pattern. Nothing contradicts the separation hypothesis.**

## 4. Provisional thresholds (to recalibrate when more data lands)

- `ADS_SERVED`: any content player response with `adPlacements` present, or any DOM ad event.
- Green pattern: preroll placement present AND (midroll placements > 0 if duration ≥ 480 s). Expected green midroll density ≈ 0.4–0.5/min.
- Candidate LIMITED pattern (**unvalidated**): placements present but no preroll placement AND midroll density < ~0.1/min; or placements entirely absent for a valid, non-rewatch observer.
- Observer validity: placements seen on ≥ 1 *fresh* known-green control video within the session; rewatches excluded.

## 5. Gate assessment (ROADMAP §0.4)

- "Green videos consistently show placements (≥ 80%)": **2/2 measured, 13/15 unmeasured** — criterion not evaluable at the required breadth.
- "Yellow videos show a clearly different pattern": **0 high-confidence yellows measured**; 2 low-confidence off-dataset yellows show the predicted deviation.

**Formal verdict: the §0.4 gate is not passed — not because the signal failed, but because coverage is insufficient. No measured datapoint contradicts the hypothesis; every one supports it.**

Closing the gate properly requires ≈ 15 minutes of logged-out incognito browsing (no account needed): the 5 high-confidence yellows (`pBpUC4Z-ZAY`, `7L5OgPRt4Jc`, `CRBa6t7u_lE`, `NCC6LGRHuR8`, `MSerFkLe5PI`) plus 3 not-yet-watched greens (`mvcesPWvUIc`, `h0EGCnBjTVk`, `l_UwsECR6cE`).

If the owner instead authorizes a **conditional GO**, the residual risk is: yellow-separation thresholds enter Phase 1 uncalibrated and may need rework once measured (the Phase 1 §1.5 manual checklist re-validates them; Phase 1 is local-only, so no shared-database pollution is possible). That authorization is the owner's call, recorded here either way.

## 6. Gate decision

**2026-07-03 — the owner authorized the conditional GO** ("if the data says we're on track, continue"). Recorded consequences:

- Phase 1 starts with the provisional thresholds in §4; the yellow/limited signature is a hypothesis to validate, not a calibrated rule.
- The owner will not run further manual collection passes. Yellow-class validation moves to the Phase 1 §1.5 manual checklist and to recruited beta testers (ROADMAP §2.5) before any Phase 2 consensus thresholds are frozen.
- Process note for future collection instructions: always hand testers full clickable `youtube.com/watch?v=…` URLs, never bare video IDs (bare IDs plus evidence links caused the owner to visit the evidence pages instead of the videos).
