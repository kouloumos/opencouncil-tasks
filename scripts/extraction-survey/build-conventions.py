#!/usr/bin/env python3
"""Consolidate the survey and the human review into one per-body convention record.

The survey (Sonnet over 1,023 documents) supplies frequencies and derived verdicts.
The review (the user, body by body) supplies corrections and structural notes that
no frequency can express. Where they conflict, the review wins and the conflict is
recorded rather than smoothed over — a disagreement between a measurement and a
person who read the page is information, not noise.
"""
import json, collections

from _paths import work

obs = json.load(open(work("observations-v5.json")))
facts = {f"{b['cityId']}/{b['administrativeBody']['name']}": b["facts"]
         for b in json.load(open(work("body-facts-v5.json")))["bodies"]}
corpus = {f"{b['cityId']}/{b['administrativeBody']['name']}": b
          for b in json.load(open(work("body-corpus-v5.json")))["bodies"]}

# Findings from the human review. Authoritative where they conflict with the survey.
REVIEW = {
  "argos/Δημοτικό Συμβούλιο": {
    "changeAnchor": "this_document",
    "note": "The roll call carries a third list, ΑΠΟΧΩΡΗΣΑΝΤΕΣ, beside ΠΑΡΟΝΤΕΣ and ΑΠΟΝΤΕΣ. It names those who had already left by the time of the decision this document records, and appears only in the documents of decisions the person missed. Per-decision attendance, stated directly. ΨΠ4ΗΩΨΔ-ΘΘΘ has one; Ψ7ΦΖΩΨΔ-ΥΦΘ does not.",
    "surveySaid": "pinned to nothing — wrong, and backwards: this is the most precisely placed form we have.",
  },
  "argos/Δημοτική Επιτροπή": {
    "note": "No attendance change of any kind in 40 documents. The two Argos bodies behave completely differently; the council's ΑΠΟΧΩΡΗΣΑΝΤΕΣ convention does not appear here.",
  },
  "athens/Δημοτικό Συμβούλιο": {
    "note": "Present and absent at the roll call, then a separate line per arrival and departure, each pinned to a decision number. Additionally «Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ ο κ. …»: temporarily out of the room for a RANGE of decisions, which is not a departure — after a departure the person is gone for everything following. Changes during out-of-agenda items name only the section, not the item.",
    "surveySaid": "the out-of-room range was captured only as free text; the structured per-vote-absence flag stayed false.",
  },
  "athens/Δημοτική Επιτροπή": {
    "note": "The σύνθεση is an invitation roster naming everyone summoned, regular and substitute. There is no attendance list at all, so composition minus absent includes people who arrived later. That is why it reads cumulative, and it is the mechanism that manufactures wrong vote lists.",
  },
  "argithea/Δημοτική Επιτροπή": {
    "note": "Present and absent lists, body of 5. No substitute appears anywhere in 33 documents even where members are absent — the case exists in principle but not in our corpus. Must be hunted on Diavgeia.",
    "missingCase": "a substitute",
  },
  "argithea/Δημοτικό Συμβούλιο": {
    "note": "Departures exist: 9ΗΧΧΩΨ3-3ΝΟ and Ρ09ΤΩΨ3-ΘΤΝ, two minority members walking out after the 8th item with a recorded statement of reasons. No arrival anywhere, so the present-list question is untestable from this corpus.",
  },
  "vrilissia/Δημοτική Επιτροπή": {
    "note": "Verbose form of the same pattern as Athens and Argos committees: «Συμμετέχοντες» and «Μη συμμετέχοντες-Απόντες», plus «Προσελεύσεις» and «Αποχωρήσεις». Substitutes appear under Συμμετέχοντες and the members they replace under Μη συμμετέχοντες.",
  },
  "vrilissia/Δημοτικό Συμβούλιο": {
    "note": "Present and absent roll call at the start, then arrivals and departures per subject.",
  },
  "zografou/Δημοτική Επιτροπή": {
    "note": "Lists all members first, regular and substitute, then present and absent. More verbose than others about whether the mayor was present.",
  },
  "zografou/Δημοτικό Συμβούλιο": {
    "note": "Same shape as the committee. States reordering of subjects when it happens — worth holding in the fixture even though our ordering comes from the transcript.",
  },
  "xylokastro/Δημοτική Επιτροπή": {
    "note": "Clear ΠΑΡΟΝΤΕΣ and ΑΠΟΝΤΕΣ listing, inline. No notion of arrivals or departures at all: none in 40 documents across 24 meetings.",
  },
  "xylokastro/Δημοτικό Συμβούλιο": {
    "note": "Present and absent at the start, arrivals and departures pinned to the agenda item.",
  },
  "orestiada/Δημοτικό Συμβούλιο": {
    "note": "Arrivals annotated inline inside the absent list, «(Προσήλθε στο 2ο Θέμα)». No departure found anywhere. The decision body includes transcript excerpts of the voting itself — ΨΧ6ΛΩΞΒ-Ν1Ο is a good example. Applies ministerial circular 108/2019, under which votes against a sole proposal count as άκυρες ψήφοι rather than opposition.",
  },
  "papagos-cholargos/Δημοτικό Συμβούλιο": {
    "note": "Present and absent in the roll call, then separate lines for arrivals and departures.",
  },
  "papagos-cholargos/Δημοτική Επιτροπή": {
    "note": "Present and absent, but no absent example in our corpus. Expected to follow the substitution pattern of other committees; unverified.",
    "missingCase": "a substitute",
  },
  "samothraki/Δημοτικό Συμβούλιο": {
    "note": "Present and absent. No arrival or departure example anywhere.",
  },
  "samothraki/Δημοτική Επιτροπή": {
    "note": "Present and absent, no substitute example. Only 10 documents from 2 meetings.",
    "missingCase": "a substitute",
  },
  "sparta/Δημοτικό Συμβούλιο": {
    "note": "Present and absent, distinguishing physical from remote attendance (not something we need). Separate «προσελεύσεις-αποχωρήσεις» section. ΨΙΛΝΩ1Ν-ΞΒ8 is the hard case: the mayor is absent and RETURNS during item 3, and the same document records a change in discussion order.",
  },
  "chalandri/Δημοτικό Συμβούλιο": {
    "note": "Present, absent, and distinct sections for arrivals and departures. The mayor-president is on his own line among the present. At the end of the document it names every member present for that specific decision — so Chalandri, like Argos, states per-decision attendance directly.",
  },
  "chalandri/Δημοτική Επιτροπή": {
    "presentListMeaning": "opening roll call only",
    "note": "ΣΥΜΜΕΤΕΧΟΝΤΕΣ is an attendance list and does NOT contain late arrivals. In ΨΥ8ΨΩΗΔ-Υ7Κ, Ευθυμίου arrives during item 7 as a substitute for Λυμπεράτος and appears nowhere in it, while Λυμπεράτος sits in ΜΗ ΣΥΜΜΕΤΕΧΟΝΤΕΣ. Confirmed by reading the page.",
    "surveySaid": "cumulative on all 5 documents under Haiku — wrong. Sonnet corrects it to opening-only.",
  },
  "chania/Δημοτική Επιτροπή": {
    "presentListMeaning": "opening roll call only",
    "note": "ΠΑΡΟΝΤΕΣ is the opening attendance and already includes substitutes WITHOUT marking them; the substitution is explained in prose below. The ΑΠΟΝΤΕΣ list is incomplete: an absent regular member replaced by a substitute can appear in neither list, and this does not show up as an arithmetic mismatch against the stated body size. OPEN QUESTION for the municipality.",
    "surveySaid": "contested 11:7 under Haiku — wrong. Sonnet corrects it to opening-only 1:18.",
  },
  "chania/Δημοτικό Συμβούλιο": {
    "note": "ΣΥΝΘΕΣΗ with all members, and «Απουσίαζαν καθ' όλη τη διάρκεια της συνεδρίασης οι …» in the same paragraph with no section boundary. Arrivals and departures pinned to decision numbers. Out-of-agenda items announced up front: «Οι υπ' αριθμ. 1/2025 έως και 3/2025 αποφάσεις συζητήθηκαν ομόφωνα εκτός ημερήσιας διάταξης». The 4 documents reporting substitutes all embed another body's decision — reader leakage, discard.",
  },
}

GLOBAL = [
  "Councils never use substitutes; committees do. Any council substitute in the data is leakage from an embedded decision of another body.",
  "The mayor's presence or absence is stated separately in essentially every body. The fixture needs one present and one absent example per body.",
  "The layout predicts what a present list means better than the body type does. With an explicit ΠΑΡΟΝΤΕΣ list it is the opening roll call in 5 of 7 bodies. With a roster plus absentees it depends on whether the absent list names people who later arrived.",
]

def verdict_state(f):
    ev = f["cumulativeEvidence"]; n = ev["cumulative"] + ev["openingOnly"]
    if n == 0: return "untested", ev
    if n < 5: return "thin", ev
    sh = ev["cumulative"] / n
    if sh > 0.8: return "cumulative", ev
    if sh < 0.2: return "opening roll call only", ev
    return "contested", ev

CASES = [("an arrival", lambda x: x["lateArrivalCheck"] is not None),
         ("a departure", lambda x: x["attendanceChangesStated"] and x["lateArrivalCheck"] is None),
         ("a substitute", lambda x: x["substitutesPresent"]),
         ("named dissenters", lambda x: x["namedVoters"] != "none"),
         ("a vote tally", lambda x: x["votePhraseCarriesCounts"]),
         ("a declaration", lambda x: x["declarationsRecorded"]),
         ("mayor presence stated", lambda x: x["mayorPresenceStated"]),
         ("reordering", lambda x: x["discussionOrderStated"]),
         ("an out-of-agenda item", lambda x: x["isOutOfAgenda"]),
         ("a per-vote absence", lambda x: x["perVoteAbsenceStated"])]

out = []
for b in obs["bodies"]:
    key = f"{b['cityId']}/{b['administrativeBody']['name']}"
    f = facts[key]; rev = REVIEW.get(key, {})
    docs = [o["observation"] for o in b["observations"] if o["observation"]["isDeliberativeDecision"]]
    n = len(docs) or 1
    state, ev = verdict_state(f)
    missing = [name for name, fn in CASES if not any(fn(x) for x in docs)]
    votes = collections.Counter(x["namedVoters"] for x in docs)
    out.append({
        "city": b["cityId"], "body": b["administrativeBody"]["name"],
        "corpusSize": b["corpusSize"], "documentsRead": len(docs),
        "meetingsSampled": corpus[key]["meetingsSampled"], "meetingsTotal": corpus[key]["meetings"],
        "rollCall": {
            "layout": f["categories"]["rollCallForm"]["dominant"],
            "layoutDissentPct": round(f["categories"]["rollCallForm"]["dissent"] * 100),
            "headings": [h["heading"] for h in f["headings"][:5]],
            "presentListMeaning": rev.get("presentListMeaning", state),
            "evidence": f"{ev['cumulative']} cumulative : {ev['openingOnly']} opening-only",
        },
        "attendanceChanges": {
            "documentsRecordingOne": sum(1 for x in docs if x["attendanceChangesStated"]),
            "anchor": rev.get("changeAnchor", f["categories"]["attendanceChangePinnedTo"]["dominant"]),
            "anchorDissentPct": round(f["categories"]["attendanceChangePinnedTo"]["dissent"] * 100),
        },
        "substitutes": {
            "documentsWithOne": sum(1 for x in docs if x["substitutesPresent"]),
            "replacedMemberAlsoListed": sum(1 for x in docs if x["replacedMemberAlsoListed"] is True),
            "replacedMemberNotListed": sum(1 for x in docs if x["replacedMemberAlsoListed"] is False),
        },
        "votes": {
            "phraseStatedPct": round(100 * sum(1 for x in docs if x["votePhraseStated"]) / n),
            "carriesTallyPct": round(100 * sum(1 for x in docs if x["votePhraseCarriesCounts"]) / n),
            "namedVoters": {"never": votes["none"], "dissentersOnly": votes["dissenters_only"], "everyVoter": votes["all"]},
            "declarationsPct": round(100 * sum(1 for x in docs if x["declarationsRecorded"]) / n),
            "partialVotesPct": round(100 * sum(1 for x in docs if x["partialOrPerLineVote"]) / n),
        },
        "mayorPresenceStatedPct": round(100 * sum(1 for x in docs if x["mayorPresenceStated"]) / n),
        "casesMissingFromCorpus": missing,
        "reviewNote": rev.get("note"),
        "surveyWasWrong": rev.get("surveySaid"),
    })

out.sort(key=lambda b: (b["city"], b["body"]))
json.dump({
    "generatedAt": "2026-09-13",
    "source": "Sonnet survey of 1,023 documents across 30 bodies, plus a body-by-body human review",
    "globalRules": GLOBAL,
    "bodies": out,
}, open(work("body-conventions-consolidated.json"), "w"), ensure_ascii=False, indent=1)
print(f"wrote body-conventions-consolidated.json — {len(out)} bodies")
print(f"  with a human review note: {sum(1 for b in out if b['reviewNote'])}")
print(f"  where the survey was corrected: {sum(1 for b in out if b['surveyWasWrong'])}")
print(f"  total missing cases to hunt: {sum(len(b['casesMissingFromCorpus']) for b in out)}")
