import { AttendanceChange, AttendanceAnchor, RawExtractedDecision, changeAnchor } from './decisionPdfExtraction.js';
import type { AttendanceEvent } from '../../types.js';

/**
 * Resolve and deduplicate attendance changes from multiple PDF extractions.
 *
 * Every decision PDF from a meeting contains the same attendance preamble,
 * but the LLM may extract it with slight differences:
 * - Name variants: abbreviated ("Κ. Αγγελής") vs full ("ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ")
 * - Timing disagreements: "during" vs "after" vs null for the same event
 * - Different rawText formatting
 *
 * This function:
 * 1. Resolves names to canonical initial-list forms using nameToPersonId
 * 2. Groups identical changes (same person + type + agendaItem)
 * 3. Picks timing by majority vote — the most common timing across PDFs wins
 *
 * @param extractions - Raw extractions from all PDFs
 * @param nameToPersonId - Name → personId mapping from the matching phase
 * @param initialNames - All names from the initial roll call (present + absent)
 */
export interface AttendanceChangeWithAgreement extends AttendanceChange {
    /** How many PDFs reported this change */
    reportingPdfCount: number;
    /** Total PDFs that were extracted */
    totalPdfCount: number;
}

export function resolveAndDeduplicateAttendanceChanges(
    extractions: Array<{ raw: Pick<RawExtractedDecision, 'attendanceChanges'> }>,
    nameToPersonId: Map<string, string>,
    initialNames: string[],
): AttendanceChangeWithAgreement[] {
    const totalPdfCount = extractions.length;

    // Build personId → canonical initial-list name mapping
    const personIdToInitialName = new Map<string, string>();
    for (const name of initialNames) {
        const id = nameToPersonId.get(name);
        if (id && !personIdToInitialName.has(id)) {
            personIdToInitialName.set(id, name);
        }
    }

    // Group changes by resolved identity (person + type + agendaItem),
    // collecting timing votes from each PDF
    const groups = new Map<string, {
        change: AttendanceChange;
        timingVotes: Map<string, number>; // timing value → count
        reportingPdfCount: number; // how many PDFs reported this change at all
    }>();

    for (const { raw } of extractions) {
        for (const change of raw.attendanceChanges || []) {
            // A per-vote absence and a change pinned to the document's own subject belong
            // to the document that states them, not to the session.
            if (change.type === 'absent_for_vote' || changeAnchor(change).kind === 'this_document') continue;
            // Resolve name to canonical initial-list form
            const personId = nameToPersonId.get(change.name);
            const canonicalName = personId ? personIdToInitialName.get(personId) : null;
            const resolvedName = canonicalName ?? change.name;

            // Group by who the person is, not by how the name is spelled: with no
            // roll call to lend a canonical spelling, two documents spelling one
            // member differently would each count once and both miss the majority.
            const identity = personId ?? resolvedName;

            // Group key: person + type + anchor (ignoring timing)
            const anchor = changeAnchor(change);
            const agendaKey = anchor.kind === 'agenda_item' && change.agendaItem
                ? `${change.agendaItem.agendaItemIndex}:${change.agendaItem.nonAgendaReason ?? ''}`
                : anchor.kind === 'decision_number' ? `decision:${anchor.decisionNumber}`
                : anchor.kind === 'phase' ? `phase:${anchor.phase}`
                : 'session';
            const key = `${identity}|${change.type}|${agendaKey}`;

            const group = groups.get(key);
            const timingKey = change.timing ?? 'null';

            if (!group) {
                groups.set(key, {
                    change: { ...change, name: resolvedName },
                    timingVotes: new Map([[timingKey, 1]]),
                    reportingPdfCount: 1,
                });
            } else {
                group.timingVotes.set(timingKey, (group.timingVotes.get(timingKey) ?? 0) + 1);
                group.reportingPdfCount++;
            }
        }
    }

    // Build final list — only include changes with sufficient agreement.
    // A change reported by a single PDF when multiple were extracted is likely
    // a hallucination. Require >50% of PDFs to report the change.
    // Exception: when only 1-2 PDFs were extracted, require all to agree.
    const result: AttendanceChangeWithAgreement[] = [];
    for (const { change, timingVotes, reportingPdfCount } of groups.values()) {
        // Consensus check: change must be reported by majority of PDFs
        if (reportingPdfCount <= totalPdfCount / 2) {
            continue; // Not enough agreement — skip this change
        }

        // Pick timing with most votes; on tie, prefer specified over null
        let bestTiming: 'during' | 'after' | null = null;
        let bestCount = 0;
        for (const [timing, count] of timingVotes) {
            // Prefer 'during' over 'after' on a tie (conservative: person was absent).
            // Prefer any non-null timing over null on a tie.
            const betterThanCurrent =
                count > bestCount ||
                (count === bestCount && timing !== 'null' && (bestTiming == null || timing === 'during'));
            if (betterThanCurrent) {
                bestTiming = timing === 'null' ? null : timing as 'during' | 'after';
                bestCount = count;
            }
        }
        result.push({ ...change, timing: bestTiming, reportingPdfCount, totalPdfCount });
    }

    return result;
}

/** The anchor as the wire carries it; «this document» becomes the document's own subject. */
export function wireAnchor(a: AttendanceAnchor, subjectId: string): AttendanceEvent['anchor'] {
    const kind = a.kind === 'this_document' ? 'subject' : a.kind;
    return {
        kind,
        agendaItemIndex: a.agendaItem?.agendaItemIndex ?? null,
        nonAgendaReason: a.agendaItem?.nonAgendaReason ?? null,
        decisionNumber: a.decisionNumber,
        subjectId: kind === 'subject' ? subjectId : null,
        phase: a.phase,
        timing: a.timing,
    };
}

/**
 * The changes one document states, on the wire. A per-vote absence becomes a
 * departure before and an arrival after the document's own subject; «this
 * document» anchors become that subject.
 */
export function toDocumentEvents(changes: AttendanceChange[], subjectId: string, resolve: (name: string) => string | null): AttendanceEvent[] {
    const out: AttendanceEvent[] = [];
    for (const c of changes) {
        const a = changeAnchor(c);
        const base = { personId: resolve(c.name), name: c.name, rawText: c.rawText, reportingPdfCount: 1, totalPdfCount: 1 };
        if (c.type === 'absent_for_vote') {
            const subject = wireAnchor({ ...a, kind: 'this_document' }, subjectId);
            out.push({ ...base, type: 'departure', anchor: { ...subject, timing: 'before' } });
            out.push({ ...base, type: 'arrival', anchor: { ...subject, timing: 'after' } });
        } else {
            out.push({ ...base, type: c.type, anchor: wireAnchor(a, subjectId) });
        }
    }
    return out;
}
