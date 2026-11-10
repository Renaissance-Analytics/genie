import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * THE TYNN TAB WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5f). genie-host holds the Tynn account, so a Pilot's board,
 * issues and pages are read and changed through it, by the same code a window uses.
 */

let dir = '';
let registry: Registry;
const requests: Array<{ path: string; method: string }> = [];
const pages: Array<[string, unknown, unknown]> = [];

function board(over: Record<string, unknown> = {}) {
    return {
        signedIn: () => true,
        projectFor: (workspaceId: string) => (workspaceId === 'tynn' ? 'proj_1' : null),
        request: async (path: string, init: { method: string }) => {
            requests.push({ path, method: init.method });
            return { ok: true, status: 200, json: async () => ({ data: [] }) };
        },
        ...over,
    };
}

function ports(tab: Record<string, unknown> = {}): HostAlonePorts {
    const engine = { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
    return {
        hostName: 'alphar', registry, engine: () => engine, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true, windowConnected: () => false,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {} },
        headroom: { view: () => ({}), subscribe: () => () => {} },
        attention: { finished: () => [], markSeen: () => {}, answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] }, deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        workspaceLifecycle: { terminals: () => null, supervisor: () => null, engines: () => null, reverifyTrust: async () => {}, github: () => null, tynn: () => null, defaultEnvFile: () => '', stagingDirectory: () => '' },
        colors: { set: async () => ({ ok: true }) },
        tynnTab: {
            board: () => board(),
            readPage: async (id: string, page: unknown, query: unknown) => { pages.push([id, page, query]); return { ok: true, page: 'issues', view: { items: [] } }; },
            ...tab,
        },
    } as unknown as HostAlonePorts;
}

function gate(alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window }, alone });
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-tynn-'));
    requests.length = 0;
    pages.length = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const CALLS: Array<[RemoteMethod, unknown[]]> = [
    ['workspaces.tynnBoard', ['tynn', {}]],
    ['workspaces.tynnPage', ['tynn', 'wip', {}]],
    ['workspaces.tynnIssues', ['tynn', {}]],
    ['workspaces.tynnBoardAction', ['tynn', { action: 'nothing-real', ids: {} }]],
    ['workspaces.tynnIssueAction', ['tynn', { action: 'nothing-real', issueId: null }]],
    ['workspaces.tynnPageAction', ['tynn', { action: 'nothing-real' }]],
];

describe('the Tynn tab with no window', () => {
    it.each(CALLS)('%s reaches genie-host, not the "open a window" refusal', async (method, args) => {
        await expect(gate(hostAloneApi(ports())).invoke(method, args)).resolves.toBeDefined();
    });

    it('the board is read from Tynn for the workspace\'s own project', async () => {
        await gate(hostAloneApi(ports())).invoke('workspaces.tynnBoard', ['tynn', {}]);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests[0]!.path).toContain('proj_1');
        expect(requests[0]!.method).toBe('GET');
    });

    it('a workspace with no Tynn project says so, and asks Tynn nothing (CONTROL)', async () => {
        expect(await gate(hostAloneApi(ports())).invoke('workspaces.tynnBoard', ['moic', {}])).toMatchObject({ ok: false, state: 'not-linked' });
        expect(requests).toEqual([]);
    });

    it('signed out says so, and asks Tynn nothing (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports({ board: () => board({ signedIn: () => false }) })));
        expect(await api.invoke('workspaces.tynnBoard', ['tynn', {}])).toMatchObject({ ok: false, state: 'signed-out' });
        expect(requests).toEqual([]);
    });

    it('a page goes to genie-host\'s own reader; Issues keep their shape', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.tynnPage', ['tynn', 'issues', { q: 1 }])).toMatchObject({ ok: true, page: 'issues' });
        expect(await api.invoke('workspaces.tynnIssues', ['tynn', { state: 'open' }])).toEqual({ ok: true, view: { items: [] } });
        expect(pages).toEqual([['tynn', 'issues', { q: 1 }], ['tynn', 'issues', { state: 'open' }]]);
    });

    it('Issues answered with another page is an error, not a wrong view (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports({ readPage: async () => ({ ok: true, page: 'wip', view: {} }) })));
        expect(await api.invoke('workspaces.tynnIssues', ['tynn', {}])).toMatchObject({ ok: false, state: 'error' });
    });

    it('an action that names nothing is refused before Tynn is asked', async () => {
        const api = gate(hostAloneApi(ports()));
        expect(await api.invoke('workspaces.tynnPageAction', [7, null])).toMatchObject({ ok: false });
        expect(requests).toEqual([]);
    });
});

describe('the gate', () => {
    it('with a window connected the window answers, and genie-host is not asked (CONTROL)', async () => {
        const alone = hostAloneApi(ports());
        const invoke = vi.spyOn(alone, 'invoke');
        const api = gate(alone, { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await api.invoke('workspaces.tynnBoard', ['tynn', {}])).toBe('window answered workspaces.tynnBoard');
        expect(invoke).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
    });

    it('the live view\'s change reads stay the window\'s own (CONTROL)', async () => {
        await expect(gate(hostAloneApi(ports())).invoke('workspaces.tynnBoardChanges', ['tynn', {}, null, []])).rejects.toThrow('open Genie on alphar');
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('the window and genie-host answer through the same code', () => {
        for (const file of ['src/main/main.ts', 'src/main/host-alone-api.ts']) expect(src(file), file).toContain('workspaceTynnApi(');
    });

    it('genie-host gives it its own account and its own page reader, the one a window\'s page reads go through', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/tynnTab: \{ board: hostTynnBoard, readPage: readHostTynnPage \}/);
        expect(host).toMatch(/tynnPages: \{ read: readHostTynnPage \}/);
    });
});
