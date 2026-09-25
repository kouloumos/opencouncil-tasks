import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { aiChat, NO_USAGE, type ResultWithUsage } from '../../lib/ai.js';
import {
    adaToPdfUrl,
    changeAnchor,
    downloadPdfAsBuffer,
    normalizeGreekName,
    readCache,
    writeCache,
    type RawExtractedDecision,
} from './decisionPdfExtraction.js';
import { describePageRanges, extractPdfPageSet, headAndTailPages } from './pdfPages.js';
import type { ExtractionLabel, Field } from './extractionScoring.js';

/**
 * Settles a scorer disagreement by reading the page, so that a label change
 * carries the sentence that justified it.
 *
 * The model is never asked who is right. It quotes what the page prints and
 * names what it saw from a closed vocabulary; the verdict is computed here from
 * that observation, the label and the extractor's answer. A model told what the
 * two sides claim would be ruling on its own output.
 */

/** Fields a page can settle. `excerpt` is advisory, and `mayor`/`perVoteAbsence` do not disagree in practice. */
export const ADJUDICABLE_FIELDS = ['subject', 'votes', 'attendanceChanges', 'rollCall'] as const;
export type AdjudicableField = (typeof ADJUDICABLE_FIELDS)[number];

export function isAdjudicable(field: Field): field is AdjudicableField {
    return (ADJUDICABLE_FIELDS as readonly string[]).includes(field);
}

export type Verdict =
    /** The page contradicts the fixture; the extractor read it correctly. */
    | 'label_wrong'
    /** The page supports the fixture; the extractor misread it. */
    | 'reader_wrong'
    /** The page agrees with neither. */
    | 'both_wrong'
    /** The page cannot settle it, or settling it needs a decision we have not taken. */
    | 'needs_human';

/** What the model may report per field. Anything else is treated as no answer. */
export const FINDINGS: Record<AdjudicableField, readonly string[]> = {
    subject: ['numbered_agenda_item', 'numbered_out_of_agenda', 'no_item_heading'],
    votes: ['names_all_voters', 'names_dissenters_only', 'names_nobody'],
    attendanceChanges: ['agenda_item', 'decision_number', 'phase', 'this_document', 'session', 'no_change_stated'],
    rollCall: ['roll_call_quoted', 'no_roll_call'],
};

/**
 * Offered only when the document is longer than the pages sent. Without it the
 * closed vocabulary forces an answer about pages the model never saw: a long
 * document whose vote is on page 30 would be reported as naming nobody.
 */
export const OUTSIDE_SUPPLIED_PAGES = 'outside_supplied_pages';

/** The question put to the model per field, in the page's own terms. */
const QUESTIONS: Record<AdjudicableField, string> = {
    subject:
        'Does this document print an item-number heading for the decision it records (e.g. «ΘΕΜΑ 3ο», «3ο θέμα ημερήσιας διάταξης», «1ο θέμα εκτός ημερήσιας διάταξης»)? '
        + 'A «Αριθμός Απόφασης» / «Αριθ. Απόφασης» is a DECISION number, not an item number — it does not count, and neither does a protocol number. '
        + 'Report `numbered_agenda_item` with the item number in `count`; `numbered_out_of_agenda` with its number in `count` (0 if the page numbers it not at all); or `no_item_heading` with `count` 0.',
    votes:
        'Does this document name the individual members who voted, and which ones? '
        + 'Report `names_all_voters` if it names those who voted ΥΠΕΡ / in favour; `names_dissenters_only` if it names only those voting ΚΑΤΑ / ΛΕΥΚΟ / ΑΠΟΧΗ / ΠΑΡΩΝ; or `names_nobody` if it gives only a phrase such as «ΟΜΟΦΩΝΑ» or «ΚΑΤΑ ΠΛΕΙΟΨΗΦΙΑ» with no names at all. '
        + 'Put in `count` the number of DISTINCT groups of members voting in favour: 1 for a single list of those in favour, and 2 or more when members voted in favour of different competing options or wordings.',
    attendanceChanges:
        'This document may state that a member arrived or left during the session. What does it pin that change to? '
        + 'Report `agenda_item` («κατά τη συζήτηση του 3ου θέματος»); `decision_number` («απεχώρησε στην 286 ΑΚΣ»); `phase` («κατά τις ερωτήσεις της προ ημερησίας διάταξης», «πριν την έναρξη της ημερήσιας διάταξης»); `this_document` (absent for THIS decision\'s vote only); `session` (an arrival or departure stated with no position at all); or `no_change_stated` if it states none. '
        + 'Put the item or decision number in `count` when the page gives one, otherwise 0.',
    rollCall:
        'Quote the opening attendance block of this document VERBATIM — the ΠΑΡΟΝΤΕΣ / ΣΥΝΘΕΣΗ list and the ΑΠΟΝΤΕΣ list, with every name exactly as printed, including any spelling that looks to you like a misprint. Do not correct anything. '
        + 'Report `roll_call_quoted`, or `no_roll_call` if the document prints no attendance list. Put the number of names listed as present in `count`.',
};

const ADJUDICATION_SYSTEM_PROMPT = `You read Greek municipal council decision PDFs and report what is printed on the page.

You are settling a disagreement between two readings of this document. You are not told what either reading says, and you must not guess: report only what the page itself prints. The judgement is made elsewhere from your answer.

Rules:
- "quote" must be text copied VERBATIM from the page, with its original Greek spelling and accents. Never paraphrase, translate, correct or normalise it. If nothing on the page bears on the question, use "".
- "page" is the 1-based page the quote is on, or 0 if you found nothing.
- "finding" must be exactly one of the allowed values you are given. If the page supports none of them, use "".
- "count" is the number the question asks for, or 0.
- Judge only from what is printed. Do not infer from what is customary in such documents.`;

const ADJUDICATION_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        quote: { type: 'string' },
        page: { type: 'number' },
        finding: { type: 'string' },
        count: { type: 'number' },
    },
    required: ['quote', 'page', 'finding', 'count'],
    additionalProperties: false,
};

export interface Observation {
    quote: string;
    page: number;
    finding: string;
    count: number;
}

/**
 * Whether the PDF's own text layer can corroborate a quote. Some corpora are
 * font-scrambled: the model reads the rendered page correctly while every text
 * tool returns mojibake, so a quote missing from that layer is not evidence of
 * a bad quote. Sparta ΔΣ documents are `mixed` — the formal decision reads
 * cleanly and the verbatim discussion embedded below it does not.
 */
export type TextLayerState = 'usable' | 'mixed' | 'scrambled' | 'empty';

/** Frequent Greek function words: a sound Greek text layer holds many, a scrambled one almost none. */
const GREEK_STOPWORDS = ['και', 'του', 'της', 'των', 'στο', 'στη', 'στην', 'που', 'για', 'με', 'το', 'οι', 'τα'];

/**
 * Measured over the corpus: an ordinary Greek page runs 18-26 stopwords per
 * 1,000 characters and a scrambled one 0-2.5, so the boundary is nowhere near
 * either population.
 */
const STOPWORDS_PER_1K_FLOOR = 3;
const WINDOW_CHARS = 3000;

function density(s: string): number {
    const lower = ` ${s.toLowerCase()} `;
    let hits = 0;
    for (const w of GREEK_STOPWORDS) hits += lower.split(` ${w} `).length - 1;
    return hits / (s.length / 1000);
}

export function assessTextLayer(text: string): TextLayerState {
    const stripped = text.replace(/\s+/g, ' ').trim();
    if (stripped.length < 200) return 'empty';
    if (density(stripped) < STOPWORDS_PER_1K_FLOOR) return 'scrambled';
    // Overlapping windows, so a scrambled region is caught wherever it falls
    // rather than only when it happens to align with a window boundary.
    for (let i = 0; i < stripped.length; i += WINDOW_CHARS / 2) {
        const w = stripped.slice(i, i + WINDOW_CHARS);
        if (w.length >= 500 && density(w) < STOPWORDS_PER_1K_FLOOR) return 'mixed';
    }
    return 'usable';
}

export type Corroboration = 'found' | 'not_found' | 'unverifiable';

/**
 * Does the quoted sentence actually appear in the document's text layer? An
 * invented quote is the one failure this design must catch, because every
 * label change rests on the quote being real.
 */
export function corroborate(quote: string, pageText: string, layer: TextLayerState): Corroboration {
    if (layer === 'scrambled' || layer === 'empty') return 'unverifiable';
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const q = norm(quote);
    if (q.length < 12) return 'unverifiable';
    const haystack = norm(pageText);
    if (haystack.includes(q)) return 'found';
    // Line wrapping and hyphenation defeat a whole-quote match on long quotes;
    // the longest run of words that survives is a fair test of the same claim.
    const words = q.split(' ').filter(w => w.length > 2);
    for (let n = Math.min(8, words.length); n >= 4; n--) {
        for (let i = 0; i + n <= words.length; i++) {
            if (haystack.includes(words.slice(i, i + n).join(' '))) return 'found';
        }
    }
    // On a mixed document the quote may sit in the unreadable region, so its
    // absence says nothing either way.
    return layer === 'mixed' ? 'unverifiable' : 'not_found';
}

export interface VerdictResult {
    verdict: Verdict;
    reason: string;
}

/** The verdict, computed from the page observation against both readings. */
export function computeVerdict(
    field: AdjudicableField,
    obs: Observation,
    label: ExtractionLabel,
    got: RawExtractedDecision | null,
    scorerDetail: string,
): VerdictResult {
    if (obs.finding === OUTSIDE_SUPPLIED_PAGES) {
        return { verdict: 'needs_human', reason: 'the document runs past the pages read, and what settles this is not on them' };
    }
    if (!FINDINGS[field].includes(obs.finding)) {
        return { verdict: 'needs_human', reason: `the page gave no answer in the expected vocabulary (finding ${JSON.stringify(obs.finding)})` };
    }
    if (!got) return { verdict: 'reader_wrong', reason: 'the extractor returned nothing for this document' };

    switch (field) {
        case 'subject': return verdictSubject(obs, label, got);
        case 'votes': return verdictVotes(obs, label, got);
        case 'attendanceChanges': return verdictChanges(obs, label, got, scorerDetail);
        case 'rollCall': return verdictRollCall(obs, scorerDetail);
    }
}

function verdictSubject(obs: Observation, label: ExtractionLabel, got: RawExtractedDecision): VerdictResult {
    const pageNumber = obs.finding === 'no_item_heading' ? null : (obs.count || null);
    const pageOutOfAgenda = obs.finding === 'numbered_out_of_agenda';
    const info = got.subjectInfo ?? null;
    const gotNumber = info?.agendaItemIndex ?? null;
    const gotOA = info?.nonAgendaReason === 'outOfAgenda';

    const labelOk = label.subject.agendaItemNumber === pageNumber
        && (pageNumber === null || label.subject.isOutOfAgenda === pageOutOfAgenda);
    const readerOk = gotNumber === pageNumber && (pageNumber === null || gotOA === pageOutOfAgenda);
    const printed = pageNumber === null
        ? 'no item heading'
        : `${pageOutOfAgenda ? 'out-of-agenda item' : 'agenda item'} ${pageNumber}`;
    return decide(labelOk, readerOk, `the page prints ${printed}`);
}

function verdictVotes(obs: Observation, label: ExtractionLabel, got: RawExtractedDecision): VerdictResult {
    if (obs.count > 1) {
        return {
            verdict: 'needs_human',
            reason: `the page holds ${obs.count} competing groups voting in favour — a multi-part vote, which the schema cannot express (spec §3)`,
        };
    }
    const pageSays = obs.finding === 'names_all_voters' ? 'all'
        : obs.finding === 'names_dissenters_only' ? 'dissenters_only'
            : 'none';
    const printed = pageSays === 'all' ? 'names the members voting in favour'
        : pageSays === 'dissenters_only' ? 'names dissenters only'
            : 'names no voters at all';

    // The policy field and the named list fail independently: a label can say
    // the page names those in favour and still list none of them, because it
    // was seeded from a reader that did not capture them.
    if (label.votes.namedVoters !== pageSays) {
        return { verdict: 'label_wrong', reason: `the page ${printed}, which the label calls ${JSON.stringify(label.votes.namedVoters)}` };
    }
    const labelHasFor = label.votes.asExtracted.some(v => v.vote === 'FOR');
    const readerHasFor = (got.voteDetails ?? []).some(v => v.vote === 'FOR');
    if (pageSays === 'all' && !labelHasFor && readerHasFor) {
        return { verdict: 'label_wrong', reason: `the page ${printed} and the label's list holds none of them, while the extractor read them` };
    }
    if (pageSays === 'all' && labelHasFor && !readerHasFor) {
        return { verdict: 'reader_wrong', reason: `the page ${printed} and the extractor returned none` };
    }
    if (pageSays !== 'all' && readerHasFor) {
        return { verdict: 'reader_wrong', reason: `the page ${printed}, yet the extractor named members as voting in favour` };
    }
    return { verdict: 'needs_human', reason: `the page ${printed}, which both readings match — the disagreement is over individual names; read the quote` };
}

/**
 * `anchoredBy` is one value for a document that may state several changes, so
 * this settles only how they are pinned — never which ones exist. A page naming
 * four departures the extractor lost is a dispute about membership: the anchor
 * is not what the two sides differ on, and answering it would convict whichever
 * side the single reported change happened to contradict.
 */
export function isAnchorKindDispute(scorerDetail: string): boolean {
    return scorerDetail.startsWith('anchor:');
}

function verdictChanges(obs: Observation, label: ExtractionLabel, got: RawExtractedDecision, scorerDetail: string): VerdictResult {
    if (!isAnchorKindDispute(scorerDetail)) {
        return { verdict: 'needs_human', reason: 'the disagreement is over which changes the page states, not how they are pinned; the quoted sentence settles only the anchor' };
    }
    const pageAnchor = obs.finding === 'no_change_stated' ? 'nothing' : obs.finding;
    // Labels written before the vocabulary settled say session_phase; the page's anchor is the phase.
    const raw = label.attendanceChanges.anchoredBy;
    const labelAnchor = raw === 'session_phase' ? 'phase' : (raw ?? 'nothing');
    const labelOk = labelAnchor === pageAnchor;

    // absent_for_vote is scoped to this decision and is not a session change.
    const sessionChanges = (got.attendanceChanges ?? []).filter(c => c.type !== 'absent_for_vote');
    const readerKinds = new Set<string>(sessionChanges.map(c => {
        const kind = changeAnchor(c).kind;
        return kind === 'session_start' || kind === 'session_end' ? 'session' : kind;
    }));
    // The label holds one anchor, so the extractor is judged on one too. Asking
    // only whether some change matches would pass the extractor on any page
    // stating several, while the label was held to the single reported anchor.
    if (readerKinds.size > 1) {
        return { verdict: 'needs_human', reason: `the extractor read ${readerKinds.size} differently pinned changes, which one anchor value cannot be compared against` };
    }
    const readerOk = pageAnchor === 'nothing'
        ? sessionChanges.length === 0
        : readerKinds.size === 1 && readerKinds.has(pageAnchor);
    const printed = pageAnchor === 'nothing' ? 'states no arrival or departure' : `pins its change to ${pageAnchor}`;
    return decide(labelOk, readerOk, `the page ${printed}`);
}

/**
 * Roll-call disputes are about one or two names, which the scorer already
 * names in its detail («present lost: X; present extra: Y»). The quoted block
 * settles which spelling the page prints.
 */
function verdictRollCall(obs: Observation, scorerDetail: string): VerdictResult {
    if (obs.finding === 'no_roll_call') {
        return { verdict: 'needs_human', reason: 'the page prints no attendance list; the dispute is about a list that is not there' };
    }
    const lost = capture(scorerDetail, /(?:present|absent) lost: ([^;]+)/);
    const extra = capture(scorerDetail, /(?:present|absent) extra: ([^;]+)/);
    if (!lost.length || !extra.length) {
        return { verdict: 'needs_human', reason: 'not a one-for-one spelling dispute; read the quoted roll call' };
    }
    const quoted = normalizeGreekName(obs.quote);
    const onPage = (names: string[]) => names.filter(n => quoted.includes(normalizeGreekName(n)));
    const labelNames = onPage(lost);
    const readerNames = onPage(extra);
    if (labelNames.length && !readerNames.length) return { verdict: 'reader_wrong', reason: `the page prints «${labelNames[0]}», as the label has it` };
    if (readerNames.length && !labelNames.length) return { verdict: 'label_wrong', reason: `the page prints «${readerNames[0]}», as the extractor read it` };
    return { verdict: 'needs_human', reason: 'the quoted roll call carries neither spelling plainly, or both; read it' };
}

function capture(detail: string, re: RegExp): string[] {
    const m = detail.match(re);
    return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

function decide(labelOk: boolean, readerOk: boolean, printed: string): VerdictResult {
    if (labelOk && readerOk) return { verdict: 'needs_human', reason: `${printed}, which both readings match — the scorer's disagreement is over something else` };
    if (labelOk) return { verdict: 'reader_wrong', reason: `${printed}, as the label has it` };
    if (readerOk) return { verdict: 'label_wrong', reason: `${printed}, as the extractor read it` };
    return { verdict: 'both_wrong', reason: `${printed}, which neither reading matches` };
}

export interface Adjudication {
    ada: string;
    city: string;
    body: string;
    field: AdjudicableField;
    /** The scorer's own description of the disagreement, kept so the verdict can be read against it. */
    scorerDetail: string;
    verdict: Verdict;
    reason: string;
    observation: Observation;
    textLayer: TextLayerState;
    corroboration: Corroboration;
    model: string;
    adjudicatedAt: string;
}

export const ADJUDICATION_MODEL = 'claude-sonnet-4-6';
/**
 * Reading for evidence needs the decision and its surroundings, not the annexes.
 * Head and tail, not the first twelve pages: what settles a dispute is printed
 * at one end or the other, and a bound-in study in the middle can run to 135
 * pages. Sending only the front made a dispute over page 30 permanently
 * unadjudicable — `outside_supplied_pages` stops a wrong verdict, but no rerun
 * could ever reach the page.
 */
const ADJUDICATION_HEAD_PAGES = 9;
const ADJUDICATION_TAIL_PAGES = 3;

/**
 * Where one adjudication is cached. An entry holds what the model observed on
 * the pages it was sent, and a hit re-rules on that observation without reading
 * again, so the page window is part of the key: a changed window must not serve
 * an observation of other pages.
 */
export function adjudicationCacheKey(ada: string, field: AdjudicableField): string {
    return `${adaToPdfUrl(ada)}#adjudicate-${field}-head${ADJUDICATION_HEAD_PAGES}-tail${ADJUDICATION_TAIL_PAGES}`;
}
const ADJUDICATION_CACHE_PREFIX = 'adjudication-';

/**
 * Reads one page and settles one field. Cached per (ada, field) so re-reading a
 * verdict is free and a re-run only pays for what changed.
 */
/**
 * The whole judgement, from an observation and its corroboration. Kept apart
 * from the page read so a cached observation can be ruled on again.
 */
function ruleOn(
    args: { field: AdjudicableField; label: ExtractionLabel; got: RawExtractedDecision | null; scorerDetail: string },
    observation: Observation,
    corroboration: Corroboration,
): { verdict: Verdict; reason: string } {
    let { verdict, reason } = computeVerdict(args.field, observation, args.label, args.got, args.scorerDetail);
    if (corroboration === 'not_found' && verdict !== 'needs_human') {
        reason = `the quoted sentence is absent from the document's own text layer, so the quote may be invented (was: ${reason})`;
        verdict = 'needs_human';
    }
    return { verdict, reason };
}

export async function adjudicateField(args: {
    ada: string;
    city: string;
    body: string;
    field: AdjudicableField;
    scorerDetail: string;
    label: ExtractionLabel;
    got: RawExtractedDecision | null;
    skipCache?: boolean;
}): Promise<ResultWithUsage<Adjudication> & { fromCache: boolean }> {
    const { ada, field, skipCache } = args;
    const cacheKey = adjudicationCacheKey(ada, field);
    if (!skipCache) {
        const cached = readCache<Adjudication>(cacheKey, ADJUDICATION_CACHE_PREFIX);
        // Only the observation is expensive, and only it is evidence. The verdict
        // is recomputed from it on every read, so correcting the verdict logic
        // takes effect on the next run instead of waiting for the cache to expire.
        if (cached) {
            const result = { ...cached, ...ruleOn(args, cached.observation, cached.corroboration) };
            return { result, usage: { ...NO_USAGE }, fromCache: true };
        }
    }

    const pdfBuffer = await downloadPdfAsBuffer(adaToPdfUrl(ada));
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();
    const selected = headAndTailPages(totalPages, ADJUDICATION_HEAD_PAGES, ADJUDICATION_TAIL_PAGES);
    const partial = selected.length < totalPages;
    const base64 = partial
        ? await extractPdfPageSet(srcDoc, selected)
        : pdfBuffer.toString('base64');

    const { result: obsRaw, usage } = await aiChat<Observation>({
        systemPrompt: ADJUDICATION_SYSTEM_PROMPT,
        userPrompt: [
            QUESTIONS[field],
            `Allowed values for "finding": ${[...FINDINGS[field], ...(partial ? [OUTSIDE_SUPPLIED_PAGES] : [])].join(', ')}.`,
            partial
                ? `You are given ${selected.length} pages of a ${totalPages}-page document: its pages ${describePageRanges(selected)}, in that order. Number "page" as the document numbers it, not as the pages you were given are ordered. If the part of the document that would answer the question is not on these pages, report \`${OUTSIDE_SUPPLIED_PAGES}\` rather than concluding it is not printed.`
                : '',
        ].filter(Boolean).join('\n\n'),
        documentBase64: base64,
        outputFormat: { type: 'json_schema', schema: ADJUDICATION_OUTPUT_SCHEMA },
        model: ADJUDICATION_MODEL,
        maxTokens: 4000,
        label: `extraction-adjudication:${field}`,
    });

    const observation: Observation = {
        quote: String(obsRaw?.quote ?? ''),
        page: Number(obsRaw?.page ?? 0) || 0,
        finding: String(obsRaw?.finding ?? ''),
        count: Number(obsRaw?.count ?? 0) || 0,
    };

    const pageText = await pdfTextLayer(pdfBuffer);
    const textLayer = assessTextLayer(pageText);
    const corroboration = corroborate(observation.quote, pageText, textLayer);

    const result: Adjudication = {
        ada, city: args.city, body: args.body, field,
        scorerDetail: args.scorerDetail,
        ...ruleOn(args, observation, corroboration),
        observation, textLayer, corroboration,
        model: ADJUDICATION_MODEL,
        adjudicatedAt: new Date().toISOString(),
    };
    writeCache(cacheKey, result, ADJUDICATION_CACHE_PREFIX);
    return { result, usage, fromCache: false };
}

const execFileAsync = promisify(execFile);

/**
 * The document's own text layer, used only to corroborate a quote. `pdftotext`
 * comes from the nix dev shell; without it every quote is simply unverifiable,
 * which is the same answer a scrambled document gives.
 */
async function pdfTextLayer(pdfBuffer: Buffer): Promise<string> {
    const tmp = path.join(os.tmpdir(), `adjudicate-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    try {
        fs.writeFileSync(tmp, pdfBuffer);
        const { stdout } = await execFileAsync('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 64 * 1024 * 1024 });
        return stdout;
    } catch {
        return '';
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* the temp file may never have been written */ }
    }
}

export function tallyVerdicts(rows: Adjudication[]): Record<Verdict, number> {
    const t: Record<Verdict, number> = { label_wrong: 0, reader_wrong: 0, both_wrong: 0, needs_human: 0 };
    for (const r of rows) t[r.verdict]++;
    return t;
}
