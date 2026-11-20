import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBoard, timelineOf, trailFrom, type BoardPost, type DisplayPost } from '../src/core/artboard.js';
import { validateQuestions, type Question } from '../src/core/attention.js';
import type { DeckItem } from '../src/core/deck.js';
import { QUESTION_VISUAL_LIMITS, parseVisualInput, sanitizeMockupHtml, selectVisualPosts, type QuestionVisual } from '../src/core/question-visuals.js';
import { mintAgentId } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { FORCE_THE_QUESTION_TOOL } from '../src/main/mcp-tools.js';
import { prepareQuestionVisuals, recordQuestionOnBoard } from '../src/main/question-visuals.js';
import { RemoteQuestions } from '../src/main/remote-questions.js';
import { QuestionApp } from '../src/renderer/components/QuestionApp.js';
import { QuestionVisuals } from '../src/renderer/components/QuestionVisuals.js';

/**
 * FORCETHEQUESTION CARRIES VISUALS (the owner, beta.65; Tynn #835). An agent attaches what it MADE to the question the
 * person decides on: ArtBoard posts (ids from `ai.genie.artboard.post`) and images or HTML mockups from its workspace, on a
 * question or on an option ("pick a mockup"). Every visual IS an ArtBoard post — a file given by path is posted to the
 * workspace's board when the question is asked — so the question window draws it with the ArtBoard tab's own
 * component, a remote driver reads it the way it reads the board, and the decision is written on each post's trail.
 *
 * Validated at the door: only the asking agent's own workspace (its board, its files), size caps, the closed set of
 * kinds, and HTML sanitised before it is posted and drawn in a frame with no script and no same origin.
 */

describe('the input (core/question-visuals.ts)', () => {
    it('one of artboard / image / html, a string; an image or a page by its extension', () => {
        expect(parseVisualInput({ artboard: 'login-v2' })).toEqual({ ok: true, input: { kind: 'artboard', ref: 'login-v2' } });
        expect(parseVisualInput({ image: 'shots/a.png', title: 'A' })).toEqual({ ok: true, input: { kind: 'image', ref: 'shots/a.png', title: 'A' } });
        expect(parseVisualInput({ html: 'mock/b.html' })).toEqual({ ok: true, input: { kind: 'html', ref: 'mock/b.html' } });
        for (const bad of [{}, { artboard: 'a', image: 'b.png' }, { image: 3 }, { image: 'run.exe' }, { html: 'page.php' }, 'a.png', null]) {
            expect(parseVisualInput(bad).ok, JSON.stringify(bad)).toBe(false);
        }
    });

    it('HTML is sanitised: no script, no handler, no javascript: URL, no nested frame, no refresh, no network', () => {
        const dirty = '<html><head><meta http-equiv="refresh" content="0;url=https://x.test"><link rel="stylesheet" href="https://cdn.test/a.css"><script>alert(1)</script></head>'
            + '<body onload="steal()"><a href="javascript:alert(2)">x</a><img src="https://track.test/p.gif" onerror="x()"><iframe src="https://x.test"></iframe><object data="a.swf"></object><embed src="b"><div style="color:red">Kept</div></body></html>';
        const clean = sanitizeMockupHtml(dirty);
        expect(clean).not.toMatch(/<script/i);
        expect(clean).not.toMatch(/\son[a-z]+\s*=/i);
        expect(clean).not.toMatch(/javascript:/i);
        expect(clean).not.toMatch(/<(iframe|object|embed)\b/i);
        expect(clean).not.toMatch(/http-equiv="refresh"/i);
        expect(clean).not.toMatch(/<link\b/i);
        // A policy of its own: nothing it draws reaches the network, even inside the sandboxed frame.
        expect(clean).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">/);
    });

    it('CONTROL: sanitising keeps the mockup itself — its markup, its classes and its inline style', () => {
        const clean = sanitizeMockupHtml('<div class="card" style="color:red"><h1>Kept</h1></div>');
        expect(clean).toContain('<div class="card" style="color:red"><h1>Kept</h1></div>');
    });

    /*
     * ONE PASS IS NOT A SANITISER (CodeQL js/incomplete-multi-character-sanitization, alerts #122-#124). Removing a match can
     * JOIN its two sides into a new match: `<scr<script>ipt>` loses its inner tag and becomes `<script>`. Each case below is
     * built so the old single pass assembled the very thing it removes. The oracle is a real HTML parser reading the result
     * the way the frame would, not a regex over the string — a regex oracle shares the sanitiser's blind spots.
     */
    const BLOCKED_ELEMENTS = 'script, iframe, frame, frameset, object, embed, applet, noscript, template, base, link';
    const URL_ATTRS = new Set(['src', 'srcset', 'href', 'action', 'formaction', 'poster', 'background', 'xlink:href', 'data']);
    function violations(html: string): string[] {
        const doc = new (new Window().DOMParser)().parseFromString(html, 'text/html');
        const found: string[] = [];
        for (const el of doc.querySelectorAll(BLOCKED_ELEMENTS)) found.push(`<${el.tagName.toLowerCase()}>`);
        for (const el of doc.querySelectorAll('*')) {
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                // What a URL resolver sees: tabs and newlines anywhere are dropped, leading spaces and controls too.
                const url = (attr.value ?? '').replace(/[\u0000- ]/g, '').toLowerCase();
                if (name.startsWith('on')) found.push(`${name}=`);
                if (/^(javascript|vbscript):|^data:text\/html/.test(url)) found.push(`${name}=${url}`);
                if (URL_ATTRS.has(name) && /^(https?:)?\/\//.test(url)) found.push(`remote ${name}=${url}`);
            }
        }
        // Counted in the whole document: a bare <meta> before <html> belongs in <head> by the spec's tree builder, which
        // happy-dom does not follow there; the CONTROL below holds our own output to <head> explicitly.
        const csp = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
        if (csp.length !== 1) found.push(`${csp.length} CSP metas`);
        // A parser's view is not enough for an unclosed tag (happy-dom drops `<script>` with no end), so the text is read too.
        const tag = /<(script|iframe|frame|frameset|object|embed|applet|noscript|template|base|link)\b/i.exec(html);
        if (tag) found.push(`text <${tag[1]!.toLowerCase()}`);
        for (const meta of doc.querySelectorAll('meta[http-equiv]')) {
            if (meta.getAttribute('http-equiv') !== 'Content-Security-Policy') found.push(`http-equiv=${meta.getAttribute('http-equiv')}`);
        }
        return found;
    }

    const BYPASSES: Record<string, string> = {
        'a tag joined from two halves': '<p>x</p><scr<script>ipt>alert(1)',
        'a closed tag joined from two halves': '<scr<link>ipt>alert(1)</scr<link>ipt>',
        'a handler joined from two halves': '<a o onclick="x"nclick="alert(1)">x</a>',
        'a javascript: URL joined from two halves': '<a hr href="javascript:x"ef="javascript:alert(1)">x</a>',
        'a remote source joined from two halves': '<img sr src="https://a.test/x"c="https://track.test/p.gif">',
        'a handler after a slash, not a space': '<svg/onload=alert(1)><img/src="data:image/png;base64,AA"/onerror="alert(2)">',
        'a handler straight after a quoted value': '<img src="data:image/png;base64,AA"onerror="alert(1)">',
        'a javascript: URL spelled with entities': '<a href="jav&#x61;script:alert(1)">a</a><a href="java&#09;script:alert(2)">b</a><a href="javascript&colon;alert(3)">c</a>',
        'a <head> the parser never sees (in a comment)': '<!--<head>--><p>x</p>',
        'a refresh whose tag holds a quoted ">"': '<meta name=">" http-equiv="refresh" content="0;url=https://x.test/opened"><p>x</p>',
    };
    for (const [name, dirty] of Object.entries(BYPASSES)) {
        it(`a single pass is not enough: ${name}`, () => {
            // Positive control: the oracle sees the attack in the raw page, so an empty list below is a real absence.
            expect(violations(dirty), 'the oracle must see the raw attack').not.toEqual([]);
            expect(violations(sanitizeMockupHtml(dirty)), sanitizeMockupHtml(dirty)).toEqual([]);
        });
    }

    it('nesting deeper than any real page still ends, and nothing survives it', () => {
        const deep = `${'<scr'.repeat(200)}<script>${'ipt>'.repeat(200)}alert(1)`;
        const clean = sanitizeMockupHtml(deep);
        expect(violations(clean), clean.slice(0, 200)).toEqual([]);
        expect(clean).not.toMatch(/<script/i);
    });

    it('CONTROL: what a mockup is made of survives — doctype first, <style>, data: images, local links, the CSP in <head>', () => {
        const page = '<!DOCTYPE html><html><head><title>Mock</title><style>.card{color:red}</style></head>'
            + '<body><a href="#pricing" class="nav">Pricing</a><img src="data:image/png;base64,AA" alt="logo"><div class="card" style="padding:4px">Kept</div></body></html>';
        const clean = sanitizeMockupHtml(page);
        expect(clean.startsWith('<!DOCTYPE html>'), 'a doctype that is not first puts the page in quirks mode').toBe(true);
        expect(clean).toContain('<style>.card{color:red}</style>');
        expect(clean).toContain('<a href="#pricing" class="nav">Pricing</a>');
        expect(clean).toContain('<img src="data:image/png;base64,AA" alt="logo">');
        expect(clean).toContain('<div class="card" style="padding:4px">Kept</div>');
        expect(violations(clean)).toEqual([]);
        const doc = new (new Window().DOMParser)().parseFromString(clean, 'text/html');
        expect(doc.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length, 'the policy is in <head>').toBe(1);
        expect(doc.title).toBe('Mock');
    });

    it('a question carries at most 6 visuals; an ask at most 12; a stored visual is well-formed', () => {
        const v = (n: number): QuestionVisual => ({ postId: `p${n}`, version: 1, title: `P${n}`, kind: 'image' });
        const q = (visuals: QuestionVisual[]): Question => ({ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], visuals });
        expect(QUESTION_VISUAL_LIMITS.perQuestion).toBe(6);
        expect(QUESTION_VISUAL_LIMITS.perAsk).toBe(12);
        expect(validateQuestions([q([1, 2, 3, 4, 5, 6, 7].map(v))])).toMatch(/6 visuals/);
        expect(validateQuestions([q([1, 2, 3, 4, 5].map(v)), q([6, 7, 8, 9, 10].map(v)), q([11, 12, 13].map(v))])).toMatch(/12 visuals/);
        expect(validateQuestions([q([{ postId: '', version: 1, title: 'x', kind: 'image' }])])).toMatch(/visual/);
    });

    it('CONTROL: a question with no visuals is as valid as ever', () => {
        expect(validateQuestions([{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }])).toBeNull();
    });
});

let dir: string;
let root: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-ftq-visuals-'));
    root = join(dir, 'ws');
    await mkdir(join(root, '.artboard'), { recursive: true });
    await mkdir(join(root, 'shots'), { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const caller = () => ({ agentId: 'agent_a', agentName: 'atlas', workspaceId: 'ws_1', workspacePath: root });
const board = async (): Promise<BoardPost[]> => parseBoard(await readFile(join(root, '.artboard', 'index.json'), 'utf8'));
const seedBoard = async (posts: BoardPost[]) => writeFile(join(root, '.artboard', 'index.json'), JSON.stringify({ posts }));
const POST: BoardPost = { id: 'login-v2', title: 'Login v2', kind: 'html', file: 'login-v2.html', createdAt: '2026-11-17T10:00:00.000Z', askVerdict: false };
const ask = (visuals: unknown, optionVisual?: unknown) => [{ header: 'Pick', question: 'Which login?', options: [{ label: 'A', ...(optionVisual ? { visual: optionVisual } : {}) }, { label: 'B' }], ...(visuals ? { visuals } : {}) }];

describe('prepareQuestionVisuals: what the agent named becomes ArtBoard posts of ITS workspace', () => {
    it('an ArtBoard id on the caller’s board: referenced at its latest version, with its title and kind', async () => {
        await seedBoard([POST]);
        await writeFile(join(root, '.artboard', 'login-v2.html'), '<p>x</p>');
        const r = await prepareQuestionVisuals(caller(), ask([{ artboard: 'login-v2' }]), () => '2026-11-18T00:00:00.000Z');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.questions[0]!.visuals).toEqual([{ postId: 'login-v2', version: 1, title: 'Login v2', kind: 'html' }]);
    });

    it('an id that is not on the caller’s board is refused by name (another workspace’s board is never read)', async () => {
        await seedBoard([POST]);
        const r = await prepareQuestionVisuals(caller(), ask([{ artboard: 'someone-elses' }]), () => '2026-11-18T00:00:00.000Z');
        expect(r).toEqual({ ok: false, reason: expect.stringMatching(/someone-elses.*not on your workspace's ArtBoard/) });
    });

    it('an image from the workspace is POSTED (copied, no verdict asked) and referenced; an option can carry one', async () => {
        await writeFile(join(root, 'shots', 'b.png'), PNG);
        const r = await prepareQuestionVisuals(caller(), ask(undefined, { image: 'shots/b.png', title: 'Mock B' }), () => '2026-11-18T00:00:00.000Z');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const ref = r.questions[0]!.options[0]!.visual!;
        expect(ref).toMatchObject({ kind: 'image', title: 'Mock B', version: 1 });
        const posts = await board();
        const post = posts.find((p) => p.id === ref.postId)!;
        expect(post).toMatchObject({ kind: 'image', askVerdict: false, agentId: 'agent_a', agentName: 'atlas' });
        expect(await readFile(join(root, '.artboard', post.file))).toEqual(PNG);
    });

    it('refused: outside the workspace, over the size cap, an unknown extension', async () => {
        await writeFile(join(dir, 'outside.png'), PNG);
        await writeFile(join(root, 'shots', 'huge.png'), Buffer.alloc(QUESTION_VISUAL_LIMITS.imageBytes + 1));
        await writeFile(join(root, 'shots', 'big.html'), `<p>${'x'.repeat(QUESTION_VISUAL_LIMITS.htmlBytes)}</p>`);
        const now = () => '2026-11-18T00:00:00.000Z';
        expect(await prepareQuestionVisuals(caller(), ask([{ image: '../outside.png' }]), now)).toEqual({ ok: false, reason: expect.stringMatching(/outside your workspace/) });
        expect(await prepareQuestionVisuals(caller(), ask([{ image: join(dir, 'outside.png') }]), now)).toEqual({ ok: false, reason: expect.stringMatching(/outside your workspace/) });
        expect(await prepareQuestionVisuals(caller(), ask([{ image: 'shots/huge.png' }]), now)).toEqual({ ok: false, reason: expect.stringMatching(/over the .* cap/) });
        expect(await prepareQuestionVisuals(caller(), ask([{ html: 'shots/big.html' }]), now)).toEqual({ ok: false, reason: expect.stringMatching(/over the .* cap/) });
        expect(await prepareQuestionVisuals(caller(), ask([{ image: 'shots/x.bmp' }]), now)).toEqual({ ok: false, reason: expect.stringMatching(/image|extension/) });
        // Nothing was posted by a refused ask.
        await expect(readFile(join(root, '.artboard', 'index.json'), 'utf8')).rejects.toThrow();
    });

    it('an HTML mockup is posted SANITISED', async () => {
        await writeFile(join(root, 'shots', 'm.html'), '<div onclick="x()">M</div><script>steal()</script>');
        const r = await prepareQuestionVisuals(caller(), ask([{ html: 'shots/m.html' }]), () => '2026-11-18T00:00:00.000Z');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const post = (await board()).find((p) => p.id === r.questions[0]!.visuals![0]!.postId)!;
        const body = await readFile(join(root, '.artboard', post.file), 'utf8');
        expect(body).toContain('M</div>');
        expect(body).not.toMatch(/<script|onclick/i);
    });

    it('CONTROL: no visuals — the questions as asked, and no board written', async () => {
        const r = await prepareQuestionVisuals(caller(), ask(undefined), () => '2026-11-18T00:00:00.000Z');
        expect(r).toEqual({ ok: true, questions: ask(undefined) });
        await expect(readFile(join(root, '.artboard', 'index.json'), 'utf8')).rejects.toThrow();
    });
});

describe('the answer and the paper trail', () => {
    it('the answer mailed to the agent records which visual was chosen', async () => {
        const inbox = await InboxStore.open(dir);
        const attention = await AttentionStore.open(dir, inbox);
        const agentId = mintAgentId();
        const visual: QuestionVisual = { postId: 'question-mock-b', version: 2, title: 'Mock B', kind: 'image' };
        const { questionId } = await attention.ask({ agentId, agentName: 'atlas', workspaceId: 'ws_1', questions: [{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B', visual }] }] }, { userActive: true });
        await attention.answer(questionId, { selections: [['B']], note: '' });
        const page = await inbox.receive({ participant: agentId });
        expect(page.messages.at(-1)!.text).toMatch(/→ B\n {2}Visual chosen: "Mock B" \(ArtBoard post question-mock-b, version 2\)/);
    });

    it('each post a question showed gets the decision on its trail: chosen, not chosen, shown — once', async () => {
        await seedBoard([
            { ...POST, id: 'a', file: 'a.html' },
            { ...POST, id: 'b', file: 'b.html' },
            { ...POST, id: 'c', file: 'c.html' },
        ]);
        const questions: Question[] = [{ header: 'Pick', question: 'Which?', visuals: [{ postId: 'c', version: 1, title: 'C', kind: 'html' }], options: [{ label: 'A', visual: { postId: 'a', version: 1, title: 'A', kind: 'html' } }, { label: 'B', visual: { postId: 'b', version: 1, title: 'B', kind: 'html' } }] }];
        const record = { questionId: 'q_1', outcome: 'answered' as const, questions, selections: [['B']] };
        await recordQuestionOnBoard(root, record, '2026-11-18T00:00:00.000Z');
        await recordQuestionOnBoard(root, record, '2026-11-18T00:00:01.000Z');
        const byId = new Map((await board()).map((p) => [p.id, p.trail ?? []]));
        expect(byId.get('a')).toEqual([{ type: 'question', version: 1, questionId: 'q_1', header: 'Pick', outcome: 'not-chosen', answer: 'B', at: '2026-11-18T00:00:00.000Z', by: 'person' }]);
        expect(byId.get('b')).toEqual([{ type: 'question', version: 1, questionId: 'q_1', header: 'Pick', outcome: 'chosen', answer: 'B', at: '2026-11-18T00:00:00.000Z', by: 'person' }]);
        expect(byId.get('c')).toEqual([{ type: 'question', version: 1, questionId: 'q_1', header: 'Pick', outcome: 'shown', answer: 'B', at: '2026-11-18T00:00:00.000Z', by: 'person' }]);
    });

    it('the board reads a question entry back, and the timeline shows it', () => {
        const entry = { type: 'question', version: 1, questionId: 'q_1', header: 'Pick', outcome: 'chosen', answer: 'B', at: '2026-11-18T00:00:00.000Z', by: 'person' };
        expect(trailFrom([entry])).toEqual([entry]);
        const events = timelineOf([{ n: 1, createdAt: '2026-11-17T00:00:00.000Z' }], trailFrom([entry]));
        expect(events.map((e) => e.kind)).toEqual(['version', 'question']);
    });

    it('CONTROL: a malformed entry is still dropped, a verdict still kept', () => {
        const verdict = { type: 'verdict', version: 1, verdict: 'approved', at: '2026-11-18T00:00:00.000Z' };
        expect(trailFrom([{ type: 'question', version: 1, at: '2026-11-18T00:00:00.000Z' }, verdict])).toEqual([verdict]);
    });

    it('a ref resolves to its post laid over the version it named; a post gone says so', () => {
        const posts: DisplayPost[] = [{ id: 'a', title: 'A', kind: 'html', createdAt: 'x', askVerdict: false, html: '<p>v2</p>', versions: [{ n: 1, kind: 'html', createdAt: 'x', html: '<p>v1</p>' }, { n: 2, kind: 'html', createdAt: 'y', html: '<p>v2</p>' }] }];
        const out = selectVisualPosts(posts, [{ postId: 'a', version: 1, title: 'A', kind: 'html' }, { postId: 'gone', version: 1, title: 'Gone', kind: 'image' }]);
        expect(out[0]).toMatchObject({ id: 'a', html: '<p>v1</p>' });
        expect(out[1]).toMatchObject({ id: 'gone', title: 'Gone', contentError: expect.stringMatching(/no longer on the ArtBoard/) });
    });
});

describe('the tool and the docs', () => {
    it('ForceTheQuestion’s schema takes visuals on a question and a visual on an option, and says so', () => {
        const schema = FORCE_THE_QUESTION_TOOL.inputSchema as unknown as { properties: { questions: { items: { properties: Record<string, { maxItems?: number; items?: { properties: Record<string, unknown> } }> } } } };
        const q = schema.properties.questions.items.properties;
        expect(q.visuals?.maxItems).toBe(6);
        expect(q.options?.items?.properties.visual).toBeDefined();
        expect(FORCE_THE_QUESTION_TOOL.description).toMatch(/ArtBoard/);
        expect(FORCE_THE_QUESTION_TOOL.description).toMatch(/visual/);
    });

    it('the handler prepares visuals for an ask AND an update before the store sees them', () => {
        const source = readFileSync('src/main/mcp-tools.ts', 'utf8');
        expect(source.match(/prepareQuestionVisuals\(/g)?.length).toBeGreaterThanOrEqual(1);
        expect(source).toMatch(/action === 'update'[\s\S]{0,900}prepared|prepared[\s\S]{0,900}attention\.update/);
        expect(source).toMatch(/recordQuestionOnBoard\(/);
    });

    it('the genie skill teaches it', () => {
        const skills = readFileSync('src/main/agent-skills.ts', 'utf8');
        expect(skills).toMatch(/ForceTheQuestion[^\n]*visuals/);
    });
});

const visualItem = (questions: Question[]) => ({
    id: 'q_v', source: 'agent-question', agentId: 'a1', agentName: 'atlas', workspaceId: 'ws_1', title: 'Pick', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'form', fields: questions.length, questions },
    forwardedFrom: null,
}) as unknown as DeckItem;
const IMG: DisplayPost = { id: 'b', title: 'Mock B', kind: 'image', createdAt: 'x', askVerdict: false, src: 'data:image/png;base64,iVBORw0KGgo=' };
const HTML: DisplayPost = { id: 'c', title: 'Page C', kind: 'html', createdAt: 'x', askVerdict: false, html: '<p>C</p>' };
const withVisuals: Question[] = [{ header: 'Pick', question: 'Which?', visuals: [{ postId: 'c', version: 1, title: 'Page C', kind: 'html' }], options: [{ label: 'A' }, { label: 'B', visual: { postId: 'b', version: 1, title: 'Mock B', kind: 'image' } }] }];
const render = (questions: Question[], visuals: { posts: readonly DisplayPost[] } | null) =>
    renderToStaticMarkup(<QuestionApp view={{ item: visualItem(questions), waiting: 0 }} sending={false} refusal={null} onAnswer={() => {}} onLater={() => {}} onDismiss={() => {}} now={10} visuals={visuals} />);

describe('the question window draws them', () => {
    it('a gallery under the question: each visual through the ArtBoard’s own preview (HTML in a frame with no script), each with full screen', () => {
        const html = render(withVisuals, { posts: [HTML, IMG] });
        expect(html).toMatch(/data-question-visuals="0"/);
        expect(html).toMatch(/<iframe[^>]*title="Page C"[^>]*sandbox=""/);
        expect(html).not.toMatch(/sandbox="[^"]*allow-scripts/);
        expect(html).toMatch(/data-action="question-visual-full"[^>]*aria-label="Show Page C full screen"|aria-label="Show Page C full screen"[^>]*data-action="question-visual-full"/);
    });

    it('an option tied to a visual shows it in its card: picking the card picks the mockup', () => {
        const html = render(withVisuals, { posts: [HTML, IMG] });
        expect(html).toMatch(/data-question-option="B"[\s\S]*?data-option-visual="b"[\s\S]*?<img[^>]*alt="Mock B"/);
        expect(html).not.toMatch(/data-question-option="A"[^>]*>(?:(?!data-question-option)[\s\S])*data-option-visual/);
    });

    it('full screen: the visual fills the window below its header, Esc or the button restores', () => {
        const html = renderToStaticMarkup(<QuestionVisuals posts={[IMG]} initialFull="b" />);
        const full = /<[^>]*data-question-visual-full="b"[^>]*>/.exec(html)?.[0] ?? '';
        expect(full).toContain('fixed');
        expect(full).toContain('top-11');
        expect(html).toMatch(/aria-label="Restore"[^>]*aria-keyshortcuts="Escape"|aria-keyshortcuts="Escape"[^>]*aria-label="Restore"/);
    });

    it('CONTROL: a question with no visuals draws no gallery and no option thumbnail', () => {
        const html = render([{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], null);
        expect(html).not.toContain('data-question-visuals');
        expect(html).not.toContain('data-option-visual');
    });

    it('the window asks main for them (its own workspace, or the driving window for a remote question)', () => {
        expect(readFileSync('src/main/question-preload.ts', 'utf8')).toMatch(/visuals: \(id: string\) => ipcRenderer\.invoke\('question:visuals', id\)/);
        const electron = readFileSync('src/main/question-window-electron.ts', 'utf8');
        expect(electron).toMatch(/ipcMain\.handle\('question:visuals'/);
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/remoteQuestions\.visuals\(/);
    });
});

describe('a remote driver sees the same', () => {
    const item = { id: 'q_9', source: 'agent-question', agentId: 'a1', workspaceId: 'ws_h', title: 'T', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 1, questions: withVisuals }, forwardedFrom: null } as unknown as DeckItem;

    it('the visuals are read through the window driving the host, and come back as its board’s posts', async () => {
        const sent: { id: string; action: { kind: string; item: DeckItem } }[] = [];
        const rq = new RemoteQuestions({ send: (_s, request) => { sent.push(request as never); return true; } });
        rq.report(7, 'host-a', [item]);
        const shown = rq.items()[0]!;
        const got = rq.visuals(shown);
        expect(sent[0]!.action.kind).toBe('deck.visuals');
        expect(sent[0]!.action.item.id).toBe('q_9');
        rq.settle(7, sent[0]!.id, { ok: true, posts: [IMG] });
        await expect(got).resolves.toEqual({ posts: [IMG] });
    });

    it('CONTROL: an answer still goes the same way and resolves on ok', async () => {
        const sent: { id: string }[] = [];
        const rq = new RemoteQuestions({ send: (_s, request) => { sent.push(request); return true; } });
        rq.report(7, 'host-a', [item]);
        const done = rq.act(rq.items()[0]!, { kind: 'deck.answerForm', selections: [['A']], notes: [''] });
        rq.settle(7, sent[0]!.id, { ok: true });
        await expect(done).resolves.toBeUndefined();
    });

    it('the driving window answers deck.visuals from its own ArtBoard bridge', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/'deck\.visuals'[\s\S]{0,600}artboard[\s\S]{0,200}\.read\(/);
    });
});
