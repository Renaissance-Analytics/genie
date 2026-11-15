import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBoard, versionsOf } from '../src/core/artboard.js';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { parseManifest } from '../src/core/plugins.js';
import { readArtBoard, reviewArtBoardPost } from '../src/main/artboard-host.js';
import { artboardReview } from '../src/main/official-panels-host.js';
import { runOfficialTool } from '../src/main/official-tools.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';

/**
 * ARTBOARD TOOL AND HOST, WITH A TRAIL (Tynn #739). An agent posts anything that needs a look — HTML at the size it was made
 * for, an image, a Markdown or PDF document — re-posting an id adds a version instead of replacing it, and the agent can READ
 * what the person decided and said so the revision answers the last comment. The person's verdicts are kept (not overwritten),
 * and pinning is a click that survives a restart.
 */
let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'genie2-artboard-trail-')); });
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

const caller = (over: Partial<{ agentId: string; agentName: string }> = {}) => ({ agentId: 'agent_7', agentName: 'atlas', workspaceId: 'tynn', workspacePath: ws, ...over });
const manifest = (() => {
    const r = parseManifest(OFFICIAL_PLUGINS.find((p) => (p.manifest as { id: string }).id === 'ai.genie.artboard')!.manifest);
    if (!r.ok) throw new Error(r.reason);
    return r.manifest;
})();
const post = (args: Record<string, unknown>, who = caller()) => runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args, caller: who, manifest });
const index = async () => parseBoard(await readFile(join(ws, '.artboard', 'index.json'), 'utf8'));
const now = (() => { let n = 0; return () => `2026-11-15T12:${String(n++).padStart(2, '0')}:00.000Z`; })();
const verdict = (id: string, v: 'approved' | 'rejected', comment?: string) => reviewArtBoardPost(ws, id, { verdict: v, comment }, { send: async () => {}, now });

describe('re-posting an id adds a version; nothing is overwritten', () => {
    it('writes each version to its own file and keeps the earlier one readable', async () => {
        await post({ title: 'Login', html: '<h1>one</h1>', id: 'login', askVerdict: true });
        await post({ title: 'Login', html: '<h1>two</h1>', id: 'login', note: 'more contrast' });
        expect(await readFile(join(ws, '.artboard', 'login.html'), 'utf8')).toBe('<h1>one</h1>');
        expect(await readFile(join(ws, '.artboard', 'login.v2.html'), 'utf8')).toBe('<h1>two</h1>');
        const [item] = await index();
        expect(versionsOf(item!).map((v) => [v.n, v.file, v.agentName])).toEqual([[1, 'login.html', 'atlas'], [2, 'login.v2.html', 'atlas']]);
        const shown = (await readArtBoard(ws)).posts[0]!;
        expect(shown.html).toBe('<h1>two</h1>');
        expect(shown.versions!.map((v) => v.html)).toEqual(['<h1>one</h1>', '<h1>two</h1>']);
    });

    it('a revision keeps the trail and the pin, and waits for a verdict again', async () => {
        await post({ title: 'Login', html: '<h1>one</h1>', id: 'login', askVerdict: true });
        await verdict('login', 'rejected', 'More contrast');
        await artboardReview({ workspacePath: () => ws, send: async () => {}, now }, 'tynn', 'login', 'pin', null);
        await post({ title: 'Login', html: '<h1>two</h1>', id: 'login', askVerdict: true });
        const [item] = await index();
        expect(item).toMatchObject({ pinned: true, trail: [{ type: 'verdict', verdict: 'rejected', comment: 'More contrast', version: 1 }] });
        expect(item!.review).toBeUndefined();
    });

    it('says in its answer that it was added as a version, and where the person finds it', async () => {
        await post({ title: 'Login', html: '<p>1</p>', id: 'login' });
        const second = await post({ title: 'Login', html: '<p>2</p>', id: 'login', askVerdict: true });
        expect(second).toMatchObject({ ok: true, result: { text: expect.stringMatching(/version 2/) } });
        expect(second).toMatchObject({ ok: true, result: { link: 'genie://workspace/tynn?view=artboard&item=login' } });
    });
});

describe('new kinds', () => {
    it('HTML keeps the size it was made for', async () => {
        await post({ title: 'Hero', html: '<h1>x</h1>', id: 'hero', width: 1280, height: 800 });
        expect((await index())[0]).toMatchObject({ width: 1280, height: 800 });
        expect((await readArtBoard(ws)).posts[0]).toMatchObject({ width: 1280, height: 800 });
    });

    it('a Markdown document is posted as text, or copied from a file', async () => {
        await post({ title: 'Spec', kind: 'markdown', markdown: '# Spec\n\nHello', id: 'spec' });
        expect(await readFile(join(ws, '.artboard', 'spec.md'), 'utf8')).toBe('# Spec\n\nHello');
        await mkdir(join(ws, 'docs'), { recursive: true });
        await writeFile(join(ws, 'docs', 'plan.md'), '# Plan');
        await post({ title: 'Plan', kind: 'markdown', filePath: 'docs/plan.md', id: 'plan' });
        expect((await readArtBoard(ws)).posts.find((p) => p.id === 'plan')).toMatchObject({ kind: 'markdown', text: '# Plan' });
    });

    it('a PDF is copied onto the board and shown as a data URL', async () => {
        await mkdir(join(ws, 'out'), { recursive: true });
        await writeFile(join(ws, 'out', 'brief.pdf'), Buffer.from('%PDF-1.4'));
        const r = await post({ title: 'Brief', kind: 'pdf', filePath: 'out/brief.pdf', id: 'brief' });
        expect(r).toMatchObject({ ok: true });
        expect((await readArtBoard(ws)).posts[0]).toMatchObject({ kind: 'pdf', src: expect.stringMatching(/^data:application\/pdf;base64,/) });
    });

    it('refuses a document that has nothing in it, in words, and writes nothing', async () => {
        expect(await post({ title: 'Spec', kind: 'markdown', id: 'spec' })).toMatchObject({ ok: false, reason: expect.stringMatching(/markdown/i) });
        expect(await post({ title: 'Brief', kind: 'pdf', id: 'brief' })).toMatchObject({ ok: false, reason: expect.stringMatching(/filePath/) });
        await expect(readFile(join(ws, '.artboard', 'index.json'), 'utf8')).rejects.toThrow();
    });

    it('an image still takes imagePath, as before', async () => {
        await mkdir(join(ws, 'out'), { recursive: true });
        await writeFile(join(ws, 'out', 'shot.png'), Buffer.from([0x89, 0x50]));
        expect(await post({ title: 'Hero', kind: 'image', imagePath: 'out/shot.png', id: 'hero' })).toMatchObject({ ok: true });
    });
});

describe('an agent reads the trail, so a revision answers the last comment', () => {
    const read = (args: Record<string, unknown>) => runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { readTrail: true, ...args }, caller: caller(), manifest });

    it('returns the item\'s versions, verdicts and comments, and what is waiting', async () => {
        await post({ title: 'Login', html: '<h1>one</h1>', id: 'login', askVerdict: true });
        await verdict('login', 'rejected', 'More contrast');
        const r = await read({ id: 'login' });
        expect(r).toMatchObject({ ok: true, result: { trail: { id: 'login', status: 'rejected', currentVersion: 1, lastVerdict: { verdict: 'rejected', comment: 'More contrast' } } } });
        expect((r as { result: { text: string } }).result.text).toMatch(/More contrast/);
    });

    it('with no id, lists every item and its status', async () => {
        await post({ title: 'Login', html: '<p>1</p>', id: 'login', askVerdict: true });
        await post({ title: 'Palette', html: '<p>2</p>', id: 'palette' });
        const r = (await read({})) as { ok: true; result: { items: Array<{ id: string; status: string }> } };
        expect(r.result.items.map((i) => [i.id, i.status]).sort()).toEqual([['login', 'waiting'], ['palette', 'shown']]);
    });

    it('a post carrying a reply records what the agent did about the last comment, against the version it answers', async () => {
        await post({ title: 'Login', html: '<h1>one</h1>', id: 'login', askVerdict: true });
        await verdict('login', 'rejected', 'More contrast');
        await post({ title: 'Login', html: '<h1>two</h1>', id: 'login', askVerdict: true, reply: 'Darkened the header to #111.' });
        const [item] = await index();
        expect(item!.trail!.map((e) => e.type)).toEqual(['verdict', 'reply']);
        expect(item!.trail![1]).toMatchObject({ type: 'reply', text: 'Darkened the header to #111.', agentName: 'atlas', version: 2 });
    });

    it('asking for an item that is not there says so', async () => {
        expect(await read({ id: 'nope' })).toMatchObject({ ok: false, reason: expect.stringMatching(/no item/i) });
    });

    it('the tool\'s own description tells the agent it can read the trail and how a revision is posted', () => {
        const tool = manifest.mcpTools.find((t) => t.name === 'post')!;
        expect(tool.description).toMatch(/readTrail/);
        expect(tool.description).toMatch(/version/);
        expect((tool.inputSchema as { properties: Record<string, unknown> }).properties).toMatchObject({ readTrail: { type: 'boolean' }, reply: { type: 'string' }, width: { type: 'integer' }, markdown: { type: 'string' }, filePath: { type: 'string' } });
        expect((tool.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind.enum).toEqual(['html', 'image', 'markdown', 'pdf']);
        expect((tool.inputSchema as { required?: string[] }).required ?? []).not.toContain('title');
        expect(GENIE_SKILLS.find((k) => k.name === 'genie')!.body).toMatch(/artboard\.post[\s\S]*readTrail/);
    });
});

describe('the person\'s verdicts and pins on the host', () => {
    const deps = () => ({ workspacePath: (id: string) => (id === 'tynn' ? ws : null), send: async () => {}, now });

    it('each verdict is kept in the trail with who and when; a changed mind leaves both', async () => {
        await post({ title: 'Login', html: '<p>1</p>', id: 'login', askVerdict: true });
        await verdict('login', 'rejected', 'No');
        await verdict('login', 'approved');
        const [item] = await index();
        expect(item!.trail!.map((e) => e.type === 'verdict' ? [e.verdict, e.by] : null)).toEqual([['rejected', 'person'], ['approved', 'person']]);
        expect(item!.review).toMatchObject({ verdict: 'approved' });
    });

    it('pin and unpin are written to the workspace, so they survive a restart', async () => {
        await post({ title: 'Login', html: '<p>1</p>', id: 'login', askVerdict: true });
        await verdict('login', 'approved');
        expect(await artboardReview(deps(), 'tynn', 'login', 'pin', null)).toEqual({ ok: true, delivered: false });
        expect((await index())[0]!.pinned).toBe(true);
        expect((await readArtBoard(ws)).posts[0]!.pinned).toBe(true);
        expect(await artboardReview(deps(), 'tynn', 'login', 'unpin', null)).toEqual({ ok: true, delivered: false });
        expect((await index())[0]!.pinned).toBeUndefined();
    });

    it('pinning an item that is gone, or in a workspace Genie does not have, is refused in words', async () => {
        expect(await artboardReview(deps(), 'tynn', 'gone', 'pin', null)).toEqual({ ok: false, error: 'That post is no longer on the board.' });
        expect(await artboardReview(deps(), 'nope', 'x', 'pin', null)).toEqual({ ok: false, error: 'Genie does not have that workspace' });
    });

    it('a pin messages nobody', async () => {
        const sent: string[] = [];
        await post({ title: 'Login', html: '<p>1</p>', id: 'login', askVerdict: true });
        await artboardReview({ ...deps(), send: async (to: string) => { sent.push(to); } }, 'tynn', 'login', 'pin', null);
        expect(sent).toEqual([]);
    });
});
