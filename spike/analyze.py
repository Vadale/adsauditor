#!/usr/bin/env python3
"""Phase 0 spike analysis (ROADMAP.md section 0.3).

Cross-references spike exports against the labeled dataset and reports,
per video and per observer session (logged-in vs logged-out):
  - Signal A: adPlacements structure (pre/mid/post), adSlots types
  - Signal B: DOM ad events actually observed (preroll/midroll)
  - playabilityStatus
Then evaluates the candidate classification rule from ROADMAP 0.3:
  green = placements present AND (midroll placement present if duration >= 8 min)
and computes precision/recall over calibration-grade (confidence=high) labels.

Observer validity (SPEC 3.4, applied to the spike itself): a session type
(logged-in / logged-out) is a VALID observer only if it saw ad placements on at
least one known-green control video. Sessions that fail this are NO_SIGNAL and
are excluded from rule evaluation (their absences are meaningless).

Usage: python3 analyze.py dataset.json export1.json [export2.json ...]
"""
import json
import sys
from collections import defaultdict

MIDROLL_ELIGIBLE_S = 480  # 8 minutes
PREROLL_MAX_CONTENT_TIME_S = 5.0


def load_exports(paths):
    records = []
    for p in paths:
        with open(p) as f:
            records.extend(json.load(f))
    return records


def is_content_pr(r):
    """True for player responses that belong to the video actually on screen
    (excludes homepage/feed prefetches and the ad creatives' own player
    responses, which carry a videoId different from the page's)."""
    if r.get("type") != "player_response":
        return False
    vid = r.get("videoId")
    page = r.get("pageVideoId")
    if not vid:
        return False
    # Old-code exports lack pageVideoId; for those, only trust the capture
    # paths that structurally read the page's own player.
    if "pageVideoId" not in r:
        return r.get("capturePath") in ("initial", "getPlayerResponse")
    return vid == page


def session_key(r):
    return "logged_in" if r.get("loggedIn") else "logged_out"


def parse_ts(r):
    from datetime import datetime
    t = r.get("storedAt") or r.get("timestamp")
    return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() if t else None


def dom_session_resolver(records):
    """dom_ad_event records carry no loggedIn flag (spike tool limitation):
    attribute each DOM event to the session of the nearest-in-time content
    player response for the same video."""
    pr_times = defaultdict(list)  # videoId -> [(ts, session)]
    for r in records:
        if is_content_pr(r):
            ts = parse_ts(r)
            if ts:
                pr_times[r["videoId"]].append((ts, session_key(r)))
    def resolve(vid, ts):
        cands = pr_times.get(vid)
        if not cands or ts is None:
            return None
        return min(cands, key=lambda c: abs(c[0] - ts))[1]
    return resolve


def aggregate(records):
    """-> {videoId: {session: evidence}}"""
    resolve_dom_session = dom_session_resolver(records)
    ev = defaultdict(lambda: defaultdict(lambda: {
        "pre": 0, "mid": 0, "post": 0, "placements_present": False,
        "slot_types": set(), "playability": set(), "capture_paths": set(),
        "duration": None,
        "dom_ads_started": set(), "dom_preroll": False, "dom_midroll": False,
        "dom_badge": False,
    }))
    for r in records:
        if is_content_pr(r):
            e = ev[r["videoId"]][session_key(r)]
            ap = r.get("adPlacements", {})
            kinds = [k for k in ap.get("kinds", []) if k]
            e["pre"] = max(e["pre"], sum("START" in k and "SELF" not in k for k in kinds))
            e["mid"] = max(e["mid"], sum("MILLISECONDS" in k for k in kinds))
            e["post"] = max(e["post"], sum(k.endswith("_END") for k in kinds))
            e["placements_present"] |= bool(ap.get("present"))
            e["slot_types"] |= set(r.get("adSlots", {}).get("types", []))
            if r.get("playabilityStatusValue"):
                e["playability"].add(r["playabilityStatusValue"])
            e["capture_paths"].add(r.get("capturePath"))
            if r.get("durationSeconds"):
                e["duration"] = r["durationSeconds"]
        elif r.get("type") == "dom_ad_event":
            vid = r.get("watchUrlVideoId") or r.get("pageVideoId")
            if not vid:
                continue
            session = resolve_dom_session(vid, parse_ts(r))
            if session is None:
                continue
            e = ev[vid][session]
            t = r.get("currentTimeSeconds") or 0.0
            if r.get("event") in ("ad-showing-start", "ad-interrupting-start"):
                e["dom_ads_started"].add(round(t))  # distinct ad breaks by content time
                if t <= PREROLL_MAX_CONTENT_TIME_S:
                    e["dom_preroll"] = True
                else:
                    e["dom_midroll"] = True
            elif r.get("event") == "ad-badge-element-seen":
                # Weak evidence: catches prerolls already showing when the
                # observer attached (MutationObserver misses pre-existing state)
                e["dom_badge"] = True
    return ev


def observer_validity(ev, labels):
    """Per session type: valid iff placements seen on >= 1 high-confidence green."""
    valid = {}
    for session in ("logged_in", "logged_out"):
        greens_seen = [v for v, lab in labels.items()
                       if lab["expected"] == "green" and lab["confidence"] == "high"
                       and session in ev.get(v, {})]
        if not greens_seen:
            valid[session] = None  # no control video observed -> unknown
        else:
            valid[session] = any(ev[v][session]["placements_present"] for v in greens_seen)
    return valid


def rule_green(e, duration):
    if not e["placements_present"]:
        return False
    if duration and duration >= MIDROLL_ELIGIBLE_S:
        return e["mid"] > 0
    return True


def main():
    dataset_path, *export_paths = sys.argv[1:]
    ds = json.load(open(dataset_path))
    labels = {v["videoId"]: v for v in ds["videos"]}
    records = load_exports(export_paths)
    ev = aggregate(records)
    validity = observer_validity(ev, labels)

    print(f"records: {len(records)}   videos with evidence: {len(ev)}")
    print(f"observer validity: {validity}  (False => that session is NO_SIGNAL, "
          f"absences not usable)")
    print()
    hdr = (f"{'videoId':13} {'expected':8} {'conf':6} {'session':10} "
           f"{'plc pre/mid/post':16} {'slots':18} {'DOM pre/mid':11} "
           f"{'playability':14} title")
    print(hdr)
    print("-" * len(hdr))
    for vid, lab in labels.items():
        if vid not in ev:
            continue
        for session, e in sorted(ev[vid].items()):
            plc = (f"{e['pre']}/{e['mid']}/{e['post']}"
                   if e["placements_present"] else "absent")
            dom = (f"{'Y' if e['dom_preroll'] else ('b' if e['dom_badge'] else '-')}"
                   f"/{'Y' if e['dom_midroll'] else '-'}")
            slots = ",".join(sorted(t.replace("SLOT_TYPE_", "") for t in e["slot_types"])) or "-"
            print(f"{vid:13} {lab['expected']:8} {lab['confidence']:6} {session:10} "
                  f"{plc:16} {slots:18} {dom:11} "
                  f"{','.join(sorted(e['playability'])) or '?':14} "
                  f"{lab['title'][:34]}")
    extra = sorted(set(ev) - set(labels))
    if extra:
        print()
        print("visited but not in dataset:")
        for vid in extra:
            for session, e in sorted(ev[vid].items()):
                plc = (f"{e['pre']}/{e['mid']}/{e['post']}"
                       if e["placements_present"] else "absent")
                print(f"  {vid} {session}: placements {plc}, "
                      f"DOM pre/mid {e['dom_preroll']}/{e['dom_midroll']}, "
                      f"playability {','.join(sorted(e['playability'])) or '?'}")

    # Rule evaluation on calibration-grade labels, valid observers only
    print()
    tp = fp = fn = tn = 0
    evaluated = unmeasured = []
    evaluated, unmeasured = [], []
    for vid, lab in labels.items():
        if lab["expected"] not in ("green", "yellow") or lab["confidence"] != "high":
            continue
        sessions = [s for s in ev.get(vid, {}) if validity.get(s)]
        if not sessions:
            unmeasured.append((vid, lab["expected"]))
            continue
        # Merge evidence across valid sessions: a per-observer ad decision can
        # be suppressed situationally (e.g. rewatch frequency capping zeroed
        # the logged-in MrBeast placements), so absence in one session must not
        # veto presence in another.
        e = {
            "placements_present": any(ev[vid][s]["placements_present"] for s in sessions),
            "pre": max(ev[vid][s]["pre"] for s in sessions),
            "mid": max(ev[vid][s]["mid"] for s in sessions),
            "post": max(ev[vid][s]["post"] for s in sessions),
            "duration": next((ev[vid][s]["duration"] for s in sessions
                              if ev[vid][s]["duration"]), None),
        }
        pred_green = rule_green(e, e["duration"] or lab.get("durationS"))
        actual_green = lab["expected"] == "green"
        evaluated.append((vid, lab["expected"], pred_green))
        tp += pred_green and actual_green
        fp += pred_green and not actual_green
        fn += (not pred_green) and actual_green
        tn += (not pred_green) and (not actual_green)
    print(f"rule 'green = placements present + midroll if >=8min' on "
          f"high-confidence green/yellow labels, valid observers only:")
    print(f"  evaluated: {len(evaluated)}  TP:{tp} FP:{fp} FN:{fn} TN:{tn}")
    if tp + fp:
        print(f"  precision(green): {tp/(tp+fp):.2f}")
    if tp + fn:
        print(f"  recall(green):    {tp/(tp+fn):.2f}")
    print(f"  UNMEASURED by any valid observer: {len(unmeasured)} -> {unmeasured}")


if __name__ == "__main__":
    main()
