import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractDecisionFromPdf, adaToPdfUrl } from '../../src/tasks/utils/decisionPdfExtraction.js';

// The gitignored work directory the Python survey scripts share, unless the
// caller names another. `__dirname` does not exist in an ES module.
const here = path.dirname(fileURLToPath(import.meta.url));
const S = process.argv[2]
    ?? process.env.OPENCOUNCIL_SURVEY_DIR
    ?? path.join(here, '..', '..', '.extraction-survey');
const sel = JSON.parse(fs.readFileSync(`${S}/extraction-fixture-selection.json`, 'utf-8')).selection;
const surveyByAda: Record<string, any> = {};
for (const b of JSON.parse(fs.readFileSync(`${S}/observations-v5.json`, 'utf-8')).bodies)
    for (const o of b.observations) surveyByAda[o.ada] = o.observation;
let out: any[] = [];
try { out = JSON.parse(fs.readFileSync(`${S}/extraction-gap.json`, 'utf-8')); } catch {}
const already = new Set(out.map((o: any) => o.ada));
const todo = sel.filter((s: any) => !already.has(s.ada));
console.log(`${already.size} already extracted, ${todo.length} to go`);
let cursor = 0;
const worker = async () => {
    while (cursor < todo.length) {
        const s = todo[cursor++];
        try {
            const { result, usage } = await extractDecisionFromPdf(adaToPdfUrl(s.ada), undefined, false);
            out.push({ city: s.city, body: s.body, ada: s.ada, pages: s.pages, covers: s.covers,
                       obs: surveyByAda[s.ada], ok: true, usage, extraction: result });
        } catch (e) {
            out.push({ city: s.city, body: s.body, ada: s.ada, ok: false, obs: surveyByAda[s.ada],
                       error: e instanceof Error ? e.message : String(e) });
        }
        fs.writeFileSync(`${S}/extraction-gap.json`, JSON.stringify(out, null, 1));
        if (out.length % 20 === 0) console.log(`  ${out.length}`);
    }
};
await Promise.all(Array.from({ length: 6 }, worker));
const tok = out.filter(o => o.ok).reduce((a, o) => a + o.usage.input_tokens, 0);
console.log(`done: ${out.filter(o => o.ok).length} ok, ${out.filter(o => !o.ok).length} failed, ${tok} input tokens`);
