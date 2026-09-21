#!/usr/bin/env python3
"""Compare what a page states against what the production extractor stores.

Three kinds of difference, and they need different fixes:
  MISSED      the page states it, the schema has a field, extraction returned nothing
  DEGRADED    extraction returned it but lost the part that makes it usable
  NO FIELD    the page states it and nothing in the schema can hold it
"""
import json, collections

from _paths import work

rows = json.load(open(work("extraction-gap.json")))

def check(r):
    """Yield (kind, fact, detail) for one document."""
    o, e = r["obs"], r.get("extraction")
    if not r["ok"] or e is None:
        yield ("FAILED", "extraction", r.get("error", "")[:80]); return

    # --- attendance changes -------------------------------------------------
    changes = e.get("attendanceChanges") or []
    if o["attendanceChangesStated"] and not changes:
        yield ("MISSED", "attendance change", "page records one, extraction returned none")
    if changes:
        unpinned = [c for c in changes if c.get("agendaItem") is None]
        anchor = o.get("attendanceChangePinnedTo")
        if unpinned and anchor in ("decision_number", "this_document", "clock_time", "session_phase"):
            yield ("NO FIELD", f"change anchored by {anchor}",
                   f"{len(unpinned)} of {len(changes)} arrive with agendaItem null and are then treated as present throughout")

    # --- the roll call ------------------------------------------------------
    pres = len(e.get("presentMembers") or [])
    absent = len(e.get("absentMembers") or [])
    if o["presentCount"] is not None and pres and abs(pres - o["presentCount"]) > 1:
        yield ("DEGRADED", "present count", f"page {o['presentCount']}, extraction {pres}")
    if o["absentCount"] is not None and absent and abs(absent - o["absentCount"]) > 1:
        yield ("DEGRADED", "absent count", f"page {o['absentCount']}, extraction {absent}")
    if (o["presentCount"] or 0) > 0 and pres == 0:
        yield ("MISSED", "present list", "page lists members, extraction returned none")

    # --- votes --------------------------------------------------------------
    details = e.get("voteDetails") or []
    if o["namedVoters"] != "none" and not details:
        yield ("MISSED", "named voters", f"page names voters ({o['namedVoters']}), extraction returned none")
    if o["votePhraseStated"] and not (e.get("voteResult") or "").strip():
        yield ("MISSED", "vote phrase", f"page states «{(o.get('votePhrase') or '')[:40]}»")
    if o["votePhraseCarriesCounts"]:
        vr = e.get("voteResult") or ""
        if not any(ch.isdigit() for ch in vr):
            yield ("DEGRADED", "vote tally", f"page states a count, stored phrase «{vr[:40]}» carries none")
    if o["declarationsRecorded"] and not any(d.get("vote") in ("PRESENT", "DID_NOT_VOTE") for d in details):
        yield ("MISSED", "ΠΑΡΩΝ / ΑΠΟΧΗ declaration", "page records one, no declaration in voteDetails")
    if o["partialOrPerLineVote"]:
        yield ("NO FIELD", "per-line or two-part vote", "one position per decision cannot express it")

    # --- everything with no field at all ------------------------------------
    if o["perVoteAbsenceStated"]:
        yield ("NO FIELD", "absence for one vote only", "changes who voted on that item; nothing holds it")
    if o["substitutesPresent"]:
        yield ("NO FIELD", "substitution", "who replaced whom is not representable")
    if o["participationModePerMember"]:
        yield ("NO FIELD", "participation mode", "in person vs remote, per member")
    if o["correctedRepost"]:
        yield ("NO FIELD", "ΟΡΘΗ ΕΠΑΝΑΛΗΨΗ", "supersedes an earlier publication")
    if o["withdrawnItemsStated"]:
        yield ("NO FIELD", "withdrawn agenda item", "a subject that will never have a decision")
    if o["isAdvisoryOpinion"]:
        yield ("NO FIELD", "ΓΝΩΜΟΔΟΤΕΙ, an advisory act", "not a decision; the decision marker does not fire")

    # --- subject identity ---------------------------------------------------
    si = e.get("subjectInfo")
    if o["agendaItemNumber"] is not None and si is None:
        yield ("MISSED", "agenda item number", f"page states item {o['agendaItemNumber']}")
    if o["agendaItemNumber"] is None and si is not None:
        yield ("DEGRADED", "agenda item number", f"page states none, extraction invented #{si.get('agendaItemIndex')}")
    if si and o["agendaItemNumber"] is not None and si.get("agendaItemIndex") != o["agendaItemNumber"]:
        yield ("DEGRADED", "agenda item number", f"page {o['agendaItemNumber']}, extraction {si.get('agendaItemIndex')}")

    # --- the decision text --------------------------------------------------
    if not (e.get("decisionExcerpt") or "").strip():
        yield ("MISSED", "decision text", "extraction returned an empty excerpt")
    if e.get("incomplete"):
        yield ("DEGRADED", "decision text", "extraction flagged the document as truncated")

kinds = collections.Counter()
facts = collections.Counter()
per_body = collections.defaultdict(collections.Counter)
examples = collections.defaultdict(list)
for r in rows:
    body = f"{r['city']}/{r['body']}".replace("Δημοτικό Συμβούλιο", "ΔΣ").replace("Δημοτική Επιτροπή", "ΔΕ").replace("Δημοτική Κοινότητα", "ΔΚ")
    for kind, fact, detail in check(r):
        kinds[kind] += 1
        facts[(kind, fact)] += 1
        per_body[body][kind] += 1
        if len(examples[(kind, fact)]) < 3:
            examples[(kind, fact)].append(f"{body} {r['ada']}: {detail}")

print(f"{len(rows)} documents compared against what the page states\n")
for k, n in kinds.most_common():
    print(f"  {k:10} {n}")
print(f"\n{'kind':10} {'count':>6}  fact")
print("-" * 78)
for (kind, fact), n in facts.most_common():
    print(f"{kind:10} {n:>6}  {fact}")
print("\nExamples of the worst three:")
for (kind, fact), n in facts.most_common(3):
    print(f"\n  {kind} · {fact}")
    for ex in examples[(kind, fact)]:
        print(f"    {ex}")
print(f"\n{'body':22}{'MISSED':>8}{'DEGRADED':>10}{'NO FIELD':>10}")
print("-" * 50)
for body in sorted(per_body):
    c = per_body[body]
    print(f"{body[:21]:22}{c['MISSED']:>8}{c['DEGRADED']:>10}{c['NO FIELD']:>10}")
