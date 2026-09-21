import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAiChat, NO_USAGE_MOCK, mockGetPageCount } = vi.hoisted(() => ({
    mockAiChat: vi.fn(),
    NO_USAGE_MOCK: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    mockGetPageCount: vi.fn().mockReturnValue(3), // Default: small PDF (≤10 pages)
}));
vi.mock("../../lib/ai.js", () => ({
    aiChat: mockAiChat,
    addUsage: (a: any, b: any) => ({
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
        cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
    }),
    NO_USAGE: NO_USAGE_MOCK,
    HAIKU_MODEL: 'claude-haiku-4-5-20251001',
}));

// Mock pdf-lib to avoid needing real PDF bytes in tests
vi.mock("pdf-lib", () => {
    const mockSrcDoc = {
        getPageCount: mockGetPageCount,
    };
    return {
        PDFDocument: {
            load: vi.fn().mockResolvedValue(mockSrcDoc),
            create: vi.fn().mockResolvedValue({
                copyPages: vi.fn().mockResolvedValue([]),
                addPage: vi.fn(),
                save: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
            }),
        },
    };
});

// Prevent tests from reading/writing the on-disk extraction cache
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        default: {
            ...actual,
            readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
                if (typeof args[0] === 'string' && args[0].includes('opencouncil-decisions-cache')) {
                    throw new Error('cache miss (mocked)');
                }
                return actual.readFileSync(...args);
            },
            writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
                if (typeof args[0] === 'string' && args[0].includes('opencouncil-decisions-cache')) {
                    return; // no-op
                }
                return actual.writeFileSync(...args);
            },
            mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
                if (typeof args[0] === 'string' && args[0].includes('opencouncil-decisions-cache')) {
                    return undefined; // no-op
                }
                return actual.mkdirSync(...args);
            },
        },
    };
});

import {
    extractDecisionFromPdf,
    normalizeGreekName,
    tokenSortKey,
    tokenSortKeys,
    matchMembersToPersonIds,
    matchPersonByName,
    matchAllMembers,
    llmMatchMembers,
    sameGreekPerson,
    greekNameInList,
    withDefaults,
    extractionCacheKey,
    EXTRACTION_SCHEMA_VERSION, adoptLaterVoteNames } from './decisionPdfExtraction.js';
import type { RawExtractedDecision, AttendanceAnchor } from './decisionPdfExtraction.js';
import type { AttendanceAnchorKind as WireAnchorKind, AttendancePhase as WirePhase } from '../../types.js';

const noUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// --- normalizeGreekName tests ---

describe('normalizeGreekName', () => {
    it('strips Greek diacritics (tonos)', () => {
        expect(normalizeGreekName('Κρανιώτης Χαράλαμπος')).toBe('κρανιωτης χαραλαμπος');
    });

    it('handles ALL CAPS without accents', () => {
        expect(normalizeGreekName('ΚΡΑΝΙΩΤΗΣ ΧΑΡΑΛΑΜΠΟΣ')).toBe('κρανιωτης χαραλαμπος');
    });

    it('strips parenthetical nicknames', () => {
        expect(normalizeGreekName('ΚΡΑΝΙΩΤΗΣ ΧΑΡΑΛΑΜΠΟΣ (ΜΠΑΜΠΗΣ)')).toBe('κρανιωτης χαραλαμπος');
    });

    it('handles names with multiple diacritics', () => {
        expect(normalizeGreekName('Αλεξάνδρη-Ζουμπουλάκη Ευσταθία')).toBe('αλεξανδρη-ζουμπουλακη ευσταθια');
    });

    it('normalizes whitespace', () => {
        expect(normalizeGreekName('  ΓΡΙΒΑΣ   ΓΕΩΡΓΙΟΣ  ')).toBe('γριβας γεωργιος');
    });

    it('handles dialytika (ϊ/ΐ)', () => {
        expect(normalizeGreekName('ΠΑΠΑΪΩΑΝΝΟΥ')).toBe('παπαιωαννου');
        expect(normalizeGreekName('Παπαΐωάννου')).toBe('παπαιωαννου');
    });
});

// --- tokenSortKey / tokenSortKeys tests ---

describe('sameGreekPerson', () => {
    it('matches surname plus initial against the spelled-out name', () => {
        expect(sameGreekPerson('Αθανασάκης Σ.', 'Σπύρος (Σάκης) Αθανασάκης')).toBe(true);
        expect(sameGreekPerson('Καρύδας Δ.-Ε.', 'ΚΑΡΥΔΑΣ ΔΗΜΗΤΡΙΟΣ-ΕΥΑΓΓΕΛΟΣ')).toBe(true);
        expect(sameGreekPerson('Χαμντί Ντ.', 'Χαμντί Ντάφερ')).toBe(true);
    });
    it('does not match a different surname or a wrong initial', () => {
        expect(sameGreekPerson('Αθανασάκης Γ.', 'Σπύρος Αθανασάκης')).toBe(false);
        expect(sameGreekPerson('Βέρα Λ.', 'Λυδία Πάλλα')).toBe(false);
        expect(sameGreekPerson('Σ.', 'Σπύρος Αθανασάκης')).toBe(false);
    });
    it('subtracts abbreviated absentees from a composition', () => {
        const composition = ['Σπύρος (Σάκης) Αθανασάκης', 'Λυδία Βέρα', 'Παναγιώτης Κουφάκης'];
        const absent = ['Αθανασάκης Σ.', 'Βέρα Λ.'];
        expect(composition.filter(n => !greekNameInList(n, absent))).toEqual(['Παναγιώτης Κουφάκης']);
    });
});

describe('tokenSortKey', () => {
    it('sorts tokens alphabetically for order-insensitive matching', () => {
        // DB: FirstName LastName → same sorted key as PDF: LastName FirstName
        expect(tokenSortKey('Ευθύμιος Μπαρμπέρης')).toBe(tokenSortKey('ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ'));
    });

    it('treats hyphens as word separators', () => {
        expect(tokenSortKey('Χριστοφορίδου-Τσιλιγκίρη Θέκλα'))
            .toBe(tokenSortKey('ΧΡΙΣΤΟΦΟΡΙΔΟΥ - ΤΣΙΛΙΓΚΙΡΗ ΘΕΚΛΑ'));
    });

    it('strips nicknames before tokenizing', () => {
        expect(tokenSortKey('ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ (ΜΑΚΗΣ)'))
            .toBe(tokenSortKey('Ευθύμιος Μπαρμπέρης'));
    });

    it('strips diacritics', () => {
        expect(tokenSortKey('Κρανιώτης Χαράλαμπος'))
            .toBe(tokenSortKey('ΚΡΑΝΙΩΤΗΣ ΧΑΡΑΛΑΜΠΟΣ'));
    });
});

describe('tokenSortKeys', () => {
    it('returns single key for names without nicknames', () => {
        expect(tokenSortKeys('Ευθύμιος Μπαρμπέρης')).toHaveLength(1);
    });

    it('returns two keys when nickname differs from formal name', () => {
        const keys = tokenSortKeys('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)');
        expect(keys).toHaveLength(2);
        // Key 1: formal name (nickname stripped)
        expect(keys[0]).toBe(tokenSortKey('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ'));
        // Key 2: nickname replaces formal first name
        expect(keys[1]).toBe(tokenSortKey('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΣΤΗΣ'));
    });

    it('nickname key matches DB name stored as informal', () => {
        const pdfKeys = tokenSortKeys('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)');
        const dbKey = tokenSortKey('Κωστής Παπαναστασόπουλος');
        expect(pdfKeys).toContain(dbKey);
    });
});

// --- matchMembersToPersonIds tests (step 1: token-sort) ---

describe('matchMembersToPersonIds', () => {
    const people = [
        { id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' },
        { id: 'p2', name: 'Ευανθία Καμινάρη' },
        { id: 'p3', name: 'Παπαϊωάννου Αριάδνη' },
    ];

    it('matches names with reversed order (PDF: LastName FirstName, DB: FirstName LastName)', () => {
        const result = matchMembersToPersonIds(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΚΑΜΙΝΑΡΗ ΕΥΑΝΘΙΑ'],
            people,
        );
        expect(result.matchedIds).toEqual(['p1', 'p2']);
        expect(result.unmatched).toEqual([]);
    });

    it('matches names with nicknames stripped', () => {
        const result = matchMembersToPersonIds(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ (ΜΑΚΗΣ)'],
            people,
        );
        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual([]);
    });

    it('matches names with dialytika differences', () => {
        const result = matchMembersToPersonIds(
            ['ΠΑΠΑΪΩΑΝΝΟΥ ΑΡΙΑΔΝΗ'],
            people,
        );
        expect(result.matchedIds).toEqual(['p3']);
        expect(result.unmatched).toEqual([]);
    });

    it('reports unmatched names', () => {
        const result = matchMembersToPersonIds(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ'],
            people,
        );
        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual(['ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ']);
    });

    it('returns empty arrays for empty input', () => {
        const result = matchMembersToPersonIds([], people);
        expect(result.matchedIds).toEqual([]);
        expect(result.unmatched).toEqual([]);
    });
});

// --- matchPersonByName tests ---

describe('matchMembersToPersonIds abbreviated fallback', () => {
    const people = [
        { id: 'gazi', name: 'Ευαγγελία Γαζή' },
        { id: 'ath', name: 'Σπύρος Αθανασάκης' },
        { id: 'pap1', name: 'Γεώργιος Παπαδόπουλος' },
        { id: 'pap2', name: 'Γιάννης Παπαδόπουλος' },
    ];
    it('matches a middle name and a surname-plus-initial when unique', () => {
        const r = matchMembersToPersonIds(['Ευαγγελία Λίλιαν Γαζή', 'Αθανασάκης Σ.'], people);
        expect(r.matchedIds).toEqual(['gazi', 'ath']);
        expect(r.unmatched).toEqual([]);
    });
    it('leaves an ambiguous initial unmatched', () => {
        const r = matchMembersToPersonIds(['Παπαδόπουλος Γ.'], people);
        expect(r.matchedIds).toEqual([]);
        expect(r.unmatched).toEqual(['Παπαδόπουλος Γ.']);
    });
});

describe('matchPersonByName', () => {
    const people = [
        { id: 'p1', name: 'Ευσταθία Βαμβάκα' },
        { id: 'p2', name: 'Κωστής Παπαναστασόπουλος' },
    ];

    it('returns personId for matching name (reversed order + nickname)', () => {
        expect(matchPersonByName('ΒΑΜΒΑΚΑ ΕΥΣΤΑΘΙΑ (ΕΦΗ)', people)).toBe('p1');
    });

    it('matches when DB stores informal name and PDF has formal + nickname', () => {
        expect(matchPersonByName('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)', people)).toBe('p2');
    });

    it('returns null for non-matching name', () => {
        expect(matchPersonByName('ΑΓΝΩΣΤΟΣ', people)).toBeNull();
    });
});

// --- llmMatchMembers tests ---

describe('matchPersonByName abbreviated fallback', () => {
    it('resolves a middle name the roster does not carry', () => {
        expect(matchPersonByName('Ευαγγελία Λιλιάν Γαζή', [{ id: 'gazi', name: 'Ευαγγελία Γαζή' }, { id: 'x', name: 'Λυδία Βέρα' }])).toBe('gazi');
    });
});

describe('llmMatchMembers', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it('returns LLM-matched names with personIds and usage', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [
                    { name: 'ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', personId: 'p1' },
                    { name: 'ΑΓΝΩΣΤΟΣ', personId: null },
                ],
            },
            usage: { input_tokens: 50, output_tokens: 25 },
        });

        const result = await llmMatchMembers(
            ['ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', 'ΑΓΝΩΣΤΟΣ'],
            [{ id: 'p1', name: 'Βασιλική Στρακαντούνα-Σφακάκη' }],
        );

        expect(result.matched).toEqual([{ name: 'ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', personId: 'p1' }]);
        expect(result.stillUnmatched).toEqual(['ΑΓΝΩΣΤΟΣ']);
        expect(result.usage).toEqual({ input_tokens: 50, output_tokens: 25 });
    });

    it('returns all names as unmatched when people list is empty', async () => {
        const result = await llmMatchMembers(['NAME1', 'NAME2'], []);
        expect(result.matched).toEqual([]);
        expect(result.stillUnmatched).toEqual(['NAME1', 'NAME2']);
        expect(result.usage).toEqual(noUsage);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it('skips LLM when no unmatched names', async () => {
        const result = await llmMatchMembers([], [{ id: 'p1', name: 'Test' }]);
        expect(result.matched).toEqual([]);
        expect(result.stillUnmatched).toEqual([]);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it('prevents duplicate personId matches', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [
                    { name: 'NAME1', personId: 'p1' },
                    { name: 'NAME2', personId: 'p1' }, // duplicate
                ],
            },
            usage: noUsage,
        });

        const result = await llmMatchMembers(
            ['NAME1', 'NAME2'],
            [{ id: 'p1', name: 'Person 1' }],
        );

        expect(result.matched).toEqual([{ name: 'NAME1', personId: 'p1' }]);
        expect(result.stillUnmatched).toEqual(['NAME2']);
    });

    it('requests structured output instead of a prefill (rejected on Claude 4.6+)', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: { matches: [{ name: 'TEST', personId: 'p1' }] },
            usage: noUsage,
        });

        await llmMatchMembers(['TEST'], [{ id: 'p1', name: 'Test Person' }]);

        const callArgs = mockAiChat.mock.calls[0][0];
        expect(callArgs.outputFormat).toBeDefined();
        expect(callArgs.prefillSystemResponse).toBeUndefined();
    });
});

// --- matchAllMembers tests (two-step) ---

describe('llmMatchMembers', () => {
    it('rejects an id the model invented instead of copying', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: { matches: [
                { name: 'Ευαγγελία Λίλιαν Γαζή', personId: 'p1' },
                { name: 'Σ. Αθανασάκης', personId: 'p1-spliced-p2' },
            ] },
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const { matched, stillUnmatched } = await llmMatchMembers(
            ['Ευαγγελία Λίλιαν Γαζή', 'Σ. Αθανασάκης'],
            [{ id: 'p1', name: 'Ευαγγελία Γαζή' }, { id: 'p2', name: 'Σπύρος Αθανασάκης' }],
        );
        expect(matched).toEqual([{ name: 'Ευαγγελία Λίλιαν Γαζή', personId: 'p1' }]);
        expect(stillUnmatched).toEqual(['Σ. Αθανασάκης']);
    });
});

describe('matchAllMembers', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it('matches all via token-sort without calling LLM', async () => {
        const result = await matchAllMembers(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ'],
            [{ id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' }],
        );
        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual([]);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it('falls back to LLM for token-sort misses', async () => {
        // "ΓΙΑΝΝΗΣ" is a nickname for "Ιωάννης" — token-sort can't match this
        mockAiChat.mockResolvedValueOnce({
            result: { matches: [{ name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΙΑΝΝΗΣ', personId: 'p2' }] },
            usage: noUsage,
        });

        const result = await matchAllMembers(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΙΑΝΝΗΣ'],
            [
                { id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' },
                { id: 'p2', name: 'Ιωάννης Παπαδόπουλος' },
            ],
        );

        // p1 matched by token-sort, p2 matched by LLM
        expect(result.matchedIds).toEqual(['p1', 'p2']);
        expect(result.unmatched).toEqual([]);
        // LLM only received the unmatched name, not p1
        expect(mockAiChat).toHaveBeenCalledOnce();
    });

    it('reports truly unmatched names after both steps', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: { matches: [{ name: 'ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ', personId: null }] },
            usage: noUsage,
        });

        const result = await matchAllMembers(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ'],
            [{ id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' }],
        );

        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual(['ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ']);
    });
});

// --- cached-reading migration ---

describe('extractionCacheKey', () => {
    it('versions the key, so a reading written by an older prompt is never found', () => {
        expect(extractionCacheKey('https://example.com/a.pdf')).toBe(`https://example.com/a.pdf#v${EXTRACTION_SCHEMA_VERSION}`);
        expect(extractionCacheKey('https://example.com/a.pdf')).not.toBe('https://example.com/a.pdf');
    });

    it('keeps a hinted reading apart from a plain one, both under the version', () => {
        const plain = extractionCacheKey('https://example.com/a.pdf');
        const hinted = extractionCacheKey('https://example.com/a.pdf', 'the body prints ΣΥΝΘΕΣΗ');
        expect(hinted).not.toBe(plain);
        expect(hinted.startsWith(`${plain}#`)).toBe(true);
    });
});

describe('withDefaults', () => {
    const WIRE_KINDS: WireAnchorKind[] = ['agenda_item', 'decision_number', 'subject', 'phase', 'session_start', 'session_end'];
    const WIRE_PHASES: (WirePhase | null)[] = ['pre_agenda', 'out_of_agenda', null];

    const cachedWithAnchor = (anchor: Record<string, unknown>) => ({
        attendanceChanges: [{ name: 'Α Β', type: 'departure', agendaItem: null, timing: null, anchor, rawText: 'x' }],
    }) as unknown as RawExtractedDecision;

    const migratedAnchor = (anchor: Record<string, unknown>): AttendanceAnchor =>
        withDefaults(cachedWithAnchor(anchor)).attendanceChanges[0].anchor!;

    const retired = (over: Record<string, unknown>) => ({ agendaItem: null, decisionNumber: null, timing: null, ...over });

    it('turns the retired session_phase anchor into a phase the wire declares', () => {
        expect(migratedAnchor(retired({ kind: 'session_phase', phase: 'μετά την ψήφιση του κατεπείγοντος' })))
            .toMatchObject({ kind: 'phase', phase: 'pre_agenda' });
        expect(migratedAnchor(retired({ kind: 'session_phase', phase: 'εκτός ημερησίας διατάξεως' })))
            .toMatchObject({ kind: 'phase', phase: 'out_of_agenda' });
        expect(migratedAnchor(retired({ kind: 'session_phase', phase: 'συζήτηση Ε.Η.Δ. θέματος' })))
            .toMatchObject({ kind: 'phase', phase: 'out_of_agenda' });
    });

    it('turns the retired clock_time anchor into the start of the session', () => {
        expect(migratedAnchor(retired({ kind: 'clock_time', phase: null })))
            .toMatchObject({ kind: 'session_start', phase: null });
    });

    it('drops a free-text phase riding a kind that is not phase', () => {
        expect(migratedAnchor(retired({ kind: 'this_document', phase: 'πριν την ψηφοφορία' })))
            .toMatchObject({ kind: 'this_document', phase: null });
    });

    it('leaves an anchor already in the v4 vocabulary alone', () => {
        const anchor = retired({ kind: 'phase', phase: 'out_of_agenda' });
        expect(migratedAnchor(anchor)).toMatchObject({ kind: 'phase', phase: 'out_of_agenda' });
        expect(migratedAnchor(retired({ kind: 'agenda_item', agendaItem: { agendaItemIndex: 3, nonAgendaReason: null }, timing: 'during' })))
            .toMatchObject({ kind: 'agenda_item', phase: null });
    });

    it('never emits a kind or a phase outside what the wire declares', () => {
        for (const kind of ['session_phase', 'clock_time', 'this_document', 'agenda_item']) {
            for (const phase of ['μετά την ψήφιση', 'εκτός ημερησίας', 'pre_agenda', null]) {
                const a = migratedAnchor(retired({ kind, phase }));
                // `this_document` is the extractor's own name for the wire's `subject`.
                expect([...WIRE_KINDS, 'this_document']).toContain(a.kind);
                expect(WIRE_PHASES).toContain(a.phase);
            }
        }
    });

    it('still fills the fields a reading written before they existed has no answer for', () => {
        const bare = { attendanceChanges: [] } as unknown as RawExtractedDecision;
        expect(withDefaults(bare)).toMatchObject({
            attendanceFormat: 'explicit_present_absent',
            compositionMembers: null,
            presidedBy: null,
            voteTally: { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null },
            decisionAttendance: null,
        });
    });
});

// --- extractDecisionFromPdf tests ---

describe('extractDecisionFromPdf', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it('returns extracted data from AI response', async () => {
        const mockResult = {
            presentMembers: ['Μέλος 1', 'Μέλος 2'],
            absentMembers: ['Μέλος 3'],
            decisionExcerpt: 'Αποφασίζεται ομόφωνα...',
            decisionNumber: '42/2025',
            references: '1. Ν.3852/2010\n2. Ν.4555/2018',
            voteResult: 'Ομόφωνα',
            voteDetails: [],
            incomplete: false,
        };

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        } as Response);

        mockAiChat.mockResolvedValueOnce({
            result: mockResult,
            usage: { input_tokens: 100, output_tokens: 50 },
        });

        const { result, usage } = await extractDecisionFromPdf('https://example.com/test-unique-extraction-url.pdf');

        expect(result).toMatchObject({ ...mockResult, attendanceChanges: [], presidedBy: null });
        expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
        expect(mockAiChat).toHaveBeenCalledOnce();
        expect(fetchSpy).toHaveBeenCalledWith('https://example.com/test-unique-extraction-url.pdf');

        fetchSpy.mockRestore();
    });

    it('turns the model\'s anchor into the change and its agenda-item projection', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) } as Response);
        mockAiChat.mockResolvedValueOnce({
            result: {
                attendanceFormat: 'explicit_present_absent', compositionMembers: null, presentMembers: ['Λυδία Βέρα'], absentMembers: [],
                mayorPresent: null, decisionExcerpt: 'x', decisionNumber: '304', references: '', voteResult: 'Ομόφωνα', voteDetails: [],
                attendanceChanges: [
                    { name: 'Λυδία Βέρα', type: 'departure', rawText: 'απεχώρησαν στην 286 ΑΚΣ',
                      anchor: { kind: 'decision_number', agendaItemIndex: 0, outOfAgenda: false, decisionNumber: '286', phase: 'none', timing: 'during' } },
                    { name: 'Π. Ζορμπά', type: 'departure', rawText: 'Πριν τη συζήτηση του 5ου θέματος',
                      anchor: { kind: 'agenda_item', agendaItemIndex: 5, outOfAgenda: false, decisionNumber: '', phase: 'none', timing: 'before' } },
                ],
                discussionOrder: null, subjectInfo: null, incomplete: false,
            },
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const { result } = await extractDecisionFromPdf('https://example.com/anchors.pdf');
        expect(result.attendanceChanges[0]).toMatchObject({ agendaItem: null, timing: null, anchor: { kind: 'decision_number', decisionNumber: '286', timing: 'during' } });
        expect(result.attendanceChanges[1]).toMatchObject({ agendaItem: { agendaItemIndex: 5, nonAgendaReason: null }, timing: 'during', anchor: { kind: 'agenda_item', timing: 'before' } });
        fetchSpy.mockRestore();
    });

    it('calls aiChat with the current model and structured output (no prefill)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
        } as Response);

        mockAiChat.mockResolvedValueOnce({
            result: {
                presentMembers: [],
                absentMembers: [],
                decisionExcerpt: '',
                decisionNumber: null,
                references: '',
                voteResult: null,
                voteDetails: [],
                incomplete: false,
            },
            usage: { input_tokens: 100, output_tokens: 50 },
        });

        await extractDecisionFromPdf('https://example.com/test-ai-params-url.pdf');

        expect(mockAiChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'claude-sonnet-4-6',
            outputFormat: expect.objectContaining({ type: 'json_schema' }),
        }));
        // Assistant prefill is rejected by Claude 4.6+ models
        expect(mockAiChat.mock.calls[0][0].prefillSystemResponse).toBeUndefined();
        expect(mockAiChat.mock.calls[0][0].documentBase64).toBeDefined();
        expect(mockAiChat.mock.calls[0][0].systemPrompt).toContain('ΠΑΡΟΝΤΕΣ');

        fetchSpy.mockRestore();
    });

    const partial = (over: Record<string, unknown>) => ({
        result: { presentMembers: ['Μέλος 1'], absentMembers: [], decisionExcerpt: '', decisionNumber: null,
                  references: '', voteResult: null, voteDetails: [], attendanceChanges: [], incomplete: true, ...over },
        usage: { input_tokens: 10, output_tokens: 5 },
    });
    const mockFetch = () => vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    } as Response);

    it('reads the pages between the front slice and the end of a 17-page document', async () => {
        mockGetPageCount.mockReturnValue(17);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({}))   // pages 1-10
            .mockResolvedValueOnce(partial({}))   // pages 1-15
            .mockResolvedValueOnce(partial({ decisionExcerpt: 'Αποφασίζει με 16 θετικές ψήφους', voteResult: 'Με δεκαέξι (16) θετικές ψήφους', incomplete: false }));

        const { result } = await extractDecisionFromPdf('https://example.com/seventeen-pages.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(4);
        expect(mockAiChat.mock.calls[3][0].userPrompt).toContain('pages 16-17 of a 17-page document');
        expect(result.voteResult).toBe('Με δεκαέξι (16) θετικές ψήφους');
        expect(result.presentMembers).toEqual(['Μέλος 1']); // attendance kept from the front pages
        expect(result.incomplete).toBe(false);
        fetchSpy.mockRestore();
    });

    it('keeps the preamble facts from the front read when the decision comes from the tail', async () => {
        mockGetPageCount.mockReturnValue(17);
        const fetchSpy = mockFetch();
        const frontPass = {
            result: {
                attendanceFormat: 'composition_and_absent', compositionMembers: ['Μέλος 1', 'Μέλος 2'],
                presentMembers: null, absentMembers: [], mayorPresent: null,
                presidedBy: { name: 'Αντιπρόεδρος Α', rawText: 'Προήδρευσε ο Αντιπρόεδρος Α' },
                decisionAttendance: { present: [], rawText: '' },
                voteTally: { FOR: -1, AGAINST: -1, ABSTAIN: -1, PRESENT: -1, DID_NOT_VOTE: -1 },
                decisionExcerpt: '', decisionNumber: null, references: '', voteResult: null,
                voteDetails: [], attendanceChanges: [], discussionOrder: null, subjectInfo: null, incomplete: true,
            },
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const tailPass = {
            result: {
                // The tail window prints no roll call and no presiding sentence.
                attendanceFormat: 'explicit_present_absent', compositionMembers: null,
                presentMembers: [], absentMembers: [], mayorPresent: null,
                presidedBy: { name: '', rawText: '' },
                decisionAttendance: { present: ['Μέλος 1'], rawText: 'ΤΑ ΜΕΛΗ: Μέλος 1' },
                voteTally: { FOR: 16, AGAINST: 2, ABSTAIN: -1, PRESENT: -1, DID_NOT_VOTE: -1 },
                decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ κατά πλειοψηφία', decisionNumber: '42/2025', references: '',
                voteResult: 'Κατά πλειοψηφία', voteDetails: [], attendanceChanges: [],
                discussionOrder: null, subjectInfo: null, incomplete: false,
            },
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        mockAiChat
            .mockResolvedValueOnce(frontPass)   // pages 1-5
            .mockResolvedValueOnce(frontPass)   // pages 1-10
            .mockResolvedValueOnce(frontPass)   // pages 1-15
            .mockResolvedValueOnce(tailPass);   // pages 16-17

        const { result } = await extractDecisionFromPdf('https://example.com/tail-merge-preamble.pdf');

        // Preamble facts: whatever the front read saw.
        expect(result.attendanceFormat).toBe('composition_and_absent');
        expect(result.compositionMembers).toEqual(['Μέλος 1', 'Μέλος 2']);
        expect(result.presidedBy).toEqual({ name: 'Αντιπρόεδρος Α', rawText: 'Προήδρευσε ο Αντιπρόεδρος Α' });
        expect(result.presentMembers).toEqual(['Μέλος 1', 'Μέλος 2']);
        // Decision facts: whatever the tail read saw.
        expect(result.voteTally).toMatchObject({ FOR: 16, AGAINST: 2, ABSTAIN: null });
        expect(result.decisionAttendance).toEqual({ present: ['Μέλος 1'], rawText: 'ΤΑ ΜΕΛΗ: Μέλος 1' });
        expect(result.decisionNumber).toBe('42/2025');
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('does not accept a pass that claims completion with an empty excerpt', async () => {
        mockGetPageCount.mockReturnValue(20);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({ incomplete: false }))   // pages 1-5: "complete", no text
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'Αποφασίζει ομόφωνα', voteResult: 'Ομόφωνα' }));

        const { result } = await extractDecisionFromPdf('https://example.com/false-complete.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(2);
        expect(result.decisionExcerpt).toBe('Αποφασίζει ομόφωνα');
        fetchSpy.mockRestore();
    });

    it('uses progressive extraction for large PDFs', async () => {
        mockGetPageCount.mockReturnValue(20); // Large PDF

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        } as Response);

        // First call: incomplete
        mockAiChat.mockResolvedValueOnce({
            result: {
                presentMembers: ['Μέλος 1'],
                absentMembers: [],
                decisionExcerpt: '',
                decisionNumber: null,
                references: '',
                voteResult: null,
                voteDetails: [],
                incomplete: true,
            },
            usage: { input_tokens: 50, output_tokens: 25 },
        });

        // Second call: complete
        mockAiChat.mockResolvedValueOnce({
            result: {
                presentMembers: ['Μέλος 1'],
                absentMembers: [],
                decisionExcerpt: 'Αποφασίζεται...',
                decisionNumber: '1/2025',
                references: '',
                voteResult: 'Ομόφωνα',
                voteDetails: [],
                incomplete: false,
            },
            usage: { input_tokens: 80, output_tokens: 40 },
        });

        const { result, usage } = await extractDecisionFromPdf('https://example.com/test-progressive-url.pdf');

        expect(result.incomplete).toBe(false);
        expect(result.decisionExcerpt).toBe('Αποφασίζεται...');
        expect(mockAiChat).toHaveBeenCalledTimes(2);
        // Usage should be aggregated
        expect(usage.input_tokens).toBe(130);
        expect(usage.output_tokens).toBe(65);

        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3); // Reset
    });
});

describe('adoptLaterVoteNames', () => {
    const base = { attendanceFormat: 'explicit_present_absent' as const, compositionMembers: null, presentMembers: [], absentMembers: [], mayorPresent: null, decisionExcerpt: 'x',
        decisionNumber: null, references: '', attendanceChanges: [], discussionOrder: null, subjectInfo: null, incomplete: false, presidedBy: null, decisionAttendance: null };
    const tally = (FOR: number | null) => ({ FOR, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null });
    const names = (n: number, vote: 'FOR' | 'PRESENT') => Array.from({ length: n }, (_, i) => ({ name: `${vote} ${i}`, vote }));
    it('adopts the names of a later window whose ΥΠΕΡ count equals the printed one', () => {
        const winner = { ...base, voteResult: 'Με δεκαεννέα (19) θετικές ψήφους', voteTally: tally(19), voteDetails: [] };
        const later = { ...base, voteResult: null, voteTally: tally(null), voteDetails: [...names(19, 'FOR'), ...names(8, 'PRESENT')] };
        expect(adoptLaterVoteNames(winner, [later]).voteDetails).toHaveLength(27);
    });
    it('leaves an embedded decision of another body alone', () => {
        const winner = { ...base, voteResult: 'Με δεκαεννέα (19) θετικές ψήφους', voteTally: tally(19), voteDetails: [] };
        const committee = { ...base, voteResult: 'Με πέντε (5) θετικές ψήφους', voteTally: tally(5), voteDetails: [...names(5, 'FOR'), ...names(2, 'PRESENT')] };
        expect(adoptLaterVoteNames(winner, [committee])).toBe(winner);
    });
    it('does nothing when the decision window already names voters or printed no count', () => {
        const named = { ...base, voteResult: 'Ομόφωνα', voteTally: tally(null), voteDetails: names(3, 'FOR') };
        expect(adoptLaterVoteNames(named, [{ ...base, voteResult: null, voteTally: tally(null), voteDetails: names(3, 'FOR') }])).toBe(named);
    });
});


describe('normalizeGreekName, Latin homoglyphs', () => {
    // «Αγρoγιάννη-Μουκριώτου» is printed with a Latin o in the roll call of
    // ΡΟΨΘΩ6Μ-2Υ8 and with a Greek omicron elsewhere on the same page.
    it('folds a Latin o inside a Greek word', () => {
        expect(normalizeGreekName('Αγρoγιάννη-Μουκριώτου')).toBe(normalizeGreekName('Αγρογιάννη-Μουκριώτου'));
    });

    it('matches a person whose name a document spells with a homoglyph', () => {
        const people = [{ id: 'p1', name: 'Ζαχαρία Αγρογιάννη-Μουκριώτου' }];
        expect(matchMembersToPersonIds(['Αγρoγιάννη-Μουκριώτου Ζαχαρία'], people).matchedIds).toEqual(['p1']);
    });

    it('leaves a name with no homoglyphs alone', () => {
        expect(normalizeGreekName('Γεώργιος Βουλγαράκης')).toBe('γεωργιος βουλγαρακης');
    });
});
