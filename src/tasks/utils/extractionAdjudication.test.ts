import { describe, it, expect } from 'vitest';
import {
    adjudicationCacheKey,
    assessTextLayer,
    corroborate,
    computeVerdict,
    OUTSIDE_SUPPLIED_PAGES,
    type Observation,
} from './extractionAdjudication.js';
import type { ExtractionLabel } from './extractionScoring.js';
import type { RawExtractedDecision } from './decisionPdfExtraction.js';

const label = (over: Partial<ExtractionLabel> = {}): ExtractionLabel => ({
    rollCall: { presentMembers: [], absentMembers: [], verified: true },
    attendanceChanges: { stated: false, anchoredBy: null, asExtracted: [], verified: true },
    votes: { phraseAsPrinted: null, carriesTally: false, namedVoters: 'none', asExtracted: [], verified: true },
    subject: { agendaItemNumber: null, isOutOfAgenda: false, verified: true },
    excerpt: { chars: 0, extractionFlaggedIncomplete: false, verified: true },
    ...over,
});

const got = (over: Partial<RawExtractedDecision> = {}): RawExtractedDecision => ({
    attendanceFormat: 'explicit_present_absent',
    compositionMembers: null,
    presentMembers: [],
    absentMembers: [],
    mayorPresent: null,
    decisionExcerpt: '',
    decisionNumber: null,
    references: '',
    voteResult: null,
    voteDetails: [],
    attendanceChanges: [],
    discussionOrder: null,
    subjectInfo: null,
    incomplete: false,
    presidedBy: null,
    voteTally: { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null },
    decisionAttendance: null,
    ...over,
});

const obs = (over: Partial<Observation>): Observation => ({ quote: '', page: 1, finding: '', count: 0, ...over });

// Measured on the corpus: an ordinary page runs 18-26 stopwords per 1,000
// characters, a scrambled one 0-2.5. Sparta ΨΧ6ΝΩ1Ν-7ΟΤ is 2.45 overall;
// 6ΑΣΙΩ1Ν-7ΒΧ is 20.0 overall but holds 2 unreadable windows of 47.
describe('assessTextLayer', () => {
    // Uppercase survives the broken font and lowercase does not, so a keyword
    // grep still hits while the prose is unreadable.
    const SCRAMBLED = 'Α Π Ο Φ Α ΢ Ι Η Ε Ι : ΟΜΟΦΩΝΑ. Υπθρεςιϊν κζμα τθσ ςυνεδρίαςθσ. '
        + 'Άρα απζχετε ι διαφωνείτε; Άρα λοιπόν ομόφωνα, ευχαριςτϊ πολφ ςυνάδελφε. '.repeat(90);
    const CLEAN = 'ΥΠΕΡ ψήφισαν η Πρόεδρος και οι Σύμβουλοι του Δημοτικού Συμβουλίου για το θέμα της ημερήσιας διάταξης. '.repeat(30);

    it('calls a font-scrambled page scrambled', () => {
        expect(assessTextLayer(SCRAMBLED)).toBe('scrambled');
    });

    it('calls an ordinary Greek page usable', () => {
        expect(assessTextLayer(CLEAN)).toBe('usable');
    });

    // A Sparta ΔΣ document: a clean formal decision with the verbatim
    // discussion embedded below it in the broken font.
    it('calls a page with a clean decision and an unreadable transcript mixed', () => {
        expect(assessTextLayer(CLEAN + SCRAMBLED + CLEAN)).toBe('mixed');
    });

    it('calls a page with no text layer empty rather than scrambled', () => {
        expect(assessTextLayer('   \n  ')).toBe('empty');
    });
});

describe('corroborate', () => {
    const page = 'ΑΚΟΛΟΥΘΕΙ ΨΗΦΟΦΟΡΙΑ\nΥΠΕΡ ψήφισαν η Πρόεδρος κα Βαρδή Πολυξένη και οι κ.κ. Σύμβουλοι: Αρβανίτη Ευανθία';

    it('finds a quote that is on the page', () => {
        expect(corroborate('ΥΠΕΡ ψήφισαν η Πρόεδρος κα Βαρδή Πολυξένη', page, 'usable')).toBe('found');
    });

    // Quotes cross line breaks in the rendered page but not in the text layer.
    it('finds a quote whose whitespace does not match the text layer', () => {
        expect(corroborate('ΥΠΕΡ   ψήφισαν\n η  Πρόεδρος κα Βαρδή Πολυξένη', page, 'usable')).toBe('found');
    });

    // The one failure the whole design has to catch.
    it('reports an invented quote as not found', () => {
        expect(corroborate('ΚΑΤΑ ψήφισαν όλοι οι Σύμβουλοι του Δήμου ομοφώνως', page, 'usable')).toBe('not_found');
    });

    it('cannot judge a quote against a scrambled text layer', () => {
        expect(corroborate('Α Π Ο Φ Α ΢ Ι Η Ε Ι ΟΜΟΦΩΝΑ', page, 'scrambled')).toBe('unverifiable');
    });

    // On a mixed document a missing quote may simply sit in the unreadable
    // region, so it must not be reported as possibly invented.
    it('does not call a missing quote invented on a mixed text layer', () => {
        expect(corroborate('ΚΑΤΑ ψήφισαν όλοι οι Σύμβουλοι του Δήμου ομοφώνως', page, 'mixed')).toBe('unverifiable');
    });
});

describe('computeVerdict', () => {
    it('refuses a finding outside the field vocabulary', () => {
        const v = computeVerdict('subject', obs({ finding: 'probably_item_one' }), label(), got(), '');
        expect(v.verdict).toBe('needs_human');
    });

    // A long document whose vote sits past the pages read: "not on these pages"
    // must never be ruled as "the page names nobody".
    it('blames neither reading when the evidence is past the pages read', () => {
        const v = computeVerdict('votes', obs({ finding: OUTSIDE_SUPPLIED_PAGES }), label(), got(), '');
        expect(v.verdict).toBe('needs_human');
    });

    // Argithea 6ΥΙΡΩΨ3-9ΟΨ: the page prints «Αριθμός Απόφασης 129/2026» and no
    // ΘΕΜΑ heading; the label says null and the extractor invented #1.
    it('blames the reader when the page prints no item heading and the extractor numbered it', () => {
        const v = computeVerdict(
            'subject',
            obs({ finding: 'no_item_heading' }),
            label({ subject: { agendaItemNumber: null, isOutOfAgenda: false, verified: true } }),
            got({ subjectInfo: { agendaItemIndex: 1, nonAgendaReason: null } }),
            'page none, extracted #1',
        );
        expect(v.verdict).toBe('reader_wrong');
    });

    // Athens 4η 97ΜΗΩ6Μ-ΠΑΦ: the page prints «ΥΠΕΡ ψήφισαν η Πρόεδρος …», the
    // label's policy field agrees (`all`) and its list holds only the member
    // who did not vote — it was seeded from a reader that dropped FOR names,
    // and two such readings matching is what made it `verified: 'agreed'`.
    it('blames the label when the page names those in favour and the label lists none of them', () => {
        const v = computeVerdict(
            'votes',
            obs({ finding: 'names_all_voters', count: 1 }),
            label({
                votes: {
                    phraseAsPrinted: 'ΟΜΟΦΩΝΑ', carriesTally: false, namedVoters: 'all',
                    asExtracted: [{ name: 'ΜΑΡΚΟΥΙΖΟΣ ΗΡΑΚΛΗΣ', vote: 'DID_NOT_VOTE' }], verified: 'agreed',
                },
            }),
            got({ voteDetails: [{ name: 'Βαρδή Πολυξένη', vote: 'FOR' }, { name: 'ΜΑΡΚΟΥΙΖΟΣ ΗΡΑΚΛΗΣ', vote: 'DID_NOT_VOTE' }] }),
            'voters extra: FOR βαρδη πολυξενη',
        );
        expect(v.verdict).toBe('label_wrong');
    });

    it('blames the label when its policy field contradicts the page', () => {
        const v = computeVerdict(
            'votes',
            obs({ finding: 'names_all_voters', count: 1 }),
            label({ votes: { phraseAsPrinted: 'ΟΜΟΦΩΝΑ', carriesTally: false, namedVoters: 'none', asExtracted: [], verified: true } }),
            got({ voteDetails: [{ name: 'Βαρδή Πολυξένη', vote: 'FOR' }] }),
            'voters extra: FOR βαρδη πολυξενη',
        );
        expect(v.verdict).toBe('label_wrong');
    });

    it('blames the reader when it names members in favour on a page that names none', () => {
        const v = computeVerdict(
            'votes',
            obs({ finding: 'names_nobody', count: 0 }),
            label({ votes: { phraseAsPrinted: 'ΟΜΟΦΩΝΑ', carriesTally: false, namedVoters: 'none', asExtracted: [], verified: true } }),
            got({ voteDetails: [{ name: 'Βαρδή Πολυξένη', vote: 'FOR' }] }),
            'voters extra: FOR βαρδη πολυξενη',
        );
        expect(v.verdict).toBe('reader_wrong');
    });

    // Athens 1η 6ΥΙ2Ω6Μ-8ΓΞ: two competing ΥΠΕΡ options, four members in both.
    // Neither side is wrong — the schema cannot express it (spec §3).
    it('escalates a multi-part vote instead of blaming either side', () => {
        const v = computeVerdict(
            'votes',
            obs({ finding: 'names_all_voters', count: 2 }),
            label({ votes: { phraseAsPrinted: 'ΚΑΤΑ ΠΛΕΙΟΨΗΦΙΑ', carriesTally: false, namedVoters: 'none', asExtracted: [], verified: true } }),
            got({ voteDetails: [{ name: 'Βασαλμάκη Αικ.', vote: 'FOR' }] }),
            'voters extra: FOR βασαλμακη αικ.',
        );
        expect(v.verdict).toBe('needs_human');
        expect(v.reason).toMatch(/multi-part/);
    });

    it('blames the reader when the page pins a change to a decision number and the extractor said phase', () => {
        const v = computeVerdict(
            'attendanceChanges',
            obs({ finding: 'decision_number', count: 286 }),
            label({ attendanceChanges: { stated: true, anchoredBy: 'decision_number', asExtracted: [], verified: true } }),
            got({
                attendanceChanges: [{
                    name: 'Χ', type: 'departure', agendaItem: null, timing: null, rawText: '',
                    anchor: { kind: 'phase', agendaItem: null, decisionNumber: null, phase: 'pre_agenda', timing: null },
                }],
            }),
            'anchor: page decision_number, extracted phase',
        );
        expect(v.verdict).toBe('reader_wrong');
    });

    // Labels written before the anchor vocabulary settled spell the phase anchor
    // session_phase; the page can only ever say phase.
    it('treats a legacy session_phase label as the phase anchor', () => {
        const v = computeVerdict(
            'attendanceChanges',
            obs({ finding: 'phase' }),
            label({ attendanceChanges: { stated: true, anchoredBy: 'session_phase', asExtracted: [], verified: true } }),
            got({
                attendanceChanges: [{
                    name: 'Χ', type: 'arrival', agendaItem: null, timing: null, rawText: '',
                    anchor: { kind: 'agenda_item', agendaItem: { agendaItemIndex: 1, nonAgendaReason: null }, decisionNumber: null, phase: null, timing: 'during' },
                }],
            }),
            'anchor: page phase, extracted agenda_item',
        );
        expect(v.verdict).toBe('reader_wrong');
    });

    // Athens 1η 6ΣΟΔΩ6Μ-Φ3Χ: κουφακης against κουκακης is a real letter apart.
    it('blames the label when the page carries the spelling the extractor read', () => {
        const v = computeVerdict(
            'rollCall',
            obs({ finding: 'roll_call_quoted', quote: 'ΠΑΡΟΝΤΕΣ: Παναγιώτης Κουκάκης, Παπαδόπουλος Ιωάννης' }),
            label(),
            got(),
            'present lost: παναγιωτης κουφακης; present extra: παναγιωτης κουκακης',
        );
        expect(v.verdict).toBe('label_wrong');
    });

    // Both spellings of Ψ75ΤΩ6Μ-6ΔΡ's «Αγρoγιάννη» differ only by a Latin o, so
    // normalisation makes them one name and the quote supports each equally.
    // The scorer no longer raises this dispute at all; if one is replayed from
    // an older run, the page cannot settle it and must not pretend otherwise.
    it('escalates a dispute that is only a Latin homoglyph', () => {
        const v = computeVerdict(
            'rollCall',
            obs({ finding: 'roll_call_quoted', quote: 'ΠΑΡΟΝΤΕΣ: Αγρoγιάννη-Μουκριώτου Ζαχαρία, Παπαδόπουλος Ιωάννης' }),
            label(),
            got(),
            'present lost: αγρογιαννη-μουκριωτου ζαχαρια; present extra: αγρoγιαννη-μουκριωτου ζαχαρια',
        );
        expect(v.verdict).toBe('needs_human');
    });

    it('escalates a roll-call dispute that is not a one-for-one spelling swap', () => {
        const v = computeVerdict(
            'rollCall',
            obs({ finding: 'roll_call_quoted', quote: 'ΠΑΡΟΝΤΕΣ: Παπαδόπουλος Ιωάννης' }),
            label(),
            got(),
            'present extra: μπατσακη πολυξενη',
        );
        expect(v.verdict).toBe('needs_human');
    });

    it('escalates when the page matches both readings, because the dispute is elsewhere', () => {
        const v = computeVerdict(
            'subject',
            obs({ finding: 'numbered_agenda_item', count: 3 }),
            label({ subject: { agendaItemNumber: 3, isOutOfAgenda: false, verified: true } }),
            got({ subjectInfo: { agendaItemIndex: 3, nonAgendaReason: null } }),
            'page #3, extracted #3',
        );
        expect(v.verdict).toBe('needs_human');
    });

    it('reports both wrong when the page matches neither', () => {
        const v = computeVerdict(
            'subject',
            obs({ finding: 'numbered_agenda_item', count: 7 }),
            label({ subject: { agendaItemNumber: 3, isOutOfAgenda: false, verified: true } }),
            got({ subjectInfo: { agendaItemIndex: 1, nonAgendaReason: null } }),
            'page #3, extracted #1',
        );
        expect(v.verdict).toBe('both_wrong');
    });
});

describe('computeVerdict, attendanceChanges', () => {
    const anchorDispute = 'anchor: page agenda_item, extracted decision_number';
    const change = (type: 'arrival' | 'departure', kind: 'agenda_item' | 'decision_number', value: string) => ({
        name: 'Χ', type, agendaItem: null, timing: null, rawText: '',
        anchor: { kind, value, timing: 'during' as const, subjectId: null },
    }) as unknown as RawExtractedDecision['attendanceChanges'][number];

    it('settles an anchor-kind dispute when each side offers one anchor', () => {
        const v = computeVerdict(
            'attendanceChanges',
            obs({ finding: 'decision_number', quote: 'απεχώρησε στην 286 ΑΚΣ' }),
            label({ attendanceChanges: { stated: true, anchoredBy: 'agenda_item', asExtracted: [], verified: true } }),
            got({ attendanceChanges: [change('departure', 'decision_number', '286')] }),
            anchorDispute,
        );
        expect(v.verdict).toBe('label_wrong');
    });

    it('refuses a dispute about which changes exist, since one anchor cannot answer it', () => {
        const v = computeVerdict(
            'attendanceChanges',
            obs({ finding: 'agenda_item', quote: 'κατά τη συζήτηση του 3ου θέματος αποβλήθηκε' }),
            label({ attendanceChanges: { stated: true, anchoredBy: 'session', asExtracted: [], verified: true } }),
            got({ attendanceChanges: [change('departure', 'agenda_item', '3')] }),
            'changes lost: departure π. σκουφης @ session, departure ν. δελης @ session',
        );
        expect(v.verdict).toBe('needs_human');
    });

    // The label carries a single anchor, so passing the extractor because one of
    // several changes matched would hold the two sides to different standards.
    it('refuses when the extractor read several differently pinned changes', () => {
        const v = computeVerdict(
            'attendanceChanges',
            obs({ finding: 'agenda_item', quote: 'κατά τη συζήτηση του 3ου θέματος' }),
            label({ attendanceChanges: { stated: true, anchoredBy: 'phase', asExtracted: [], verified: true } }),
            got({ attendanceChanges: [change('departure', 'agenda_item', '3'), change('arrival', 'decision_number', '12')] }),
            anchorDispute,
        );
        expect(v.verdict).toBe('needs_human');
    });
});

describe('adjudicationCacheKey', () => {
    // An entry holds what the model observed on the pages it was sent. Pages 1-12
    // became the first nine and the last three, and an entry read from the old
    // window kept a dispute on page 30 unsettled on every rerun.
    it('names the page window the observation was made from', () => {
        const key = adjudicationCacheKey('ΨΗΝΥΩΞΠ-93Χ', 'rollCall');
        expect(key).toContain('head9-tail3');
        expect(key).not.toMatch(/#adjudicate-rollCall-v2$/);
    });
});
