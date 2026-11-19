import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, HOST_ALONE_METHODS, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * CLIENT/HOST SPLIT STEP 2d-2 (Tynn #898, P4 #332): THE LAST FAMILIES A WINDOW HAD TO ANSWER ARE GENIE-HOST'S.
 *
 * Opening and listing a workspace's terminals, adding an agent, and sending a file to an agent were the only remote
 * methods genie-host still left to a window ("open Genie on <host>"). It has everything they need: its terminal host,
 * the hosting engines' environment, its registry and Tynn account, its inbox and roster. So a phone or a paired device
 * does them with every window closed, and with a window open the window is not asked.
 */

let dir = '';
let registry: Registry;
let atlas: AgentRecord;

const engine = () => ({ probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true }) as unknown as HostAloneEngine;

function terminals() {
    const opened: unknown[] = [];
    return {
        opened,
        port: {
            open: (options: { workspaceId: string; cwd: string; env?: Record<string, string> }) => { opened.push(options); return { id: 'term_1', pid: 7, shell: 'sh', scrollback: '' }; },
            list: () => [{ id: 'term_1', pid: 7, shell: 'sh', workspaceId: 'tynn' }, { id: 'term_2', pid: 8, shell: 'sh', workspaceId: 'moic' }],
            attach: () => null, write: () => true, resize: () => true, close: () => true, onData: () => () => {}, onExit: () => () => {},
        },
    };
}

function ports(over: Record<string, unknown> = {}): HostAlonePorts {
    return {
        hostName: 'alphar', registry, engine: () => engine(), cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => [], open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        terminals: terminals().port, takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
        serviceEnvFor: () => ({}),
        uploads: { sendFile: async () => ({ ok: true, messageId: 'msg_1' }) },
        ...over,
    } as unknown as HostAlonePorts;
}

function gate(alone: HostApi) {
    return { api: hostRemoteApi({ hostName: 'alphar', own: {}, alone }) };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d2-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    // Real workspaces are folders on the host's disk with their project.json: adding an agent writes into them.
    for (const id of ['tynn', 'moic']) { await mkdir(join(dir, id)); await writeFile(join(dir, id, 'project.json'), JSON.stringify({ name: id }, null, 2)); }
    await registry.addWorkspace({ id: 'tynn', path: join(dir, 'tynn') });
    await registry.addWorkspace({ id: 'moic', path: join(dir, 'moic') });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const FAMILY = ['terminals.open', 'terminals.list', 'addAgent', 'inbox.sendFile'] as const;

describe('the four are genie-host\'s', () => {
    it('they are in the set genie-host owns', () => {
        for (const method of FAMILY) expect(HOST_ALONE_METHODS.has(method)).toBe(true);
    });

    it('every one is answered by genie-host (since step 2d-2b there is no window to ask)', async () => {
        const alone = hostAloneApi(ports());
        const invoke = vi.spyOn(alone, 'invoke');
        const { api } = gate(alone);
        for (const method of FAMILY) {
            const answer = await api.invoke(method, []).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
            expect(String(answer)).not.toMatch(/open Genie on alphar/);
        }
        expect(invoke.mock.calls.map(([method]) => method)).toEqual([...FAMILY]);
    });
});

describe('what each one does on genie-host', () => {
    it('terminals.open opens in the workspace\'s folder with the hosting engines\' environment', async () => {
        const t = terminals();
        const api = hostAloneApi(ports({ terminals: t.port, serviceEnvFor: (id: string) => (id === 'tynn' ? { DB_HOST: '127.0.0.1' } : {}) }));
        expect(await api.invoke('terminals.open', ['tynn', { cols: 80, rows: 24 }])).toMatchObject({ id: 'term_1' });
        expect(t.opened).toEqual([expect.objectContaining({ workspaceId: 'tynn', cwd: join(dir, 'tynn'), env: { DB_HOST: '127.0.0.1' } })]);
    });

    it('terminals.list lists that workspace\'s terminals only', async () => {
        const api = hostAloneApi(ports());
        const listed = await api.invoke('terminals.list', ['tynn']) as Array<{ id: string }>;
        expect(listed.map((t) => t.id)).toEqual(['term_1']);
    });

    it('addAgent registers the agent in genie-host\'s registry and writes its folder', async () => {
        const api = hostAloneApi(ports());
        const created = await api.invoke('addAgent', ['tynn', { name: 'vega', purpose: 'reviews', provider: 'claude' }]) as { ok: boolean; id?: string };
        expect(created).toEqual({ ok: true, id: expect.any(String) });
        const record = registry.find(created.id as never);
        expect(record).toMatchObject({ name: 'vega', workspaceId: 'tynn', provider: 'claude' });
        expect(await readFile(join(dir, 'tynn', '.agents', 'vega', 'AGENT.md'), 'utf8')).toContain('reviews');
    });

    it('addAgent refuses a name already in the workspace, in words', async () => {
        const api = hostAloneApi(ports());
        const answer = await api.invoke('addAgent', ['tynn', { name: atlas.name, purpose: 'x', provider: 'claude' }]) as { ok: boolean; reason?: string };
        expect(answer.ok).toBe(false);
        expect(answer.reason).toEqual(expect.any(String));
    });

    it('inbox.sendFile hands the bytes to genie-host\'s upload sender', async () => {
        const sendFile = vi.fn(async () => ({ ok: true, messageId: 'msg_9' }));
        const api = hostAloneApi(ports({ uploads: { sendFile } }));
        expect(await api.invoke('inbox.sendFile', ['atlas', 'see this', 'a.txt', Buffer.from('hi').toString('base64')])).toEqual({ ok: true, messageId: 'msg_9' });
        expect(sendFile).toHaveBeenCalledWith('atlas', 'see this', 'a.txt', Buffer.from('hi'));
    });
});

describe('genie-host gives them their real parts', () => {
    it('its terminal host, the engines\' environment, an upload sender over its inbox and roster, and its agent creation', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        const block = host.slice(host.indexOf('phoneApi = hostAloneApi({'));
        expect(block).toMatch(/serviceEnvFor: \(workspaceId\) => engine\.serviceEnvFor\(workspaceId\)/);
        expect(block).toMatch(/uploads: uploadSender\(\{/);
        expect(block).toMatch(/agentCreate: /);
        const alone = readFileSync('src/main/host-alone-api.ts', 'utf8');
        expect(alone).not.toMatch(/needsWindow\('a new agent'\)/);
        expect(alone).not.toMatch(/windowOnly<HostApiDeps\['uploads'\]>/);
    });
});
