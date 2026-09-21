import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSearchAll, mockObserveDocument, NO_USAGE_MOCK } = vi.hoisted(() => ({
    mockSearchAll: vi.fn(),
    mockObserveDocument: vi.fn(),
    NO_USAGE_MOCK: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));

vi.mock('@schemalabs/diavgeia-cli', () => ({
    Diavgeia: vi.fn(() => ({ searchAll: mockSearchAll })),
}));

vi.mock('./utils/observeDocument.js', () => ({
    observeDocument: mockObserveDocument,
    DOCUMENT_CACHE_DIR: '/tmp/test-document-cache',
    OBSERVATION_MODEL: 'test-model',
}));

vi.mock('../lib/ai.js', () => ({
    NO_USAGE: NO_USAGE_MOCK,
    addUsage: (a: Record<string, number>, b: Record<string, number>) => ({
        input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
        output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
        cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
        cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
    }),
}));

import { profileBody, thinToSample } from './profileBody.js';

describe('thinToSample', () => {
    const found = Array.from({ length: 10 }, (_, i) => i);

    it('takes the ends and a fixed stride between them', () => {
        expect(thinToSample(found, 3)).toEqual([0, 5, 9]);
    });

    it('returns everything when fewer were found than wanted', () => {
        expect(thinToSample([1, 2], 5)).toEqual([1, 2]);
    });

    it('returns everything when exactly as many were found as wanted', () => {
        expect(thinToSample(found, 10)).toEqual(found);
    });

    it('takes the oldest end when only one is wanted', () => {
        // `wanted - 1 || 1` guards the division; without it the stride is Infinity.
        expect(thinToSample(found, 1)).toEqual([0]);
    });

    it('takes nothing when nothing is wanted', () => {
        expect(thinToSample(found, 0)).toEqual([]);
    });
});

describe('profileBody scope budget', () => {
    const observation = {
        isDeliberativeDecision: true, rollCallForm: 'present_and_absent', attendanceChangePinnedTo: 'nothing',
        namedVoters: 'none', perVoteAbsenceStated: false, substitutesPresent: false, mayorPresenceStated: false,
        rollCallIsCumulative: null, discussionOrderStated: false, withdrawnItemsStated: false, correctedRepost: false,
    };

    beforeEach(() => {
        mockSearchAll.mockReset();
        mockObserveDocument.mockReset();
        mockObserveDocument.mockImplementation(async () => ({
            observation, pages: 2, usage: { ...NO_USAGE_MOCK }, fromCache: true,
        }));
    });

    /** A scope that can hand out `count` documents, prefixed so its scope is identifiable. */
    const scopeYielding = (prefix: string, count: number) => async function* () {
        for (let i = 0; i < count; i++) yield { ada: `${prefix}-${i}`, issueDate: 0 };
    };

    it('gives each configured scope its own share of the fetch budget', async () => {
        // The first signer alone could fill the whole ceiling (sampleSize * 3 = 12).
        mockSearchAll
            .mockImplementationOnce(scopeYielding('A', 50))
            .mockImplementationOnce(scopeYielding('B', 50));

        const result = await profileBody({
            cityId: 'athens', administrativeBodyId: 'body-1', diavgeiaUid: '6104',
            diavgeiaUnitIds: ['84655:signerA', '84655:signerB'], sampleSize: 4,
        } as Parameters<typeof profileBody>[0], () => { });

        expect(mockSearchAll).toHaveBeenCalledTimes(2);
        const fromB = result.adas.filter(a => a.startsWith('B-'));
        expect(fromB.length).toBeGreaterThan(0);
        expect(result.adas.filter(a => a.startsWith('A-')).length).toBeGreaterThan(0);
    });

    it('asks Diavgeia for an explicit order rather than taking its default', async () => {
        mockSearchAll.mockImplementationOnce(scopeYielding('A', 10));

        await profileBody({
            cityId: 'athens', administrativeBodyId: 'body-1', diavgeiaUid: '6104',
            diavgeiaUnitIds: ['84655'], sampleSize: 3,
        } as Parameters<typeof profileBody>[0], () => { });

        expect(mockSearchAll.mock.calls[0][0]).toMatchObject({ sort: 'recent' });
    });

    it('records how many documents were drawn, not how many read as decisions', async () => {
        mockSearchAll.mockImplementationOnce(scopeYielding('A', 10));
        // One of the four sampled documents is not a deliberative decision.
        mockObserveDocument
            .mockImplementationOnce(async () => ({ observation: { ...observation, isDeliberativeDecision: false }, pages: 1, usage: { ...NO_USAGE_MOCK }, fromCache: true }));

        const result = await profileBody({
            cityId: 'athens', administrativeBodyId: 'body-1', diavgeiaUid: '6104',
            diavgeiaUnitIds: ['84655'], sampleSize: 4,
        } as Parameters<typeof profileBody>[0], () => { });

        expect(result.conventions.provenance.documentsSampled).toBe(4);
        expect(result.facts.documents).toBe(3);
    });
});
