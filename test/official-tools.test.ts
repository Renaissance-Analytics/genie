import { Agent as SlideAgent } from '@particle-academy/dark-slide';
import { Agent as SheetAgent } from '@particle-academy/holy-sheet';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { parseBoard } from '../src/core/artboard.js';
import { parseManifest } from '../src/core/plugins.js';
import { PluginHost } from '../src/main/plugin-host.js';
import { readArtBoard, reviewArtBoardPost } from '../src/main/artboard-host.js';
import { runOfficialTool } from '../src/main/official-tools.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';

/**
 * THE OFFICIAL PLUGINS' TOOLS AND PANELS (beta.33 item 14, part two; Genie 1 main/plugins/official.ts + artboard-plugin.ts +
 * main/artboard/*). Genie 1's agents could make a deck (`presentation.createDeck`), a workbook (`spreadsheet.createWorkbook`)
 * and put what they MADE in front of a person (`artboard.post`), whose verdict came back to them; the Repository plugin gave
 * the workspace a git panel. Genie 2 had none of it. The tools run INSIDE Genie (they are Genie's own code, shipped in the
 * app) under the same declared-capability guard as any plugin's: a write outside the workspace, or of a type the plugin did
 * not declare, is refused.
 */

let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), 'genie2-official-tools-')); });
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

const caller = () => ({ agentId: 'agent_7', agentName: 'atlas', workspaceId: 'tynn', workspacePath: ws });
const manifestOf = (id: string) => {
    const r = parseManifest(OFFICIAL_PLUGINS.find((p) => (p.manifest as { id: string }).id === id)!.manifest);
    if (!r.ok) throw new Error(r.reason);
    return r.manifest;
};

describe('the official manifests carry their tools and panels', () => {
    it('Presentation offers createDeck, Spreadsheet createWorkbook, ArtBoard post + its board panel, Repository its changes panel', () => {
        expect(manifestOf('ai.genie.presentation').mcpTools.map((t) => t.name)).toEqual(['createDeck']);
        expect(manifestOf('ai.genie.spreadsheet').mcpTools.map((t) => t.name)).toEqual(['createWorkbook']);
        expect(manifestOf('ai.genie.artboard').mcpTools.map((t) => t.name)).toEqual(['post']);
        expect(manifestOf('ai.genie.artboard').panels).toMatchObject([{ id: 'board', title: 'ArtBoard', fancyComponent: { export: 'ArtBoardPanel' } }]);
        expect(manifestOf('ai.genie.repository').panels).toMatchObject([{ id: 'changes', title: 'Repository', fancyComponent: { export: 'RepoChangesPanel' } }]);
    });

    it('the host offers their tools and panels — and marks the tools as Genie\'s own, run in-process', async () => {
        const host = await PluginHost.open({ dir: join(ws, 'plugins'), keys: {}, developerMode: false, official: OFFICIAL_PLUGINS });
        const tools = host.tools().map((t) => `${t.pluginId}.${t.tool.name}:${t.official === true}`);
        expect(tools).toEqual(expect.arrayContaining(['ai.genie.presentation.createDeck:true', 'ai.genie.spreadsheet.createWorkbook:true', 'ai.genie.artboard.post:true']));
        expect(host.panels().map((p) => `${p.pluginId}/${p.id}`)).toEqual(expect.arrayContaining(['ai.genie.artboard/board', 'ai.genie.repository/changes']));
        await host.setEnabled('ai.genie.artboard', false);
        expect(host.tools().some((t) => t.pluginId === 'ai.genie.artboard')).toBe(false);
    });
});

describe('createDeck and createWorkbook', () => {
    it('createDeck writes a real .pptx in the workspace that dark-slide reads back', async () => {
        const r = await runOfficialTool({ pluginId: 'ai.genie.presentation', tool: 'createDeck', args: { title: 'Q3 Review', slides: [{ title: 'Revenue', bullets: ['up 20%'] }] }, caller: caller(), manifest: manifestOf('ai.genie.presentation') });
        expect(r).toMatchObject({ ok: true });
        const deck = SlideAgent.read(await readFile(join(ws, 'q3-review.pptx')));
        expect(JSON.stringify(deck)).toContain('up 20%');
    });

    it('createWorkbook writes a real .xlsx that holy-sheet reads back', async () => {
        const r = await runOfficialTool({ pluginId: 'ai.genie.spreadsheet', tool: 'createWorkbook', args: { title: 'People', headers: ['name', 'age'], rows: [['Ada', 36]] }, caller: caller(), manifest: manifestOf('ai.genie.spreadsheet') });
        expect(r).toMatchObject({ ok: true });
        expect(JSON.stringify(SheetAgent.read(await readFile(join(ws, 'people.xlsx'))))).toContain('Ada');
    });

    it('a path outside the workspace, or a type the plugin did not declare, is refused and nothing is written', async () => {
        const deck = { slides: [{ title: 'x' }] };
        expect(await runOfficialTool({ pluginId: 'ai.genie.presentation', tool: 'createDeck', args: { ...deck, path: '../escape.pptx' }, caller: caller(), manifest: manifestOf('ai.genie.presentation') })).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the workspace/) });
        expect(await runOfficialTool({ pluginId: 'ai.genie.presentation', tool: 'createDeck', args: { ...deck, path: 'notes.txt' }, caller: caller(), manifest: manifestOf('ai.genie.presentation') })).toMatchObject({ ok: true });
        // `.txt` is not declared: the tool makes it `notes.txt.pptx`, never a .txt.
        await expect(readFile(join(ws, 'notes.txt'))).rejects.toThrow();
    });
});

describe('the ArtBoard: post, show, verdict back to the agent that posted', () => {
    it('post writes the artifact and the index, recording WHO posted (from the caller, never the args)', async () => {
        const r = await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Login screen', html: '<h1>Hi</h1>', agentId: 'someone_else' }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        expect(r).toMatchObject({ ok: true });
        expect(await readFile(join(ws, '.artboard', 'login-screen.html'), 'utf8')).toBe('<h1>Hi</h1>');
        const board = parseBoard(await readFile(join(ws, '.artboard', 'index.json'), 'utf8'));
        expect(board).toMatchObject([{ id: 'login-screen', title: 'Login screen', kind: 'html', file: 'login-screen.html', agentId: 'agent_7' }]);
    });

    it('an image post is COPIED onto the board; re-posting the same id replaces the card', async () => {
        await mkdir(join(ws, 'out'), { recursive: true });
        await writeFile(join(ws, 'out', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Hero', kind: 'image', imagePath: 'out/shot.png', id: 'hero' }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Hero v2', kind: 'image', imagePath: 'out/shot.png', id: 'hero' }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        const shown = await readArtBoard(ws);
        expect(shown.posts).toHaveLength(1);
        expect(shown.posts[0]).toMatchObject({ id: 'hero', title: 'Hero v2', kind: 'image', src: expect.stringMatching(/^data:image\/png;base64,/) });
    });

    it('a verdict is written to the board and delivered to the agent that posted, with the comment', async () => {
        await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Login screen', html: '<h1>Hi</h1>', askVerdict: true }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        const sent: { to: string; text: string }[] = [];
        const r = await reviewArtBoardPost(ws, 'login-screen', { verdict: 'rejected', comment: 'More contrast' }, { send: async (to, text) => { sent.push({ to, text }); }, now: () => '2026-10-20T00:00:00.000Z' });
        expect(r).toEqual({ ok: true, delivered: true });
        expect(sent).toEqual([{ to: 'agent_7', text: expect.stringMatching(/"Login screen" was rejected\. Comment: More contrast.*SAME id \(`login-screen`\)/) }]);
        expect((await readArtBoard(ws)).posts[0]!.review).toEqual({ verdict: 'rejected', comment: 'More contrast', at: '2026-10-20T00:00:00.000Z' });
        expect(await reviewArtBoardPost(ws, 'gone', { verdict: 'approved' }, { send: async () => {}, now: () => '' })).toEqual({ ok: false, error: 'That post is no longer on the board.' });
    });

    it('a verdict is OPT-IN per post: askVerdict is in the schema, and without it the post just shows (genie#1275)', async () => {
        const post = manifestOf('ai.genie.artboard').mcpTools.find((t) => t.name === 'post')!;
        expect((post.inputSchema as { properties: Record<string, { type: string }> }).properties.askVerdict).toMatchObject({ type: 'boolean' });
        expect(post.description).toMatch(/askVerdict/);
        // The skill agents read says it too, or they keep asking for a verdict on everything (or on nothing).
        expect(GENIE_SKILLS.find((k) => k.name === 'genie')!.body).toMatch(/artboard\.post[\s\S]*askVerdict/);

        const shown = await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Palette', html: '<p>x</p>' }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        expect(shown).toMatchObject({ ok: true, result: { text: expect.not.stringMatching(/approve or reject/) } });
        const asked = await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Login', html: '<p>y</p>', askVerdict: true }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        expect(asked).toMatchObject({ ok: true, result: { text: expect.stringMatching(/approve or reject/) } });

        // Written EXPLICITLY, both ways: on disk, a post with no field is one from before #1275, which asked.
        const raw = JSON.parse(await readFile(join(ws, '.artboard', 'index.json'), 'utf8')) as { posts: { id: string; askVerdict?: boolean }[] };
        expect(raw.posts.map((p) => [p.id, p.askVerdict])).toEqual([['login', true], ['palette', false]]);
        expect((await readArtBoard(ws)).posts.map((p) => [p.id, p.askVerdict])).toEqual([['login', true], ['palette', false]]);
    });

    it('a post that asked for no verdict cannot be given one: nothing is written and nobody is messaged', async () => {
        await runOfficialTool({ pluginId: 'ai.genie.artboard', tool: 'post', args: { title: 'Palette', html: '<p>x</p>' }, caller: caller(), manifest: manifestOf('ai.genie.artboard') });
        const sent: string[] = [];
        const r = await reviewArtBoardPost(ws, 'palette', { verdict: 'approved' }, { send: async (to) => { sent.push(to); }, now: () => '2026-10-27T00:00:00.000Z' });
        expect(r).toEqual({ ok: false, error: 'That post did not ask for a verdict.' });
        expect(sent).toEqual([]);
        expect((await readArtBoard(ws)).posts[0]!.review).toBeUndefined();
    });
});
