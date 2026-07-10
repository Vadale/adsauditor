# Fixtures

Real player-response JSON and DOM/beacon event captures used by `../fixtures.test.ts`
(docs/ROADMAP.md §1.5). `classifier.test.ts` still drives `classify()` with hand-built
synthetic events per SPEC §3.2 table row — these fixtures are the real-data cross-check
on top of that, converted from `spike/exports/*.json` (see `spike/RESULTS.md` §2 for the
human-readable summary each fixture cites).

Each file is `{ "_meta": {...}, "events": DetectionEvent[] }`. `_meta` documents: which
`spike/exports/` file and record timestamps the events came from, which real records were
omitted as redundant (and why), and any real-schema-to-type-shape conversions (e.g. the
raw export's `adPlacements[].offsetStartMs`/`offsetEndMs` are captured as STRINGS —
YouTube's protobuf-JSON int64-as-string encoding — and are numberified here to match
`AdPlacementItem`'s `number | null` field type). Nothing in `events` fabricates evidence
the spike didn't actually capture; where the real data doesn't support a scenario (e.g. no
logged-out/`LOGIN_REQUIRED` capture exists for the age-restricted video), the corresponding
fixture's `_meta.note` says so explicitly instead of synthesizing it.

| File                                      | Video (spike/RESULTS.md §2 row)                                          |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `green-mrbeast-iYlODtkyw_I.json`          | row 1 — logged-out fresh watch, 1 preroll/18 midroll/1 postroll          |
| `green-mrbeast-__fmDj0ZJ1Q.json`          | row 3 — first load 1/14/1, reload drops the preroll (0/14/1)             |
| `yellow-class-elisa-kZwWv_2SDgU.json`     | row 4 — candidate yellow/limited signature (uncalibrated), 0/5/1         |
| `rewatch-stripped-iYlODtkyw_I.json`       | row 2 (rewatch) — same green video, ≥3-4x rewatched, placements stripped |
| `special-age-restricted-JM1G0BXHQyU.json` | row 6 — age-restricted trailer, logged-in adult, zero placements         |
| `special-nonypp-iwW3qjvkFZE.json`         | row 7 — channel removed from YPP, zero placements                        |

No fixture here contains a `BEACON` event: the Phase 0 spike tool never captured source C
(verified — every `spike/exports/*.json` record is `type: "player_response"` or
`type: "dom_ad_event"`, never a beacon record).
