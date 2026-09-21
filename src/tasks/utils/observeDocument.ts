/**
 * Read one decision document and record what it states.
 *
 * The survey CLI and the `profileBody` task both need exactly this: fetch the
 * PDF, send its head and tail pages to the model, and keep the reading. One
 * implementation, so a body profiled from the task and a body profiled from the
 * survey are the same measurement — and so both share the cache, which
 * represents tens of millions of tokens of model output.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import { aiChat, NO_USAGE } from '../../lib/ai.js';
import { adaToPdfUrl, downloadPdfAsBuffer } from './decisionPdfExtraction.js';
import { extractPdfPageSet, headAndTailPages } from './pdfPages.js';
import {
    OBSERVATION_HEAD_PAGES,
    OBSERVATION_SCHEMA,
    OBSERVATION_SCHEMA_VERSION,
    OBSERVATION_SYSTEM_PROMPT,
    OBSERVATION_TAIL_PAGES,
    type DocumentObservation,
} from './documentObservation.js';

/**
 * Where downloaded documents and their model readings live.
 *
 * Not /tmp: this cache represents tens of millions of tokens of model output
 * and a couple of thousand fetches from Diavgeia, and losing it to a reboot
 * costs real money and real time to rebuild.
 */
export const DOCUMENT_CACHE_DIR = process.env.OPENCOUNCIL_DOCUMENT_CACHE
    ?? path.join(os.homedir(), '.cache', 'opencouncil-body-corpus');

/** Model to profile a body with when the caller names none. */
export const OBSERVATION_MODEL = 'claude-sonnet-4-5-20250929';

export interface ObserveDocumentOptions {
    model: string;
    cacheDir: string;
    /** Ignore a cached reading and read the document again. */
    skipCache?: boolean;
}

export interface ObservedDocument {
    observation: DocumentObservation;
    pages: number;
    usage: Anthropic.Messages.Usage;
    fromCache: boolean;
}

const adaDigest = (ada: string) => crypto.createHash('sha256').update(ada).digest('hex').slice(0, 16);

/**
 * The cache key carries the model, so comparing two models over the same
 * documents is one flag, and the schema version, so a field change cannot serve
 * stale answers in the old shape. Bump OBSERVATION_SCHEMA_VERSION in
 * documentObservation.ts whenever a field's meaning changes.
 */
export function observationCachePath(ada: string, model: string, cacheDir: string): string {
    return path.join(cacheDir, `obs-v${OBSERVATION_SCHEMA_VERSION}-${model}-${adaDigest(ada)}.json`);
}

export function documentCachePath(ada: string, cacheDir: string): string {
    return path.join(cacheDir, `${adaDigest(ada)}.pdf`);
}

export async function observeDocument(ada: string, opts: ObserveDocumentOptions): Promise<ObservedDocument> {
    fs.mkdirSync(opts.cacheDir, { recursive: true });
    const cachePath = observationCachePath(ada, opts.model, opts.cacheDir);
    if (!opts.skipCache && fs.existsSync(cachePath)) {
        const record = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { pages: number; observation: DocumentObservation };
        return { observation: record.observation, pages: record.pages, usage: NO_USAGE, fromCache: true };
    }

    const pdfPath = documentCachePath(ada, opts.cacheDir);
    if (!fs.existsSync(pdfPath)) {
        fs.writeFileSync(pdfPath, await downloadPdfAsBuffer(adaToPdfUrl(ada)));
    }
    const buffer = fs.readFileSync(pdfPath);
    const pages = (await PDFDocument.load(buffer)).getPageCount();
    const base64 = await extractPdfPageSet(
        buffer,
        headAndTailPages(pages, OBSERVATION_HEAD_PAGES, OBSERVATION_TAIL_PAGES),
    );
    const { result, usage } = await aiChat<DocumentObservation>({
        systemPrompt: OBSERVATION_SYSTEM_PROMPT,
        userPrompt: `This document has ${pages} page(s); you are seeing its first ${Math.min(OBSERVATION_HEAD_PAGES, pages)} and last ${Math.min(OBSERVATION_TAIL_PAGES, pages)}. Record what it states.`,
        documentBase64: base64,
        outputFormat: { type: 'json_schema', schema: OBSERVATION_SCHEMA },
        model: opts.model,
        maxTokens: 2048,
        label: 'document-observation',
    });

    fs.writeFileSync(cachePath, JSON.stringify({ ada, pages, observation: result }, null, 2));
    return { observation: result, pages, usage, fromCache: false };
}
