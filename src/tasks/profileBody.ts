/**
 * Profile one administrative body's decision conventions from its own documents.
 *
 * Extraction reads a document assuming it knows what a list called "present"
 * means. It does not: two bodies print that heading and mean different things.
 * This task answers the question per body — sample its Diavgeia documents,
 * record what each one states, aggregate, and derive the conventions record the
 * rest of the pipeline reads. It is the survey that produced today's stored
 * conventions, packaged so a body nobody surveyed can be profiled on its own.
 */
import { Diavgeia } from '@schemalabs/diavgeia-cli';
import type { Decision } from '@schemalabs/diavgeia-cli';
import { ProfileBodyRequest, ProfileBodyResult } from '../types.js';
import { Task } from './pipeline.js';
import { addUsage, NO_USAGE, toTaskTokenUsage } from '../lib/ai.js';
import { buildBodyFactProfile } from './utils/bodyFactProfile.js';
import { conventionsFromProfile } from './utils/conventionsFromProfile.js';
import { observeDocument, DOCUMENT_CACHE_DIR, OBSERVATION_MODEL } from './utils/observeDocument.js';
import { parseDiavgeiaUnitScopes, formatDiavgeiaUnitScope } from './utils/diavgeiaUnitScope.js';
import type { DocumentObservation } from './utils/documentObservation.js';
// The sample spreads across what the fetch returned, not across the whole date
// window: the search is capped (see `fetchCeiling`), so a body publishing more
// than the cap is sampled across its most recent documents.
import { thinToSample } from './utils/evenSample.js';

const DEFAULT_SAMPLE_SIZE = 40;
const DEFAULT_FROM_DATE = '2024-01-01';
/** Documents read at once. Above this, Diavgeia and the API both start refusing. */
const READ_CONCURRENCY = 4;

export const profileBody: Task<ProfileBodyRequest, ProfileBodyResult> = async (request, onProgress) => {
    const sampleSize = request.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    const fromDate = request.fromDate ?? DEFAULT_FROM_DATE;
    const toDate = new Date().toISOString().slice(0, 10);
    const scopes = parseDiavgeiaUnitScopes(request.diavgeiaUnitIds);

    console.log(`Profiling ${request.cityId}/${request.administrativeBodyId}:`, {
        diavgeiaUid: request.diavgeiaUid,
        scopes: scopes.map(formatDiavgeiaUnitScope),
        sampleSize, fromDate, toDate,
    });

    onProgress('listing documents', 5);

    // Search Diavgeia directly rather than reading the decisions we already
    // hold: a body worth profiling is typically one we hold little of.
    const client = new Diavgeia();
    const seen = new Set<string>();
    const found: Decision[] = [];
    // Over-fetch, then thin — stopping at sampleSize would take one contiguous
    // run of documents rather than a spread. Each scope gets its own share of
    // the ceiling: a body configured as `unit:signerA` + `unit:signerB` must not
    // be profiled from one signer's documents alone.
    const fetchCeiling = sampleSize * 3;
    const scopeCeiling = Math.ceil(fetchCeiling / scopes.length);
    for (const [i, scope] of scopes.entries()) {
        const target = Math.min(fetchCeiling, scopeCeiling * (i + 1));
        if (found.length >= target) continue;
        for await (const d of client.searchAll({
            org: request.diavgeiaUid,
            unit: scope.unit,
            signer: scope.signer,
            from_issue_date: fromDate,
            to_issue_date: toDate,
            status: 'PUBLISHED',
            // The order is a decision, not whatever the API defaults to: the
            // stride below spreads across whatever this returns.
            sort: 'recent',
        })) {
            if (seen.has(d.ada)) continue;
            seen.add(d.ada);
            found.push(d);
            if (found.length >= target) break;
        }
    }

    const sample = thinToSample(found, sampleSize);
    if (sample.length === 0) {
        throw new Error(`No documents found on Diavgeia for org ${request.diavgeiaUid}, scopes ${scopes.map(formatDiavgeiaUnitScope).join(', ')} between ${fromDate} and ${toDate}`);
    }
    console.log(`Found ${found.length} documents, reading ${sample.length}`);

    onProgress(`reading ${sample.length} documents`, 10);

    const observations: DocumentObservation[] = [];
    const adas: string[] = [];
    let usage = { ...NO_USAGE };
    let cursor = 0;
    let done = 0;
    const failures: string[] = [];

    const worker = async () => {
        while (cursor < sample.length) {
            const d = sample[cursor++];
            try {
                const observed = await observeDocument(d.ada, {
                    model: OBSERVATION_MODEL,
                    cacheDir: DOCUMENT_CACHE_DIR,
                    skipCache: request.skipCache,
                });
                usage = addUsage(usage, observed.usage);
                observations.push(observed.observation);
                adas.push(d.ada);
            } catch (e) {
                // One unreadable document is not a failed profile: the aggregate
                // is a frequency over whatever could be read, and it reports how
                // many that was.
                failures.push(`${d.ada}: ${e instanceof Error ? e.message : e}`);
                console.warn(`  ${d.ada}: ${e instanceof Error ? e.message : e}`);
            }
            done++;
            // Also the cancellation checkpoint — a profile is dozens of model
            // calls and has to be stoppable between them.
            onProgress(`read ${done}/${sample.length} documents`, 10 + Math.round((done / sample.length) * 85));
        }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, sample.length) }, worker));

    if (observations.length === 0) {
        throw new Error(`Could not read any of the ${sample.length} sampled documents: ${failures.slice(0, 3).join('; ')}`);
    }

    onProgress('deriving conventions', 97);
    const facts = buildBodyFactProfile(observations);
    // documentsSampled is how many documents were drawn, not how many turned out
    // to be deliberative decisions — the CLI prints that distinction separately.
    const conventions = conventionsFromProfile(facts, sample.length, toDate);
    console.log(`Profiled ${request.cityId}/${request.administrativeBodyId}: ${conventions.rollCallLayout}, present=${conventions.presentListMeaning}, anchors=${conventions.attendanceChangeAnchors.join('|') || '-'}, substitutes=${conventions.usesSubstitutes}, voters=${conventions.namedVoters}${failures.length ? `, ${failures.length} unreadable` : ''}`);

    onProgress('complete', 100);
    return {
        conventions,
        facts,
        adas,
        usage: toTaskTokenUsage(usage),
    };
};
