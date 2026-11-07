import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { parseTynnPage, tynnPagePath, type TynnPage } from '../src/core/tynn-pages.js';
import { NOT_CONNECTED, SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { readTynnPage } from '../src/main/tynn-page-client.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';

const TOKEN = 'e'.repeat(64);
const QUEUE = {
    project_id: 'host-project', cursor: '2026-11-07T11:00:00Z',
    issues: [{ id: 'i1', issue_number: 7, title: 'Dark mode', status: 'resolved' }],
    filters: { status: 'resolved', source: 'feedback', q: 'Dark mode' },
    features: [], convertible_versions: [], can_triage: true,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function window(local: boolean, service = true) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-tynn-issues-host-'));
    const requests: Array<{ path: string; method: string }> = [];
    const ports: TynnBoardPorts = {
        signedIn: () => true,
        projectFor: id => id === 'work' ? 'host-project' : null,
        request: async (path, init) => {
            requests.push({ path, method: init.method });
            return { ok: true, status: 200, json: async () => QUEUE };
        },
    };
    const server = new SessionEngineServer({ token: TOKEN, build: 'test', ...(service ? { tynnPages: { read: (id: string, page: unknown, query: unknown) => readTynnPage(ports, id, page, query) } } : {}) });
    const host = new SessionHost({ userData: dir, driverFor: () => { throw new Error('an Issues read must start no provider'); }, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, ...server.hostOptions() });
    server.attach(host);
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide, { local });
    const client = new SessionEngineClient();
    cleanups.push(async () => { client.disconnect(); await host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    return { client, requests };
}

describe('Issues reads use the host-owned page door', () => {
    it('returns the host project queue, with only declared filters; supplied projects and paths cannot replace it', async () => {
        const w = await window(true);
        expect(await w.client.tynnPage('work', 'issues', { status: 'resolved', source: 'feedback', q: ' Dark mode ', project_id: 'other', path: 'https://elsewhere.test' }))
            .toMatchObject({ ok: true, page: 'issues', view: { issues: [{ id: 'i1', number: '#7', title: 'Dark mode' }], filters: QUEUE.filters, canTriage: true, cursor: QUEUE.cursor } });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/issues?status=resolved&source=feedback&q=Dark+mode', method: 'GET' }]);
    });

    it('normalizes unknown filters and ignores non-string query values without changing the host project', async () => {
        const w = await window(true);
        expect(await w.client.tynnPage('work', 'issues', { status: 'constructor', source: 'unknown', q: ['injected'], project_id: 'other' })).toMatchObject({ ok: true, page: 'issues' });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/issues', method: 'GET' }]);
    });

    it('an unlinked workspace asks Tynn nothing', async () => {
        const w = await window(true);
        expect(await w.client.tynnPage('other', 'issues', {})).toMatchObject({ ok: false, state: 'not-linked' });
        expect(w.requests).toEqual([]);
    });

    it('a non-local engine connection cannot use the owner pairing (positive control: the local read above)', async () => {
        const w = await window(false);
        expect(await w.client.tynnPage('work', 'issues', {})).toMatchObject({ ok: false, state: 'error', reason: expect.stringContaining('local window only') });
        expect(w.requests).toEqual([]);
    });

    it('a host without the page service refuses explicitly', async () => {
        const w = await window(true, false);
        expect(await w.client.tynnPage('work', 'issues', {})).toMatchObject({ ok: false, state: 'error', reason: expect.stringContaining('no Tynn pages') });
        expect(w.requests).toEqual([]);
    });

    it('a disconnected host is an error, never a reason for the window to read its own pairing', async () => {
        const w = await window(true);
        expect(await w.client.tynnPage('work', 'issues', {})).toMatchObject({ ok: true, page: 'issues' });
        w.client.disconnect();
        expect(await w.client.tynnPage('work', 'issues', {})).toEqual({ ok: false, state: 'error', reason: NOT_CONNECTED });
        expect(w.requests).toEqual([{ path: '/api/v1/projects/host-project/issues', method: 'GET' }]);
    });

    it('builds the Issues path and parses its answer through the shared page contract', () => {
        expect(tynnPagePath('host-project', 'issues' as TynnPage, { status: 'resolved', q: 'Dark mode', path: '/elsewhere' }))
            .toBe('/api/v1/projects/host-project/issues?status=resolved&q=Dark+mode');
        expect(parseTynnPage('issues' as TynnPage, QUEUE)).toMatchObject({ page: 'issues', view: { issues: [{ id: 'i1' }] } });
        expect(parseTynnPage('issues' as TynnPage, { stories: [] })).toBeNull();
    });
});

describe('the window delegates both Issues entry points', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    it('native IPC and HostApi use one host-backed Issues adapter', () => {
        const ipc = main.slice(main.indexOf("ipcMain.handle('genie:workspace-tynn-issues'"), main.indexOf("ipcMain.handle('genie:workspace-tynn-issue-action'"));
        expect(ipc).toContain('readWorkspaceTynnIssues(');
        expect(ipc).not.toContain('readTynnIssues(tynnBoardPorts()');
        expect(main.match(/tynnIssues: ([^\n]+)/)?.[1]).toContain('readWorkspaceTynnIssues(');
    });
    it('the Issues adapter calls the same host-backed page door as WIP', () => {
        const adapter = main.match(/async function readWorkspaceTynnIssues[\s\S]*?\n\}/)?.[0];
        expect(adapter).toBeDefined();
        expect(adapter).toContain("readWorkspaceTynnPage(workspaceId, 'issues',");
        expect(adapter).not.toContain('readTynnIssues(tynnBoardPorts()');
    });
});
