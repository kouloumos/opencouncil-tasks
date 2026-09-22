#!/usr/bin/env python3
"""Generate the extraction fixture, seeded so that a review round completes it.

Shape follows the existing reading fixture — cities → bodies → documents — and
adds two things it does not have:

  conventions   per body. `presentMembers` means different things in different
                bodies, so a label for it cannot be scored without this.
  extraction    per document, only on the selected ones. Reading labels stay on
                all 282; extraction labels go on the 133 chosen for mechanism
                coverage, because labelling a roll call is not like labelling a
                date and the scorer runs a field subset anyway.

Every label carries its own `verified`, never one flag for the whole document:
  verified: true       a person confirmed it
  verified: "agreed"   the survey and the production extractor independently
                       agree; trustworthy enough to score against, not proof
  verified: false      contested, and waiting for the review round
"""
import json, collections

from _paths import fixture, work

sel = json.load(open(work("extraction-fixture-selection.json")))
gap = {r["ada"]: r for r in json.load(open(work("extraction-gap.json")))}
queue = {q["ada"]: q for q in json.load(open(work("review-queue.json")))["queue"]}
conv = {f"{b['city']}/{b['body']}": b
        for b in json.load(open(work("body-conventions-consolidated.json")))["bodies"]}
edge = {c["ada"]: c for c in json.load(open(work("edge-cases.json")))["cases"]}
reading = json.load(open(fixture("decision-reading-golden.json")))
in_reading = set()
for c in reading["cities"]:
    for b in c["bodies"]:
        for d in b["documents"]: in_reading.add(d["ada"])
    for d in c.get("otherDocuments", []): in_reading.add(d["ada"])

# Which fields each issue casts doubt on, so only the contested ones lose their seed.
DOUBTS = {
    "agenda item invented": ["subject"], "agenda item disagrees": ["subject"],
    "declaration stored as a vote": ["votes"], "declaration dropped": ["votes"],
    "named voters dropped": ["votes"], "vote tally dropped": ["votes"],
    "vote phrase missing": ["votes"], "agenda item missed": ["subject"],
    "present count disagrees": ["rollCall"], "absent count disagrees": ["rollCall"],
    "attendance change dropped": ["attendanceChanges"],
    "no decision text": ["excerpt"], "flagged truncated": ["excerpt"],
}

# The label's anchor vocabulary is the reader's, not the survey's. The reader
# spells session_phase as phase, and it keeps no clock-time anchor at all: a
# printed time is never an anchor, so such a change carries no reference the
# label can compare.
LABEL_ANCHOR = {"session_phase": "phase", "clock_time": "nothing"}


def seed(ada):
    """One document's extraction labels, seeded from the two readings."""
    r = gap[ada]
    o, e = r["obs"], r["extraction"]
    contested = set()
    for iss in queue.get(ada, {}).get("issues", []):
        contested.update(DOUBTS.get(iss["what"], []))
    def v(field):
        return False if field in contested else "agreed"
    return {
        "rollCall": {
            "layout": o["rollCallForm"],
            "headingsAsPrinted": o.get("rollCallHeadings") or [],
            "statedBodySize": o["statedBodySize"],
            "presentMembers": e.get("presentMembers") or [],
            "absentMembers": e.get("absentMembers") or [],
            "verified": v("rollCall"),
        },
        # A label either says the page records no change, and then carries neither
        # an anchor nor a list, or says it records some and carries both. The
        # survey's pinning is null exactly when it saw no change, so a stated
        # label that has no pinning states its change in prose: "nothing".
        "attendanceChanges": {
            "stated": True,
            "anchoredBy": LABEL_ANCHOR.get(o["attendanceChangePinnedTo"], o["attendanceChangePinnedTo"] or "nothing"),
            "asExtracted": [{"name": c.get("name"), "type": c.get("type"),
                             "agendaItem": c.get("agendaItem"), "timing": c.get("timing"),
                             "rawText": c.get("rawText")}
                            for c in (e.get("attendanceChanges") or [])],
            "verified": v("attendanceChanges"),
        } if o["attendanceChangesStated"] else {
            "stated": False,
            "verified": v("attendanceChanges"),
        },
        "votes": {
            "phraseAsPrinted": o["votePhrase"],
            "phraseAsExtracted": e.get("voteResult"),
            "carriesTally": o["votePhraseCarriesCounts"],
            "namedVoters": o["namedVoters"],
            "declarationsRecorded": o["declarationsRecorded"],
            "perLineVote": o["partialOrPerLineVote"],
            "asExtracted": [{"name": d.get("name"), "vote": d.get("vote")}
                            for d in (e.get("voteDetails") or [])],
            "verified": v("votes"),
        },
        "subject": {
            "agendaItemNumber": o["agendaItemNumber"],
            "isOutOfAgenda": o["isOutOfAgenda"],
            "asExtracted": e.get("subjectInfo"),
            "verified": v("subject"),
        },
        "excerpt": {
            "chars": len(e.get("decisionExcerpt") or ""),
            "extractionFlaggedIncomplete": bool(e.get("incomplete")),
            # Free text cannot be scored by equality. Holding today's output as a
            # regression baseline catches a future change without asking anyone to
            # read 133 excerpts; the ones extraction itself flagged, or returned
            # empty, are in the review queue and get a real verdict.
            "verified": False if ada in queue and any(
                i["what"] in ("no decision text", "flagged truncated")
                for i in queue[ada]["issues"]) else "baseline",
        },
        # Facts the page states that no field in the pipeline can hold today.
        # Not scoreable yet; they are the requirements list for the schema change.
        "statedButUnstorable": [k for k, present in [
            ("substitution", o["substitutesPresent"]),
            ("perVoteAbsence", o["perVoteAbsenceStated"]),
            ("participationMode", o["participationModePerMember"]),
            ("correctedRepost", o["correctedRepost"]),
            ("withdrawnItem", o["withdrawnItemsStated"]),
            ("advisoryAct", o["isAdvisoryOpinion"]),
            ("embeddedOtherBodyDecision", o["embeddedOtherBodyDecision"]),
            ("reordering", o["discussionOrderStated"]),
        ] if present],
    }

by_city = collections.defaultdict(lambda: collections.defaultdict(list))
for s in sel["selection"]:
    if s["ada"] not in gap:
        continue
    doc = {
        "ada": s["ada"],
        "pdfUrl": f"https://diavgeia.gov.gr/doc/{s['ada']}",
        "pages": s["pages"],
        "alsoInReadingFixture": s["ada"] in in_reading,
        "selectedBecause": s["covers"],
        "namedEdgeCase": edge.get(s["ada"], {}).get("why"),
        "needsReview": s["ada"] in queue,
        "extraction": seed(s["ada"]),
    }
    by_city[s["city"]][s["body"]].append(doc)

cities = []
for city in sorted(by_city):
    bodies = []
    for body in sorted(by_city[city]):
        c = conv.get(f"{city}/{body}", {})
        bodies.append({
            "name": body,
            "conventions": {
                "rollCallLayout": (c.get("rollCall") or {}).get("layout"),
                "headingsAsPrinted": (c.get("rollCall") or {}).get("headings"),
                "presentListMeaning": (c.get("rollCall") or {}).get("presentListMeaning"),
                "presentListEvidence": (c.get("rollCall") or {}).get("evidence"),
                "attendanceChangeAnchor": (c.get("attendanceChanges") or {}).get("anchor"),
                "usesSubstitutes": ((c.get("substitutes") or {}).get("documentsWithOne") or 0) > 0,
                "replacedMemberAlsoListed": ((c.get("substitutes") or {}).get("replacedMemberAlsoListed") or 0) > 0,
                "votes": c.get("votes"),
                "mayorPresenceStatedPct": c.get("mayorPresenceStatedPct"),
                "structuralNote": c.get("reviewNote"),
                "surveyWasCorrected": c.get("surveyWasWrong"),
                "casesMissingFromCorpus": c.get("casesMissingFromCorpus"),
                # The human reviewed these body by body; document labels depend on them.
                "verified": bool(c.get("reviewNote")),
            },
            "documents": sorted(bodies_docs := by_city[city][body], key=lambda d: d["ada"]),
        })
    cities.append({"cityId": city, "bodies": bodies})

out = {
    "version": 1,
    "description": (
        "Extraction fixture. Documents selected for mechanism coverage across every administrative "
        "body of the 12 supported municipalities, not inherited from the reading fixture's selection "
        "— of the 22 named edge cases that drove our conclusions, 13 are absent from it. Each document "
        "records why it was selected. Labels carry their own `verified`: true means a person confirmed "
        "it, \"agreed\" means the survey and the production extractor independently agree, false means "
        "contested and awaiting review. `statedButUnstorable` lists facts the page states that no field "
        "can hold; those are requirements, not labels."
    ),
    "generatedAt": "2026-09-13",
    "cities": cities,
}
path = work("extraction-fixture.json")
json.dump(out, open(path, "w"), ensure_ascii=False, indent=1)

docs = [d for c in cities for b in c["bodies"] for d in b["documents"]]
labels = collections.Counter()
for d in docs:
    for k in ("rollCall", "attendanceChanges", "votes", "subject", "excerpt"):
        labels[d["extraction"][k]["verified"]] += 1
print(f"wrote extraction-fixture.json")
print(f"  {len(cities)} cities · {sum(len(c['bodies']) for c in cities)} bodies · {len(docs)} documents")
print(f"  label states: {dict(labels)}")
print(f"  documents needing review: {sum(1 for d in docs if d['needsReview'])}")
print(f"  bodies with a verified convention: {sum(1 for c in cities for b in c['bodies'] if b['conventions']['verified'])}")
unst = collections.Counter(x for d in docs for x in d["extraction"]["statedButUnstorable"])
print(f"  unstorable facts present: {dict(unst.most_common())}")
