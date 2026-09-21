import Anthropic from '@anthropic-ai/sdk';
import { addUsage, NO_USAGE } from '../../lib/ai.js';
import { ExtractedDecisionResult } from '../../types.js';
import {
    extractDecisionFromPdf,
    RawExtractedDecision,
    matchPersonByName,
    llmMatchMembers,
    normalizeGreekName,
    changeAnchor,
    PersonForMatching,
} from './decisionPdfExtraction.js';
import type { AttendanceEvent } from '../../types.js';
import { resolveAndDeduplicateAttendanceChanges, toDocumentEvents, wireAnchor } from './meetingAttendance.js';
import { selectRollCall } from './rollCallVote.js';
import { validateRawExtraction, validateProcessedDecision } from './decisionValidation.js';

export interface ExtractionSubject {
    subjectId: string;
    name: string;
    agendaItemIndex: number | null;
    decision: {
        pdfUrl: string;
        ada: string | null;
        protocolNumber: string | null;
    };
}

export interface ExtractionPipelineResult {
    decisions: ExtractedDecisionResult[];
    warnings: string[];
    usage: Anthropic.Messages.Usage;
    /** Initial roll call — who was present/absent at session start (meeting-level, not per-subject) */
    initialAttendance: { personId: string; status: 'PRESENT' | 'ABSENT' }[];
    /** Names from the initial roll call that couldn't be matched to any person in the database */
    unmatchedInitialAttendance: string[];
    /** The session's stated arrivals and departures, resolved across PDFs, with their anchors. */
    attendanceEvents: AttendanceEvent[];
}

const BATCH_SIZE = 5;

/**
 * Extract structured decision data from PDFs.
 *
 * Returns what each document states, never what follows from it: the roll call
 * a majority of the meeting's documents agree on, the arrivals and departures
 * with the anchor each was printed against, and the voters a page names, with
 * names resolved to person ids. Replaying presence across subjects and
 * inferring a FOR for everyone the page did not name both happen in the app,
 * over stored rows, so they can be re-run and explained without re-reading.
 *
 * @param subjects - Subjects with linked decisions (have PDF URLs)
 * @param allMeetingSubjects - ALL subjects in the meeting (for discussion order + non-decision attendance)
 * @param people - People for name matching
 */
export async function extractDecisionsFromPdfs(
    subjects: ExtractionSubject[],
    people: PersonForMatching[],
    onProgress: (stage: string, percent: number) => void,
    mayorId?: string,
    skipCache?: boolean,
    /** The body's conventions as sentences for the prompt (rendered by opencouncil from its glossary). */
    hints?: string | null,
): Promise<ExtractionPipelineResult> {
    const taskStart = Date.now();
    const warnings: string[] = [];
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };

    const mayorName = mayorId
        ? people.find(p => p.id === mayorId)?.name
        : undefined;

    console.log(`\n--- extractDecisionsFromPdfs ---`);
    console.log(`Subjects with decisions: ${subjects.length}`);
    console.log(`People for matching: ${people.length}`);
    if (mayorName) console.log(`Mayor: ${mayorName} (${mayorId})`);

    if (subjects.length === 0) {
        return { decisions: [], warnings: [], usage: totalUsage, initialAttendance: [], unmatchedInitialAttendance: [], attendanceEvents: [] };
    }

    // --- Phase 1: Extract all PDFs (batched for concurrency) ---
    const extractions: { subjectId: string; agendaItemIndex: number | null; raw: RawExtractedDecision; usage: Anthropic.Messages.Usage; fromCache: boolean }[] = [];
    let completed = 0;

    for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
        const batch = subjects.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
            batch.map(async (subject, batchIdx) => {
                const idx = i + batchIdx;
                const pdfUrl = subject.decision.pdfUrl;
                console.log(`\n[PDF ${idx + 1}/${subjects.length}] Subject: "${subject.name}"`);
                console.log(`  URL: ${pdfUrl}`);

                const pdfStart = Date.now();
                const { result: raw, usage: pdfUsage, fromCache } = await extractDecisionFromPdf(pdfUrl, mayorName, skipCache, hints ?? undefined);
                const elapsed = ((Date.now() - pdfStart) / 1000).toFixed(1);

                console.log(`  Excerpt: ${raw.decisionExcerpt?.length ?? 0} chars`);
                console.log(`  Vote: ${raw.voteResult ?? '(none)'}`);
                console.log(`  Present: ${raw.presentMembers?.length ?? 0}, Absent: ${raw.absentMembers?.length ?? 0}`);
                console.log(`  SubjectInfo: ${raw.subjectInfo ? `#${raw.subjectInfo.agendaItemIndex}${raw.subjectInfo.nonAgendaReason ? ' (out-of-agenda)' : ''}` : '(none)'}`);
                if (fromCache) console.log(`  (from cache)`);
                console.log(`  Done in ${elapsed}s`);

                return { subjectId: subject.subjectId, agendaItemIndex: subject.agendaItemIndex, raw, usage: pdfUsage, fromCache };
            })
        );

        for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            if (result.status === 'fulfilled') {
                extractions.push(result.value);
                totalUsage = addUsage(totalUsage, result.value.usage);
            } else {
                const subject = batch[j];
                const msg = result.reason instanceof Error ? result.reason.message : 'Unknown error';
                console.error(`  [PDF ${i + j + 1}] FAILED for "${subject.name}" (${subject.decision.pdfUrl}): ${msg}`);
                warnings.push(`Failed to extract data from decision PDF for "${subject.name}" (${subject.decision.pdfUrl}): ${msg}`);
            }
        }

        completed += batch.length;
        const progressPercent = (completed / subjects.length) * 100;
        onProgress(`extracted ${completed}/${subjects.length} PDFs`, progressPercent);
    }

    // --- Phase 2: Meeting-level name matching ---
    onProgress('matching members', 100);

    // Collect all unique raw names across all decisions + attendance changes
    const allRawNames = new Set<string>();
    for (const { raw } of extractions) {
        for (const name of raw.presentMembers || []) allRawNames.add(name);
        for (const name of raw.absentMembers || []) allRawNames.add(name);
        for (const detail of raw.voteDetails || []) allRawNames.add(detail.name);
        for (const change of raw.attendanceChanges || []) allRawNames.add(change.name);
        for (const name of raw.decisionAttendance?.present ?? []) allRawNames.add(name);
        if (raw.presidedBy?.name) allRawNames.add(raw.presidedBy.name);
    }

    // Step 1: Token-sort matching — build name→personId map
    const nameToPersonId = new Map<string, string>();
    for (const rawName of allRawNames) {
        const personId = matchPersonByName(rawName, people);
        if (personId) {
            nameToPersonId.set(rawName, personId);
        }
    }
    const step1Unmatched = [...allRawNames].filter(n => !nameToPersonId.has(n));

    console.log(`\n--- Meeting-level matching ---`);
    console.log(`  Unique names: ${allRawNames.size}`);
    console.log(`  Token-sort matched: ${nameToPersonId.size}`);
    console.log(`  Remaining for LLM: ${step1Unmatched.length}`);

    // Step 2: LLM fallback for remaining unmatched
    if (step1Unmatched.length > 0) {
        try {
            const llmResult = await llmMatchMembers(step1Unmatched, people);
            totalUsage = addUsage(totalUsage, llmResult.usage);
            for (const { name, personId } of llmResult.matched) {
                nameToPersonId.set(name, personId);
            }
            console.log(`  LLM matched: ${llmResult.matched.length}`);
            console.log(`  Still unmatched: ${llmResult.stillUnmatched.length}`);
            if (llmResult.stillUnmatched.length > 0) {
                console.log(`  Unmatched names: ${llmResult.stillUnmatched.join(', ')}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.warn(`  LLM matching failed: ${msg}`);
            warnings.push(`LLM name matching failed: ${msg}`);
        }
    }

    console.log(`  Final matched: ${nameToPersonId.size}/${allRawNames.size}`);

    // --- Select initial roll call by majority vote across all PDFs ---
    // All PDFs from the same meeting should have the same attendance preamble,
    // but extraction errors or a PDF from a different session can produce outliers.
    // Majority vote ensures one wrong PDF doesn't poison the entire meeting's attendance.
    const rollCallVote = selectRollCall(extractions.map(({ raw }) => ({
        presentMembers: raw.presentMembers,
        absentMembers: raw.absentMembers,
        mayorPresent: raw.mayorPresent,
    })), (name) => nameToPersonId.get(name) ?? normalizeGreekName(name));
    const winningRollCall = rollCallVote.selected;

    if (rollCallVote.breakdown.length > 1) {
        console.log(`  Roll call vote: ${rollCallVote.breakdown[0].count}/${rollCallVote.totalPdfs - rollCallVote.emptyCount} PDFs agree (${rollCallVote.breakdown.length} distinct roll calls found)`);
        for (const { entry, count } of rollCallVote.breakdown) {
            console.log(`    ${count}× ${entry.presentMembers.length}p/${entry.absentMembers.length}a, mayor ${entry.mayorPresent?.present ? 'present' : 'absent'}`);
        }
    }

    // --- Aggregate meeting-level attendance data from all PDFs ---
    // Attendance changes are resolved with majority voting (resolveAndDeduplicateAttendanceChanges).
    const attendanceEvents: AttendanceEvent[] = [];
    // The roll call only lends its spelling to the names; the changes are resolved
    // by their own majority. A session whose roll calls split still states them.
    const allInitialNames = winningRollCall ? [...winningRollCall.presentMembers, ...winningRollCall.absentMembers] : [];
    const aggregatedChanges = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, allInitialNames);
    // Session-level changes never carry a subject: only a `subject` anchor does,
    // and those are emitted per document by toDocumentEvents below.
    for (const change of aggregatedChanges) {
        if (change.type === 'absent_for_vote') continue;
        attendanceEvents.push({
            personId: nameToPersonId.get(change.name) ?? null,
            name: change.name,
            type: change.type,
            anchor: wireAnchor(changeAnchor(change), ''),
            rawText: change.rawText,
            reportingPdfCount: change.reportingPdfCount,
            totalPdfCount: change.totalPdfCount,
        });
    }

    // Log attendance changes after resolution
    if (aggregatedChanges.length > 0) {
        console.log(`  Attendance changes (${aggregatedChanges.length} after resolution/dedup, majority threshold >50% of ${extractions.length} PDFs):`);
        for (const change of aggregatedChanges) {
            const personId = nameToPersonId.get(change.name);
            const status = personId ? '✓' : '✗ unmatched';
            const agendaLabel = change.agendaItem
                ? `${change.timing} ${change.agendaItem.nonAgendaReason === 'outOfAgenda' ? 'OA' : '#'}${change.agendaItem.agendaItemIndex}`
                : 'session';
            console.log(`    ${change.type} "${change.name}" ${agendaLabel} ${status} (${change.reportingPdfCount}/${change.totalPdfCount} PDFs)`);
        }
    }

    // --- Build meeting-level initial attendance from majority-voted roll call ---
    const initialAttendance: ExtractionPipelineResult['initialAttendance'] = [];
    const unmatchedInitialAttendance: string[] = [];
    if (winningRollCall) {
        for (const name of winningRollCall.presentMembers) {
            const personId = nameToPersonId.get(name);
            if (personId) initialAttendance.push({ personId, status: 'PRESENT' });
            else unmatchedInitialAttendance.push(name);
        }
        for (const name of winningRollCall.absentMembers) {
            const personId = nameToPersonId.get(name);
            if (personId) initialAttendance.push({ personId, status: 'ABSENT' });
            else unmatchedInitialAttendance.push(name);
        }
        // Include mayor if extracted from decision narrative
        let mayorAdded = false;
        if (winningRollCall.mayorPresent?.present != null && mayorId) {
            if (!initialAttendance.some(a => a.personId === mayorId)) {
                initialAttendance.push({ personId: mayorId, status: winningRollCall.mayorPresent.present ? 'PRESENT' : 'ABSENT' });
                mayorAdded = true;
            }
        }

        // Deduplicate by personId. When the same person appears in both present
        // and absent (e.g., truncated name in absent list matched to same personId
        // as the full name in composition), ABSENT wins — explicit absence is a
        // stronger signal than presence inferred from composition membership.
        const attendanceByPersonId = new Map<string, 'PRESENT' | 'ABSENT'>();
        for (const a of initialAttendance) {
            const existing = attendanceByPersonId.get(a.personId);
            if (!existing || a.status === 'ABSENT') {
                attendanceByPersonId.set(a.personId, a.status);
            }
        }
        const deduplicatedCount = initialAttendance.length - attendanceByPersonId.size;
        initialAttendance.length = 0;
        for (const [personId, status] of attendanceByPersonId) {
            initialAttendance.push({ personId, status });
        }

        const presentCount = initialAttendance.filter(a => a.status === 'PRESENT').length;
        const absentCount = initialAttendance.filter(a => a.status === 'ABSENT').length;
        const totalExtracted = winningRollCall.presentMembers.length + winningRollCall.absentMembers.length;
        const matchedCount = presentCount + absentCount;
        const mayorNote = mayorAdded ? ' (includes mayor from narrative)' : '';
        const dedupNote = deduplicatedCount > 0 ? ` (${deduplicatedCount} duplicate${deduplicatedCount > 1 ? 's' : ''} resolved)` : '';
        console.log(`  Initial attendance: ${presentCount} present, ${absentCount} absent — ${matchedCount} matched from ${totalExtracted} extracted${mayorNote}${dedupNote}`);
        if (unmatchedInitialAttendance.length > 0) {
            console.warn(`  ⚠ ${unmatchedInitialAttendance.length} unmatched members in initial roll call:`);
            for (const name of unmatchedInitialAttendance) {
                console.warn(`    - "${name}"`);
            }
        }
    }

    // --- Phase 4: Build decision results ---
    // What each document states, matched to ids. Replay of presence and FOR
    // inference happen in the app, over stored rows.
    const decisions: ExtractedDecisionResult[] = [];
    const resolve = (name: string) => nameToPersonId.get(name) ?? null;
    const ids = (names: string[]) => [...new Set(names.map(resolve).filter((id): id is string => !!id))];

    for (const { subjectId, raw, fromCache } of extractions) {
        const namedOnPage = [...raw.presentMembers, ...raw.absentMembers, ...raw.voteDetails.map(v => v.name), ...raw.attendanceChanges.map(c => c.name), ...(raw.decisionAttendance?.present ?? []), ...(raw.presidedBy?.name ? [raw.presidedBy.name] : [])];
        const unmatchedMembers = [...new Set(namedOnPage.filter(n => !resolve(n)))];
        // A page that names the same councillor twice — once in the dissenting
        // list, once in a declaration line — states one vote, not two.
        const seenVoterIds = new Set<string>();
        const voteDetails = raw.voteDetails.flatMap(v => {
            const personId = resolve(v.name);
            if (!personId || seenVoterIds.has(personId)) return [];
            seenVoterIds.add(personId);
            return [{ personId, name: v.name, vote: v.vote }];
        });
        const attendanceChanges = toDocumentEvents(raw.attendanceChanges, subjectId, resolve);
        // Per-vote absences and «this document» changes are facts of this document alone; they join the session list unvoted.
        attendanceEvents.push(...attendanceChanges.filter(e => e.anchor.kind === 'subject'));
        const presidedBy = raw.presidedBy
            ? { name: raw.presidedBy.name, personId: resolve(raw.presidedBy.name) ?? matchPersonByName(raw.presidedBy.name, people), rawText: raw.presidedBy.rawText }
            : null;
        const warnings = [...validateRawExtraction(raw), ...validateProcessedDecision({ voteResult: raw.voteResult, voteDetails: voteDetails.map(v => ({ vote: v.vote })) })];

        decisions.push({
            subjectId,
            excerpt: raw.decisionExcerpt || '',
            references: raw.references || '',
            decisionNumber: raw.decisionNumber || null,
            subjectInfo: raw.subjectInfo
                ? { number: raw.subjectInfo.agendaItemIndex, isOutOfAgenda: raw.subjectInfo.nonAgendaReason !== null }
                : null,
            incomplete: raw.incomplete,
            rollCall: {
                layout: raw.attendanceFormat === 'composition_and_absent' ? 'composition_and_absent' : 'present_and_absent',
                composition: raw.compositionMembers ?? [],
                present: raw.presentMembers,
                absent: raw.absentMembers,
                presentIds: ids(raw.presentMembers),
                absentIds: ids(raw.absentMembers),
            },
            mayorPresent: raw.mayorPresent,
            presidedBy,
            decisionAttendance: raw.decisionAttendance ? { present: raw.decisionAttendance.present, presentIds: ids(raw.decisionAttendance.present), rawText: raw.decisionAttendance.rawText } : null,
            voteResult: raw.voteResult || null,
            voteTally: raw.voteTally,
            voteDetails,
            attendanceChanges,
            unmatchedMembers,
            fromCache,
            warnings,
        });

        console.log(`  [${subjectId}] ${raw.presentMembers.length} present, ${raw.absentMembers.length} absent as printed, ${voteDetails.length} named votes, ${attendanceChanges.length} changes`);
        if (unmatchedMembers.length > 0) {
            console.warn(`  ⚠ [${subjectId}] ${unmatchedMembers.length} unmatched members: ${unmatchedMembers.map(n => `"${n}"`).join(', ')}`);
        }
    }

    const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.log(`\n--- extractDecisionsFromPdfs DONE (${totalElapsed}s) ---`);
    console.log(`  Extracted: ${extractions.length}/${subjects.length}`);
    console.log(`  Warnings: ${warnings.length}`);

    return { decisions, warnings, usage: totalUsage, initialAttendance, unmatchedInitialAttendance, attendanceEvents };
}
