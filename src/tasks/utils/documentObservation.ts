/**
 * What one decision document states about its own session, read the way
 * production reads it.
 *
 * This is deliberately not extraction. Extraction pulls out the values — who
 * was present, how they voted. An observation records the *shape*: whether the
 * document states a thing at all, and in what form. Aggregated per
 * administrative body it answers the question that has to be settled before
 * anything can be stored or scored: what do this body's documents actually
 * contain?
 *
 * It reads the rendered page through the model, not a text layer. An earlier
 * version of this profiling used `pdftotext` and silently discarded 129 of
 * 1,099 sampled documents whose embedded font has no Unicode mapping —
 * including every Sparta document, a body with 527 linked decisions that
 * production extracts without difficulty. Measuring a different population
 * than production sees is not a measurement.
 */

/**
 * Bump whenever a field's meaning changes, so cached readings in the old shape
 * are never served as if current.
 *
 * v3: added `this_document` pinning, for Argos council's ΑΠΟΧΩΡΗΣΑΝΤΕΣ column —
 * recorded as "nothing" before, which read as unplaceable when it is in fact
 * the most precisely placed form we have. Widened `perVoteAbsenceStated` to
 * cover Athens council's «Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ», a temporary
 * absence over a range of decisions rather than a departure.
 *
 * v2: `lateArrivalCheck.appearsInPresentOrRosterList` split into
 * `appearsInPresentList` and `appearsInCompositionRoster`. Merging them made
 * two opposite cases indistinguishable: Athens committee prints an invitation
 * roster that contains late arrivals, Chalandri and Chania print attendance
 * lists that do not. The merged flag read all three as cumulative.
 */
export const OBSERVATION_SCHEMA_VERSION = 3;

/** Pages from the front: the roll call, the session framing, arrivals and departures. */
export const OBSERVATION_HEAD_PAGES = 3;
/** Pages from the back: the vote, the decision number, the signatures. */
export const OBSERVATION_TAIL_PAGES = 2;

export interface DocumentObservation {
    /** False for an agenda, an invitation, a mayoral act — anything not a deliberative decision. */
    isDeliberativeDecision: boolean;

    rollCallForm: 'composition_and_absent' | 'present_and_absent' | 'present_only' | 'narrative_only' | 'absent';
    /** The literal headings of the attendance lists, verbatim, e.g. ["ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ", "ΑΠΟΝΤΕΣ"]. */
    rollCallHeadings: string[];
    /** The body's size as the document states it («σε σύνολο 27 μελών»). Null when unstated. */
    statedBodySize: number | null;
    presentCount: number | null;
    absentCount: number | null;

    attendanceChangesStated: boolean;
    attendanceChangePinnedTo: 'agenda_item' | 'decision_number' | 'clock_time' | 'session_phase' | 'this_document' | 'nothing' | null;
    /**
     * Evidence for the question that decides what a present list means, rather
     * than the model's verdict on it. Asking a model to judge "is this person in
     * the present set" while it answers 25 other fields agreed with a second
     * model only 83% of the time; asking it to name the person and say which
     * lists contain them is ordinary extraction, and the verdict is then
     * computed by `lateArrivalIsInOpeningPresentSet`.
     * Null when the document records no late arrival to check.
     */
    lateArrivalCheck: {
        name: string;
        /** In the list the document itself calls present or participating. */
        appearsInPresentList: boolean;
        /** In a whole-body roster of members invited, regular and substitute alike. */
        appearsInCompositionRoster: boolean;
        appearsInAbsentList: boolean;
    } | null;

    /** Members named as out of the room for one particular vote, distinct from a departure. */
    perVoteAbsenceStated: boolean;

    votePhraseStated: boolean;
    /** The vote phrase verbatim, e.g. «Κατά πλειοψηφία με ψήφους 21 υπέρ και 2 κατά». */
    votePhrase: string | null;
    votePhraseCarriesCounts: boolean;
    namedVoters: 'none' | 'dissenters_only' | 'all';
    /** ΠΑΡΩΝ or ΑΠΟΧΗ recorded as a declaration rather than a vote. */
    declarationsRecorded: boolean;
    /** A vote differing per budget line, or a decides clause carried by different majorities. */
    partialOrPerLineVote: boolean;

    substitutesPresent: boolean;
    /** When a substitute stands in, is the replaced member also listed? Null when no substitute. */
    replacedMemberAlsoListed: boolean | null;

    /** Kinds of attendee present without a vote, as the document names them. */
    nonVotingAttendees: string[];
    /** Whether the mayor's presence or absence is stated in prose. */
    mayorPresenceStated: boolean;

    agendaItemNumber: number | null;
    isOutOfAgenda: boolean;
    /** The decision's own number exactly as printed, e.g. "120/2026", "1487", "35/06-05-2026". */
    decisionNumberAsPrinted: string | null;

    participationModePerMember: boolean;
    discussionOrderStated: boolean;
    withdrawnItemsStated: boolean;
    correctedRepost: boolean;
    embeddedOtherBodyDecision: boolean;
    /** An advisory act (ΓΝΩΜΟΔΟΤΕΙ) rather than a decision (ΑΠΟΦΑΣΙΖΕΙ). */
    isAdvisoryOpinion: boolean;

    /** Anything stated that no field above holds. This is where schema requirements come from. */
    unusual: string[];
}

export const OBSERVATION_SCHEMA = {
    type: 'object' as const,
    properties: {
        isDeliberativeDecision: { type: 'boolean' },
        rollCallForm: { type: 'string', enum: ['composition_and_absent', 'present_and_absent', 'present_only', 'narrative_only', 'absent'] },
        rollCallHeadings: { type: 'array', items: { type: 'string' } },
        statedBodySize: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        presentCount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        absentCount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        attendanceChangesStated: { type: 'boolean' },
        attendanceChangePinnedTo: { anyOf: [{ type: 'string', enum: ['agenda_item', 'decision_number', 'clock_time', 'session_phase', 'this_document', 'nothing'] }, { type: 'null' }] },
        lateArrivalCheck: {
            anyOf: [
                {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        appearsInPresentList: { type: 'boolean' },
                        appearsInCompositionRoster: { type: 'boolean' },
                        appearsInAbsentList: { type: 'boolean' },
                    },
                    required: ['name', 'appearsInPresentList', 'appearsInCompositionRoster', 'appearsInAbsentList'],
                    additionalProperties: false,
                },
                { type: 'null' },
            ],
        },
        perVoteAbsenceStated: { type: 'boolean' },
        votePhraseStated: { type: 'boolean' },
        votePhrase: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        votePhraseCarriesCounts: { type: 'boolean' },
        namedVoters: { type: 'string', enum: ['none', 'dissenters_only', 'all'] },
        declarationsRecorded: { type: 'boolean' },
        partialOrPerLineVote: { type: 'boolean' },
        substitutesPresent: { type: 'boolean' },
        replacedMemberAlsoListed: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        nonVotingAttendees: { type: 'array', items: { type: 'string' } },
        mayorPresenceStated: { type: 'boolean' },
        agendaItemNumber: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        isOutOfAgenda: { type: 'boolean' },
        decisionNumberAsPrinted: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        participationModePerMember: { type: 'boolean' },
        discussionOrderStated: { type: 'boolean' },
        withdrawnItemsStated: { type: 'boolean' },
        correctedRepost: { type: 'boolean' },
        embeddedOtherBodyDecision: { type: 'boolean' },
        isAdvisoryOpinion: { type: 'boolean' },
        unusual: { type: 'array', items: { type: 'string' } },
    },
    required: [
        'isDeliberativeDecision', 'rollCallForm', 'statedBodySize', 'presentCount', 'absentCount',
        'rollCallHeadings', 'attendanceChangesStated', 'attendanceChangePinnedTo', 'lateArrivalCheck',
        'perVoteAbsenceStated', 'votePhraseStated', 'votePhrase', 'votePhraseCarriesCounts',
        'namedVoters', 'declarationsRecorded', 'partialOrPerLineVote', 'substitutesPresent',
        'replacedMemberAlsoListed', 'nonVotingAttendees', 'mayorPresenceStated', 'agendaItemNumber',
        'isOutOfAgenda', 'decisionNumberAsPrinted', 'participationModePerMember',
        'discussionOrderStated', 'withdrawnItemsStated', 'correctedRepost',
        'embeddedOtherBodyDecision', 'isAdvisoryOpinion', 'unusual',
    ],
    additionalProperties: false,
};

export const OBSERVATION_SYSTEM_PROMPT = `You are surveying Greek municipal decision documents (ΑΠΟΣΠΑΣΜΑ ΠΡΑΚΤΙΚΟΥ / ΑΠΟΦΑΣΗ / ΠΡΑΞΗ) to record WHAT EACH ONE STATES, not what its contents are.

You are given the opening pages and the closing pages of one document. Do not extract names, votes or decision text. Record only whether the document states each thing, and in what form. Where the document does not settle a question, use null rather than inferring.

The document may be a scanned image or use a font that renders oddly. Read the page as displayed.

Field guidance:

- **rollCallForm** — decide in this order. If the document has a list headed ΠΑΡΟΝΤΕΣ (or ΠΑΡΟΝΤΑ ΜΕΛΗ), it is "present_and_absent" when an ΑΠΟΝΤΕΣ list also exists, otherwise "present_only". If instead it has a whole-body roster (ΣΥΝΘΕΣΗ, ΜΕΛΗ, ΤΑΚΤΙΚΑ/ΑΝΑΠΛΗΡΩΜΑΤΙΚΑ) plus absentees named separately, it is "composition_and_absent". If attendance appears only in prose, "narrative_only". If there is none, "absent".

**THE OPENING PRESENT SET.** Several fields below turn on who the document treats as present when the session opened. That set is NOT always a printed list:
  - present_and_absent / present_only: the ΠΑΡΟΝΤΕΣ list as printed.
  - composition_and_absent: the roster MINUS the absentees. A person named in the roster and also named as absent is NOT in the opening present set. The roster alone is the membership, not the attendance.
- **statedBodySize** — only when the document states a total in words or numerals, as in «σε σύνολο 27 μελών», «επί του συνόλου των είκοσι εννιά (29) μελών», «(Σύνολο 35 μέλη)». Never a number you arrive at by counting names; if the document does not say it, return null.
- **presentCount / absentCount** — count the names in each list. For a composition-plus-absent layout, presentCount is the composition minus the absent.
- **rollCallHeadings** — the literal headings of the attendance lists, copied exactly as printed, in the order they appear: for example ["ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ"], or ["ΠΑΡΟΝΤΕΣ ΣΥΜΒΟΥΛΟΙ", "ΑΠΟΝΤΕΣ ΣΥΜΒΟΥΛΟΙ"], or ["ΜΕΛΗ ΔΗΜΟΤΙΚΗΣ ΕΠΙΤΡΟΠΗΣ", "ΤΑΚΤΙΚΑ", "ΑΝΑΠΛΗΡΩΜΑΤΙΚΑ"]. Do not translate, normalise or summarise them. Empty array when attendance is prose only.
- **lateArrivalCheck** — evidence, not a verdict. Pick ONE person the document names as having arrived after the session opened, then look that exact name up in each list separately. These three are independent; report each on its own.
  - "name": the person as the document writes them.
  - "appearsInPresentList": true only if that exact name is inside the list the document calls present or participating (ΠΑΡΟΝΤΕΣ, ΣΥΜΜΕΤΕΧΟΝΤΕΣ, Συμμετέχοντες-Παρόντες). **Beware**: such a list often contains a DIFFERENT substitute carrying a «σε αντικατάσταση» annotation. That is not the person you are checking. Find the arriving person's own name, character by character, or answer false.
  - "appearsInCompositionRoster": true if the name is in a whole-body roster of everyone invited — regular and substitute members alike (ΣΥΝΘΕΣΗ, ΜΕΛΗ, «με την εξής σύνθεση»). Such a roster says who was summoned, not who attended, so a late arriver is routinely in it.
  - "appearsInAbsentList": true if the name is in the ΑΠΟΝΤΕΣ / ΜΗ ΣΥΜΜΕΤΕΧΟΝΤΕΣ / απουσίαζαν list, including with an annotation such as «(Προσήλθε στο 1ο Θέμα)».
  Return null only when the document names no late arrival at all. Do not reason about what the lists mean; just report where the name is found. A name can legitimately be in more than one.
- **attendanceChangesStated** — true only when at least one real arrival or departure is recorded. A heading with nothing under it, «Προσελεύσεις: Ουδείς» or «Αποχωρήσεις: Καμία», is false: the section exists, the change does not.
- **attendanceChangePinnedTo** — null when no change is stated at all; "nothing" when a change IS stated in prose but carries no reference of any kind. Otherwise, what an arrival or departure is tied to. «κατά τη συζήτηση του 4ου θέματος» is agenda_item. «στη με αρ. 399 ΑΔΣ» and «Πριν την 1/2025 απόφαση» are decision_number. «στις 20:15» is clock_time. «κατά τη συζήτηση των εκτός ημερήσιας διάταξης θεμάτων» is session_phase.
  **this_document**: the roll call itself carries a further list beside ΠΑΡΟΝΤΕΣ and ΑΠΟΝΤΕΣ, headed ΑΠΟΧΩΡΗΣΑΝΤΕΣ, naming those who had already left by the time of the decision this very document records. No sentence anchors it because the document is the anchor, and the list appears only in the documents of decisions the person missed. Do not call this "nothing": it is the most precisely placed form there is.
  **nothing**: a change stated in prose with no reference at all, «αποχώρησε ο κ. Χ». Null when no change is stated.
- **perVoteAbsenceStated** — true when the document names someone as temporarily out of the room rather than departed, in either of two forms: «Κατά τη διάρκεια της ψήφισης απουσίαζαν από την αίθουσα οι …», scoped to this vote; or «Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ ο κ. …», scoped to a named range of decisions. Both differ from a departure, after which the person is gone for everything that follows. A departure recorded earlier does not count.
- **namedVoters** — "none": no voter is named, typical of a unanimous decision. "dissenters_only": only those against, blank or declaring are named. "all": every voter is named with their vote.
- **declarationsRecorded** — ΠΑΡΩΝ or ΑΠΟΧΗ recorded as a position in the vote. Note that «παρών» also simply means present; it counts here only in voting context.
- **replacedMemberAlsoListed** — when an αναπληρωματικό μέλος stands in, is the member they replace ALSO named, usually as absent? Null when no substitute appears.
- **nonVotingAttendees** — the kinds of attendee present without a vote, in Greek as the document names them: «Πρόεδροι Δημοτικών Κοινοτήτων», «εκπρόσωποι παράταξης χωρίς δικαίωμα ψήφου», «Γενική Γραμματέας», «πρακτικογράφος». Empty array when none.
- **agendaItemNumber** — the item number this decision belongs to, only when the document states it. Never the decision number. Null when unstated.
- **decisionNumberAsPrinted** — verbatim, including any date part: "120/2026", "1487", "35/06-05-2026", "206". Never the protocol number.
- **participationModePerMember** — true when each attendee is marked in person or remote («δια ζώσης», «τηλεδιάσκεψη»), not merely when the session is described as mixed.
- **embeddedOtherBodyDecision** — true when another body's decision is reproduced inside, with its own attendance list.
- **isAdvisoryOpinion** — true when the operative verb is ΓΝΩΜΟΔΟΤΕΙ or similar rather than ΑΠΟΦΑΣΙΖΕΙ.
- **unusual** — anything the document states that no field above captures. Be concrete and specific. This list becomes a requirements list, so vagueness wastes it.`;

/**
 * Whether a body's opening present set already contains its late arrivals,
 * derived from where the document lists the person rather than from a model's
 * judgement.
 *
 * The rule differs by layout, which is the whole reason the question is hard.
 * With explicit ΠΑΡΟΝΤΕΣ / ΑΠΟΝΤΕΣ lists, being in the present list settles it.
 * With a whole-body roster plus absentees, the roster is the membership and not
 * the attendance, so a late arriver named in the roster AND among the absentees
 * is *not* in the opening present set.
 *
 * Returns null when the document gives nothing to decide on.
 */
export function lateArrivalIsInOpeningPresentSet(
    observation: Pick<DocumentObservation, 'rollCallForm' | 'lateArrivalCheck'>,
): boolean | null {
    const check = observation.lateArrivalCheck;
    if (!check) return null;

    // A printed present list settles it outright: either the arriving person is
    // in it or they are not. This takes precedence over the roster, because a
    // roster is an invitation and says nothing about attendance.
    if (observation.rollCallForm === 'present_and_absent' || observation.rollCallForm === 'present_only') {
        // Nobody is in both the present and the absent list. A reading that
        // says so has not looked the name up, so it yields no verdict rather
        // than a coin flip — Chania's committee produced seven of these.
        if (check.appearsInPresentList && check.appearsInAbsentList) return null;
        return check.appearsInPresentList;
    }
    if (observation.rollCallForm === 'composition_and_absent') {
        // No present list exists, so the present set is the roster minus the
        // absentees. A late arriver in the roster and not named absent is
        // therefore inside that computed set — which is exactly the hazard.
        if (!check.appearsInCompositionRoster) return false;
        return !check.appearsInAbsentList;
    }
    // Prose-only or absent attendance leaves nothing to check against.
    return null;
}
