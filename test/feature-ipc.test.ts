import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE FEATURE SURFACES' MAIN-SIDE HALF — the renderer sends a `FeatureAction`, the main process
 * applies it to the composed services and answers with the next `FeatureData`. Every action from a
 * surface is a USER action, so arming a flow here is allowed (an agent's arm goes through the MCP
 * tool and is refused there). Tested against the real composition root on a temp dir, with a fake
 * pty — no Electron.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[] = [];
/** An agent on the roster — what the registry hands the composed services. */
const onRoster = (id: string, name: string, workspaceId: string): void => {
    roster.push({ id, workspaceId, provider: 'claude', name, instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null } as never);
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-'));
    roster = [];
    // One registered workspace, `tynn`, at the temp dir: a site created in Hosting is kept in ITS project.json.
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, workspaces: () => [{ id: 'tynn', path: dir }] });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('the snapshot', () => {
    it('reports every section MEASURED (never null) once the services exist — the knowledge hits too: with no search, what the graph holds (empty here)', async () => {
        const snap = await featureSnapshot(services, { toolStatuses: null, knowledgeQuery: '' });
        expect(snap.flows).toEqual({ flows: [], adding: null });
        expect(snap.hosting).toEqual({ sites: [], processes: [], adding: null, editing: null, frontDoor: { running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' } });
        expect(snap.inbox).toEqual({ unread: [], peers: [], recent: [] });
        expect(snap.settings.values).toMatchObject({ theme: 'system', restore_agents_on_launch: false });
        expect(snap.knowledge).toEqual({ hits: [], query: '', adding: null, lastAdd: null });
        // The toolchain is the one section that needs a scan — null until one has run.
        expect(snap.toolchain).toBeNull();
        expect(snap.browser).toEqual({ url: null, routes: [] });
    });
});

describe('actions', () => {
    it('knowledge.search answers with hits for the query, system + every workspace (the human sees all)', async () => {
        services.knowledge.add({ title: 'Caddy note', body: 'replace breaks h2', scope: { kind: 'workspace', id: 'tynn' }, source: 'user' });
        const snap = await handleFeatureAction(services, { kind: 'knowledge.search', query: 'caddy' });
        expect(snap.knowledge.query).toBe('caddy');
        expect(snap.knowledge.hits!.map((h) => h.title)).toEqual(['Caddy note']);
    });

    it('flows.arm / disarm / remove act as the USER, so arming succeeds; the snapshot reflects it', async () => {
        const doc = { version: 1, nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '*/5 * * * *', timezone: 'UTC' } }], edges: [] };
        const f = await services.flows.create({ workspaceId: 'tynn', name: 'tick', document: doc, by: { kind: 'agent', id: 'agent_a', name: 'atlas' } });
        expect(f.armed).toBe(false);
        let snap = await handleFeatureAction(services, { kind: 'flows.arm', flowId: f.id });
        expect(snap.flows!.flows[0]!.armed).toBe(true);
        snap = await handleFeatureAction(services, { kind: 'flows.disarm', flowId: f.id });
        expect(snap.flows!.flows[0]!.armed).toBe(false);
        snap = await handleFeatureAction(services, { kind: 'flows.remove', flowId: f.id });
        expect(snap.flows!.flows).toEqual([]);
    });

    it('settings.set validates through the store and settings.reset returns the default', async () => {
        let snap = await handleFeatureAction(services, { kind: 'settings.set', key: 'theme', value: 'light' });
        expect(snap.settings.values!.theme).toBe('light');
        await expect(handleFeatureAction(services, { kind: 'settings.set', key: 'theme', value: 'sepia' })).rejects.toThrow(/sepia/);
        snap = await handleFeatureAction(services, { kind: 'settings.reset', key: 'theme' });
        expect(snap.settings.values!.theme).toBe('system');
    });

    it('inbox.markRead commits the HUMAN’s cursor for that message and nothing else', async () => {
        const a = 'agent_' + 'a'.repeat(32);
        await services.inbox.send({ from: a as never, to: 'human', text: 'one' });
        await services.inbox.send({ from: a as never, to: 'human', text: 'two' });
        const first = services.inbox.unread('human')[0]!;
        const snap = await handleFeatureAction(services, { kind: 'inbox.markRead', messageId: first.id });
        expect(snap.inbox!.unread.map((m) => m.text)).toEqual(['two']);
    });

    it('inbox.send from the human reaches the agent by address, and the snapshot stays the human’s view', async () => {
        const a = 'agent_' + 'b'.repeat(32);
        onRoster(a, 'atlas', 'tynn');
        await handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'hello atlas' });
        expect(services.inbox.unread(a as never).map((m) => m.text)).toEqual(['hello atlas']);
        await expect(handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:ghost', text: 'x' })).rejects.toThrow(/claude:ghost/);
    });

    it('hosting.stopSite stops the site and the routes empty; browser.navigate records the url', async () => {
        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        let snap = await handleFeatureAction(services, { kind: 'browser.navigate', url: 'tynn.gen' });
        expect(snap.browser.url).toBe('https://tynn.gen/');
        expect(snap.browser.routes).toEqual([{ host: 'docs.gen', target: '127.0.0.1:5173' }]);
        snap = await handleFeatureAction(services, { kind: 'hosting.stopSite', siteId: 'site_docs' });
        expect(snap.hosting!.sites[0]!.state).toBe('stopped');
        expect(snap.browser.routes).toEqual([]);
    });
});

describe('opening the forms', () => {
    it('hosting.addSite opens the form with defaults read from the repo folder; hosting.cancelForm closes it', async () => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(dir, 'artisan'), '');
        let snap = await handleFeatureAction(services, { kind: 'hosting.addSite', workspaceId: 'tynn', repoPath: dir });
        expect(snap.hosting!.adding).toMatchObject({ workspaceId: 'tynn', repoPath: dir, problems: [], defaults: { mode: 'proxy', devServer: { stack: 'laravel' } } });
        snap = await handleFeatureAction(services, { kind: 'hosting.cancelForm' });
        expect(snap.hosting!.adding).toBeNull();
    });

    it('flows.add opens the flow form with the hourly default for the workspace', async () => {
        const snap = await handleFeatureAction(services, { kind: 'flows.add', workspaceId: 'tynn' });
        expect(snap.flows!.adding).toMatchObject({ problems: [], defaults: { name: 'tynn hourly', armed: false } });
    });
});

describe('submitting the forms', () => {
    it('hosting.createSite creates the site from a valid form (the route appears) and keeps it in project.json; an invalid form rejects with every problem', async () => {
        await writeFile(join(dir, 'project.json'), `${JSON.stringify({ name: 'tynn', repos: [] }, null, 2)}\n`, 'utf8');
        const snap = await handleFeatureAction(services, {
            kind: 'hosting.createSite',
            workspaceId: 'tynn',
            repoPath: dir,
            form: { name: 'docs', mode: 'proxy', devServer: null, hostPort: 5173, root: null, spa: false },
        });
        expect(snap.hosting!.sites.map((s) => [s.host, s.port, s.state])).toEqual([['docs.gen', 5173, 'external']]);
        expect(snap.browser.routes).toEqual([{ host: 'docs.gen', target: '127.0.0.1:5173' }]);
        const kept = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as { sites: Record<string, unknown> };
        expect(Object.values(kept.sites)).toEqual([{ repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'docs', genName: 'docs.gen', hostPort: 5173 }]);
        // a refused submit keeps the form open with every problem — shown where it was caused, not logged.
        const refused = await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'tynn', repoPath: dir, form: { name: 'docs', mode: 'proxy', devServer: null, hostPort: null, root: null, spa: false } });
        expect(refused.hosting!.adding!.problems.map((p) => p.field)).toEqual(['name', 'hostPort']);
        expect(refused.hosting!.sites).toHaveLength(1);
    });

    it('flows.create creates an UNARMED flow from a valid form as the user; an invalid form rejects naming the node', async () => {
        const form = { workspaceId: 'tynn', name: 'nightly', document: { version: 1, nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 2 * * *', timezone: 'UTC' } }], edges: [] }, armed: true };
        const snap = await handleFeatureAction(services, { kind: 'flows.create', form });
        expect(snap.flows!.flows.map((f) => [f.name, f.armed, f.createdBy.kind])).toEqual([['nightly', true, 'user']]);
        // a refused flow submit keeps the form open naming the node; nothing is created.
        const refused = await handleFeatureAction(services, { kind: 'flows.create', form: { ...form, document: { ...form.document, nodes: [{ ...form.document.nodes[0]!, config: { cron: 'nope' } }] } } });
        expect(refused.flows!.adding!.problems[0]!.message).toMatch(/Node t/);
        expect(refused.flows!.flows).toHaveLength(1);
        // and a successful submit closes the form.
        expect(snap.flows!.adding).toBeNull();
    });
});
