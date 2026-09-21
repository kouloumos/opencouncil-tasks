#!/usr/bin/env python3
"""Turn reviewed document labels into meeting-level claims for opencouncil's
fixtures/minutes-golden.json (source: documents).

    build-minutes-golden.py <cityId>... > entries.json

For every fixture document that belongs to a production meeting of the given
cities, the claims a single decision extract can support: the opening roll
call (from the first document of the meeting whose roll-call label is
scoreable), the subject's outcome and its named non-FOR voters, and members
the page excludes from that vote. Nothing per subject is claimed about
presence unless the page states it.
"""
import json, sys, collections, re

from _paths import fixture, work

golden = json.load(open(fixture("extraction-golden.json")))
corpus = json.load(open(work("body-corpus-v5.json")))
cities = set(sys.argv[1:])

meeting_of = {}
for b in corpus["bodies"]:
    for smp in b["sample"]:
        if smp.get("meetingId"):
            meeting_of[smp["ada"]] = (b["cityId"], smp["meetingId"], smp.get("agendaItemIndex"), b["administrativeBody"]["name"])

VOTE = {"AGAINST": "against", "ABSTAIN": "blank", "PRESENT": "declaredPresent", "DID_NOT_VOTE": "declaredAbstain"}
scoreable = lambda v: v is True or v == "agreed"

by_meeting = collections.defaultdict(lambda: {"subjects": {}, "docs": []})
for c in golden["cities"]:
    if c["cityId"] not in cities: continue
    for b in c["bodies"]:
        for d in b["documents"]:
            m = meeting_of.get(d["ada"])
            if not m: continue
            city, mid, idx, body = m
            e = d["extraction"]
            entry = by_meeting[(city, mid)]
            entry["body"] = body
            entry["docs"].append(d["ada"])
            rc = e["rollCall"]
            if "rollCall" not in entry and scoreable(rc["verified"]) and (rc["presentMembers"] or rc["absentMembers"]):
                entry["rollCall"] = {"present": rc["presentMembers"], "absent": rc["absentMembers"], "fromAda": d["ada"]}
            v = e["votes"]
            claim = {"ada": d["ada"]}
            phrase = (v.get("phraseAsPrinted") or v.get("phraseAsExtracted") or "")
            if scoreable(v["verified"]):
                if re.search(r"ομ[οό]φων", phrase, re.I): claim["outcome"] = "unanimous"
                elif re.search(r"πλειοψηφ", phrase, re.I): claim["outcome"] = "majority"
                for vd in v["asExtracted"]:
                    k = VOTE.get(vd.get("vote"))
                    if k: claim.setdefault(k, []).append(vd["name"])
                if v.get("namedVoters") == "all":
                    claim["for"] = [vd["name"] for vd in v["asExtracted"] if vd.get("vote") == "FOR"]
            pva = e.get("perVoteAbsence")
            if pva and scoreable(pva["verified"]):
                claim["absent"] = pva["members"]
            key = str(idx) if idx is not None else f"OA?"
            if e["subject"].get("isOutOfAgenda") and e["subject"].get("agendaItemNumber"):
                key = f"OA{e['subject']['agendaItemNumber']}"
            entry["subjects"][key] = claim

out = []
for (city, mid), entry in sorted(by_meeting.items()):
    out.append({
        "cityId": city, "meetingId": mid, "source": "documents",
        "sourceRef": f"{entry['body']}; {', '.join(entry['docs'])}",
        **({"rollCall": entry["rollCall"]} if "rollCall" in entry else {}),
        "subjects": entry["subjects"],
    })
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
print(f"\n{len(out)} meetings, {sum(len(m['subjects']) for m in out)} subject claims", file=sys.stderr)
