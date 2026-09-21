# What each administrative body's decisions state

Extraction was built assuming decision documents share one shape. They do not, and the differences
fall along administrative bodies rather than municipalities. Inside Chania, the council names its
dissenting voters in almost every decision and the committee in almost none. Athens council pins
attendance changes to decision numbers, Zografou council to agenda items, Argos council to nothing
at all. Athens council's present list already contains members who arrived late; Orestiada's does
not, leaving them under ΑΠΟΝΤΕΣ with «(Προσήλθε στο 1ο Θέμα)» beside the name.

That last difference is the one that matters most. Two bodies print a list called *present* and the
two lists mean different things. Until that is recorded per body, `presentMembers` is not a fact
anyone can label, and an evaluation of it cannot be scored.

This tooling answers, per body: **which facts its documents state, in what form, and what a person
still has to decide.**

```
opencouncil         scripts/export-body-corpus.ts  ->  body-corpus.json
opencouncil-tasks   observe-documents              ->  observations.json
opencouncil-tasks   body-facts                     ->  body-facts.json
```

## It reads the way production reads

Every document is read as a rendered page by the model, exactly as `extractDecisionFromPdf` and
`readDecisionDocument` do. This is not a detail.

An earlier version of this profiling used `pdftotext`. Many Greek municipal PDFs embed a font with
no Unicode mapping, and the text layer then decodes to plausible-looking nonsense — «Απιθ. απόθαζηρ»
where the page shows «Αριθ. αποφάσης». That version silently discarded **129 of 1,099** sampled
documents, including **every Sparta document**: a municipality with 527 linked decisions that
production extracts without difficulty. Bodies losing a tenth or more of their sample accounted for
27% of the corpus.

Measuring a different population than production sees is not a measurement. Read the page.

## Stage 1 — sample the corpus

```bash
npx tsx scripts/export-body-corpus.ts --per-body 40 --min-decisions 15 --out body-corpus.json
```

| Option | Purpose |
| --- | --- |
| `--per-body <n>` | Documents to sample per body. The default is 40. |
| `--min-decisions <n>` | Skip bodies with fewer linked decisions than this. |
| `--city <id>` | One municipality only. |
| `--out <file>` | Output path. |

The sample is **time-stratified**: the body's linked decisions are ordered by meeting date and
taken at a fixed stride, always including the oldest and newest. A municipality that changed its
template partway through the period then shows both templates instead of averaging them away.

Read-only.

## Stage 2 — observe what each document states

```bash
npx tsx src/cli.ts observe-documents body-corpus.json -O observations.json
```

| Option | Purpose |
| --- | --- |
| `-c, --concurrency <n>` | Parallel reads. The default is 6. |
| `-b, --body <text>` | Only bodies whose `city / name` contains this string. |
| `-m, --model <id>` | Model to read with. Defaults to Haiku. |
| `-l, --limit <n>` | Only the first N documents per body, for cost control. |
| `--cache-dir <dir>` | Where PDFs and observations live. |
| `--skip-cache` | Ignore cached observations and read again. |
| `-O, --output-file <file>` | Write observations as JSON. |

Each document yields one structured observation, defined in
[`src/tasks/utils/documentObservation.ts`](../src/tasks/utils/documentObservation.ts). Only the
first three and last two pages are sent: a Greek decision states its session, roll call and
attendance changes at the front and its vote and number at the back, while the middle is subject
matter and can run to 135 pages of bound-in study.

Observations are cached per document **and per model**, so re-running costs nothing and comparing
two models over the same documents is one flag.

### Evidence, not verdicts

The observation deliberately does not ask the model to judge the hard question. Asking directly
whether a late arrival is "in the present set" agreed with a second model only 83% of the time,
because it requires cross-referencing a name across two lists while answering 25 other fields.

Instead the model reports where it found the person:

```
lateArrivalCheck: { name, appearsInPresentOrRosterList, appearsInAbsentList }
```

and `lateArrivalIsInOpeningPresentSet` computes the answer, because the rule differs by layout.
With explicit ΠΑΡΟΝΤΕΣ / ΑΠΟΝΤΕΣ lists, being in the present list settles it. With a whole-body
roster plus absentees, the roster is *membership, not attendance*, so someone named in both the
roster and the absent list is not in the opening present set. Moving the judgement into code raised
agreement to 88% and made it testable.

The same principle applies to `rollCallHeadings`, which records the attendance headings verbatim
rather than a classification. The headings are the reviewable evidence, and they are more varied
than any enum: ΠΑΡΟΝΤΕΣ, Συμμετέχοντες-Παρόντες, ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ, ΜΕΛΗ ΔΗΜΟΤΙΚΗΣ
ΕΠΙΤΡΟΠΗΣ, ΑΠΟΥΣΕΣ.

## Stage 3 — aggregate per body, and flag what needs a person

```bash
npx tsx src/cli.ts body-facts observations.json -O body-facts.json
```

An aggregate is only useful if it says where it is shaky. Two signals do that without a second
model run, and both appear as `reviewReasons`:

| reason | meaning |
| --- | --- |
| `inconsistent-roll-call-form` | more than a quarter of the body's documents disagree about its own layout |
| `inconsistent-change-pinning` | the body pins attendance changes more than one way |
| `roll-call-meaning-unresolved` | no document in the sample records a late arrival, so the decisive question is untested |
| `roll-call-meaning-contested` | documents of one body disagree about whether the present set is cumulative |
| `no-usable-sample` | nothing in the sample is a deliberative decision |
| `holds-facts-we-cannot-store` | the body states something no field can hold |

A flagged body is not a broken body. It is a body where the evidence does not settle the question,
which is exactly the set worth escalating to a stronger model or to a person.

## Escalating a flagged body

Re-read just that body with a stronger model and compare:

```bash
npx tsx src/cli.ts observe-documents body-corpus.json --body "athens / Δημοτικό Συμβούλιο" --model claude-sonnet-4-6 -O athens-council-sonnet.json
```

Haiku and Sonnet agree on 95% of fields across a 60-document sample. Where they differ, Haiku finds
fewer late arrivals, so the cheap pass under-samples the evidence for the decisive question rather
than getting it backwards. Escalate the flagged bodies; do not pay three times over for the rest.

## Profiling one body on its own

The three stages above survey every body we hold documents for, in bulk, from a corpus exported by
opencouncil. A body nobody surveyed — a new municipality, a body whose template just changed — needs
the same measurement for one body, without a corpus: the `profileBody` task does all three stages in
one pass, listing the documents from Diavgeia itself.

```bash
npx tsx src/cli.ts profile-body zografou cmf... --uid 6104 --unit 100084744 -n 20
```

| Option | Purpose |
| --- | --- |
| `-u, --uid <org>` | The city's Diavgeia organization UID. Required. |
| `--unit <id...>` | Unit ids to search, `unit` or `unit:signer` each, as in `pollDecisions`. Required. |
| `-n, --sample-size <n>` | Documents to read. The default is 40. |
| `--from <date>` | Earliest issue date to search. The default is 2024-01-01. |
| `--skip-cache` | Ignore cached readings and read again. |
| `-O, --output-file <file>` | Write the whole result — conventions, facts and the ADAs read — as JSON. |

The search is capped at three times the sample size, split evenly across the configured scopes so
one signer cannot consume the whole budget, and returns the most recent documents first. What it
returns is thinned to the sample with a fixed stride, for the same reason stage 1 stratifies by
time — so the sample spreads across the fetched run rather than clustering at one end of it. For a
body publishing more than the cap since `--from`, that run is its most recent documents, not the
whole window. Reading is capped at four documents at once and shares the cache of
`observe-documents`, so a body already surveyed re-profiles for free.

The printed record is a `DecisionConventions` (see [`src/types.ts`](../src/types.ts)) carrying
`provenance: { source: 'profile', … }`. It is a derivation from frequencies, not a person's
judgement: `notes` repeats the `reviewReasons` above, and opencouncil only overwrites a stored record
whose provenance is not `manual`. The same profiling runs as a task at `POST /profileBody`, which is
what the admin form calls.

Two thresholds are worth knowing when reading the output. A convention exercised by every document
— the roll-call layout, whether the mayor is stated separately — has to hold in at least half of
them. A convention that only appears when the case arises — a substitute, a per-vote absence — counts
from 10% of documents, and the per-decision attendance form counts from a single document, because it
appears only in the documents of decisions someone missed.

## What this still cannot tell you

Questions about where in a long document the decision sits cannot be answered from a head-and-tail
slice: a decision that begins after a bound-in study looks like one that begins at the front. Judge
that from page counts and full documents.

Frequencies are of the sample, not of the corpus. Forty documents give a usable estimate of whether
a body does something routinely, and a poor one of whether it does something rarely. A property no
sampled document exercises is unknown, not absent, which is why the aggregate reports it as
unresolved rather than as zero.
