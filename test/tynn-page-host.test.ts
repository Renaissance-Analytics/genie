import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEngineFrame } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { TynnPage, TynnPageQuery } from '../src/core/tynn-pages.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { readTynnPage } from '../src/main/tynn-page-client.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';

const TOKEN = 'd'.repeat(64);
const WIP = { project_id: 'host-project', view: 'attention', active_version: null, available_versions: [], stories: [], selected_story: null, tasks: [], story_counts: { active: 0, attention: 0, done: 0, backlog: 0 } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function window(local: boolean, service = true) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-tynn-page-host-'));
    const requests: Array<{ path: string; method: string }> = [];
    const ports: TynnBoardPorts = {
        signedIn: () => true,
        projectFor: id => id === 'work' ? 'host-project' : null,
        request: async (path, init) => {
            requests.push({ path, method: init.method });
            return { ok: true, status: 200, json: async () => WIP };
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
    return { read, requests };
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
