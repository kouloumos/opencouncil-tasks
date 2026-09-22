import Anthropic from '@anthropic-ai/sdk';
import { aiChat, ResultWithUsage, NO_USAGE, addUsage, HAIKU_MODEL } from '../../lib/ai.js';
import type { AttendancePhase, DecisionConventions } from '../../types.js';
import { PDFDocument } from 'pdf-lib';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// --- PDF download ---

export function adaToPdfUrl(ada: string): string {
    return `https://diavgeia.gov.gr/doc/${encodeURIComponent(ada)}`;
}

export async function downloadPdfAsBuffer(source: string): Promise<Buffer> {
    // Local file path
    if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) {
        const filePath = decodeURIComponent(source);
        console.log(`Reading local file: ${filePath}...`);
        const buffer = fs.readFileSync(filePath);
        console.log(`Read file: ${(buffer.length / 1024).toFixed(0)} KB`);
        return buffer;
    }

    console.log(`Downloading file from ${source}...`);
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Failed to download PDF from ${source}: HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`Downloaded file: ${(buffer.length / 1024).toFixed(0)} KB`);
    return buffer;
}

/** @deprecated Use downloadPdfAsBuffer instead */
export async function downloadPdfToBase64(source: string): Promise<string> {
    const buffer = await downloadPdfAsBuffer(source);
    return buffer.toString('base64');
}

// PDF page selection lives in pdfPages.ts; imported for use below and
// re-exported so existing callers keep importing it from here.
import { extractPdfPages, extractPdfPageSet, headAndTailPages } from './pdfPages.js';
export { extractPdfPages, extractPdfPageSet, headAndTailPages };

// --- Extraction cache ---
// Caches Claude extraction results per PDF URL to avoid re-downloading and re-processing
// during iterative development. Uses a fixed path so it persists across nix-shell sessions.

const CACHE_DIR = '/tmp/opencouncil-decisions-cache';

function getCachePath(pdfUrl: string, prefix: string): string {
    const hash = crypto.createHash('sha256').update(pdfUrl).digest('hex').slice(0, 16);
    return path.join(CACHE_DIR, `${prefix}${hash}.json`);
}

export function readCache<T>(pdfUrl: string, prefix = 'decision-'): T | null {
    const cachePath = getCachePath(pdfUrl, prefix);
    try {
        const data = fs.readFileSync(cachePath, 'utf-8');
        console.log(`Cache hit for ${pdfUrl}`);
        return JSON.parse(data) as T;
    } catch {
        return null;
    }
}

export function writeCache<T>(pdfUrl: string, data: T, prefix = 'decision-'): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(getCachePath(pdfUrl, prefix), JSON.stringify(data, null, 2));
    } catch (err) {
        console.warn('Failed to write extraction cache:', err);
    }
}

// --- PDF extraction types ---

export type AgendaItemRef = {
    agendaItemIndex: number;
    nonAgendaReason: 'outOfAgenda' | null;  // null = regular agenda item
};

/**
 * What a document pins an attendance change to — the vocabulary of the page, as
 * read. It is not the wire vocabulary: `wireAnchor` maps it to
 * `AttendanceAnchorKind` in types.ts, which has `subject` where this has
 * `this_document` and no `this_document` of its own.
 */
export type DocumentAnchorKind =
    | 'agenda_item' | 'decision_number' | 'phase' | 'this_document' | 'session_start' | 'session_end';

export interface AttendanceAnchor {
    kind: DocumentAnchorKind;
    agendaItem: AgendaItemRef | null;      // when kind is agenda_item
    decisionNumber: string | null;         // when kind is decision_number, e.g. "286"
    phase: AttendancePhase | null;         // when kind is phase: the block the page names
    timing: 'before' | 'during' | 'after' | null;
}

export interface AttendanceChange {
    name: string;
    /** absent_for_vote: «Κατά τη διαδικασία της ψηφοφορίας απουσίαζε…» — scoped to this document's decision only. */
    type: 'arrival' | 'departure' | 'absent_for_vote';
    agendaItem: AgendaItemRef | null;      // null = session-level (start/end) or anchored elsewhere
    timing: 'during' | 'after' | null;     // null when agendaItem is null
    /** Absent on cached extractions from before anchors existed; readers must tolerate that. */
    anchor?: AttendanceAnchor;
    rawText: string;
}

/** The anchor of a change, reconstructed for extractions cached before anchors existed. */
export function changeAnchor(change: AttendanceChange): AttendanceAnchor {
    if (change.anchor) return change.anchor;
    if (change.type === 'absent_for_vote') return { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: null };
    if (change.agendaItem) return { kind: 'agenda_item', agendaItem: change.agendaItem, decisionNumber: null, phase: null, timing: change.timing };
    return { kind: change.type === 'arrival' ? 'session_start' : 'session_end', agendaItem: null, decisionNumber: null, phase: null, timing: null };
}

export type VoteValue = 'FOR' | 'AGAINST' | 'ABSTAIN' | 'PRESENT' | 'DID_NOT_VOTE';

/**
 * Raw shape returned by the LLM. The attendance section varies by PDF format:
 * - "composition_and_absent": PDF lists all members (ΣΥΝΘΕΣΗ) + absent separately
 * - "explicit_present_absent": PDF has explicit ΠΑΡΟΝΤΕΣ / ΑΠΟΝΤΕΣ lists
 */
interface RawLlmExtraction {
    attendanceFormat: 'composition_and_absent' | 'explicit_present_absent';
    /** All council members listed in ΣΥΝΘΕΣΗ — only when attendanceFormat is "composition_and_absent" */
    compositionMembers: string[] | null;
    /** Members from ΠΑΡΟΝΤΕΣ list — only when attendanceFormat is "explicit_present_absent" */
    presentMembers: string[] | null;
    /** Members from ΑΠΟΝΤΕΣ / "απουσίαζαν" list — always present */
    absentMembers: string[];
    mayorPresent: { present: boolean; rawText: string } | null;
    decisionExcerpt: string;
    decisionNumber: string | null;
    references: string;
    voteResult: string | null;
    voteDetails: { name: string; vote: VoteValue }[];
    attendanceChanges: LlmAttendanceChange[];
    discussionOrder: AgendaItemRef[] | null;
    subjectInfo: AgendaItemRef | null;
    incomplete: boolean;
    /** Who presided in the mayor's or president's place; name "" when the page says nothing. */
    presidedBy: { name: string; rawText: string };
    /** Who kept the minutes in the secretary's place («εκτελούσα χρέη Γραμματέα»); name "" when the page says nothing. */
    actingSecretary: { name: string; rawText: string };
    /** The item heading as printed («ΘΕΜΑ 3ο», «1ο ΕΚΤΑΚΤΟ ΘΕΜΑ»); "" when the page prints no item number for this decision. */
    subjectHeading: string;
    /** The members listed as present for THIS decision after the decision text (ΤΑ ΜΕΛΗ); empty when the page prints no such list. */
    decisionAttendance: { present: string[]; rawText: string };
    /** Counts printed in the vote phrase; -1 for a value the page does not count. */
    voteTally: Record<VoteValue, number>;
}

/**
 * The change as the model returns it. Structured outputs cap the number of
 * nullable parameters per schema, so "not applicable" is an empty string,
 * a zero or "none" here and becomes null in normalizeExtraction.
 */
interface LlmAttendanceChange {
    name: string;
    type: 'arrival' | 'departure' | 'absent_for_vote';
    anchor: {
        kind: DocumentAnchorKind;
        agendaItemIndex: number;      // 0 when kind is not agenda_item
        outOfAgenda: boolean;
        decisionNumber: string;       // "" when not decision_number
        phase: AttendancePhase | 'none';  // 'none' when kind is not phase
        timing: 'before' | 'during' | 'after' | 'none';
    };
    rawText: string;
}

function fromLlmChange(c: LlmAttendanceChange): AttendanceChange {
    const a = c.anchor;
    const agendaItem: AgendaItemRef | null = a.kind === 'agenda_item' && a.agendaItemIndex > 0
        ? { agendaItemIndex: a.agendaItemIndex, nonAgendaReason: a.outOfAgenda ? 'outOfAgenda' : null }
        : null;
    const anchor: AttendanceAnchor = {
        kind: c.type === 'absent_for_vote' ? 'this_document' : a.kind,
        agendaItem,
        decisionNumber: a.kind === 'decision_number' && a.decisionNumber ? a.decisionNumber : null,
        phase: a.kind === 'phase' && a.phase !== 'none' ? a.phase : null,
        timing: a.timing === 'none' ? null : a.timing,
    };
    // «Πριν» means the member was not there for the item, which is what 'during' has always meant here.
    const timing: 'during' | 'after' | null = agendaItem ? (anchor.timing === 'after' ? 'after' : 'during') : null;
    return { name: c.name, type: c.type, agendaItem, timing, anchor, rawText: c.rawText };
}

/**
 * Normalize the LLM extraction into the standard shape used by the pipeline.
 * When the PDF uses "composition + absent" format, computes present = composition - absent
 * so the LLM doesn't have to do any subtraction.
 */
export function normalizeExtraction(raw: RawLlmExtraction): RawExtractedDecision {
    let presentMembers: string[];
    let absentMembers = raw.absentMembers || [];

    if (raw.attendanceFormat === 'composition_and_absent') {
        if (raw.compositionMembers && raw.compositionMembers.length > 0) {
            // Compute present = composition - absent. Absentees are often printed
            // abbreviated («Αθανασάκης Σ.») against a spelled-out composition.
            presentMembers = raw.compositionMembers.filter(n => !greekNameInList(n, absentMembers));
        } else {
            console.warn('⚠ LLM returned attendanceFormat "composition_and_absent" but compositionMembers is empty — attendance may be incomplete');
            presentMembers = raw.presentMembers || [];
        }
    } else {
        presentMembers = raw.presentMembers || [];
    }
    // Whatever the layout, a member the page lists as absent is not present:
    // the model has been seen returning the whole ΣΥΝΘΕΣΗ as the present list.
    presentMembers = presentMembers.filter(n => !greekNameInList(n, absentMembers));

    // The anchor is the fact; agendaItem/timing are its agenda-item projection,
    // kept for every reader that predates anchors.
    const attendanceChanges = (raw.attendanceChanges || []).map(fromLlmChange);

    const VOTE_VALUES: VoteValue[] = ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'];
    const voteTally = Object.fromEntries(VOTE_VALUES.map(k => [k, raw.voteTally?.[k] >= 0 ? raw.voteTally[k] : null])) as Record<VoteValue, number | null>;

    return {
        attendanceFormat: raw.attendanceFormat,
        compositionMembers: raw.compositionMembers,
        presentMembers,
        absentMembers,
        mayorPresent: raw.mayorPresent,
        presidedBy: raw.presidedBy?.name ? raw.presidedBy : null,
        actingSecretary: raw.actingSecretary?.name ? raw.actingSecretary : null,
        // The heading is kept as a fact beside the number, not as a gate on it:
        // nulling the number whenever the heading came back empty cost 15 correct
        // numbers on the fixture (the reader takes the number from places it does
        // not call a heading) and fixed none of the five invented ones.
        subjectInfo: raw.subjectInfo,
        subjectHeading: raw.subjectHeading?.trim() ?? '',
        voteTally,
        decisionAttendance: raw.decisionAttendance?.present?.length ? raw.decisionAttendance : null,
        decisionExcerpt: raw.decisionExcerpt,
        decisionNumber: raw.decisionNumber,
        references: raw.references,
        voteResult: raw.voteResult,
        voteDetails: raw.voteDetails,
        attendanceChanges,
        discussionOrder: raw.discussionOrder,
        incomplete: raw.incomplete,
    };
}

export interface RawExtractedDecision {
    /** The layout the page used and the composition it printed, when it printed one. */
    attendanceFormat: 'composition_and_absent' | 'explicit_present_absent';
    compositionMembers: string[] | null;
    presentMembers: string[];
    absentMembers: string[];
    mayorPresent: { present: boolean; rawText: string } | null;
    decisionExcerpt: string;
    decisionNumber: string | null;
    references: string;
    voteResult: string | null;
    voteDetails: { name: string; vote: VoteValue }[];
    attendanceChanges: AttendanceChange[];
    /** Kept as a document fact, read only by the CLI — deliberately not on the wire. */
    discussionOrder: AgendaItemRef[] | null;
    subjectInfo: AgendaItemRef | null;
    incomplete: boolean;
    presidedBy: { name: string; rawText: string } | null;
    actingSecretary: { name: string; rawText: string } | null;
    /** The item heading as printed; "" when the page prints none, in which case subjectInfo is null. */
    subjectHeading: string;
    voteTally: Record<VoteValue, number | null>;
    /** The page's own list of who was present for this decision (ΤΑ ΜΕΛΗ after the decision), never the opening roll call. */
    decisionAttendance: { present: string[]; rawText: string } | null;
}

// --- PDF parsing with Claude ---

const EXTRACTION_SYSTEM_PROMPT = `You are a document parser for Greek municipal council decision PDFs (Αποφάσεις Δημοτικού Συμβουλίου).

Extract the following information from the PDF:

1. **attendanceFormat**: How attendance is structured in this PDF. One of:
   - "composition_and_absent" — The PDF has a "ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ" section listing ALL council members, followed by a separate "απουσίαζαν" / "ΑΠΟΝΤΕΣ" section listing absent members.
   - "explicit_present_absent" — The PDF has separate "Παρόντες" / "ΠΑΡΟΝΤΕΣ" and "Απόντες" / "ΑΠΟΝΤΕΣ" lists, OR a sentence naming who was present ("Παρόντες κατά την έναρξη της συνεδρίασης ήταν …"). A sentence that names the present members wins over any roster printed above it: use "explicit_present_absent" and copy exactly the names it gives.
   A committee roster split into "ΤΑΚΤΙΚΑ" and "ΑΝΑΠΛΗΡΩΜΑΤΙΚΑ" (regular and substitute members) is NOT an attendance list: substitutes are present only when the document names them as present (e.g. "ΠΟΛΙΤΗΣ ΘΩΜΑΣ (αναπλ. μέλος)"). Never count the ΑΝΑΠΛΗΡΩΜΑΤΙΚΑ list into compositionMembers.
2. **compositionMembers**: When attendanceFormat is "composition_and_absent", extract ALL names from the ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ section — this is the complete council membership. Set to null when attendanceFormat is "explicit_present_absent".
3. **presentMembers**: When attendanceFormat is "explicit_present_absent", extract names from the ΠΑΡΟΝΤΕΣ list. Set to null when attendanceFormat is "composition_and_absent".
4. **absentMembers**: Names from the ΑΠΟΝΤΕΣ / "απουσίαζαν" section. Always extract this regardless of format. Do NOT remove someone from this list just because they arrived later (Προσελεύσεις) — that information goes in attendanceChanges.
5. **decisionExcerpt**: The decision text, starting from "ΤΟ Δ.Σ αφού έλαβε υπόψη" or similar phrasing through "ΑΠΟΦΑΣΙΖΕΙ" and the decision content. Include the full decision text — do not skip or omit any sections. Use markdown formatting to preserve structure (tables, bullet points, numbered lists, etc.). When the PDF contains tabular data, render it as a markdown table with all rows including summary/total rows. Not all tables follow the same columnar format — budget amendments may include title-change tables (ΑΠΟ/ΣΕ), revenue limit tables, or other non-standard layouts. Represent these faithfully using the most appropriate markdown structure (table, list, or formatted text). Preserve bold formatting from the PDF — if text is bold in the original, wrap it in **bold** markdown. The "decides" statement (e.g. "ΑΠΟΦΑΣΙΖΕΙ", "Το Δημοτικό Συμβούλιο … αποφασίζει ομόφωνα") must be its own paragraph — keep the full sentence on one line, separated by blank lines from surrounding text, not merged with the decision content that follows.
6. **decisionNumber**: The decision number (Αριθμός Απόφασης), e.g. "231/2025".
7. **references**: The legal bases and references from the "αφού έλαβε υπόψη" or "Έχοντας υπόψη" section. List each reference item. Use markdown formatting (numbered list). If the section just says something generic like "τις σχετικές διατάξεις της Νομοθεσίας", return that text as-is.
8. **voteResult**: The vote result phrase, e.g. "Ομόφωνα", "Κατά πλειοψηφία", "Κατά πλειοψηφία με ψήφους 21 υπέρ και 2 κατά". This is usually found right before or after "ΑΠΟΦΑΣΙΖΕΙ".
9. **voteDetails**: Every person the PDF names with a vote or a declaration. Usually that is only dissenters and declarations; when the page lists those in favour by name ("ΥΠΕΡ ψήφισαν …", "Οι κάτωθι Δημοτικοί Σύμβουλοι έδωσαν θετική ψήφο: …"), list every one of them as FOR too. Never invent a FOR entry for someone the page does not name. For a unanimous decision that names nobody, return an empty array. Each entry has "name" (full name) and "vote":
   - "FOR" (ΥΠΕΡ) — voted in favor
   - "AGAINST" (ΚΑΤΑ) — voted against
   - "ABSTAIN" (ΛΕΥΚΟ) — blank vote, no position taken (still a vote)
   - "PRESENT" (ΠΑΡΩΝ/ΠΑΡΟΥΣΑ) — declared physical presence but did not participate in the vote (declaration, not a vote)
   - "DID_NOT_VOTE" (ΑΠΟΧΗ) — declined to participate (declaration, not a vote)
10. **attendanceChanges**: Members who arrived late, left early, or were absent for this decision's vote. Look in "Προσελεύσεις – Αποχωρήσεις" sections, in the attendance preamble (e.g. "Ο κ. Χ απεχώρησε στην 286 ΑΚΣ", "προσήλθε κατά τη συζήτηση του 3ου θέματος"), and at the end of the document ("Κατά τη διαδικασία της ψηφοφορίας απουσίαζε ο κ. Χ"). Include the mayor when the page says the mayor arrived or left («Η Δήμαρχος … προσήλθε στη λήξη της συζήτησης του 8ου θέματος»), with the name as printed. For each person, extract:
   - "name": full name as printed
   - "type": "arrival", "departure", or "absent_for_vote" (the document says the member was absent for THIS decision's vote — «απουσίαζε κατά τη διαδικασία της ψηφοφορίας», «απουσίαζαν από την αίθουσα κατά την ψήφιση του θέματος»)
   - "anchor": WHAT the document pins the change to. Copy the document; never convert one kind into another.
     - "kind": "agenda_item" (a numbered item: "κατά τη συζήτηση του 3ου θέματος", "μετά το 1ο έκτακτο θέμα"); "decision_number" (a decision number: "στην 286 ΑΚΣ", "μετά την 230 απόφαση"); "phase" (a moment named without an item number: "pre_agenda" for anything before the agenda items — «πριν την έναρξη της ημερήσιας διάταξης», «κατά τις ερωτήσεις της προ ημερησίας», «μετά την ανάδειξη του Προεδρείου», «στην ανάγνωση των δια περιφοράς»; "out_of_agenda" for «κατά τη συζήτηση των θεμάτων εκτός ημερήσιας διάταξης»); "this_document" (for absent_for_vote); "session_start" / "session_end" (arrived at the start or left at the end, nothing more specific)
     - "agendaItemIndex": the item number when kind is "agenda_item", else 0
     - "outOfAgenda": true when that item is ΕΚΤΑΚΤΟ / ΕΚΤΟΣ Η.Δ., else false
     - "decisionNumber": the number as printed (e.g. "286") when kind is "decision_number", else ""
     - "phase": "pre_agenda" or "out_of_agenda" when kind is "phase", else "none". A printed clock time («ώρα 19:18») is never an anchor: use the item printed with it, or "session_start" when the sentence says only «κατά τη διάρκεια της συνεδρίασης».
     - "timing": "before" ("πριν τη συζήτηση"), "during" ("κατά τη διάρκεια", "κατά τη συζήτηση", "στην 286 ΑΚΣ"), "after" ("μετά τη λήξη", "μετά το 5ο θέμα", "μετά την 230 ΑΚΣ"), or "none" when the kind carries no timing
   - "rawText": the original sentence describing this change
   If no such statements exist, return an empty array.
11. **discussionOrder**: When subjects were discussed out of the standard agenda order (e.g. "Προτάθηκε η αλλαγή σειράς συζήτησης", items reordered, or out-of-agenda items inserted between regular items), extract the full discussion sequence including both regular and out-of-agenda/emergency items. Each entry is an object with:
   - "agendaItemIndex": the item number
   - "nonAgendaReason": "outOfAgenda" if the item is an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ), otherwise null
   Example: if regular item 1 was discussed first, then 3 out-of-agenda items, then regular item 9 was brought forward, the sequence would be: [{"agendaItemIndex":1,"nonAgendaReason":null},{"agendaItemIndex":1,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":2,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":3,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":9,"nonAgendaReason":null},...].
   Return null if subjects were discussed in standard agenda order with no out-of-agenda items interleaved.
12. **subjectInfo**: The agenda item this decision relates to:
   - "agendaItemIndex": The subject/topic number (e.g., "ΘΕΜΑ 3ο" → 3, "1ο ΕΚΤΑΚΤΟ ΘΕΜΑ" → 1, "ΘΕΜΑ ΕΚΤΟΣ Η.Δ. 2ο" → 2)
   - "nonAgendaReason": "outOfAgenda" if this is an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ, ΘΕΜΑ ΕΚΤΟΣ Η.Δ., etc.), null for regular agenda items (ΘΕΜΑ Η.Δ., τακτικό θέμα)
   - Return null if the subject/topic number cannot be determined. Return null when the page prints no item number for THIS decision; never infer one from position, from the decision number, or from a "1ο" in a heading that belongs to another item.
   - "subjectHeading" (a separate top-level field): the heading you read the number from, exactly as printed («ΘΕΜΑ 3ο», «1ο ΕΚΤΑΚΤΟ ΘΕΜΑ», «ΘΕΜΑ ΕΚΤΟΣ Η.Δ. 2ο»). Return "" when there is no such heading — a decision that prints only «Αριθμός Απόφασης 129/2026» and calls its item «το παρακάτω θέμα» has no heading and no item number.
13. **mayorPresent**: Whether the city mayor (Δήμαρχος/Δήμαρχο) was present at the session. This is usually stated in a narrative paragraph separate from the council member attendance list. Look for phrases like "Ο/Η Δήμαρχος ... προσκλήθηκε νομίμως και παρέστη" or "Ο/Η Δήμαρχος ... παρών/παρούσα" (present), or "Ο/Η Δήμαρχος ... δεν ήταν παρών/παρούσα" or "απουσίαζε" (absent). Return an object with "present" (boolean) and "rawText" (the original sentence from the PDF describing the mayor's presence/absence). Return null if mayor presence is not mentioned.
14. **incomplete**: Set to true ONLY if the document appears physically truncated — i.e. you can see attendance lists and preamble but the decision section starting with "ΑΠΟΦΑΣΙΖΕΙ" is not present because the provided pages end before reaching it. Set to false if you can see the "ΑΠΟΦΑΣΙΖΕΙ" section, even if some fields within it (like the vote result phrase) are missing or unclear. Missing data in a complete document is a data quality issue, not truncation.

15. **presidedBy**: When the page says someone presided over the session in place of the mayor or the president («ο Αντιπρόεδρος κ. Χ, ο οποίος προήδρευσε λόγω της απουσίας της Δημάρχου», «προεδρεύοντος του Αντιδημάρχου κ. Χ»), return {"name": the full name as printed, "rawText": the sentence}. Presiding means chairing the meeting (προήδρευσε, προεδρεύων, προεδρεύοντος). A deputy standing in for the absent mayor in the mayor's capacity («του Δημάρχου απουσιάζοντος και αναπληρούμενου από τον Αντιδήμαρχο κ. Χ») is NOT presiding unless the page also says he chaired; the session's usual president still presides. Otherwise {"name": "", "rawText": ""}.

16. **actingSecretary**: When the page says someone kept the minutes in the secretary's place («Η εκτελούσα χρέη Γραμματέα κα. Χ», «χρέη γραμματέα εκτέλεσε ο κ. Χ»), return {"name": the full name as printed, "rawText": the sentence}. Otherwise {"name": "", "rawText": ""}.

17. **voteTally**: The counts printed in the vote phrase, per value: FOR (υπέρ / θετικές ψήφοι), AGAINST (κατά / αρνητικές), ABSTAIN (λευκά), PRESENT (παρών), DID_NOT_VOTE (αποχή). Use -1 for every value the page does not count. «Κατά πλειοψηφία με 12 υπέρ και 3 κατά» → FOR 12, AGAINST 3, the rest -1. «Ομόφωνα» → all -1. Never count names yourself.

18. **decisionAttendance**: Some bodies print, AFTER the decision text, the members present for THIS decision: a list headed ΤΑ ΜΕΛΗ / ΠΑΡΟΝΤΑ ΜΕΛΗ. Return {"present": the names in that list, "rawText": the heading and its first line}. A list of who had LEFT (ΑΠΟΧΩΡΗΣΑΝΤΕΣ) is not a present list: never put its names in "present". When the page prints no such list, return {"present": [], "rawText": ""}. Never copy the opening roll call (ΠΑΡΟΝΤΕΣ/ΣΥΝΘΕΣΗ at the top) here, and never remove anyone from presentMembers because of this list.

If a field cannot be found, use empty array for lists, empty string for text, and null where indicated.`;
// The output shape itself is not described here — it is enforced by
// EXTRACTION_OUTPUT_SCHEMA via structured outputs, so the prompt only needs
// the field-finding guidance above.

// --- Greek name matching ---

/**
 * Normalize a Greek name for matching: strip diacritics (tonos), remove
 * parenthetical nicknames like "(ΜΠΑΜΠΗΣ)", collapse whitespace, lowercase.
 */
/**
 * Latin letters that are indistinguishable from a Greek letter in the fonts
 * these documents use, folded towards Greek.
 *
 * Municipal templates really do mix them: \u00ab\u0391\u03b3\u03c1o\u03b3\u03b9\u03ac\u03bd\u03bd\u03b7-\u039c\u03bf\u03c5\u03ba\u03c1\u03b9\u03ce\u03c4\u03bf\u03c5\u00bb carries a
 * Latin o in the roll call of `\u03a1\u039f\u03a8\u0398\u03a96\u039c-2\u03a58` and a Greek omicron elsewhere on
 * the same page. Without this, two spellings of one name compare unequal over
 * a character nobody can see \u2014 the matcher drops the person, and the scorer
 * reports a disagreement that flips between runs depending on which occurrence
 * the model happened to read.
 */
const LATIN_TO_GREEK: Record<string, string> = {
    A: '\u0391', B: '\u0392', E: '\u0395', Z: '\u0396', H: '\u0397', I: '\u0399', K: '\u039a', M: '\u039c',
    N: '\u039d', O: '\u039f', P: '\u03a1', T: '\u03a4', X: '\u03a7', Y: '\u03a5',
    a: '\u03b1', e: '\u03b5', i: '\u03b9', k: '\u03ba', o: '\u03bf', p: '\u03c1', t: '\u03c4', x: '\u03c7', y: '\u03c5', v: '\u03bd',
};

export function foldGreekHomoglyphs(s: string): string {
    return s.replace(/[ABEZHIKMNOPTXYaeikoptxyv]/g, c => LATIN_TO_GREEK[c] ?? c);
}

export function normalizeGreekName(name: string): string {
    return foldGreekHomoglyphs(name)
        .replace(/\s*\([^)]*\)\s*/g, ' ')      // strip parenthetical nicknames
        .replace(/[\u2010-\u2015\u2212]/g, ' ')  // normalize Unicode dashes (en-dash, em-dash, etc.) to spaces; preserve ASCII hyphen-minus in compound surnames
        .normalize('NFD')                        // decompose accented chars
        .replace(/[\u0300-\u036f]/g, '')         // strip combining diacriticals (tonos etc.)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Does `short` name the same person as `full`? Documents abbreviate members
 * as «Αθανασάκης Σ.» or «Καρύδας Δ.-Ε.» while the composition and the roster
 * spell them out. Every whole word of `short` must be a word of `full`, and
 * every initial must open some remaining word of `full`.
 */
export function sameGreekPerson(short: string, full: string): boolean {
    const a = normalizeGreekName(short);
    const b = normalizeGreekName(full);
    if (a === b) return true;
    const words = (n: string) => n.split(/[\s-]+/).filter(Boolean);
    const fullWords = words(b);
    const initials: string[] = [];
    const whole: string[] = [];
    // «Ντ.» and «Μπ.» are one initial each, so a trailing dot marks an initial
    // whatever its length; a bare single letter counts as one too.
    for (const w of words(a)) {
        if (w.endsWith('.')) initials.push(w.slice(0, -1));
        else if (w.length === 1) initials.push(w);
        else whole.push(w);
    }
    if (whole.length === 0) return false;
    const remaining = [...fullWords];
    for (const w of whole) {
        const i = remaining.indexOf(w);
        if (i < 0) return false;
        remaining.splice(i, 1);
    }
    for (const ch of initials) {
        const i = remaining.findIndex(w => w.startsWith(ch));
        if (i < 0) return false;
        remaining.splice(i, 1);
    }
    return true;
}

/** Is `name` listed in `list`, allowing abbreviated forms on either side? */
export function greekNameInList(name: string, list: string[]): boolean {
    return list.some(other => sameGreekPerson(name, other) || sameGreekPerson(other, name));
}

/**
 * Build a sorted token key from a normalized name string.
 */
function buildSortKey(normalized: string): string {
    return normalized
        .replace(/[-–—]/g, ' ')   // treat hyphens as word separators
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(' ');
}

/**
 * Generate token-sort keys for a name. Returns multiple keys when the name
 * contains a parenthetical nickname like "(ΚΩΣΤΗΣ)": one key with the nickname
 * stripped and one with the nickname replacing the preceding name part.
 * This handles Greek naming conventions where the DB may store the informal name
 * (e.g. "Κωστής Παπαναστασόπουλος") while the PDF has the formal name + nickname
 * (e.g. "ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)").
 */
export function tokenSortKeys(name: string): string[] {
    const keys: string[] = [];

    // Key 1: standard — strip nickname entirely
    keys.push(buildSortKey(normalizeGreekName(name)));

    // Key 2: nickname variant — if "(NICKNAME)" is present, replace the word
    // immediately before it with the nickname
    const nicknameMatch = name.match(/(\S+)\s*\(([^)]+)\)/);
    if (nicknameMatch) {
        const replaced = name
            .replace(/\S+\s*\([^)]+\)/, nicknameMatch[2]); // replace "WORD (NICK)" with "NICK"
        const nicknameKey = buildSortKey(normalizeGreekName(replaced));
        if (nicknameKey !== keys[0]) {
            keys.push(nicknameKey);
        }
    }

    return keys;
}

/** Convenience: primary token-sort key (nickname stripped). */
export function tokenSortKey(name: string): string {
    return tokenSortKeys(name)[0];
}

export interface PersonForMatching {
    id: string;
    name: string;
}

interface MatchResult {
    matchedIds: string[];
    unmatched: string[];
}

/**
 * Step 1: Token-sort matching. Handles name order differences, hyphenation,
 * and nickname-as-first-name variants.
 * Returns matched personIds and remaining unmatched raw names.
 */
export function matchMembersToPersonIds(
    rawNames: string[],
    people: PersonForMatching[],
): MatchResult {
    // Build token-sorted lookup: sortedTokens → personId
    // Include all key variants from each person's name
    const lookup = new Map<string, string>();
    for (const person of people) {
        for (const key of tokenSortKeys(person.name)) {
            lookup.set(key, person.id);
        }
    }

    const matchedIds: string[] = [];
    const unmatched: string[] = [];

    for (const rawName of rawNames) {
        const keys = tokenSortKeys(rawName);
        const personId = keys.map(k => lookup.get(k)).find(Boolean) ?? uniqueAbbreviatedMatch(rawName, people);
        if (personId) {
            matchedIds.push(personId);
        } else {
            unmatched.push(rawName);
        }
    }

    return { matchedIds, unmatched };
}

/**
 * «Αθανασάκης Σ.» or «Ευαγγελία Λίλιαν Γαζή» against a roster that spells
 * names fully or without the middle name. Only a unique candidate counts:
 * two Παπαδόπουλοι and an initial is a question for the model, not a match.
 */
function uniqueAbbreviatedMatch(rawName: string, people: PersonForMatching[]): string | null {
    const candidates = people.filter(p => sameGreekPerson(rawName, p.name) || sameGreekPerson(p.name, rawName));
    return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Step 1: Token-sort match for a single name.
 */
export function matchPersonByName(
    rawName: string,
    people: PersonForMatching[],
): string | null {
    const rawKeys = tokenSortKeys(rawName);
    for (const person of people) {
        const personKeys = tokenSortKeys(person.name);
        for (const rk of rawKeys) {
            for (const pk of personKeys) {
                if (rk === pk) return person.id;
            }
        }
    }
    return uniqueAbbreviatedMatch(rawName, people);
}

// Structured-outputs schema for llmMatchMembers — replaces the '[' assistant
// prefill, which Claude 4.6+ models reject
const MEMBER_MATCH_SCHEMA = {
    type: 'object' as const,
    properties: {
        matches: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    personId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                },
                required: ['name', 'personId'],
                additionalProperties: false,
            },
        },
    },
    required: ['matches'],
    additionalProperties: false,
};

/**
 * Step 2: LLM fallback for names that couldn't be matched by token-sort.
 * Sends unmatched names + available people to haiku for semantic matching.
 */
export async function llmMatchMembers(
    unmatchedNames: string[],
    availablePeople: PersonForMatching[],
): Promise<{ matched: { name: string; personId: string }[]; stillUnmatched: string[]; usage: Anthropic.Messages.Usage }> {
    if (unmatchedNames.length === 0 || availablePeople.length === 0) {
        return { matched: [], stillUnmatched: unmatchedNames, usage: { ...NO_USAGE } };
    }

    console.log(`  LLM matching ${unmatchedNames.length} unmatched names against ${availablePeople.length} people`);

    const { result: response, usage } = await aiChat<{ matches: { name: string; personId: string | null }[] }>({
        systemPrompt: `You are a Greek name matcher for municipal council members.

Match each name from "unmatchedNames" to its corresponding person from "availablePeople".
Names may differ in:
- Word order or missing middle names
- Accents/diacritics (monotonic vs polytonic, missing accents)
- Hyphenation or spacing (e.g. "ΚΩΝΣΤΑΝΤΙΝΑ - ΟΛΥΜΠΙΑ" vs "Κωνσταντίνα-Ολυμπία")
- First-initial abbreviations (e.g., "Ε. Χριστούλη" → "ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ", "Κ. Αγγελής" → "ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ"). Match by surname — if the surname is unique among available people, the initial is enough.
- Greek diminutives (υποκοριστικά): official documents use formal/legal names while databases often store the commonly used form. These can be very different from the formal name. Examples: Παρασκευή→Βούλα/Εύη, Ελπινίκη→Νίκη, Κωνσταντίνα→Τάνια/Ντίνα, Κωνσταντίνος→Ντίνος/Κώστας, Ευαγγελία→Εύα/Λίτσα, Δημήτριος→Μήτσος/Τάκης, Γεώργιος→Γιώργος, Αθανάσιος→Θανάσης, Χαράλαμπος→Μπάμπης

**Key strategy**: When the surname matches exactly between an unmatched name and only ONE available person shares that surname, the first name is very likely a diminutive — match them even if the first name looks very different. If multiple available people share the same surname, only match when you can confidently identify the diminutive.

Return one entry in "matches" per unmatched name:
{"matches": [{"name": "<exact name from unmatchedNames>", "personId": "<id from availablePeople or null>"}]}

Rules:
- "name" must be the EXACT string from unmatchedNames
- "personId" must be an id from availablePeople, or null if no match
- When the surname matches exactly, match confidently even if the first name differs significantly (it's almost certainly a diminutive)
- Each personId at most once`,
        userPrompt: JSON.stringify({
            unmatchedNames,
            availablePeople: availablePeople.map(p => ({ id: p.id, name: p.name })),
        }),
        outputFormat: { type: 'json_schema', schema: MEMBER_MATCH_SCHEMA },
        model: HAIKU_MODEL,
        label: 'member-match',
    });

    const result = response.matches;

    const matched: { name: string; personId: string }[] = [];
    const stillUnmatched: string[] = [];
    const usedIds = new Set<string>();
    // The model copies ids as text and has been seen splicing two of them into
    // one that exists nowhere; such a row would fail the foreign key downstream
    // and take the whole subject's attendance with it.
    const knownIds = new Set(availablePeople.map(p => p.id));

    for (const entry of result) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
        if (entry.personId && !knownIds.has(entry.personId)) {
            console.warn(`  LLM matcher returned an id not in the roster for "${entry.name}": ${entry.personId} — treating as unmatched`);
        }
        if (entry.personId && knownIds.has(entry.personId) && !usedIds.has(entry.personId)) {
            matched.push({ name: entry.name, personId: entry.personId });
            usedIds.add(entry.personId);
        } else {
            stillUnmatched.push(entry.name);
        }
    }

    // Names from input that LLM didn't return at all → still unmatched
    const returnedNames = new Set(result.map(r => r.name));
    for (const name of unmatchedNames) {
        if (!returnedNames.has(name)) {
            stillUnmatched.push(name);
        }
    }

    console.log(`  LLM matched ${matched.length}, still unmatched: ${stillUnmatched.length}`);
    return { matched, stillUnmatched, usage };
}

/**
 * Two-step matching: token-sort first, then LLM fallback for remaining.
 */
export async function matchAllMembers(
    rawNames: string[],
    people: PersonForMatching[],
): Promise<MatchResult> {
    // Step 1: token-sort matching
    const step1 = matchMembersToPersonIds(rawNames, people);

    if (step1.unmatched.length === 0) {
        return step1;
    }

    // Step 2: LLM fallback for unmatched
    const alreadyMatchedIds = new Set(step1.matchedIds);
    const availablePeople = people.filter(p => !alreadyMatchedIds.has(p.id));

    const step2 = await llmMatchMembers(step1.unmatched, availablePeople);

    return {
        matchedIds: [...step1.matchedIds, ...step2.matched.map(m => m.personId)],
        unmatched: step2.stillUnmatched,
    };
}

// --- PDF extraction ---

const EXTRACTION_MODEL = 'claude-sonnet-4-6';

/**
 * Max output tokens for extraction — needs headroom for decisions with large
 * tables (budget amendments, etc.). Structured outputs cannot use aiChat's
 * max_tokens continuation (hitting the cap is a hard failure), so this is
 * Sonnet 4.6's full output ceiling; aiChat streams, so large values don't
 * risk HTTP timeouts.
 */
const EXTRACTION_MAX_TOKENS = 64000;

// Structured-outputs schemas mirroring RawLlmExtraction — they replace the
// '{' assistant prefill, which Claude 4.6+ models reject

const AGENDA_ITEM_REF_SCHEMA = {
    type: 'object' as const,
    properties: {
        agendaItemIndex: { type: 'integer' },
        nonAgendaReason: { anyOf: [{ type: 'string', enum: ['outOfAgenda'] }, { type: 'null' }] },
    },
    required: ['agendaItemIndex', 'nonAgendaReason'],
    additionalProperties: false,
};

const EXTRACTION_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        attendanceFormat: { type: 'string', enum: ['composition_and_absent', 'explicit_present_absent'] },
        compositionMembers: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        presentMembers: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        absentMembers: { type: 'array', items: { type: 'string' } },
        mayorPresent: {
            anyOf: [
                {
                    type: 'object',
                    properties: {
                        present: { type: 'boolean' },
                        rawText: { type: 'string' },
                    },
                    required: ['present', 'rawText'],
                    additionalProperties: false,
                },
                { type: 'null' },
            ],
        },
        decisionExcerpt: { type: 'string' },
        decisionNumber: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        references: { type: 'string' },
        voteResult: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        voteDetails: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    vote: { type: 'string', enum: ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'] },
                },
                required: ['name', 'vote'],
                additionalProperties: false,
            },
        },
        attendanceChanges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: ['arrival', 'departure', 'absent_for_vote'] },
                    anchor: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['agenda_item', 'decision_number', 'phase', 'this_document', 'session_start', 'session_end'] },
                            agendaItemIndex: { type: 'integer' },
                            outOfAgenda: { type: 'boolean' },
                            decisionNumber: { type: 'string' },
                            phase: { type: 'string', enum: ['pre_agenda', 'out_of_agenda', 'none'] },
                            timing: { type: 'string', enum: ['before', 'during', 'after', 'none'] },
                        },
                        required: ['kind', 'agendaItemIndex', 'outOfAgenda', 'decisionNumber', 'phase', 'timing'],
                        additionalProperties: false,
                    },
                    rawText: { type: 'string' },
                },
                required: ['name', 'type', 'anchor', 'rawText'],
                additionalProperties: false,
            },
        },
        discussionOrder: { anyOf: [{ type: 'array', items: AGENDA_ITEM_REF_SCHEMA }, { type: 'null' }] },
        subjectInfo: { anyOf: [AGENDA_ITEM_REF_SCHEMA, { type: 'null' }] },
        incomplete: { type: 'boolean' },
        presidedBy: {
            type: 'object',
            properties: { name: { type: 'string' }, rawText: { type: 'string' } },
            required: ['name', 'rawText'],
            additionalProperties: false,
        },
        actingSecretary: {
            type: 'object',
            properties: { name: { type: 'string' }, rawText: { type: 'string' } },
            required: ['name', 'rawText'],
            additionalProperties: false,
        },
        subjectHeading: { type: 'string' },
        decisionAttendance: {
            type: 'object',
            properties: { present: { type: 'array', items: { type: 'string' } }, rawText: { type: 'string' } },
            required: ['present', 'rawText'],
            additionalProperties: false,
        },
        voteTally: {
            type: 'object',
            properties: { FOR: { type: 'integer' }, AGAINST: { type: 'integer' }, ABSTAIN: { type: 'integer' }, PRESENT: { type: 'integer' }, DID_NOT_VOTE: { type: 'integer' } },
            required: ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'],
            additionalProperties: false,
        },
    },
    required: [
        'attendanceFormat', 'compositionMembers', 'presentMembers', 'absentMembers',
        'mayorPresent', 'decisionExcerpt', 'decisionNumber', 'references',
        'voteResult', 'voteDetails', 'attendanceChanges', 'discussionOrder',
        'subjectInfo', 'incomplete', 'presidedBy', 'actingSecretary', 'subjectHeading', 'voteTally', 'decisionAttendance',
    ],
    additionalProperties: false,
};

/** Page count threshold: PDFs with this many pages or fewer are sent whole. */
const SMALL_PDF_THRESHOLD = 10;

/** Initial number of pages to send for large PDFs. */
const INITIAL_PAGES = 5;

/** How many additional pages to add on each retry. */
const PAGE_INCREMENT = 5;

/** Maximum front pages to try before switching to tail extraction. */
const MAX_FRONT_PAGES = 15;

/** Number of pages to try from the end of the document as a last resort. */
const TAIL_PAGES = 5;

/**
 * A pass has reached the decision only when it says so AND carries text. Long
 * Sparta documents embed earlier decisions in the preamble, and the model
 * reports "complete" on those pages with an empty excerpt.
 */
function reachedTheDecision(result: RawExtractedDecision): boolean {
    return !result.incomplete && (result.decisionExcerpt?.trim().length ?? 0) > 0;
}

/**
 * A later window of a long document may hold the named vote lists the decision
 * window did not (Vrilissia 8/12: ΑΠΟΦΑΣΙΖΕΙ on page 27, the nineteen ΥΠΕΡ and
 * eight «παρών» names on page 37). They are adopted only when they are the same
 * vote: the decision window names nobody in favour and printed a count of at
 * least one that the candidate's named ΥΠΕΡ list matches exactly. An embedded
 * decision of another body (its own count, its own names) never matches and is
 * left where it is.
 *
 * The names are added to the decision window's own rows, not substituted for
 * them. The window that names nobody in favour can still name a dissenter, and
 * replacing the list would drop that person unless the later window happened to
 * reprint them — turning a stated AGAINST into an inferred FOR.
 */
export function adoptLaterVoteNames(winner: RawExtractedDecision, later: RawExtractedDecision[]): RawExtractedDecision {
    const printedFor = winner.voteTally?.FOR ?? null;
    const winnerNamesFor = winner.voteDetails.some(v => v.vote === 'FOR');
    // A printed zero would be matched by the first later window that names
    // nobody in favour, whatever else that window holds.
    if (printedFor == null || printedFor < 1 || winnerNamesFor) return winner;
    const ownNames = winner.voteDetails.map(v => v.name);
    for (const w of later) {
        const namedFor = w.voteDetails.filter(v => v.vote === 'FOR').length;
        const sameCount = w.voteTally?.FOR == null || w.voteTally.FOR === printedFor;
        if (namedFor !== printedFor || !sameCount) continue;
        const adopted = w.voteDetails.filter(v => !greekNameInList(v.name, ownNames));
        return { ...winner, voteDetails: [...winner.voteDetails, ...adopted] };
    }
    return winner;
}

/** Did this pass read any count out of the vote phrase? */
function hasCountedTally(tally: RawExtractedDecision['voteTally'] | undefined): boolean {
    return !!tally && Object.values(tally).some(v => v !== null);
}

/**
 * Bumped whenever the prompt or the output schema changes what a reading means,
 * so a reading in the old shape is never served to code expecting the new one.
 * v4 retired the `clock_time` and `session_phase` anchor kinds and the free-text
 * `phase` that came with them. v5 read the item heading and the acting
 * secretary, and nulled the item number when the heading came back empty; v6
 * keeps the number — the cache holds the normalised result, so the readings
 * v5 nulled had to be retired with it. v7 keys the cache on the mayor name as
 * well; a v6 entry cannot be told apart, because a caller that named the mayor
 * and a caller that did not wrote to the same key.
 */
export const EXTRACTION_SCHEMA_VERSION = 7;

/** Everything besides the document that steers a reading, and so has to key its cache entry. */
export interface ExtractionSteering {
    /** Steers mayorPresent and presidedBy: the prompt appends "The city mayor is: …". */
    mayorName?: string;
    /** The body's conventions, appended to the prompt verbatim. */
    hints?: string;
}

/**
 * The cache key. Two callers read the same document with different steering —
 * `pollDecisions` names the mayor, the scorer does not — so the steering is part
 * of the key. Without it, whichever ran first owned the entry both read.
 */
export function extractionCacheKey(pdfUrl: string, steering?: ExtractionSteering): string {
    const versioned = `${pdfUrl}#v${EXTRACTION_SCHEMA_VERSION}`;
    const parts = [steering?.mayorName, steering?.hints].filter(Boolean);
    if (parts.length === 0) return versioned;
    return `${versioned}#${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 8)}`;
}

/** A phase as the retired `session_phase` anchor stated it: the block as the page printed it. */
function phaseFromFreeText(raw: unknown): AttendancePhase | null {
    if (raw === 'pre_agenda' || raw === 'out_of_agenda') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // «εκτός ημερησίας διατάξεως» / «Ε.Η.Δ.» name the out-of-agenda block; every
    // other phrase the old prompt produced («προ ημερησίας», «μετά την ψήφιση
    // του κατεπείγοντος») sits before the agenda proper.
    const normalized = normalizeGreekName(raw);
    return normalized.includes('εκτος ημερησ') || /(^|[^α-ω])ε\.?η\.?δ([^α-ω]|$)/.test(normalized) ? 'out_of_agenda' : 'pre_agenda';
}

/** The anchor as v4 declares it, from an anchor a pre-v4 reading stated. */
function migrateAnchor(anchor: AttendanceAnchor): AttendanceAnchor {
    const kind: string = anchor.kind;
    if (kind === 'session_phase') return { ...anchor, kind: 'phase', phase: phaseFromFreeText(anchor.phase) };
    if (kind === 'clock_time') return { ...anchor, kind: 'session_start', phase: null };
    // A free-text phase can ride any kind; only the two enum values are on the wire.
    if (anchor.phase !== null && anchor.phase !== 'pre_agenda' && anchor.phase !== 'out_of_agenda') return { ...anchor, phase: null };
    return anchor;
}

/**
 * The belt to the cache key's braces: entries written on this branch before a
 * field existed are read as absent, and any anchor vocabulary predating v4 is
 * migrated rather than passed onto the wire.
 */
export function withDefaults(raw: RawExtractedDecision): RawExtractedDecision {
    const r = raw as Partial<RawExtractedDecision>;
    return {
        ...raw,
        attendanceFormat: r.attendanceFormat ?? 'explicit_present_absent',
        compositionMembers: r.compositionMembers ?? null,
        presidedBy: r.presidedBy?.name ? r.presidedBy : null,
        actingSecretary: r.actingSecretary?.name ? r.actingSecretary : null,
        // A reading cached before the heading was read keeps its subjectInfo: "" here means "not read", not "no heading".
        subjectHeading: r.subjectHeading ?? '',
        voteTally: r.voteTally ?? { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null },
        decisionAttendance: r.decisionAttendance?.present?.length ? r.decisionAttendance : null,
        attendanceChanges: (r.attendanceChanges ?? []).map(c => c.anchor ? { ...c, anchor: migrateAnchor(c.anchor) } : c),
    };
}

export async function extractDecisionFromPdf(pdfUrl: string, mayorName?: string, skipCache?: boolean, hints?: string): Promise<ResultWithUsage<RawExtractedDecision> & { fromCache: boolean }> {
    const cacheKey = extractionCacheKey(pdfUrl, { mayorName, hints });
    if (!skipCache) {
        const cached = readCache<RawExtractedDecision>(cacheKey);
        if (cached) return { result: withDefaults(cached), usage: { ...NO_USAGE }, fromCache: true };
    }

    const pdfBuffer = await downloadPdfAsBuffer(pdfUrl);
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();

    const userPromptParts = ['Extract the required information from this Greek municipal council decision PDF.'];
    if (mayorName) {
        userPromptParts.push(`The city mayor is: ${mayorName}`);
    }
    if (hints) {
        userPromptParts.push(hints);
    }
    const userPrompt = userPromptParts.join('\n');

    // Small PDFs: send the whole thing in one call
    if (totalPages <= SMALL_PDF_THRESHOLD) {
        console.log(`  PDF has ${totalPages} pages (≤${SMALL_PDF_THRESHOLD}), sending whole document`);
        const base64 = pdfBuffer.toString('base64');
        const { result: raw, usage } = await aiChat<RawLlmExtraction>({
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt,
            documentBase64: base64,
            outputFormat: { type: 'json_schema', schema: EXTRACTION_OUTPUT_SCHEMA },
            model: EXTRACTION_MODEL,
            maxTokens: EXTRACTION_MAX_TOKENS,
            label: 'decision-extraction',
        });

        const result = normalizeExtraction(raw);
        writeCache(cacheKey, result);
        return { result, usage, fromCache: false };
    }

    // Large PDFs: progressive page loading
    console.log(`  PDF has ${totalPages} pages (>${SMALL_PDF_THRESHOLD}), using progressive extraction`);
    let pagesToSend = INITIAL_PAGES;
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };
    let lastFrontResult: RawExtractedDecision | null = null;

    while (pagesToSend <= MAX_FRONT_PAGES) {
        const actualPages = Math.min(pagesToSend, totalPages);
        console.log(`  Trying with first ${actualPages}/${totalPages} pages...`);

        const partialBase64 = await extractPdfPages(pdfBuffer, 0, actualPages);

        const partialPrompt = actualPages < totalPages
            ? `${userPrompt}\n\nNote: You are seeing pages 1-${actualPages} of a ${totalPages}-page document. If the decision section ("ΑΠΟΦΑΣΙΖΕΙ") is not visible in these pages because the document is cut off, set "incomplete" to true. If you can see "ΑΠΟΦΑΣΙΖΕΙ" but some details are missing or unclear, set "incomplete" to false.`
            : userPrompt;

        const { result: raw, usage } = await aiChat<RawLlmExtraction>({
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt: partialPrompt,
            documentBase64: partialBase64,
            outputFormat: { type: 'json_schema', schema: EXTRACTION_OUTPUT_SCHEMA },
            model: EXTRACTION_MODEL,
            maxTokens: EXTRACTION_MAX_TOKENS,
            label: 'decision-extraction:partial',
        });

        totalUsage = addUsage(totalUsage, usage);
        const result = normalizeExtraction(raw);
        lastFrontResult = result;

        if (reachedTheDecision(result)) {
            console.log(`  Extraction complete with ${actualPages} pages`);
            writeCache(cacheKey, result);
            return { result, usage: totalUsage, fromCache: false };
        }
        if (actualPages >= totalPages) {
            console.log(`  Extraction still incomplete after all ${totalPages} pages`);
            const exhausted = { ...result, incomplete: true };
            writeCache(cacheKey, exhausted);
            return { result: exhausted, usage: totalUsage, fromCache: false };
        }

        console.log(`  Incomplete extraction — decision content not found in first ${actualPages} pages, retrying with more...`);
        pagesToSend += PAGE_INCREMENT;
    }

    // Front pages exhausted — walk the unseen pages in windows from the end,
    // because the decision sits at the end and the pages between the front
    // slice and the tail are exactly where 16-19-page documents keep it.
    let windowEnd = totalPages;
    const laterWindows: RawExtractedDecision[] = [];
    while (windowEnd > MAX_FRONT_PAGES) {
        const windowStart = Math.max(MAX_FRONT_PAGES, windowEnd - TAIL_PAGES);
        console.log(`  Front pages exhausted, trying pages ${windowStart + 1}-${windowEnd} of ${totalPages}...`);

        const tailBase64 = await extractPdfPages(pdfBuffer, windowStart, windowEnd);
        const tailPrompt = `${userPrompt}\n\nNote: You are seeing pages ${windowStart + 1}-${windowEnd} of a ${totalPages}-page document. The earlier pages contained attendance lists and preamble but not the decision section. Extract the decision information from these pages. If the decision section ("ΑΠΟΦΑΣΙΖΕΙ") is not visible in these pages either, set "incomplete" to true.`;

        const { result: tailRaw, usage } = await aiChat<RawLlmExtraction>({
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt: tailPrompt,
            documentBase64: tailBase64,
            outputFormat: { type: 'json_schema', schema: EXTRACTION_OUTPUT_SCHEMA },
            model: EXTRACTION_MODEL,
            maxTokens: EXTRACTION_MAX_TOKENS,
            label: 'decision-extraction:tail',
        });

        totalUsage = addUsage(totalUsage, usage);
        const tailResult = normalizeExtraction(tailRaw);

        if (reachedTheDecision(tailResult)) {
            // Merge: attendance + preamble from front pages, decision data from tail pages.
            // The tail window carries neither the roll call nor the presiding
            // sentence, so every preamble fact falls back to the front read;
            // the decision facts fall back the other way.
            const tailSawRollCall = !!(tailResult.presentMembers?.length || tailResult.absentMembers?.length || tailResult.compositionMembers?.length);
            const merged: RawExtractedDecision = {
                ...tailResult,
                presentMembers: tailResult.presentMembers?.length ? tailResult.presentMembers : lastFrontResult!.presentMembers,
                absentMembers: tailResult.absentMembers?.length ? tailResult.absentMembers : lastFrontResult!.absentMembers,
                attendanceChanges: tailResult.attendanceChanges?.length ? tailResult.attendanceChanges : lastFrontResult!.attendanceChanges,
                mayorPresent: tailResult.mayorPresent ?? lastFrontResult!.mayorPresent,
                discussionOrder: tailResult.discussionOrder ?? lastFrontResult!.discussionOrder,
                subjectInfo: tailResult.subjectInfo ?? lastFrontResult!.subjectInfo,
                attendanceFormat: tailSawRollCall ? tailResult.attendanceFormat : lastFrontResult!.attendanceFormat,
                compositionMembers: tailSawRollCall ? tailResult.compositionMembers : lastFrontResult!.compositionMembers,
                presidedBy: tailResult.presidedBy ?? lastFrontResult!.presidedBy,
                actingSecretary: tailResult.actingSecretary ?? lastFrontResult!.actingSecretary,
                subjectHeading: tailResult.subjectHeading || lastFrontResult!.subjectHeading,
                voteTally: hasCountedTally(tailResult.voteTally) ? tailResult.voteTally : lastFrontResult!.voteTally,
                decisionAttendance: tailResult.decisionAttendance ?? lastFrontResult!.decisionAttendance,
            };
            const withNames = adoptLaterVoteNames(merged, laterWindows);
            if (withNames !== merged) console.log(`  Named votes adopted from a later window (${withNames.voteDetails.length - merged.voteDetails.length} names added to ${merged.voteDetails.length} already read)`);
            console.log(`  Extraction complete from pages ${windowStart + 1}-${windowEnd} (merged with front-page attendance)`);
            writeCache(cacheKey, withNames);
            return { result: withNames, usage: totalUsage, fromCache: false };
        }
        // Windows after the decision are kept: they may hold the vote's named lists.
        laterWindows.push(tailResult);
        console.log(`  Decision content not found in pages ${windowStart + 1}-${windowEnd}`);
        windowEnd = windowStart;
    }

    // Fully exhausted — return best partial result we got (with incomplete flag)
    console.log(`  Progressive extraction exhausted (all ${totalPages} pages seen), returning partial data`);
    const bestResult: RawExtractedDecision = { ...lastFrontResult!, incomplete: true };
    writeCache(cacheKey, bestResult);
    return { result: bestResult, usage: totalUsage, fromCache: false };
}
