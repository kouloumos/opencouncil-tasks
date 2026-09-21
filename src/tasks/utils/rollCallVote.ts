/**
 * Majority vote for initial roll call across multiple PDFs.
 *
 * All PDFs from the same meeting should have the same initial attendance
 * preamble, but extraction errors or PDFs from a different session can
 * produce outliers. This selects the roll call reported by the majority.
 */

interface RollCallEntry {
    presentMembers: string[];
    absentMembers: string[];
    mayorPresent: { present: boolean; rawText: string } | null;
}

interface RollCallGroup {
    entry: RollCallEntry;
    count: number;
    /** Every mayor reading among the group's documents, stated or not. */
    mayorReadings: RollCallEntry['mayorPresent'][];
}

export interface RollCallVoteResult {
    /** The winning roll call, or null if no data or no majority */
    selected: RollCallEntry | null;
    breakdown: RollCallGroup[];
    /** Number of PDFs with no roll call data */
    emptyCount: number;
    totalPdfs: number;
}

/**
 * Serialize a roll call to a comparable key: the set of names, sorted, since
 * extraction order varies.
 *
 * The mayor is deliberately not part of it. On a committee the mayor chairs he
 * is printed inside the member list, and the reader reports that line as a
 * separate mayor fact on some documents and not on others. With the mayor in
 * the key, two documents agreeing on every member split one against one and
 * the meeting lost its roll call.
 */
function serializeRollCall(entry: RollCallEntry, resolve: (name: string) => string): string {
    const present = [...new Set(entry.presentMembers.map(resolve))].sort().join('|');
    const absent = [...new Set(entry.absentMembers.map(resolve))].sort().join('|');
    return `P:${present};;A:${absent}`;
}

/** The mayor's status by majority among the documents that state one; a tie states none. */
function majorityMayor(readings: RollCallEntry['mayorPresent'][]): RollCallEntry['mayorPresent'] {
    const stated = readings.filter((r): r is NonNullable<typeof r> => r != null);
    const present = stated.filter(r => r.present);
    const absent = stated.filter(r => !r.present);
    if (present.length === absent.length) return null;
    return present.length > absent.length ? present[0] : absent[0];
}

export function selectRollCall(
    extractions: Array<{
        presentMembers: string[] | null;
        absentMembers: string[] | null;
        mayorPresent: { present: boolean; rawText: string } | null;
    }>,
    /**
     * Two documents of one session spell a member differently («Παπαγεωργίου
     * Χρυσούλα» / «Χρυσούλα Παπαγεωργίου»); compared as strings they split
     * the vote and no roll call wins. Resolve names to the person first.
     */
    resolve: (name: string) => string = (name) => name,
): RollCallVoteResult {
    const totalPdfs = extractions.length;

    // Filter to PDFs that have roll call data
    const withRoll = extractions.filter(
        e => (e.presentMembers?.length ?? 0) > 0 || (e.absentMembers?.length ?? 0) > 0
    );
    const emptyCount = totalPdfs - withRoll.length;

    if (withRoll.length === 0) {
        return { selected: null, breakdown: [], emptyCount, totalPdfs };
    }

    // Group by serialized content
    const groups = new Map<string, RollCallGroup>();
    for (const e of withRoll) {
        const entry: RollCallEntry = {
            presentMembers: e.presentMembers || [],
            absentMembers: e.absentMembers || [],
            mayorPresent: e.mayorPresent,
        };
        const key = serializeRollCall(entry, resolve);
        const existing = groups.get(key);
        if (existing) {
            existing.count++;
            existing.mayorReadings.push(e.mayorPresent);
        } else {
            groups.set(key, { entry, count: 1, mayorReadings: [e.mayorPresent] });
        }
    }

    const breakdown = [...groups.values()].sort((a, b) => b.count - a.count);
    const best = breakdown[0];

    // Majority = >50% of PDFs with roll call data
    const selected = best.count > withRoll.length / 2
        ? { ...best.entry, mayorPresent: majorityMayor(best.mayorReadings) }
        : null;

    return { selected, breakdown, emptyCount, totalPdfs };
}
