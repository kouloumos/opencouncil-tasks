import { describe, it, expect } from 'vitest';
import {
    resolveAndDeduplicateAttendanceChanges,
    toDocumentEvents,
} from './meetingAttendance.js';
import { AgendaItemRef, AttendanceChange } from './decisionPdfExtraction.js';

function ref(index: number, nonAgendaReason: 'outOfAgenda' | null = null): AgendaItemRef {
    return { agendaItemIndex: index, nonAgendaReason };
}

function makeChange(overrides: Partial<AttendanceChange> & Pick<AttendanceChange, 'name' | 'type'>): AttendanceChange {
    return { agendaItem: null, timing: null, rawText: '', ...overrides };
}

describe('resolveAndDeduplicateAttendanceChanges', () => {
    const nameToPersonId = new Map([
        ['ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', 'p1'],
        ['Κ. Αγγελής', 'p1'],
        ['ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ', 'p2'],
    ]);
    const initialNames = ['ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', 'ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ'];

    it('resolves abbreviated names to canonical initial-list form', () => {
        const extractions = [{
            raw: { attendanceChanges: [
                makeChange({ name: 'Κ. Αγγελής', type: 'departure', agendaItem: ref(1), timing: 'during' }),
            ] },
        }];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ');
        expect(result[0].timing).toBe('during');
    });

    it('deduplicates same change from multiple PDFs with different name variants', () => {
        const extractions = [
            { raw: { attendanceChanges: [
                makeChange({ name: 'Κ. Αγγελής', type: 'departure', agendaItem: ref(1), timing: 'during' }),
            ] } },
            { raw: { attendanceChanges: [
                makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' }),
            ] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ');
    });

    it('still counts two spellings as one person when no roll call lends a canonical name', () => {
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'Κ. Αγγελής', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, []);
        expect(result).toHaveLength(1);
        expect(result[0].reportingPdfCount).toBe(2);
        expect(nameToPersonId.get(result[0].name)).toBe('p1');
    });

    it('picks timing by majority vote', () => {
        // 3 PDFs say "during", 1 says "after" → "during" wins
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'after' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].timing).toBe('during');
    });

    it('prefers specified timing over null on tie', () => {
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: null })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].timing).toBe('during');
    });

    it('prefers during over after on tie', () => {
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'after' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' as const })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].timing).toBe('during');
    });

    it('filters out changes reported by only 1 PDF when multiple are extracted', () => {
        // 5 PDFs, only 1 reports a change → hallucination, should be filtered
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(0);
    });

    it('includes changes reported by majority of PDFs', () => {
        // 4 PDFs, 3 report a change → above 50% threshold
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].reportingPdfCount).toBe(3);
        expect(result[0].totalPdfCount).toBe(4);
    });

    it('filters out changes at exactly 50% (requires strict majority)', () => {
        // 4 PDFs, 2 report → exactly 50%, NOT strict majority
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(0);
    });

    it('accepts single-PDF change when only 1 PDF is extracted', () => {
        // 1 PDF, 1 reports → 1 > 0.5 → accepted
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
    });

    it('keeps unmatched names as-is', () => {
        const extractions = [{
            raw: { attendanceChanges: [
                makeChange({ name: 'Ε. Χριστούλη', type: 'arrival', agendaItem: ref(2, 'outOfAgenda'), timing: 'during' }),
            ] },
        }];
        // "Ε. Χριστούλη" not in nameToPersonId
        const result = resolveAndDeduplicateAttendanceChanges(extractions, new Map([['ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ', 'p2']]), initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Ε. Χριστούλη'); // unchanged
    });
});


describe('toDocumentEvents', () => {
    const resolve = (n: string) => ({ 'Α. Χαμηλοθώρη': 'p1', 'Γ. Ρεμούνδος': 'p2' } as Record<string, string>)[n] ?? null;
    it('expands a per-vote absence into a departure before and an arrival after the subject', () => {
        const out = toDocumentEvents([{ name: 'Α. Χαμηλοθώρη', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: 'Κατά τη διαδικασία…',
            anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: null } }], 'sub-1', resolve);
        expect(out).toEqual([
            expect.objectContaining({ type: 'departure', personId: 'p1', anchor: expect.objectContaining({ kind: 'subject', subjectId: 'sub-1', timing: 'before' }), rawText: 'Κατά τη διαδικασία…' }),
            expect.objectContaining({ type: 'arrival', personId: 'p1', anchor: expect.objectContaining({ kind: 'subject', subjectId: 'sub-1', timing: 'after' }) }),
        ]);
    });
    it('maps this_document departures to the subject anchor and keeps other anchors', () => {
        const out = toDocumentEvents([
            { name: 'Γ. Ρεμούνδος', type: 'departure', agendaItem: null, timing: null, rawText: 'x', anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: 'during' } },
            { name: 'Γ. Ρεμούνδος', type: 'arrival', agendaItem: null, timing: null, rawText: 'y', anchor: { kind: 'phase', agendaItem: null, decisionNumber: null, phase: 'pre_agenda', timing: null } },
        ], 'sub-1', resolve);
        expect(out[0].anchor).toMatchObject({ kind: 'subject', subjectId: 'sub-1', timing: 'during' });
        expect(out[1].anchor).toMatchObject({ kind: 'phase', phase: 'pre_agenda', subjectId: null });
        expect(out.every(e => e.reportingPdfCount === 1 && e.totalPdfCount === 1)).toBe(true);
    });
});
