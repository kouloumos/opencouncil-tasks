import { addUsage, NO_USAGE, toTaskTokenUsage } from '../lib/ai.js';
import type { ReadAttendanceSheetRequest, ReadAttendanceSheetResult } from '../types.js';
import type { Task } from './pipeline.js';
import {
    buildSheetUserPrompt,
    collectSheetNames,
    matchSheetNames,
    readSheetWithModel,
    sheetCacheKey,
    toMeetingFactsReading,
    SHEET_CACHE_PREFIX,
    type RawSheetReading,
} from './utils/attendanceSheetReading.js';
import { readCache, writeCache } from './utils/decisionPdfExtraction.js';

/**
 * Read the sheet the back office keeps during a meeting: the roll call, the
 * arrivals and departures noted by hand, per-item votes when the sheet has
 * them, and who presided. The reading states what the page states, matched
 * to the roster; opencouncil combines it with the transcript and the
 * decision documents.
 */

export interface ReadAttendanceSheetOptions {
    /** Call the model even when the file was read before. */
    skipCache?: boolean;
    /** How to get the file's bytes; the default fetches the presigned URL. The CLI reads a local path instead. */
    download?: (fileUrl: string) => Promise<Buffer>;
}

async function downloadSheet(fileUrl: string): Promise<Buffer> {
    const response = await fetch(fileUrl);
    if (!response.ok) {
        throw new Error(`Failed to download attendance sheet from ${fileUrl}: HTTP ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

export async function readAttendanceSheetWith(
    request: ReadAttendanceSheetRequest,
    onProgress: (stage: string, progressPercent: number) => void,
    options: ReadAttendanceSheetOptions = {},
): Promise<ReadAttendanceSheetResult> {
    const cacheKey = sheetCacheKey(request.fileUrl, request.layoutNotes);
    const userPrompt = buildSheetUserPrompt(request);

    let raw = options.skipCache ? null : readCache<RawSheetReading>(cacheKey, SHEET_CACHE_PREFIX);
    let usage = { ...NO_USAGE };
    if (!raw) {
        onProgress('downloading sheet', 5);
        const bytes = await (options.download ?? downloadSheet)(request.fileUrl);
        onProgress('reading sheet', 15);
        const read = await readSheetWithModel({ bytes, mediaType: request.mediaType, userPrompt });
        raw = read.result;
        usage = addUsage(usage, read.usage);
        writeCache(cacheKey, raw, SHEET_CACHE_PREFIX);
    }

    onProgress('matching names', 75);
    const matching = await matchSheetNames(collectSheetNames(raw), request.roster);
    usage = addUsage(usage, matching.usage);

    const reading = toMeetingFactsReading(raw, matching, request.agendaItems);
    onProgress('done', 100);
    return { reading, usage: toTaskTokenUsage(usage) };
}

export const readAttendanceSheet: Task<ReadAttendanceSheetRequest, ReadAttendanceSheetResult> = (request, onProgress) =>
    readAttendanceSheetWith(request, onProgress);
