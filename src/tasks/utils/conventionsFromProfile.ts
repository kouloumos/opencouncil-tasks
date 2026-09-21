/**
 * Turn what a body's documents were observed to state into the conventions
 * record production reads.
 *
 * The profile counts documents; the conventions assert a property of the body.
 * Crossing that gap is a set of thresholds, and they are deliberately not all
 * the same number: a convention a body follows when it applies (substitutes,
 * per-vote absences) shows up in a minority of documents even when it is
 * universal practice, while a convention exercised by every document (the
 * mayor's presence, the roll-call layout) has to hold in most of them before it
 * is one.
 */
import type { BodyFactProfile } from './bodyFactProfile.js';
import type { DecisionConventions, ProfiledDecisionConventions } from '../../types.js';

/** Observed layouts that name no usable list; production treats them as mixed. */
const UNUSABLE_LAYOUTS = new Set(['narrative_only', 'absent']);

/**
 * The observation's anchor vocabulary predates `DecisionConventions`.
 * `clock_time` and `nothing` have no anchor to offer — a time of day places a
 * change in the session but not against any subject, and "nothing" says so
 * outright — so they are dropped rather than mapped to a lie.
 */
const ANCHOR_MAP: Record<string, DecisionConventions['attendanceChangeAnchors'][number] | undefined> = {
    agenda_item: 'agenda_item',
    decision_number: 'decision_number',
    session_phase: 'phase',
    this_document: 'subject',
    clock_time: undefined,
    nothing: undefined,
};

/** A practice that only appears where the case arises. */
const OCCASIONAL_PRACTICE_PERCENT = 10;
/** A practice every document has the chance to exercise. */
const ROUTINE_PRACTICE_PERCENT = 50;

export function conventionsFromProfile(
    profile: BodyFactProfile,
    sampled: number,
    today: string,
): ProfiledDecisionConventions {
    const layout = profile.categories.rollCallForm?.dominant ?? null;
    const anchors = (profile.categories.attendanceChangePinnedTo?.values ?? [])
        .filter(v => v.count > 0)
        .map(v => ANCHOR_MAP[v.value])
        .filter((a): a is DecisionConventions['attendanceChangeAnchors'][number] => a !== undefined);

    return {
        version: 1,
        rollCallLayout: layout === null || UNUSABLE_LAYOUTS.has(layout)
            ? 'mixed'
            : layout as DecisionConventions['rollCallLayout'],
        presentListMeaning: profile.rollCallIsCumulative === null
            ? 'unknown'
            : profile.rollCallIsCumulative ? 'cumulative' : 'opening',
        attendanceChangeAnchors: [...new Set(anchors)],
        // No presence field counts per-decision attendance; the anchor does.
        // A document carrying the `this_document` form — Argos' ΑΠΟΧΩΡΗΣΑΝΤΕΣ
        // column, Chalandri council's closing ΤΑ ΜΕΛΗ — states who was present
        // for that one decision. It appears only in the documents of decisions
        // someone missed, so it is rare by construction and a majority
        // threshold would erase it.
        statesPerDecisionAttendance: anchors.includes('subject'),
        statesPerVoteAbsence: profile.presence.perVoteAbsenceStated.percent >= OCCASIONAL_PRACTICE_PERCENT,
        usesSubstitutes: profile.presence.substitutesPresent.percent >= OCCASIONAL_PRACTICE_PERCENT,
        namedVoters: (profile.categories.namedVoters?.dominant ?? 'none') as DecisionConventions['namedVoters'],
        mayorStatedSeparately: profile.presence.mayorPresenceStated.percent >= ROUTINE_PRACTICE_PERCENT,
        // What the sample could not settle, carried through to the person who
        // confirms the record rather than dropped at the last step.
        ...(profile.reviewReasons.length > 0 ? { notes: profile.reviewReasons.join(', ') } : {}),
        provenance: { source: 'profile', profiledAt: today, documentsSampled: sampled },
    };
}
