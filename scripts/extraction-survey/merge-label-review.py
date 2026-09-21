#!/usr/bin/env python3
"""Merge a label-review export into the extraction fixture.

    merge-label-review.py <export.json> <patches.json> <fixture.json>

The export carries the reviewer's verdict per issue. Verdicts settle direction,
not value: "survey is right" on a roll call says the extraction is wrong but
not who was present. The patches file carries the values, transcribed from the
page, keyed by ADA and field. Every contested label must end up either
patched, confirmed ("extraction is right"), or marked unresolvable — the
script refuses to leave one in the dark.

Label states after the merge:
  true            value confirmed; `review` records the verdicts and notes
  "unresolvable"  reviewed, and the page cannot settle it; excluded from scoring
  "agreed"/"baseline" untouched
"""
import json, sys, collections

export, patches, fixture_path = sys.argv[1:4]
export = json.load(open(export))["documents"]
patches = json.load(open(patches))
fixture = json.load(open(fixture_path))

FIELD_OF = {
    "agenda item invented": "subject", "agenda item disagrees": "subject", "agenda item missed": "subject",
    "declaration stored as a vote": "votes", "declaration dropped": "votes",
    "named voters dropped": "votes", "vote tally dropped": "votes", "vote phrase missing": "votes",
    "present count disagrees": "rollCall", "absent count disagrees": "rollCall",
    "attendance change dropped": "attendanceChanges",
    "no decision text": "excerpt", "flagged truncated": "excerpt",
}

docs = {d["ada"]: (city, body, d) for city in fixture["cities"] for body in city["bodies"] for d in body["documents"]}
stats = collections.Counter()
problems = []

for ada, rev in export.items():
    if ada not in docs:
        problems.append(f"{ada}: in export but not in fixture"); continue
    city, body, doc = docs[ada]
    patch = patches.get(ada, {})
    if "remove" in patch:
        body["documents"].remove(doc)
        stats["removed"] += 1
        continue
    ext = doc["extraction"]
    by_field = collections.defaultdict(list)
    for issue in rev["issues"]:
        by_field[FIELD_OF[issue["what"]]].append(issue)
    for field, issues in by_field.items():
        label = ext[field]
        label["review"] = [{"what": i["what"], "verdict": i["verdict"], "note": i["correctValue"]} for i in issues]
        p = patch.get(field)
        if p and "unresolvable" in p:
            label["verified"] = "unresolvable"
            label["review"].append({"what": "unresolvable", "verdict": None, "note": p["unresolvable"]})
            stats["unresolvable"] += 1
            continue
        verdicts = {i["verdict"] for i in issues}
        if p:
            label.update(p["set"])
            if p.get("note"): label["review"].append({"what": "transcribed", "verdict": None, "note": p["note"]})
            stats["patched"] += 1
        elif verdicts == {"extraction is right"}:
            # Subject labels were seeded from the survey; the other fields from the extraction.
            if field == "subject":
                ex = label.get("asExtracted")
                label["agendaItemNumber"] = ex.get("agendaItemIndex") if ex else None
                label["isOutOfAgenda"] = bool(ex and ex.get("nonAgendaReason") == "outOfAgenda")
            stats["confirmed"] += 1
        else:
            problems.append(f"{ada} {field}: verdicts {sorted(verdicts)} but no patch carries the value")
            continue
        label["verified"] = True
    # Fields the reviewer did not touch but the page settled while it was open.
    for field, p in patch.items():
        if field in ("remove", "perVoteAbsence") or field in by_field: continue
        ext[field].update(p["set"]); ext[field]["verified"] = True
        ext[field]["review"] = [{"what": "transcribed", "verdict": None, "note": p.get("note")}]
        stats["patched-untouched"] += 1
    if "perVoteAbsence" in patch:
        ext["perVoteAbsence"] = {**patch["perVoteAbsence"], "verified": True}
        if "perVoteAbsence" not in ext["statedButUnstorable"]: ext["statedButUnstorable"].append("perVoteAbsence")
        stats["per-vote absence recorded"] += 1
    doc["needsReview"] = False

for ada in patches:
    if ada not in export: problems.append(f"{ada}: patched but never reviewed")

remaining = [(d["ada"], f) for _, _, d in docs.values() for f in ("rollCall", "attendanceChanges", "votes", "subject", "excerpt")
             if d["extraction"][f]["verified"] is False and d["ada"] not in {a for a, _ in [(p, 0) for p in patches if "remove" in patches[p]]}]
if remaining: problems.append(f"{len(remaining)} labels still contested: {remaining[:5]}")

if problems:
    print("NOT WRITTEN:"); [print("  " + p) for p in problems]; sys.exit(1)

fixture["reviewedAt"] = "2026-09-13"
json.dump(fixture, open(fixture_path, "w"), ensure_ascii=False, indent=1)
n = sum(len(b["documents"]) for c in fixture["cities"] for b in c["bodies"])
print(f"wrote {fixture_path}: {n} documents")
for k, v in sorted(stats.items()): print(f"  {k}: {v}")
