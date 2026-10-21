import { Agent as SlideAgent } from '@particle-academy/dark-slide';
import { Agent as SheetAgent } from '@particle-academy/holy-sheet';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BOARD_DIR, BOARD_INDEX, addPost, parseBoard, type BoardPost } from '../core/artboard.js';
import { bridgeAccess, type PluginManifest } from '../core/plugins.js';
import type { RunResult } from './plugin-runner.js';

/**
 * THE OFFICIAL PLUGINS' TOOLS, RUN INSIDE GENIE (beta.33 item 14; Genie 1 main/plugins/official.ts PRESENTATION_TOOLS /
 * SPREADSHEET_TOOLS and artboard-plugin.ts). They are Genie's own code, shipped in the app, so there is no plugin folder to
 * launch from — but every file they touch goes through the plugin's DECLARED capability, exactly as a third-party plugin's
 * would (`bridgeAccess`): inside the workspace, of a declared type, or refused in words and nothing written.
 *
 *   ai.genie.presentation.createDeck     an outline → a .pptx (dark-slide)
 *   ai.genie.spreadsheet.createWorkbook  rows / CSV / sheets → an .xlsx (holy-sheet)
 *   ai.genie.artboard.post               a mockup or an image → the workspace's `.artboard/`, for a person to review; WHO posted
 *                                        is taken from the caller, never from the args, so a verdict reaches that agent only
 */

export interface OfficialToolInput {
    readonly pluginId: string;
    readonly tool: string;
    readonly args: unknown;
    readonly caller: { readonly agentId: string; readonly agentName: string; readonly workspaceId: string; readonly workspacePath: string };
    readonly manifest: PluginManifest;
}

type Args = Record<string, unknown>;
const NL = '\n';
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const slug = (s: string, fallback: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
const refuse = (reason: string): RunResult => ({ ok: false, reason });

/** A workspace-relative path, resolved and checked against the plugin's declared fs capability. */
function guarded(input: OfficialToolInput, rel: string): { ok: true; full: string; rel: string } | { ok: false; reason: string } {
    const root = input.caller.workspacePath;
    const full = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
    const decision = bridgeAccess(input.manifest, { kind: 'fs', path: full, workspacePath: root });
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    return { ok: true, full, rel: relative(root, full).split('\\').join('/') };
}

async function write(input: OfficialToolInput, rel: string, bytes: Uint8Array | string): Promise<{ ok: true; rel: string; bytes: number } | { ok: false; reason: string }> {
    const g = guarded(input, rel);
    if (!g.ok) return g;
    await mkdir(dirname(g.full), { recursive: true });
    await writeFile(g.full, bytes);
    return { ok: true, rel: g.rel, bytes: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length };
}

/** The output path: the one asked for, or `<slug of title>.<ext>`; anything without the extension gets it appended. */
function outPath(args: Args, title: string, ext: string, fallback: string): string {
    const asked = str(args.path);
    const p = asked || `${slug(title, fallback)}${ext}`;
    return p.toLowerCase().endsWith(ext) ? p : `${p}${ext}`;
}

// --- Presentation ----------------------------------------------------------------------------------------------------

function textEl(id: string, content: string, x: number, y: number, w: number, h: number, style: Record<string, unknown>) {
    return { id, type: 'text', x, y, w, h, content, format: 'markdown', style };
}

function buildSlide(raw: unknown, i: number) {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Args;
    const elements: unknown[] = [];
    const title = str(s.title);
    if (title) elements.push(textEl(`s${i}-title`, `# ${title}`, 0.06, 0.07, 0.88, 0.18, { fontSize: 40, fontWeight: 700 }));
    let body = typeof s.body === 'string' ? s.body : '';
    if (!body && Array.isArray(s.bullets)) body = s.bullets.map((b) => `- ${String(b)}`).join(NL);
    if (body) elements.push(textEl(`s${i}-body`, body, 0.06, 0.3, 0.88, 0.62, { fontSize: 22 }));
    if (elements.length === 0) elements.push(textEl(`s${i}-empty`, '', 0.06, 0.3, 0.88, 0.4, {}));
    return { id: `slide-${i + 1}`, layout: str(s.layout) || 'title-content', elements };
}

async function createDeck(input: OfficialToolInput): Promise<RunResult> {
    const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Args;
    const title = str(args.title) || 'Untitled deck';
    const slides = (Array.isArray(args.slides) ? args.slides : []).map(buildSlide);
    if (slides.length === 0) slides.push(buildSlide({ title }, 0));
    let deck: unknown = { id: `deck-${Date.now()}`, title, theme: { name: str(args.theme) || 'default' }, slides };
    const errors = SlideAgent.validate(deck);
    if (errors.length > 0) {
        const repaired = SlideAgent.validateAndRepair(deck);
        if (!repaired.ok) return refuse(`The deck did not validate:${NL}${errors.map((e) => `- ${e.path}: ${e.hint}`).join(NL)}`);
        deck = repaired.schema;
    }
    const w = await write(input, outPath(args, title, '.pptx', 'deck'), SlideAgent.toBytes(deck));
    if (!w.ok) return refuse(w.reason);
    return { ok: true, result: { path: w.rel, text: `Created ${w.rel} (${slides.length} slide(s), ${w.bytes} bytes). Open it in Genie to edit it or Present it.` } };
}

// --- Spreadsheet -----------------------------------------------------------------------------------------------------

async function createWorkbook(input: OfficialToolInput): Promise<RunResult> {
    const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Args;
    const sheetName = str(args.sheetName) || 'Sheet1';
    let schema: unknown;
    if (Array.isArray(args.sheets) && args.sheets.length > 0) {
        schema = { sheets: args.sheets.map((raw, i) => { const s = (raw && typeof raw === 'object' ? raw : {}) as Args; return { name: str(s.name) || `Sheet${i + 1}`, ...(Array.isArray(s.columns) ? { columns: s.columns } : {}), rows: Array.isArray(s.rows) ? s.rows : [] }; }) };
    } else if (Array.isArray(args.rows)) {
        schema = SheetAgent.fromArray(args.rows as unknown[][], Array.isArray(args.headers) ? (args.headers as string[]) : null, sheetName);
    } else if (typeof args.csv === 'string') {
        schema = SheetAgent.fromCsv(args.csv);
    } else {
        schema = { sheets: [{ name: sheetName, columns: [], rows: [] }] };
    }
    const errors = SheetAgent.validate(schema);
    if (errors.length > 0) {
        const repaired = SheetAgent.validateAndRepair(schema);
        if (repaired.schema) schema = repaired.schema;
        if (SheetAgent.validate(schema).length > 0) return refuse(`The workbook did not validate:${NL}${errors.map((e) => `- ${e.path}: ${e.hint}`).join(NL)}`);
    }
    const title = str(args.title) || 'workbook';
    const w = await write(input, outPath(args, title, '.xlsx', 'workbook'), SheetAgent.toBytes(schema));
    if (!w.ok) return refuse(w.reason);
    const count = Array.isArray((schema as { sheets?: unknown[] }).sheets) ? (schema as { sheets: unknown[] }).sheets.length : 1;
    return { ok: true, result: { path: w.rel, text: `Created ${w.rel} (${count} sheet(s), ${w.bytes} bytes). Open it in Genie to edit it.` } };
}

// --- ArtBoard --------------------------------------------------------------------------------------------------------

async function readBoardFile(root: string): Promise<BoardPost[]> {
    try { return parseBoard(await readFile(join(root, BOARD_DIR, BOARD_INDEX), 'utf8')); } catch { return []; }
}

async function postToBoard(input: OfficialToolInput): Promise<RunResult> {
    const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Args;
    const title = str(args.title);
    if (!title) return refuse('A post needs a title — it is what the reviewer sees on the card.');
    const kind = args.kind === 'image' ? 'image' : 'html';
    const id = slug(str(args.id) || title, 'post');
    let file: string;
    if (kind === 'html') {
        const html = typeof args.html === 'string' ? args.html : '';
        if (!html.trim()) return refuse('An html post needs the markup in html.');
        file = `${id}.html`;
        const w = await write(input, `${BOARD_DIR}/${file}`, html);
        if (!w.ok) return refuse(w.reason);
    } else {
        const from = str(args.imagePath);
        if (!from) return refuse('An image post needs imagePath — the workspace-relative path of the image you made.');
        const source = guarded(input, from);
        if (!source.ok) return refuse(source.reason);
        const dot = from.lastIndexOf('.');
        file = `${id}${dot > 0 ? from.slice(dot).toLowerCase() : '.png'}`;
        const target = guarded(input, `${BOARD_DIR}/${file}`);
        if (!target.ok) return refuse(target.reason);
        // COPIED, not referenced: the reviewer still sees what was posted after the agent rewrites its own output.
        await mkdir(dirname(target.full), { recursive: true });
        await copyFile(source.full, target.full);
    }
    const root = input.caller.workspacePath;
    const entry: BoardPost = { id, title, kind, file, createdAt: new Date().toISOString(), agentId: input.caller.agentId, ...(str(args.note) ? { note: str(args.note) } : {}) };
    const board = addPost(await readBoardFile(root), entry);
    const w = await write(input, `${BOARD_DIR}/${BOARD_INDEX}`, JSON.stringify({ posts: board }, null, 2));
    if (!w.ok) return refuse(w.reason);
    return {
        ok: true,
        result: {
            id,
            text: `Posted "${title}" to the ArtBoard as ${id}. The person sees it in the workspace's ArtBoard panel and can approve or reject it with a comment; that verdict arrives in your AgentInbox, so this call does not wait — carry on with work that does not depend on the answer.${NL}Revising? Post again with id "${id}" and the board REPLACES that card.`,
        },
    };
}

const TOOLS: Readonly<Record<string, (input: OfficialToolInput) => Promise<RunResult>>> = {
    'ai.genie.presentation.createDeck': createDeck,
    'ai.genie.spreadsheet.createWorkbook': createWorkbook,
    'ai.genie.artboard.post': postToBoard,
};

export async function runOfficialTool(input: OfficialToolInput): Promise<RunResult> {
    const run = TOOLS[`${input.pluginId}.${input.tool}`];
    if (!run) return refuse(`${input.pluginId}.${input.tool} is not a tool Genie ships`);
    try {
        return await run(input);
    } catch (error) {
        return refuse(`${input.pluginId}.${input.tool} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
