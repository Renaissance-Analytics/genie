import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEngineFrame } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { TynnPage, TynnPageQuery } from '../src/core/tynn-pages.js';
import { NOT_CONNECTED, SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { readTynnPage } from '../src/main/tynn-page-client.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';

const TOKEN = 'd'.repeat(64);
const WIP = { project_id: 'host-project', view: 'attention', active_version: null, available_versions: [], stories: [], selected_story: null, tasks: [], story_counts: { active: 0, attention: 0, done: 0, backlog: 0 } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const RELEASES = { project_id: 'host-project', releases: [{ id: 'v1', number: '1.0.0', title: 'First', description: null, why: null, released_at: '2026-10-01T00:00:00+00:00', pr_id: null, repository_id: null, story_count: 1, story_done_count: 1, top_stories: [{ id: 's1', story_number: 1, title: 'One', status: 'done' }] }] };

const VIP = { project_id: 'host-project', vip_version: null, stories: [], past_vips: [], can_start_vip: false };
const FEATURES = { project_id: 'host-project', features: [{ id: 'f1', title: 'Board', task_count: 2, task_done: 1 }], domains: [], repositories: [], models: [], envelope_status: 'present', can_manage: false };
const HOME = { project_id: 'host-project', section: 'dashboard', details: null, dashboard: { range: 7, metrics: {}, taskBreakdown: {}, storyBreakdown: {}, sparkline: [], charts: {}, availableVersions: [], version: null, versionComparison: [], attention: [], recentActivity: [] } };

async function window(local: boolean, service = true) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-tynn-page-host-'));
    const requests: Array<{ path: string; method: string }> = [];
    const ports: TynnBoardPorts = {
        signedIn: () => true,
        projectFor: id => id === 'work' ? 'host-project' : null,
        request: async (path, init) => {
            requests.push({ path, method: init.method });
            return { ok: true, status: 200, json: async () => (path.includes('/releases') ? RELEASES : path.includes('/home') ? HOME : path.includes('/features') ? FEATURES : path.endsWith('/vip') ? VIP : WIP) };
        },
    };
    const tynnPages = { read: (id: string, page: unknown, query: unknown) => readTynnPage(ports, id, page as TynnPage, query as TynnPageQuery) };
    const server = new SessionEngineServer({ token: TOKEN, build: 'test', ...(service ? { tynnPages } : {}) });
    const host = new SessionHost({ userData: dir, driverFor: () => { throw new Error('this read must start no provider'); }, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, ...server.hostOptions() });
    server.attach(host);
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide, { local });
    const client = new SessionEngineClient();
    cleanups.push(async () => { client.disconnect(); await host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    const read = async (id: string, page: string, query: Record<string, unknown>) => {
        // Check the table before sending: an unlisted method would close the link, not exercise the read.
        expect(parseEngineFrame(JSON.stringify({ kind: 'call', id: 42, method: 'engine.tynnPage', args: [id, page, query] }))).toMatchObject({ ok: true });
        return client.call('engine.tynnPage' as Parameters<SessionEngineClient['call']>[0], [id, page, query]);
    };
    return { read, requests, client };
}

describe('WIP is read on genie-host', () => {
    it('a local window gets WIP for the host registry project; a supplied project or URL cannot replace it', async () => {
        const w = await window(true);
        expect(await w.read('work', 'wip', { view: 'attention', project_id: 'other', path: 'https://elsewhere.test', product: 'product-1' })).toMatchObject({ ok: true, value: { ok: true, page: 'wip', view: { lens: 'attention' } } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/wip?view=attention&product=product-1', method: 'GET' }]);
    });

    it('an unlinked workspace and an unknown page ask Tynn nothing', async () => {
        const w = await window(true);
        expect(await w.read('other', 'wip', {})).toMatchObject({ ok: true, value: { ok: false, state: 'not-linked' } });
        expect(await w.read('work', 'manage', {})).toMatchObject({ ok: true, value: { ok: false, state: 'error' } });
        expect(w.requests).toEqual([]);
    });

    it('a non-local engine link cannot use the owner pairing (control: the local read above)', async () => {
        const w = await window(false);
        expect(await w.read('work', 'wip', {})).toMatchObject({ ok: false, reason: expect.stringContaining('local window only') });
        expect(w.requests).toEqual([]);
    });

    it('a host without the page service refuses explicitly', async () => {
        const w = await window(true, false);
        expect(await w.read('work', 'wip', {})).toMatchObject({ ok: false, reason: expect.stringContaining('no Tynn pages') });
        expect(w.requests).toEqual([]);
    });

    it('the window client returns the host page and makes a lost link an error, with no local read', async () => {
        const w = await window(true);
        expect(await w.client.tynnPage('work', 'wip', { view: 'attention' })).toMatchObject({ ok: true, page: 'wip', view: { lens: 'attention' } });
        w.client.disconnect();
        expect(await w.client.tynnPage('work', 'wip', {})).toEqual({ ok: false, state: 'error', reason: NOT_CONNECTED });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/wip?view=attention', method: 'GET' }]);
    });
});

describe('Releases is read on genie-host, through the same page door', () => {
    it('a local window gets Releases for the host registry project, with only the contract\'s query', async () => {
        const w = await window(true);
        expect(await w.read('work', 'releases', { product: 'product-1', project_id: 'other', path: 'https://elsewhere.test' })).toMatchObject({ ok: true, value: { ok: true, page: 'releases', view: { totalStories: 1, releases: [{ id: 'v1', number: '1.0.0' }] } } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/releases?product=product-1', method: 'GET' }]);
    });

    it('the window client returns the host\'s Releases; a non-local link and an unlinked workspace ask Tynn nothing', async () => {
        const w = await window(true);
        expect(await w.client.tynnPage('work', 'releases', {})).toMatchObject({ ok: true, page: 'releases', view: { totalStories: 1 } });
        expect(await w.read('other', 'releases', {})).toMatchObject({ ok: true, value: { ok: false, state: 'not-linked' } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/releases', method: 'GET' }]);
        const remote = await window(false);
        expect(await remote.read('work', 'releases', {})).toMatchObject({ ok: false, reason: expect.stringContaining('local window only') });
        expect(remote.requests).toEqual([]);
    });
});

describe('the Home is read on genie-host, through the same page door', () => {
    it('a local window gets the Home for the host registry project, with only the contract\'s section, range and version', async () => {
        const w = await window(true);
        expect(await w.read('work', 'home', { section: 'dashboard', range: '7', version: 'v1', project_id: 'other', path: 'https://elsewhere.test' })).toMatchObject({ ok: true, value: { ok: true, page: 'home', view: { section: 'dashboard', dashboard: { range: 7 } } } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/home?section=dashboard&range=7&version=v1', method: 'GET' }]);
    });

    it('a non-local link and an unlinked workspace ask Tynn nothing (control: the local read above)', async () => {
        const w = await window(true);
        expect(await w.read('other', 'home', {})).toMatchObject({ ok: true, value: { ok: false, state: 'not-linked' } });
        expect(w.requests).toEqual([]);
        const remote = await window(false);
        expect(await remote.read('work', 'home', {})).toMatchObject({ ok: false, reason: expect.stringContaining('local window only') });
        expect(remote.requests).toEqual([]);
    });
});

describe('Features is read on genie-host, through the same page door', () => {
    it('a local window gets the page for the host registry project, whole, with no query passed on', async () => {
        const w = await window(true);
        expect(await w.read('work', 'features', { tab: 'domains', project_id: 'other', path: 'https://elsewhere.test' })).toMatchObject({ ok: true, value: { ok: true, page: 'features', view: { canManage: false, features: [{ id: 'f1', tasks: 2, done: 1 }] } } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/features', method: 'GET' }]);
    });

    it('a non-local link and an unlinked workspace ask Tynn nothing (control: the local read above)', async () => {
        const w = await window(true);
        expect(await w.read('other', 'features', {})).toMatchObject({ ok: true, value: { ok: false, state: 'not-linked' } });
        expect(w.requests).toEqual([]);
        const remote = await window(false);
        expect(await remote.read('work', 'features', {})).toMatchObject({ ok: false, reason: expect.stringContaining('local window only') });
        expect(remote.requests).toEqual([]);
    });
});

describe('the VIP lane is read on genie-host, through the same page door', () => {
    it('a local window gets the lane for the host registry project, whole, with no query passed on', async () => {
        const w = await window(true);
        expect(await w.read('work', 'vip', { view: 'x', project_id: 'other', path: 'https://elsewhere.test' })).toMatchObject({ ok: true, value: { ok: true, page: 'vip', view: { version: null, canStart: false } } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/vip', method: 'GET' }]);
    });

    it('a non-local link and an unlinked workspace ask Tynn nothing (control: the local read above)', async () => {
        const w = await window(true);
        expect(await w.read('other', 'vip', {})).toMatchObject({ ok: true, value: { ok: false, state: 'not-linked' } });
        expect(w.requests).toEqual([]);
        const remote = await window(false);
        expect(await remote.read('work', 'vip', {})).toMatchObject({ ok: false, reason: expect.stringContaining('local window only') });
        expect(remote.requests).toEqual([]);
    });
});

describe('the window delegates the WIP door', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    it('both native IPC and the HostApi use the host-backed door', () => {
        const ipc = main.slice(main.indexOf("ipcMain.handle('genie:workspace-tynn-page'"), main.indexOf("ipcMain.handle('genie:workspace-tynn-board-action'"));
        expect(ipc).toContain('readWorkspaceTynnPage(');
        expect(ipc).not.toContain('readTynnPage(tynnBoardPorts()');
        const api = main.match(/tynnPage: ([^\n]+)/)?.[1];
        expect(api).toContain('readWorkspaceTynnPage(');
    });
});
