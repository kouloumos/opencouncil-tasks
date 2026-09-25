# Decision Extraction Evaluation

`pollDecisions` extracts what the minutes print out of a decision PDF: who was present, who arrived or left and when, how the vote went and who dissented, which agenda item it belongs to, and the decision text. A wrong extraction prints a wrong fact under a councillor's name. This document explains the golden fixture that holds the expected values and the command that scores the extractor against it.

The reading fixture (`docs/decision-reading-eval.md`) covers the two facts that attach a document to a meeting. This one covers everything after that.

Extractor: `extractDecisionFromPdf()`
Fixture: `fixtures/extraction-golden.json`
Command: `evaluate-decision-extraction` in `src/cli.ts`
Scorer: `src/tasks/utils/extractionScoring.ts`

## Run the evaluation

```bash
npx tsx src/cli.ts evaluate-decision-extraction fixtures/extraction-golden.json
```

| Option | Purpose |
| --- | --- |
| `-c, --concurrency <n>` | Parallel extractions. The default is 4. |
| `-l, --limit <n>` | Extract only the first N documents. Use this to control cost. |
| `--skip-cache` | Ignore cached extractions. The command calls the model again. |
| `--hints-file <file>` | Per-body conventions text, as opencouncil's `scripts/conventions-text.ts --all` prints it. |
| `-O, --output-file <file>` | Write per-document scores as JSON. |

Extractions are cached under the canonical ADA URL and the two inputs that steer a reading: the conventions text and the mayor's name. The scorer sends no mayor name and `pollDecisions` sends one, so the two keep separate entries. A second scoring run with the same `--hints-file` costs nothing. Add `--skip-cache` after you change the prompt or the schema.

`pollDecisions` always sends `conventionsText`. Without `--hints-file` the command therefore scores a reader production never runs. opencouncil owns the glossary. Its `scripts/conventions-text.ts --all` prints the file, one block per body:

```
### argos/Δημοτικό Συμβούλιο
<the sentences the poll request carries for this body>
```

The command reports how many bodies the file covers and names the ones it reads cold.

## What the fixture contains

140 documents across all 31 administrative bodies of the 12 supported municipalities, chosen for mechanism coverage rather than inherited from the reading fixture: every roll-call layout, every way an attendance change is anchored, substitutions, declarations, per-line votes, corrected reposts. Each document records why it was selected. `fixtures/extraction-edge-cases.json` names the ones that drove a conclusion.

```
cities[]
  cityId
  bodies[]
    name
    conventions        what this body's documents do: roll-call layout, what the present
                       list means, how changes are anchored, whether substitutes appear
    documents[]
      ada, pdfUrl, pages
      selectedBecause[]      the mechanisms this document covers
      namedEdgeCase          why it matters, when it does
      extraction
        rollCall             layout, headings as printed, stated body size, present, absent
        attendanceChanges    stated, anchoredBy, the changes
        votes                phrase as printed, carriesTally, namedVoters, declarations, voters
        subject              agendaItemNumber, isOutOfAgenda
        excerpt              length baseline, whether extraction flagged it incomplete
        statedButUnstorable  facts the page states that no field can hold today
```

Every label carries its own `verified`, never one flag per document:

| `verified` | Meaning | Scored? |
| --- | --- | --- |
| `true` | A person read the page and confirmed the value. | yes |
| `"adjudicated"` | `adjudicate-extraction` read the page and settled it; the label carries `evidence` — the verbatim quote, its ADA and page, and when. Stronger than `"agreed"`, which two readings can reach while sharing a blind spot. | yes |
| `"agreed"` | Two independent readings of the page — the survey (`docs/body-profiles.md`) and the production extractor — returned the same value. Trustworthy, not proof. | yes |
| `"baseline"` | Free text held at today's value to catch a regression, not to assert correctness. | as changed-or-not |
| `"unresolvable"` | A person reviewed it and the page cannot settle it — a corrected repost whose other ADA holds the truth, a vote value no field can express. | counts for neither side |
| `false` | The two readings disagree and the review round has not settled it. | counts for neither side |

A label that went through review also carries `review`: the verdicts, the reviewer's notes, and the transcription note when a value was read off the page. `scripts/extraction-survey/merge-label-review.py` applies a review export plus a patch file of transcribed values; the 2026-09-13 round is under `scripts/extraction-survey/reviews/`.

Documents whose page states a **per-vote absence** («Κατά τη διαδικασία της ψηφοφορίας απουσίαζε…») carry it under `perVoteAbsence`. It is not an arrival or a departure and no field holds it; the scorer stays silent on it until one does.

`statedButUnstorable` is not a label. It lists what the page says that the pipeline has no field for — a substitution, a per-vote absence, a participation mode — and is the requirements list for the schema change, not something the scorer reads.

## What the command scores

One outcome per field per document. A page whose roll call is right and whose votes are wrong is one of each, and the per-field table says which is weak.

| Outcome | Meaning |
| --- | --- |
| `agree` | The extraction matches the label. |
| `disagree` | The extraction differs. The detail names what was lost or invented. |
| `missing` | The extractor returned nothing where the label holds a value. |
| `contested` | The label is `verified: false`. Excluded from the agree rate. |
| `unlabelled` | The label is `verified: "unresolvable"`. Excluded from the agree rate. |

How each field compares, and why:

**Roll call** — present and absent as sets of names, matched through `normalizeGreekName()` so tonos, case and a parenthetical nickname do not count as a difference. The detail lists who was lost and who was invented.

**Attendance changes** — as a set of `type, name, anchor`. The anchor is part of the fact: a departure *after* item 5 and one *during* item 5 put the member on opposite sides of that vote. When the page pins its changes to something other than an agenda item (`anchoredBy`: a decision number or a phase of the session), the extracted changes must carry that anchor kind, or the replay places them wrongly.

**Per-vote absence** — «Κατά τη διαδικασία της ψηφοφορίας απουσίαζε…»: the members the page excludes from this decision's vote, compared as a set against `absent_for_vote` changes. Scored only where the fixture carries `perVoteAbsence`.

**Votes** — three checks. The phrase must survive when the page prints one. A tally printed in the phrase («με 12 υπέρ και 3 κατά») must survive into the stored phrase, because that number is the only thing that can validate a derived name list. Named voters compare as a set of `vote, name`, **excluding FOR entries unless the page named every voter**: pages name dissenters and declarers and almost never the majority, and the pipeline derives FOR from presence, so a FOR entry is not a read fact. A dropped dissenter is therefore a `disagree`, not a lost value: the derivation would print them as having voted for.

**Subject** — agenda item number and the out-of-agenda flag. Null is a correct answer; three bodies never print a number, and extraction inventing `#1` for an out-of-agenda item is the most common subject error.

**Mayor** — the page's statement that the mayor was present or absent, as a flag; scored only where the fixture carries a `mayor` label (the Zografou documents added on 2026-09-17).

**Excerpt** — length within 15% of the baseline and the same `incomplete` flag. Free text cannot be scored by equality. Once a person has confirmed the text is on the page, only its presence is scored.

## What the fixture does not do

It does not score the decision number or the references field, and scores the mayor only where a label exists. The decision number is scored by the reading fixture.

It does not know the member roster. Names compare as strings after normalisation, which is what the pipeline does before matching. When the fixture carries each body's roster, the comparison unit becomes the member and their state, and Chania's knowingly incomplete absent list becomes tractable.

It cannot express what the schema cannot hold. A substitution, a change anchored to a decision number, a per-line vote all arrive as `statedButUnstorable`; the scorer stays silent on them until there is a field.

## Reading a disagreement

Two things can be wrong: the extraction, or the label. On an `"agreed"` label both readings said the same thing, so a later disagreement is a change in the extractor and usually a regression. On a `true` label a person confirmed the page. Read the page before changing either side; `build-label-review.py` in `scripts/extraction-survey/` writes `label-review.html` into `.extraction-survey/`, where it puts the PDF beside both readings. Every script there reads and writes its intermediates in `.extraction-survey/`, which is gitignored.

`"agreed"` is weaker than it looks: two readings agree when they share a blind spot. The Athens 4η labels (`97ΜΗΩ6Μ-ΠΑΦ`, `ΨΒΑΔΩ6Μ-ΚΡΙ`) say `namedVoters: "all"` and list none of the members the page names as voting in favour, because both readings came from an extractor that dropped FOR names.

## Settling a disagreement from the page

`adjudicate-extraction` reads the page and settles one field, so a label change carries the sentence that justified it:

```bash
npm run cli -- adjudicate-extraction .extraction-survey/scores-2026-09-17-c.json --field votes -O verdicts.json
```

It takes the scorer's `-O` output. Pass it the `--hints-file` the scores were produced with: the reading it checks then comes from the scorer's cache, and without the file it reads each page again, cold, at model cost. It writes nothing: the result is a verdict queue of `label_wrong`, `reader_wrong`, `both_wrong` and `needs_human`, each with the verbatim quote, its page, and whether the quote could be corroborated.

The model is never asked who is right — it is not told what either reading says. It quotes what the page prints and names what it saw from a closed vocabulary per field; the verdict is computed in code from that observation against both readings. A model that ranked its own output would be scoring itself.

Two things the verdict will not do. It escalates rather than guesses: a multi-part vote (two competing ΥΠΕΡ blocks, which the schema cannot express) and a page matching both readings both come back `needs_human`. And a quote absent from the document's own text layer downgrades any verdict to `needs_human`, because an invented quote is the one failure the design must catch — except on `scrambled` and `mixed` documents, where the text layer cannot corroborate anything and the absence means nothing. Sparta ΔΣ pages are `mixed`: the formal decision reads cleanly and the verbatim discussion embedded below it does not.
