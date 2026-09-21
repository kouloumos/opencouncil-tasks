import { DocumentObservation, lateArrivalIsInOpeningPresentSet } from './documentObservation.js';

/**
 * Aggregate what one administrative body's documents state, and flag what a
 * person still has to decide.
 *
 * The aggregate is only useful if it also says where it is shaky. Two signals
 * do that without a second model run:
 *
 * - **Dissent.** A body's publishing convention should be constant across its
 *   documents. When a field that ought to be constant is not, either the body
 *   really does vary or the reading is unreliable — and both need a person.
 * - **Silence.** A property nothing in the sample exercises is unknown, not
 *   absent. Reporting "0%" for it would be a claim the evidence cannot support.
 */

/** Fields whose value should be a property of the body, not of the document. */
export const CONSTANT_FIELDS = [
    'rollCallForm',
    'attendanceChangePinnedTo',
    'namedVoters',
] as const;

/** Fields that are simply present or absent per document. */
export const PRESENCE_FIELDS = [
    'attendanceChangesStated',
    'perVoteAbsenceStated',
    'votePhraseStated',
    'votePhraseCarriesCounts',
    'declarationsRecorded',
    'partialOrPerLineVote',
    'substitutesPresent',
    'mayorPresenceStated',
    'participationModePerMember',
    'discussionOrderStated',
    'withdrawnItemsStated',
    'correctedRepost',
    'embeddedOtherBodyDecision',
    'isAdvisoryOpinion',
    'isOutOfAgenda',
] as const;

export interface FactTally {
    /** Documents evidencing the fact. */
    yes: number;
    /** Documents where the fact could be evidenced and was not. */
    no: number;
    percent: number;
}

export interface CategoryTally {
    /** Value → documents reporting it, most common first. */
    values: Array<{ value: string; count: number }>;
    dominant: string | null;
    /** Share of documents NOT holding the dominant value. 0 means the body is consistent. */
    dissent: number;
}

export type ReviewReason =
    | 'inconsistent-roll-call-form'
    | 'inconsistent-change-pinning'
    | 'roll-call-meaning-unresolved'
    | 'roll-call-meaning-contested'
    | 'no-usable-sample'
    | 'holds-facts-we-cannot-store';

export interface BodyFactProfile {
    documents: number;
    /** Documents the reader judged not to be deliberative decisions at all. */
    notDecisions: number;
    categories: Record<string, CategoryTally>;
    presence: Record<string, FactTally>;
    /**
     * Whether the opening present set already contains late arrivals, derived
     * per document and then agreed across the body. Null when the sample cannot
     * settle it: no document records a late arrival to test, or the documents
     * that do are evenly split.
     */
    rollCallIsCumulative: boolean | null;
    /** Documents that could settle the cumulative question, and how they split. */
    cumulativeEvidence: { cumulative: number; openingOnly: number };
    /** The attendance list headings this body prints, verbatim, most common first. */
    headings: Array<{ heading: string; count: number }>;
    /** Kinds of non-voting attendee named, most common first. */
    nonVotingAttendees: Array<{ kind: string; count: number }>;
    /** Everything the reader found that no field holds, deduplicated. */
    unrepresentable: string[];
    reviewReasons: ReviewReason[];
}

function tallyCategory(values: Array<string | null>): CategoryTally {
    const counts = new Map<string, number>();
    for (const v of values) {
        if (v === null) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sorted = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const total = sorted.reduce((n, e) => n + e.count, 0);
    const dominant = sorted[0]?.value ?? null;
    return {
        values: sorted,
        dominant,
        dissent: total === 0 ? 0 : (total - (sorted[0]?.count ?? 0)) / total,
    };
}

/** Above this share of documents disagreeing, a "convention" is not one. */
export const DISSENT_REVIEW_THRESHOLD = 0.25;

export function buildBodyFactProfile(observations: DocumentObservation[]): BodyFactProfile {
    const decisions = observations.filter(o => o.isDeliberativeDecision);
    const notDecisions = observations.length - decisions.length;

    const categories: Record<string, CategoryTally> = {};
    for (const field of CONSTANT_FIELDS) {
        categories[field] = tallyCategory(decisions.map(o => (o[field] as string | null) ?? null));
    }

    const presence: Record<string, FactTally> = {};
    for (const field of PRESENCE_FIELDS) {
        const yes = decisions.filter(o => o[field] === true).length;
        presence[field] = {
            yes,
            no: decisions.length - yes,
            percent: decisions.length === 0 ? 0 : (yes / decisions.length) * 100,
        };
    }

    const verdicts = decisions
        .map(o => lateArrivalIsInOpeningPresentSet(o))
        .filter((v): v is boolean => v !== null);
    const cumulative = verdicts.filter(Boolean).length;
    const openingOnly = verdicts.length - cumulative;

    const headingCounts = new Map<string, number>();
    for (const o of decisions) {
        for (const h of o.rollCallHeadings ?? []) {
            const key = h.trim();
            if (key) headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1);
        }
    }
    const attendeeCounts = new Map<string, number>();
    for (const o of decisions) {
        for (const a of o.nonVotingAttendees ?? []) {
            const key = a.trim();
            if (key) attendeeCounts.set(key, (attendeeCounts.get(key) ?? 0) + 1);
        }
    }

    const reviewReasons: ReviewReason[] = [];
    if (decisions.length === 0) reviewReasons.push('no-usable-sample');
    if (categories.rollCallForm.dissent > DISSENT_REVIEW_THRESHOLD) reviewReasons.push('inconsistent-roll-call-form');
    if (categories.attendanceChangePinnedTo.dissent > DISSENT_REVIEW_THRESHOLD) reviewReasons.push('inconsistent-change-pinning');
    if (verdicts.length === 0) reviewReasons.push('roll-call-meaning-unresolved');
    else if (cumulative > 0 && openingOnly > 0) reviewReasons.push('roll-call-meaning-contested');
    const unrepresentable = [...new Set(decisions.flatMap(o => o.unusual ?? []).map(u => u.trim()).filter(Boolean))];
    if (unrepresentable.length > 0) reviewReasons.push('holds-facts-we-cannot-store');

    return {
        documents: decisions.length,
        notDecisions,
        categories,
        presence,
        // A tie is not a verdict. `cumulative > openingOnly` resolved one document
        // against one to false, and `conventionsFromProfile` turns false into
        // presentListMeaning 'opening' — a consequential value the sample did not
        // support. Null reaches 'unknown' instead.
        rollCallIsCumulative: cumulative === openingOnly ? null : cumulative > openingOnly,
        cumulativeEvidence: { cumulative, openingOnly },
        headings: [...headingCounts.entries()]
            .map(([heading, count]) => ({ heading, count }))
            .sort((a, b) => b.count - a.count),
        nonVotingAttendees: [...attendeeCounts.entries()]
            .map(([kind, count]) => ({ kind, count }))
            .sort((a, b) => b.count - a.count),
        unrepresentable,
        reviewReasons,
    };
}
