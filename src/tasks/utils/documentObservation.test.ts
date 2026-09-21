import { describe, it, expect } from 'vitest';
import { lateArrivalIsInOpeningPresentSet, OBSERVATION_SCHEMA, OBSERVATION_SCHEMA_VERSION } from './documentObservation.js';

/**
 * The rule differs by layout, and getting it wrong is what makes
 * `presentMembers` mean two different things across bodies.
 */
describe('lateArrivalIsInOpeningPresentSet', () => {
    it('excludes a roster-listed arrival who is also named absent', () => {
        // Zografou council: a ΣΥΝΘΕΣΗ of 35 names everyone, then «απουσίαζαν οι
        // …» names 10, three of whom arrive during item 1. Being in the roster
        // is membership, not attendance.
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'composition_and_absent',
            lateArrivalCheck: { name: 'ΛΑΠΠΑΣ ΒΑΣΙΛΕΙΟΣ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true },
        })).toBe(false);
    });

    it('includes a roster-listed arrival who is not named absent', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'composition_and_absent',
            lateArrivalCheck: { name: 'Χ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: false },
        })).toBe(true);
    });

    it('reads the present list directly when the document prints one', () => {
        // Orestiada council: ΤΣΕΛΕΜΠΗΣ stays under ΑΠΟΝΤΕΣ with
        // «(ΠΡΟΣΗΛΘΕ ΣΤΟ 1ο ΘΕΜΑ)», so he is not in the opening present set.
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'present_and_absent',
            lateArrivalCheck: { name: 'ΤΣΕΛΕΜΠΗΣ ΔΗΜΗΤΡΙΟΣ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: true },
        })).toBe(false);
    });

    it('yields no verdict when a printed present list also names the person absent', () => {
        // Superseded an earlier rule that took the present list as decisive
        // here. Nobody is in both lists, so this reading is evidence of a
        // failed lookup rather than of attendance.
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'present_and_absent',
            lateArrivalCheck: { name: 'Χ', appearsInPresentList: true, appearsInCompositionRoster: true, appearsInAbsentList: true },
        })).toBeNull();
    });

    it('returns null when the document names no late arrival', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'present_and_absent',
            lateArrivalCheck: null,
        })).toBeNull();
    });

    it('returns null when attendance is prose only, so there is nothing to check against', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'narrative_only',
            lateArrivalCheck: { name: 'Χ', appearsInPresentList: false, appearsInCompositionRoster: false, appearsInAbsentList: false },
        })).toBeNull();
    });
});

describe('OBSERVATION_SCHEMA', () => {
    it('requires every property it declares, so a partial reading is rejected', () => {
        const declared = Object.keys(OBSERVATION_SCHEMA.properties).sort();
        expect([...OBSERVATION_SCHEMA.required].sort()).toEqual(declared);
    });
});

describe('a printed present list beats a roster', () => {
    /**
     * The error this split exists to prevent. Chalandri's ΣΥΜΜΕΤΕΧΟΝΤΕΣ list
     * carries a substitute with a «σε αντικατάσταση» annotation, and the
     * arriving substitute Ευθυμίου is NOT in it — he arrives during item 7
     * while Λυμπεράτος sits in ΜΗ ΣΥΜΜΕΤΕΧΟΝΤΕΣ. A single merged flag read
     * this as cumulative across five documents. It is opening-only.
     */
    it('reads opening-only when the arriving substitute is not in the participating list', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'present_and_absent',
            lateArrivalCheck: { name: 'Κ. Ευθυμίου', appearsInPresentList: false, appearsInCompositionRoster: false, appearsInAbsentList: false },
        })).toBe(false);
    });

    /**
     * Athens committee is the genuine opposite case: the σύνθεση is an
     * invitation roster naming everyone summoned, and ΧΑΡΛΑΥΤΗΣ is in it while
     * arriving during item 1. Composition minus absentees therefore includes
     * him, which is the hazard worth recording as cumulative.
     */
    it('reads cumulative when a roster-only layout lists the arrival and does not name them absent', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'composition_and_absent',
            lateArrivalCheck: { name: 'Π.Π.ΧΑΡΛΑΥΤΗΣ', appearsInPresentList: false, appearsInCompositionRoster: true, appearsInAbsentList: false },
        })).toBe(true);
    });

    it('reads opening-only when a roster layout does not list the arrival at all', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'composition_and_absent',
            lateArrivalCheck: { name: 'Χ', appearsInPresentList: false, appearsInCompositionRoster: false, appearsInAbsentList: false },
        })).toBe(false);
    });
});

describe('self-contradictory readings yield no verdict', () => {
    /**
     * A person cannot be in both ΠΑΡΟΝΤΕΣ and ΑΠΟΝΤΕΣ. Seven Chania committee
     * readings claimed exactly that, which means the name was never looked up.
     * Counting them as evidence would have manufactured a majority.
     */
    it('returns null when a printed present list also contains the name as absent', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'present_and_absent',
            lateArrivalCheck: { name: 'Γιαννακάκης Ιωάννης', appearsInPresentList: true, appearsInCompositionRoster: false, appearsInAbsentList: true },
        })).toBeNull();
    });

    it('still answers when only one of the two is true', () => {
        expect(lateArrivalIsInOpeningPresentSet({
            rollCallForm: 'present_and_absent',
            lateArrivalCheck: { name: 'Χ', appearsInPresentList: true, appearsInCompositionRoster: false, appearsInAbsentList: false },
        })).toBe(true);
    });
});

describe('OBSERVATION_SCHEMA_VERSION', () => {
    /**
     * The cache key carries this number. Forgetting to bump it after changing a
     * field's meaning silently serves old-shape answers, which is how a fix
     * once looked like it had not worked.
     */
    it('is ahead of the shapes it replaced', () => {
        expect(OBSERVATION_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    });

    it('offers a pinning value for a roll call that carries its own departures', () => {
        const pin = OBSERVATION_SCHEMA.properties.attendanceChangePinnedTo as { anyOf: Array<{ enum?: string[] }> };
        const values = pin.anyOf.flatMap(v => v.enum ?? []);
        expect(values).toContain('this_document');
        expect(values).toContain('nothing');
    });
});
