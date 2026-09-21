#!/usr/bin/env python3
"""Build the per-body adjudication page: PDF beside observation, body questions to close.

Picks, per body, the documents that actually bear on its open questions rather than a
random slice — the ones carrying a late arrival (the only thing that tests what a present
list means), the ones dissenting from the body's dominant answers, and the ones holding a
rare fact. Then a couple of typical documents so the reviewer sees the ordinary case too.
"""
import json, hashlib, html, collections
from urllib.parse import quote

from _paths import script, work

obs = json.load(open(work("observations-sonnet.json")))
facts = {f"{b['cityId']}/{b['administrativeBody']['name']}": b for b in json.load(open(work("body-facts-sonnet.json")))["bodies"]}
corpus = {f"{b['cityId']}/{b['administrativeBody']['name']}": b for b in json.load(open(work("body-corpus-v3.json")))["bodies"]}

CITY = {
    "argithea": "Αργιθέα", "argos": "Άργος-Μυκήνες", "athens": "Αθήνα", "chalandri": "Χαλάνδρι",
    "chania": "Χανιά", "orestiada": "Ορεστιάδα", "piraeus": "Πειραιάς", "samothraki": "Σαμοθράκη",
    "sparta": "Σπάρτη", "thessaloniki": "Θεσσαλονίκη", "thira": "Θήρα", "vrilissia": "Βριλήσσια",
    "xylokastro": "Ξυλόκαστρο-Ευρωστίνη", "zografou": "Ζωγράφου",
    "papagos-cholargos": "Παπάγου-Χολαργού",
}

def pdf_name(ada):
    return hashlib.sha256(ada.encode()).hexdigest()[:16] + ".pdf"

def derived(o):
    """Mirrors lateArrivalIsInOpeningPresentSet in documentObservation.ts."""
    c = o.get("lateArrivalCheck")
    if not c:
        return None
    if o["rollCallForm"] in ("present_and_absent", "present_only"):
        if c["appearsInPresentList"] and c["appearsInAbsentList"]:
            return None  # self-contradictory: the name was never looked up
        return c["appearsInPresentList"]
    if o["rollCallForm"] == "composition_and_absent":
        if not c["appearsInCompositionRoster"]:
            return False
        return not c["appearsInAbsentList"]
    return None

RARE = ["perVoteAbsenceStated", "partialOrPerLineVote", "isAdvisoryOpinion",
        "withdrawnItemsStated", "embeddedOtherBodyDecision", "correctedRepost",
        "participationModePerMember", "substitutesPresent"]

bodies_out = []
for b in obs["bodies"]:
    key = f"{b['cityId']}/{b['administrativeBody']['name']}"
    f = facts[key]["facts"]
    meta = {d["ada"]: d for d in corpus[key]["sample"]}
    docs = [o for o in b["observations"] if o["observation"]["isDeliberativeDecision"]]
    notdec = [o for o in b["observations"] if not o["observation"]["isDeliberativeDecision"]]

    dom_pin = f["categories"]["attendanceChangePinnedTo"]["dominant"]
    dom_form = f["categories"]["rollCallForm"]["dominant"]
    ev = f["cumulativeEvidence"]
    majority = ev["cumulative"] > ev["openingOnly"]

    picked, reasons = [], {}
    def take(o, why, cap_key, cap):
        if o["ada"] in reasons or len([1 for a in reasons.values() if a[0] == cap_key]) >= cap:
            return
        reasons[o["ada"]] = (cap_key, why)
        picked.append(o)

    # Evidence that decides the roll-call question. Minority readings first: those are
    # where the body's own documents disagree, and where a misread would flip the answer.
    with_arrival = [o for o in docs if o["observation"].get("lateArrivalCheck")]
    minority = [o for o in with_arrival if derived(o["observation"]) is not majority]
    for o in minority:
        take(o, "tests the roll-call question, and reads against the body's majority", "arrival", 5)
    for o in with_arrival:
        take(o, "tests the roll-call question", "arrival", 8)

    for o in docs:
        x = o["observation"]
        if x["attendanceChangesStated"] and x["attendanceChangePinnedTo"] != dom_pin:
            take(o, f"pins a change to {x['attendanceChangePinnedTo']}, unlike the body's usual {dom_pin}", "pin", 3)
    for o in docs:
        if o["observation"]["rollCallForm"] != dom_form:
            take(o, f"reads as {o['observation']['rollCallForm']}, unlike the body's usual {dom_form}", "form", 2)
    for o in docs:
        hits = [r for r in RARE if o["observation"].get(r)]
        if hits:
            take(o, "carries " + ", ".join(hits[:3]), "rare", 4)
    for o in notdec:
        take(o, "read as NOT a deliberative decision, though it is linked to a subject", "notdec", 3)
    for o in docs:
        take(o, "a typical document of this body", "typical", 2)

    out_docs = []
    for o in picked:
        m = meta.get(o["ada"], {})
        out_docs.append({
            "ada": o["ada"], "pdf": "pdfs/" + pdf_name(o["ada"]), "pages": o["pages"],
            "why": reasons[o["ada"]][1], "kind": reasons[o["ada"]][0],
            "derived": derived(o["observation"]),
            "meetingDate": m.get("meetingDate"), "agendaItemIndex": m.get("agendaItemIndex"),
            "meetingId": m.get("meetingId"),
            "dbDecisionNumber": m.get("decisionNumber"), "alreadyExtracted": m.get("extracted"),
            "o": o["observation"],
        })

    # Does this body ever record an arrival? If it records changes but never an arrival,
    # the roll-call question may be moot rather than unanswered.
    changes = sum(1 for o in docs if o["observation"]["attendanceChangesStated"])

    # The substitution axis, which is NOT the same question as whether late
    # arrivals sit in the present list. A committee can list both the absent
    # regular member and the substitute standing in for them, so present plus
    # absent exceeds the body size while nothing at all is known about arrivals.
    subs = [o["observation"] for o in docs if o["observation"]["substitutesPresent"]]
    repl_yes = sum(1 for x in subs if x["replacedMemberAlsoListed"] is True)
    repl_no = sum(1 for x in subs if x["replacedMemberAlsoListed"] is False)
    sized = [o["observation"] for o in docs
             if o["observation"]["statedBodySize"] and o["observation"]["presentCount"] is not None
             and o["observation"]["absentCount"] is not None]
    over = sum(1 for x in sized
               if x["presentCount"] + x["absentCount"] > x["statedBodySize"])
    bodies_out.append({
        "key": key, "city": b["cityId"], "cityName": CITY.get(b["cityId"], b["cityId"]),
        "body": b["administrativeBody"]["name"], "corpusSize": b["corpusSize"],
        "read": len(docs), "notDecisions": len(notdec),
        "meetings": corpus[key]["meetings"], "meetingsSampled": corpus[key]["meetingsSampled"],
        "withChanges": changes, "withArrival": len(with_arrival),
        "withSubstitutes": len(subs), "replacedAlsoListed": repl_yes, "replacedNotListed": repl_no,
        "sizedDocs": len(sized), "countsExceedBodySize": over,
        "cumulative": ev["cumulative"], "openingOnly": ev["openingOnly"],
        "dominantPin": dom_pin, "pinDissent": round(f["categories"]["attendanceChangePinnedTo"]["dissent"] * 100),
        "dominantForm": dom_form, "formDissent": round(f["categories"]["rollCallForm"]["dissent"] * 100),
        "headings": f["headings"][:6],
        "presence": {k: round(v["percent"]) for k, v in f["presence"].items() if v["percent"] > 0},
        "docs": out_docs,
    })

bodies_out.sort(key=lambda b: (b["cityName"], b["body"]))
data = json.dumps({"bodies": bodies_out}, ensure_ascii=False)
# Written beside the intermediates, because the page loads the PDFs from a
# `pdfs/` directory next to itself.
tpl = open(script("adjudication-template.html")).read()
open(work("adjudicate.html"), "w").write(tpl.replace("__DATA__", data))
n = sum(len(b["docs"]) for b in bodies_out)
print(f"wrote adjudicate.html — {len(bodies_out)} bodies, {n} documents selected for review")
