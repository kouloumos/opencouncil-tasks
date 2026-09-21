#!/usr/bin/env python3
"""Build the label-review page: the 39 documents where the two readings disagree.

Two independent readings of every page already exist — the survey (what the page
states) and the production extractor (what we store). Where they agree the label
can be seeded and spot-checked; where they disagree one of them is wrong, and
that disagreement is exactly what a person should spend time on. This page shows
both readings side by side against the PDF and records which is right.

The verdicts become the extraction fixture's labels.
"""
import json, hashlib

from _paths import script, work

queue = json.load(open(work("review-queue.json")))["queue"]
gap = {r["ada"]: r for r in json.load(open(work("extraction-gap.json")))}
edge = {c["ada"]: c for c in json.load(open(work("edge-cases.json")))["cases"]}

CITY = {"argithea": "Αργιθέα", "argos": "Άργος-Μυκήνες", "athens": "Αθήνα", "chalandri": "Χαλάνδρι",
        "chania": "Χανιά", "orestiada": "Ορεστιάδα", "papagos-cholargos": "Παπάγου-Χολαργού",
        "samothraki": "Σαμοθράκη", "sparta": "Σπάρτη", "vrilissia": "Βριλήσσια",
        "xylokastro": "Ξυλόκαστρο", "zografou": "Ζωγράφου"}

def short(b):
    return (b.replace("Δημοτικό Συμβούλιο", "Συμβούλιο").replace("Δημοτική Επιτροπή", "Επιτροπή")
             .replace("Δημοτική Κοινότητα", "Κοινότητα"))

docs = []
for q in queue:
    r = gap[q["ada"]]
    o, e = r["obs"], r["extraction"]
    docs.append({
        "ada": q["ada"], "city": q["city"], "cityName": CITY.get(q["city"], q["city"]),
        "body": short(q["body"]), "pages": q["pages"],
        "pdf": "pdfs/" + hashlib.sha256(q["ada"].encode()).hexdigest()[:16] + ".pdf",
        "topPriority": min(i["priority"] for i in q["issues"]),
        "issues": q["issues"],
        "edgeWhy": edge.get(q["ada"], {}).get("why"),
        # Both readings, field by field, so the reviewer judges evidence rather than a verdict.
        "survey": {
            "rollCallForm": o["rollCallForm"], "headings": o.get("rollCallHeadings") or [],
            "statedBodySize": o["statedBodySize"], "present": o["presentCount"], "absent": o["absentCount"],
            "votePhrase": o["votePhrase"], "namedVoters": o["namedVoters"],
            "declarations": o["declarationsRecorded"], "tally": o["votePhraseCarriesCounts"],
            "agendaItem": o["agendaItemNumber"], "outOfAgenda": o["isOutOfAgenda"],
            "decisionNumber": o["decisionNumberAsPrinted"],
            "changes": o["attendanceChangesStated"], "anchor": o["attendanceChangePinnedTo"],
            "perVoteAbsence": o["perVoteAbsenceStated"], "substitutes": o["substitutesPresent"],
        },
        "extraction": {
            "present": len(e.get("presentMembers") or []), "absent": len(e.get("absentMembers") or []),
            "presentNames": (e.get("presentMembers") or [])[:40],
            "absentNames": (e.get("absentMembers") or [])[:40],
            "voteResult": e.get("voteResult"),
            "voteDetails": [{"name": d.get("name"), "vote": d.get("vote")} for d in (e.get("voteDetails") or [])],
            "subjectInfo": e.get("subjectInfo"), "decisionNumber": e.get("decisionNumber"),
            "changes": [{"name": c.get("name"), "type": c.get("type"), "item": c.get("agendaItem"),
                         "timing": c.get("timing"), "raw": (c.get("rawText") or "")[:160]}
                        for c in (e.get("attendanceChanges") or [])],
            "excerptChars": len((e.get("decisionExcerpt") or "")),
            "excerptHead": (e.get("decisionExcerpt") or "")[:400],
            "incomplete": e.get("incomplete"),
        },
    })

order = {"P1": 0, "P2": 1, "P3": 2}
docs.sort(key=lambda d: (order[d["topPriority"]], d["city"], d["body"]))
data = json.dumps({"docs": docs, "clean": json.load(open(work("review-queue.json")))["cleanDocuments"]},
                  ensure_ascii=False)
# Written beside the intermediates, because the page loads the PDFs from a
# `pdfs/` directory next to itself.
tpl = open(script("label-review-template.html")).read()
open(work("label-review.html"), "w").write(tpl.replace("__DATA__", data))
print(f"wrote label-review.html — {len(docs)} documents, {sum(len(d['issues']) for d in docs)} issues")
