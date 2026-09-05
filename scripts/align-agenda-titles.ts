/**
 * Align existing OpenCouncil subjects with the verbatim item text of their agenda
 * document. Step 2 of the one-time backfill for schemalabz/opencouncil#616.
 *
 * Reads <city>-agenda-subjects.json from opencouncil/scripts/export-agenda-subjects.ts,
 * fetches each meeting's agenda document, and asks the model for the printed title of
 * each subject the app already holds. One model call per meeting, no enrichment.
 * The output file is rewritten after every meeting, so a crash keeps its progress.
 *
 * Usage:
 *   npx tsx scripts/align-agenda-titles.ts <export.json> -O <titles.json> [--resume] [--batch] [--limit N] [--concurrency N]
 */
import fs from "fs";
import dotenv from "dotenv";
import { aiChat, addUsage, NO_USAGE } from "../src/lib/ai.js";
import { fetchAgendaDocument, type AgendaDocument } from "../src/lib/documentConversion.js";
import { AGENDA_ITEM_TITLE_RULES, normalizeAgendaItemTitle } from "../src/lib/agendaItemTitle.js";

dotenv.config();

// The same model as the processAgenda extraction (src/tasks/processAgenda.ts).
const MODEL = "claude-opus-4-6";

interface ExportSubject { id: string; agendaItemIndex: number; name: string; description: string }
interface ExportMeeting { meetingId: string; dateTime: string; administrativeBodyName: string | null; agendaUrl: string; subjects: ExportSubject[] }
interface ExportFile { cityId: string; cityName: string; meetings: ExportMeeting[] }

interface AlignedTitle { subjectId: string; agendaItemIndex: number; name: string; agendaItemTitle: string | null; note?: string }
interface AlignedMeeting { meetingId: string; agendaUrl: string; resolvedModel?: string; usage?: unknown; titles: AlignedTitle[]; error?: string }
interface OutputFile { cityId: string; model: string; alignedAt: string; meetings: AlignedMeeting[] }

type ModelRow = { subjectId: string; agendaItemTitle: string | null };

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
    return process.argv.includes(flag);
}

const systemPrompt = `Είσαι ένα σύστημα που αντιστοιχίζει θέματα δημοτικών συμβουλίων με το κείμενό τους στην ημερήσια διάταξη.
Θα λάβεις τη λίστα των θεμάτων που ήδη έχουμε για μια συνεδρίαση (subjectId, αριθμός θέματος, σύντομος τίτλος, περιγραφή) και το έγγραφο της ημερήσιας διάταξης.
Για ΚΑΘΕ subjectId επίστρεψε το agendaItemTitle: το κείμενο του θέματος όπως ακριβώς είναι γραμμένο στο έγγραφο.
Αν δεν βρίσκεις το θέμα στο έγγραφο, βάλε null. Μην επινοείς κείμενο. Μην αλλάζεις τα subjectId.
Η αντιστοίχιση γίνεται με τον αριθμό του θέματος ΚΑΙ με το νόημα του σύντομου τίτλου και της περιγραφής: αν η αρίθμηση του εγγράφου διαφέρει από τη δική μας, εμπιστεύσου το νόημα.

${AGENDA_ITEM_TITLE_RULES}

Η απάντηση είναι μόνο JSON: ένας πίνακας με αντικείμενα { subjectId: string, agendaItemTitle: string | null }, ένα για κάθε subjectId που σου δόθηκε.`;

function userPrompt(file: ExportFile, meeting: ExportMeeting, agenda: AgendaDocument): string {
    const converted = agenda.kind === "html"
        ? `\n\nΤο έγγραφο της ημερήσιας διάταξης (μετατροπή από αρχείο Word σε HTML):\n\n${agenda.html}\n`
        : "";
    const subjects = meeting.subjects.map(s => ({
        subjectId: s.id, agendaItemIndex: s.agendaItemIndex, name: s.name, description: s.description,
    }));
    const body = meeting.administrativeBodyName ? ` (${meeting.administrativeBodyName})` : "";
    return `Πόλη: ${file.cityName}. Συνεδρίαση της ${meeting.dateTime.slice(0, 10)}${body}.${converted}

Τα θέματα που ήδη έχουμε για αυτή τη συνεδρίαση:
${JSON.stringify(subjects, null, 2)}

Επίστρεψε για κάθε subjectId τον τίτλο του θέματος όπως ακριβώς είναι γραμμένος στο έγγραφο.`;
}

const outputSchema = {
    type: "array",
    items: {
        type: "object",
        properties: {
            subjectId: { type: "string" },
            agendaItemTitle: { type: ["string", "null"] },
        },
        required: ["subjectId", "agendaItemTitle"],
        additionalProperties: false,
    },
};

async function alignMeeting(file: ExportFile, meeting: ExportMeeting): Promise<AlignedMeeting> {
    const agenda = await fetchAgendaDocument(meeting.agendaUrl);
    const { result, usage, resolvedModel } = await aiChat<ModelRow[]>({
        model: MODEL,
        label: `align-agenda-titles:${file.cityId}/${meeting.meetingId}`,
        systemPrompt,
        userPrompt: userPrompt(file, meeting, agenda),
        documentBase64: agenda.kind === "pdf" ? agenda.base64 : undefined,
        batchFirst: has("--batch"),
        outputFormat: { type: "json_schema", schema: outputSchema },
    });

    const returned = new Map<string, string | null>(result.map(r => [r.subjectId, r.agendaItemTitle]));
    const known = new Set(meeting.subjects.map(s => s.id));
    const unknown = result.filter(r => !known.has(r.subjectId)).length;
    if (unknown > 0) console.warn(`  ${meeting.meetingId}: ${unknown} returned subjectId(s) are not in the export; ignored`);

    const titles: AlignedTitle[] = meeting.subjects.map(s => {
        const raw = returned.get(s.id);
        const title = normalizeAgendaItemTitle(raw);
        const note = !returned.has(s.id) ? "not returned by the model"
            : raw === null ? "not found in the document"
            : title === null ? "empty title"
            : undefined;
        return { subjectId: s.id, agendaItemIndex: s.agendaItemIndex, name: s.name, agendaItemTitle: title, ...(note ? { note } : {}) };
    });
    return { meetingId: meeting.meetingId, agendaUrl: meeting.agendaUrl, resolvedModel, usage, titles };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

async function main() {
    const inputFile = process.argv[2];
    const outFile = arg("-O");
    if (!inputFile || inputFile.startsWith("-") || !outFile) {
        console.error("Usage: npx tsx scripts/align-agenda-titles.ts <export.json> -O <titles.json> [--resume] [--batch] [--limit N] [--concurrency N]");
        process.exit(1);
    }
    const file = JSON.parse(fs.readFileSync(inputFile, "utf8")) as ExportFile;
    const output: OutputFile = has("--resume") && fs.existsSync(outFile)
        ? JSON.parse(fs.readFileSync(outFile, "utf8")) as OutputFile
        : { cityId: file.cityId, model: MODEL, alignedAt: new Date().toISOString(), meetings: [] };

    const done = new Set(output.meetings.filter(m => !m.error).map(m => m.meetingId));
    const limit = arg("--limit") ? parseInt(arg("--limit") as string, 10) : Infinity;
    const todo = file.meetings.filter(m => !done.has(m.meetingId)).slice(0, limit);
    const concurrency = arg("--concurrency") ? parseInt(arg("--concurrency") as string, 10) : 2;
    console.log(`${file.cityId}: ${todo.length} meeting(s) to align (${done.size} already done), concurrency ${concurrency}${has("--batch") ? ", batch API first" : ""}`);

    let total = NO_USAGE;
    const save = () => fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

    await pool(todo, concurrency, async meeting => {
        const started = Date.now();
        let aligned: AlignedMeeting;
        try {
            aligned = await alignMeeting(file, meeting);
            const titled = aligned.titles.filter(t => t.agendaItemTitle !== null).length;
            console.log(`  ${meeting.meetingId}: ${titled}/${aligned.titles.length} titled in ${Math.round((Date.now() - started) / 1000)}s`);
            if (aligned.usage) total = addUsage(total, aligned.usage as Parameters<typeof addUsage>[1]);
        } catch (e) {
            aligned = { meetingId: meeting.meetingId, agendaUrl: meeting.agendaUrl, titles: [], error: e instanceof Error ? e.message : String(e) };
            console.error(`  ${meeting.meetingId}: FAILED ${aligned.error}`);
        }
        output.meetings = output.meetings.filter(m => m.meetingId !== meeting.meetingId).concat(aligned);
        save();
    });

    save();
    console.log(`usage: ${JSON.stringify(total)}`);
    console.log(`-> ${outFile}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
