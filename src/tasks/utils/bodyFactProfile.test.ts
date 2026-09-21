import { describe, it, expect } from 'vitest';
import { buildBodyFactProfile } from './bodyFactProfile.js';
import type { DocumentObservation } from './documentObservation.js';

function obs(over: Partial<DocumentObservation> = {}): DocumentObservation {
    return {
        isDeliberativeDecision: true,
        rollCallForm: 'present_and_absent',
        rollCallHeadings: ['ΠΑΡΟΝΤΕΣ', 'ΑΠΟΝΤΕΣ'],
        statedBodySize: null, presentCount: null, absentCount: null,
        attendanceChangesStated: false, attendanceChangePinnedTo: null, lateArrivalCheck: null,
        perVoteAbsenceStated: false, votePhraseStated: true, votePhrase: 'Ομόφωνα',
        votePhraseCarriesCounts: false, namedVoters: 'none', declarationsRecorded: false,
        partialOrPerLineVote: false, substitutesPresent: false, replacedMemberAlsoListed: null,
        nonVotingAttendees: [], mayorPresenceStated: false, agendaItemNumber: null,
        isOutOfAgenda: false, decisionNumberAsPrinted: null, participationModePerMember: false,
        discussionOrderStated: false, withdrawnItemsStated: false, correctedRepost: false,
        embeddedOtherBodyDecision: false, isAdvisoryOpinion: false, unusual: [],
        ...over,
    };
}

describe('buildBodyFactProfile', () => {
    it('excludes documents that are not deliberative decisions from every tally', () => {
        const p = buildBodyFactProfile([
            obs({ perVoteAbsenceStated: true }),
            obs({ isDeliberativeDecision: false, perVoteAbsenceStated: true }),
        ]);
        expect(p.documents).toBe(1);
        expect(p.notDecisions).toBe(1);
        expect(p.presence.perVoteAbsenceStated).toEqual({ yes: 1, no: 0, percent: 100 });
    });

    it('flags a body whose roll-call form is not consistent', () => {
        const p = buildBodyFactProfile([
            obs({ rollCallForm: 'present_and_absent' }),
            obs({ rollCallForm: 'composition_and_absent' }),
        ]);
        expect(p.categories.rollCallForm.dissent).toBe(0.5);
        expect(p.reviewReasons).toContain('inconsistent-roll-call-form');
    });

    it('does not flag a body that varies only slightly', () => {
        const p = buildBodyFactProfile([
            ...Array.from({ length: 9 }, () => obs()),
            obs({ rollCallForm: 'composition_and_absent' }),
        ]);
        expect(p.reviewReasons).not.toContain('inconsistent-roll-call-form');
    });

    it('reports the cumulative question as unresolved when no document tests it', () => {
        const p = buildBodyFactProfile([obs(), obs()]);
        expect(p.rollCallIsCumulative).toBeNull();
        expect(p.reviewReasons).toContain('roll-call-meaning-unresolved');
    });

    it('derives an opening-only roll call from where the arrival is listed', () => {
        // Orestiada: the arrival stays under ΑΠΟΝΤΕΣ with an annotation.
        const p = buildBodyFactProfile([
            obs({ lateArrivalCheck: { name: 'Χ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true } }),
            obs({ lateArrivalCheck: { name: 'Ψ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true } }),
        ]);
        expect(p.rollCallIsCumulative).toBe(false);
        expect(p.cumulativeEvidence).toEqual({ cumulative: 0, openingOnly: 2 });
        expect(p.reviewReasons).not.toContain('roll-call-meaning-contested');
    });

    // One document against one used to resolve to false, and false becomes
    // presentListMeaning 'opening' — a consequential value the sample did not
    // support.
    it('settles nothing when the documents that test it are evenly split', () => {
        const p = buildBodyFactProfile([
            obs({ lateArrivalCheck: { name: 'Χ', appearsInPresentList: true, appearsInCompositionRoster: true, appearsInAbsentList: false } }),
            obs({ lateArrivalCheck: { name: 'Ψ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true } }),
        ]);
        expect(p.rollCallIsCumulative).toBeNull();
        expect(p.cumulativeEvidence).toEqual({ cumulative: 1, openingOnly: 1 });
        expect(p.reviewReasons).toContain('roll-call-meaning-contested');
    });

    it('takes the majority when the split is not even', () => {
        const cumulative = obs({ lateArrivalCheck: { name: 'Χ', appearsInPresentList: true, appearsInCompositionRoster: true, appearsInAbsentList: false } });
        const openingOnly = obs({ lateArrivalCheck: { name: 'Ψ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true } });
        expect(buildBodyFactProfile([cumulative, cumulative, openingOnly]).rollCallIsCumulative).toBe(true);
        expect(buildBodyFactProfile([cumulative, openingOnly, openingOnly]).rollCallIsCumulative).toBe(false);
    });

    it('deduplicates what the body states but we cannot store', () => {
        const p = buildBodyFactProfile([
            obs({ unusual: ['ΟΡΘΗ ΕΠΑΝΑΛΗΨΗ marker', ' participation mode '] }),
            obs({ unusual: ['ΟΡΘΗ ΕΠΑΝΑΛΗΨΗ marker'] }),
        ]);
        expect(p.unrepresentable).toEqual(['ΟΡΘΗ ΕΠΑΝΑΛΗΨΗ marker', 'participation mode']);
        expect(p.reviewReasons).toContain('holds-facts-we-cannot-store');
    });

    it('reports headings verbatim and ranked, since they are the reviewable evidence', () => {
        const p = buildBodyFactProfile([
            obs({ rollCallHeadings: ['ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ'] }),
            obs({ rollCallHeadings: ['ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ', 'ΑΠΟΝΤΕΣ'] }),
        ]);
        expect(p.headings[0]).toEqual({ heading: 'ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ', count: 2 });
    });

    it('flags a body with no usable sample rather than reporting zeroes', () => {
        const p = buildBodyFactProfile([obs({ isDeliberativeDecision: false })]);
        expect(p.reviewReasons).toContain('no-usable-sample');
    });
});
