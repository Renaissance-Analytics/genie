import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { BOARD_DIR, BOARD_INDEX, addPost, nextVersionNumber, parseBoard, versionsOf, type BoardPost, type DisplayPost, type QuestionTrailOutcome, type TrailEntry } from '../core/artboard.js';
import { readArtBoard } from './artboard-host.js';
import type { Question, QuestionOption } from '../core/attention.js';
import { QUESTION_VISUAL_LIMITS, parseVisualInput, sanitizeMockupHtml, selectVisualPosts, visualRefsOf, type QuestionVisual, type QuestionVisualInput } from '../core/question-visuals.js';

/**
 * FORCETHEQUESTION'S VISUALS, HOST SIDE (Tynn #835; core/question-visuals.ts says what they are). Two jobs:
 *
 * - `prepareQuestionVisuals`, when a question is asked or updated: every visual the agent named becomes a reference to a
 *   post on ITS OWN workspace's ArtBoard — an id is looked up there (and only there), a file is read from inside the
 *   workspace (and only there), capped, an HTML page sanitised, and POSTED to the board. All or nothing: one refused
 *   visual refuses the ask, and nothing is written until every visual has been checked.
 * - `recordQuestionOnBoard`, when the person decides: each post the question showed gets the decision on its trail
 *   (chosen, not chosen, shown, dismissed), once per question however many times it is told.
 */

type Caller = { readonly agentId: string; readonly agentName: string; readonly workspaceId: string; readonly workspacePath: string };
type Prepared = { ok: true; questions: Question[] } | { ok: false; reason: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'visual';

async function boardOf(root: string): Promise<BoardPost[]> {
    try { return parseBoard(await readFile(join(root, BOARD_DIR, BOARD_INDEX), 'utf8')); } catch { return []; }
}

const hasVisuals = (raw: unknown): boolean => {
    if (typeof raw !== 'object' || raw === null) return false;
    const q = raw as { visuals?: unknown; options?: unknown };
    return q.visuals !== undefined || (Array.isArray(q.options) && q.options.some((o) => typeof o === 'object' && o !== null && (o as { visual?: unknown }).visual !== undefined));
};

/** A path inside the workspace, links resolved: the real file, or why not. */
async function inside(root: string, ref: string): Promise<{ ok: true; full: string } | { ok: false; reason: string }> {
    const outside = { ok: false as const, reason: `${ref} is outside your workspace; a visual is a file in it` };
    const asked = isAbsolute(ref) ? resolve(ref) : resolve(root, ref);
    let realRoot: string;
    let full: string;
    try { realRoot = await realpath(root); } catch { return { ok: false, reason: 'your workspace folder cannot be read' }; }
    // The path as written first, so a missing file outside is still "outside", not "not found".
    const plain = relative(resolve(root), asked);
    if (plain === '' || plain.startsWith('..') || isAbsolute(plain)) return outside;
    try { full = await realpath(asked); } catch { return { ok: false, reason: `${ref} was not found in your workspace` }; }
    // ...and again with links followed: a link inside that leads out is outside.
    const real = relative(realRoot, full);
    if (real === '' || real.startsWith('..') || isAbsolute(real)) return outside;
    return { ok: true, full };
}

/** One visual checked and read, not yet written. */
type Checked =
    | { kind: 'artboard'; ref: QuestionVisual }
    | { kind: 'file'; postKind: 'image' | 'html'; title: string; ext: string; bytes: Buffer | string };

async function check(caller: Caller, board: readonly BoardPost[], input: QuestionVisualInput): Promise<{ ok: true; checked: Checked } | { ok: false; reason: string }> {
    if (input.kind === 'artboard') {
        const post = board.find((p) => p.id === input.ref);
        if (!post) return { ok: false, reason: `ArtBoard post "${input.ref}" is not on your workspace's ArtBoard; post it first with ai.genie.artboard.post, or name an image or html file instead` };
        const version = versionsOf(post).at(-1)?.n ?? 1;
        return { ok: true, checked: { kind: 'artboard', ref: { postId: post.id, version, title: input.title ?? post.title, kind: post.kind } } };
    }
    const found = await inside(caller.workspacePath, input.ref);
    if (!found.ok) return found;
    const cap = input.kind === 'image' ? QUESTION_VISUAL_LIMITS.imageBytes : QUESTION_VISUAL_LIMITS.htmlBytes;
    const size = (await stat(found.full)).size;
    if (size > cap) return { ok: false, reason: `${input.ref} is ${size} bytes, over the ${cap}-byte cap for ${input.kind === 'image' ? 'an image' : 'a mockup'}` };
    const title = input.title ?? basename(input.ref, extname(input.ref));
    if (input.kind === 'image') return { ok: true, checked: { kind: 'file', postKind: 'image', title, ext: extname(found.full).toLowerCase(), bytes: await readFile(found.full) } };
    return { ok: true, checked: { kind: 'file', postKind: 'html', title, ext: '.html', bytes: sanitizeMockupHtml(await readFile(found.full, 'utf8')) } };
}

export async function prepareQuestionVisuals(caller: Caller, raw: readonly unknown[], now: () => string): Promise<Prepared> {
    // No visuals anywhere: the questions exactly as asked (validateQuestions judges them, as it always has).
    if (!raw.some(hasVisuals)) return { ok: true, questions: raw as Question[] };
    const board = await boardOf(caller.workspacePath);
    // Check every visual first; nothing is written unless all of them pass.
    type Slot = { q: number; option: number | null };
    const work: { slot: Slot; checked: Checked }[] = [];
    let count = 0;
    for (const [qi, rq] of raw.entries()) {
        if (typeof rq !== 'object' || rq === null) continue;
        const q = rq as { header?: unknown; visuals?: unknown; options?: unknown };
        const header = typeof q.header === 'string' ? q.header : `question ${qi + 1}`;
        if (q.visuals !== undefined) {
            if (!Array.isArray(q.visuals)) return { ok: false, reason: `${header}: visuals is a list` };
            if (q.visuals.length > QUESTION_VISUAL_LIMITS.perQuestion) return { ok: false, reason: `${header}: a question carries at most ${QUESTION_VISUAL_LIMITS.perQuestion} visuals; got ${q.visuals.length}` };
            for (const v of q.visuals) {
                const parsed = parseVisualInput(v);
                if (!parsed.ok) return { ok: false, reason: `${header}: ${parsed.reason}` };
                const c = await check(caller, board, parsed.input);
                if (!c.ok) return { ok: false, reason: `${header}: ${c.reason}` };
                work.push({ slot: { q: qi, option: null }, checked: c.checked });
            }
        }
        for (const [oi, ro] of (Array.isArray(q.options) ? q.options : []).entries()) {
            const visual = typeof ro === 'object' && ro !== null ? (ro as { visual?: unknown }).visual : undefined;
            if (visual === undefined) continue;
            const parsed = parseVisualInput(visual);
            if (!parsed.ok) return { ok: false, reason: `${header}: option ${oi + 1}: ${parsed.reason}` };
            const c = await check(caller, board, parsed.input);
            if (!c.ok) return { ok: false, reason: `${header}: option ${oi + 1}: ${c.reason}` };
            work.push({ slot: { q: qi, option: oi }, checked: c.checked });
        }
        count = work.length;
        if (count > QUESTION_VISUAL_LIMITS.perAsk) return { ok: false, reason: `one question carries at most ${QUESTION_VISUAL_LIMITS.perAsk} visuals in all` };
    }
    // Post the files: one post per file, ids unique within this ask, each a new version of an earlier ask's post of the same name.
    let next = board;
    const used = new Set<string>();
    const refs = new Map<string, QuestionVisual>();
    const key = (s: Slot, i: number) => `${s.q}:${s.option ?? 'q'}:${i}`;
    let wrote = false;
    for (const [i, w] of work.entries()) {
        if (w.checked.kind === 'artboard') { refs.set(key(w.slot, i), w.checked.ref); continue; }
        const base = `question-${slug(w.checked.title)}`;
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        const version = nextVersionNumber(next, id);
        const file = version <= 1 ? `${id}${w.checked.ext}` : `${id}.v${version}${w.checked.ext}`;
        await mkdir(join(caller.workspacePath, BOARD_DIR), { recursive: true });
        await writeFile(join(caller.workspacePath, BOARD_DIR, file), w.checked.bytes);
        next = addPost(next, { id, title: w.checked.title, kind: w.checked.postKind, file, createdAt: now(), agentId: caller.agentId, agentName: caller.agentName, askVerdict: false, note: 'Shown with a ForceTheQuestion question' });
        refs.set(key(w.slot, i), { postId: id, version, title: w.checked.title, kind: w.checked.postKind });
        wrote = true;
    }
    if (wrote) await writeFile(join(caller.workspacePath, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: next }, null, 2));
    // The questions, rebuilt from what a question is: anything else the agent sent is not carried.
    const questions = raw.map((rq, qi): Question => {
        const q = (rq ?? {}) as { header?: unknown; question?: unknown; multiSelect?: unknown; options?: unknown };
        const mine = work.map((w, i) => ({ w, i })).filter(({ w }) => w.slot.q === qi);
        const own = mine.filter(({ w }) => w.slot.option === null).map(({ w, i }) => refs.get(key(w.slot, i))!);
        const options = (Array.isArray(q.options) ? q.options : []).map((ro, oi): QuestionOption => {
            const o = (ro ?? {}) as { label?: unknown; description?: unknown };
            const hit = mine.find(({ w }) => w.slot.option === oi);
            return { label: String(o.label ?? ''), ...(typeof o.description === 'string' ? { description: o.description } : {}), ...(hit ? { visual: refs.get(key(hit.w.slot, hit.i))! } : {}) };
        });
        return {
            header: String(q.header ?? ''),
            question: String(q.question ?? ''),
            options,
            ...(q.multiSelect === true ? { multiSelect: true } : {}),
            ...(own.length > 0 ? { visuals: own } : {}),
        };
    });
    return { ok: true, questions };
}

export interface DecidedQuestion {
    readonly questionId: string;
    readonly outcome: 'answered' | 'dismissed';
    readonly questions: readonly Question[];
    /** One array of chosen labels per question; empty for a dismissal. */
    readonly selections: readonly (readonly string[])[];
}

/** Write the decision onto every post the question showed. Once per question per post; a post gone is skipped. */
export async function recordQuestionOnBoard(root: string, record: DecidedQuestion, at: string): Promise<void> {
    const entries = new Map<string, TrailEntry>();
    record.questions.forEach((q, i) => {
        const chosen = record.selections[i] ?? [];
        const answer = record.outcome === 'answered' && chosen.length > 0 ? chosen.join(', ') : undefined;
        const add = (v: QuestionVisual, outcome: QuestionTrailOutcome) => {
            if (entries.has(v.postId)) return;
            entries.set(v.postId, { type: 'question', version: v.version, questionId: record.questionId, header: q.header, outcome, ...(answer ? { answer } : {}), at, by: 'person' });
        };
        for (const o of q.options) if (o.visual) add(o.visual, record.outcome === 'dismissed' ? 'dismissed' : chosen.includes(o.label) ? 'chosen' : 'not-chosen');
        for (const v of q.visuals ?? []) add(v, record.outcome === 'dismissed' ? 'dismissed' : 'shown');
    });
    if (entries.size === 0) return;
    const board = await boardOf(root);
    let changed = false;
    const next = board.map((p) => {
        const entry = entries.get(p.id);
        if (!entry || (p.trail ?? []).some((e) => e.type === 'question' && e.questionId === record.questionId)) return p;
        changed = true;
        return { ...p, trail: [...(p.trail ?? []), entry] };
    });
    if (changed) await writeFile(join(root, BOARD_DIR, BOARD_INDEX), JSON.stringify({ posts: next }, null, 2));
}

/**
 * A question's visuals for the question window on THIS machine: its workspace's board, read and resolved as the ArtBoard
 * tab reads it (artboard-host.ts), each post laid over the version the question named.
 */
export async function readQuestionVisuals(root: string, questions: readonly Question[]): Promise<{ posts: DisplayPost[] }> {
    const refs = visualRefsOf(questions);
    if (refs.length === 0) return { posts: [] };
    const board = await readArtBoard(root);
    return { posts: selectVisualPosts(board.posts, refs) };
}
