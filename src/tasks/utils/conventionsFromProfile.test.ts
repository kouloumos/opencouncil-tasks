import { describe, it, expect } from 'vitest';
import { conventionsFromProfile } from './conventionsFromProfile.js';
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

const arrivedLate = { name: 'Χ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true };

describe('conventionsFromProfile', () => {
    it('reads a committee that prints a roster, substitutes and agenda-item changes', () => {
        // Zografou's shape: every member listed, the absent named, a substitute
        // in a minority of documents, arrivals annotated inside the absent list.
        const profile = buildBodyFactProfile([
            ...Array.from({ length: 7 }, () => obs({
                rollCallForm: 'composition_and_absent',
                mayorPresenceStated: true,
                lateArrivalCheck: arrivedLate,
                attendanceChangesStated: true,
                attendanceChangePinnedTo: 'agenda_item',
            })),
            ...Array.from({ length: 3 }, () => obs({
                rollCallForm: 'composition_and_absent',
                mayorPresenceStated: true,
                substitutesPresent: true,
                replacedMemberAlsoListed: true,
            })),
        ]);

        expect(conventionsFromProfile(profile, 10, '2026-09-17')).toEqual({
            version: 1,
            rollCallLayout: 'composition_and_absent',
            presentListMeaning: 'opening',
            attendanceChangeAnchors: ['agenda_item'],
            statesPerDecisionAttendance: false,
            statesPerVoteAbsence: false,
            usesSubstitutes: true,
            namedVoters: 'none',
            mayorStatedSeparately: true,
            provenance: { source: 'profile', profiledAt: '2026-09-17', documentsSampled: 10 },
        });
    });

    it('keeps the per-decision form even though only a few documents carry it', () => {
        // Argos council: the ΑΠΟΧΩΡΗΣΑΝΤΕΣ column appears only in documents of
        // decisions the person missed, so it is a minority by construction.
        const profile = buildBodyFactProfile([
            ...Array.from({ length: 8 }, () => obs({
                lateArrivalCheck: { ...arrivedLate, appearsInPresentList: true, appearsInAbsentList: false },
                namedVoters: 'dissenters_only',
            })),
            ...Array.from({ length: 2 }, () => obs({
                attendanceChangesStated: true,
                attendanceChangePinnedTo: 'this_document',
                perVoteAbsenceStated: true,
                namedVoters: 'dissenters_only',
            })),
        ]);
        const conventions = conventionsFromProfile(profile, 10, '2026-09-17');

        expect(conventions.attendanceChangeAnchors).toEqual(['subject']);
        expect(conventions.statesPerDecisionAttendance).toBe(true);
        expect(conventions.statesPerVoteAbsence).toBe(true);
        expect(conventions.presentListMeaning).toBe('cumulative');
        expect(conventions.namedVoters).toBe('dissenters_only');
    });

    it('says unknown, mixed and no anchor when the sample settles nothing', () => {
        // Prose attendance, a change with no reference and one pinned to a
        // clock time: neither anchor is one production can place a change at.
        const profile = buildBodyFactProfile([
            obs({ rollCallForm: 'narrative_only', attendanceChangesStated: true, attendanceChangePinnedTo: 'nothing' }),
            obs({ rollCallForm: 'narrative_only', attendanceChangesStated: true, attendanceChangePinnedTo: 'clock_time' }),
        ]);
        const conventions = conventionsFromProfile(profile, 2, '2026-09-17');

        expect(conventions.rollCallLayout).toBe('mixed');
        expect(conventions.presentListMeaning).toBe('unknown');
        expect(conventions.attendanceChangeAnchors).toEqual([]);
        expect(conventions.notes).toContain('roll-call-meaning-unresolved');
    });
});
