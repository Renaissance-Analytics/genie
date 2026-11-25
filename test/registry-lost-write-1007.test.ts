import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId, AgentRecord } from '../src/core/identity.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { HostRegistryStore } from '../src/main/agent-stores-replica.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import type { OwnCallAnswer } from '../src/main/own-protocol-client.js';
import { Registry } from '../src/main/registry.js';
import { hostRegistryAnswers, registryWatchFeed } from '../src/main/registry-protocol.js';
import { Store } from '../src/main/store.js';
import { openWindowRegistryStore } from '../src/main/window-registry-store.js';

/*
 * AN AGENT'S SETTINGS ARE NEVER LOST (Tynn #1007; measured 2026-11-25, sandbox/mount-1016/run-1124-225604.log): on one
 * host, agents.setPermissions 'edits', then setMode, setAutoApprove and setAccessScope on the same agent, read back
 * permissions 'all'. The registry was written as a WHOLE agents array by two writers — genie-host's phone registry and
 * the window's replica (refreshed asynchronously on registry.watch, writing thread ids through recordThread) — so the
 * last whole-array writer won and a stale replica clobbered a field just written.
 *
 * Every registry here is wired as the product wires it: genie-host's phone registry over HostRegistryStore and the
 * host's stores, and window registries over openWindowRegistryStore and main's own client (hostRegistryAnswers). A
 * window that has not refreshed yet is exactly the stale replica of the measurement.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const WORKSTATION = { name: 'test', healthy: true };
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
    for (const c of closers.splice(0)) c();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A seeded PRNG (mulberry32): the same seed, the same interleaving, so a red run is a reproducible one. */
function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const ticks = async (n: number) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

async function rig(options: { delay?: () => number } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'registry-lost-write-'));
    dirs.push(dir);
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    const knowledge = KnowledgeStore.open(dir);
    closers.push(() => knowledge.close());
    const store = new Store(dir);
    await store.writeWorkspaces([{ id: 'ws', path: join(dir, 'ws') }]);
    const hostRegistry = new HostRegistry(store);
    await hostRegistry.refresh();
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals: new ApprovalQueue(), registry: { store, model: hostRegistry } });
    const feed = registryWatchFeed({ dropped: () => store.dropped, onWritten: (l) => stores.onEvent((e) => { if (e.store === 'registry') l(); }) });
    const answers = hostRegistryAnswers({ call: (method, args) => stores.call('registry', method, args), dropped: () => store.dropped }, feed);

    // genie-host's phone registry, as genie-host.ts wires it.
    const phone = new Registry(new HostRegistryStore({ call: (s, method, args) => stores.call(s, method, args), registryDropped: () => store.dropped }));
    await phone.load(WORKSTATION);
    stores.onEvent((event) => { if (event.store === 'registry') void phone.refresh(); });

    /** A window's registry over main's own client. It is NOT refreshed on the watch: a replica as stale as it can be. */
    const window = async (): Promise<Registry> => {
        const own = {
            call: async (method: string, args: unknown[]): Promise<OwnCallAnswer> => {
                if (options.delay) await ticks(options.delay());
                const value = method === 'registry.read' ? await answers.registry.read(args[0] as never) : await answers.own['registry.write'](args, { own: true });
                if (value !== null && typeof value === 'object' && (value as { ok?: unknown }).ok === false) return value as OwnCallAnswer;
                return { ok: true, value };
            },
        };
        const registry = new Registry(new HostRegistryStore({ call: async () => { throw new Error('the window registry must not use this'); }, registryDropped: () => [] }));
        registry.useStore(await openWindowRegistryStore(own as never));
        await registry.load(WORKSTATION);
        return registry;
    };
    const onDisk = async (id: AgentId): Promise<AgentRecord> => (await store.readAgents()).find((a) => a.id === id)!;
    return { store, stores, phone, window, onDisk };
}

describe('the measured lost write (Tynn #1007)', () => {
    it('a stale window recording a thread id does not clobber the permissions genie-host just wrote', async () => {
        const r = await rig();
        const bolt = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'bolt' });
        const window = await r.window(); // loads bolt as it is now: permissions unset (all)
        await r.phone.setPermissions(bolt.id, 'edits');
        await r.stores.registrySettled();
        // The window's first session start records its thread id, from the replica it has.
        expect(await window.recordThread(bolt.id, 'thread-1')).toEqual({ ok: true });
        const record = await r.onDisk(bolt.id);
        expect(record.threadId).toBe('thread-1');
        expect(record.permissions).toBe('edits');
    });

    it('the sequence of the measurement (permissions, mode, autoApprove, accessScope) all survive a window writing in between', async () => {
        const r = await rig();
        const bolt = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'bolt' });
        const window = await r.window();
        await r.phone.setPermissions(bolt.id, 'edits');
        await window.setLastTurn(bolt.id, 3);
        await r.phone.setMode(bolt.id, 'automated');
        await window.recordThread(bolt.id, 'thread-1');
        await r.phone.setAutoApprove(bolt.id, true);
        await window.setPlan(bolt.id, [{ content: 'build', status: 'pending' }]);
        await r.phone.setAccessScope(bolt.id, 'all');
        await r.stores.registrySettled();
        expect(await r.onDisk(bolt.id)).toMatchObject({ permissions: 'edits', mode: 'automated', autoApprove: true, accessScope: 'all', threadId: 'thread-1', lastTurn: 3, plan: [{ content: 'build', status: 'pending' }] });
    });

    it('a setting a stale window puts back to the value it still shows lands all the same (only changed fields cross, but a set field always does)', async () => {
        const r = await rig();
        const bolt = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'bolt' });
        await r.phone.setPermissions(bolt.id, 'all');
        const window = await r.window(); // shows 'all'
        await r.phone.setPermissions(bolt.id, 'edits');
        await r.stores.registrySettled();
        await window.setPermissions(bolt.id, 'all');
        expect((await r.onDisk(bolt.id)).permissions).toBe('all');
        // And this window now holds what was written.
        expect(window.find(bolt.id)?.permissions).toBe('all');
    });

    it('a stale replica cannot resurrect a field another writer removed, nor drop an agent another writer added', async () => {
        const r = await rig();
        const bolt = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'bolt' });
        await r.phone.setModel(bolt.id, 'opus');
        const window = await r.window(); // knows model 'opus'
        await r.phone.setModel(bolt.id, null);
        const atlas = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'atlas' });
        await r.stores.registrySettled();
        await window.setBudget(bolt.id, 5);
        const agents = await r.store.readAgents();
        expect(agents.find((a) => a.id === bolt.id)).toMatchObject({ dailyBudgetUsd: 5 });
        expect(agents.find((a) => a.id === bolt.id)?.model).toBeUndefined();
        expect(agents.some((a) => a.id === atlas.id)).toBe(true);
    });
});

describe('concurrent field updates on one agent, from several callers, all survive (a seeded interleaving, repeated)', () => {
    for (const seed of [1, 7, 42, 1007, 2026, 31337, 65535, 99991]) {
        it(`seed ${seed}`, async () => {
            const random = prng(seed);
            const r = await rig({ delay: () => Math.floor(random() * 6) });
            const bolt = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'bolt' });
            const atlas = await r.phone.register({ workspaceId: 'ws', provider: 'claude', name: 'atlas' });
            const [w1, w2, w3] = [await r.window(), await r.window(), await r.window()];
            const writes: Array<() => Promise<unknown>> = [
                () => r.phone.setPermissions(bolt.id, 'edits'),
                () => w1.setMode(bolt.id, 'automated'),
                () => w2.setAutoApprove(bolt.id, true),
                () => w3.setAccessScope(bolt.id, 'all'),
                () => w1.recordThread(bolt.id, 'thread-b'),
                () => w2.setLastTurn(bolt.id, 9),
                () => r.phone.setModel(bolt.id, 'opus'),
                () => w3.setBudget(bolt.id, 4),
                () => w1.setPermissions(atlas.id, 'ask'),
                () => w2.recordThread(atlas.id, 'thread-a'),
            ];
            // Shuffled by the seed, started together; each window call waits a seeded number of ticks on the wire.
            for (let i = writes.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [writes[i], writes[j]] = [writes[j]!, writes[i]!]; }
            await Promise.all(writes.map((w) => w()));
            await r.stores.registrySettled();
            expect(await r.onDisk(bolt.id)).toMatchObject({ permissions: 'edits', mode: 'automated', autoApprove: true, accessScope: 'all', threadId: 'thread-b', lastTurn: 9, model: 'opus', dailyBudgetUsd: 4 });
            expect(await r.onDisk(atlas.id)).toMatchObject({ permissions: 'ask', threadId: 'thread-a' });
        });
    }
});

describe('the store: one record at a time, under its lock', () => {
    it('concurrent patches of different fields of one agent, from separate Store objects over one file, all land', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'registry-store-patch-'));
        dirs.push(dir);
        const seed = new Store(dir);
        const phone = new Registry(seed);
        await phone.load(WORKSTATION);
        await seed.writeWorkspaces([{ id: 'ws', path: join(dir, 'ws') }]);
        await phone.refresh();
        const bolt = await phone.register({ workspaceId: 'ws', provider: 'claude', name: 'bolt' });
        const a = new Store(dir), b = new Store(dir), c = new Store(dir);
        await Promise.all([
            a.changeAgents({ patch: [{ id: bolt.id, set: { permissions: 'edits' } }] }),
            b.changeAgents({ patch: [{ id: bolt.id, set: { mode: 'automated' } }] }),
            c.changeAgents({ patch: [{ id: bolt.id, set: { autoApprove: true }, unset: ['instructions'] }] }),
        ]);
        const record = (await seed.readAgents()).find((x) => x.id === bolt.id)!;
        expect(record).toMatchObject({ permissions: 'edits', mode: 'automated', autoApprove: true });
        expect('instructions' in record).toBe(false);
    });
});

describe('GUARD: the window composes no registry writer of whole arrays (Tynn #1007)', () => {
    it('the window’s registry store and the protocol carry per-record changes only; nothing writes a whole array but genie-host’s own store', () => {
        const window = code('src/main/window-registry-store.ts');
        expect(window).not.toMatch(/writeAgents|writeWorkspaces/);
        expect(window).toMatch(/changeAgents/);
        expect(window).toMatch(/changeWorkspaces/);
        const protocol = code('src/main/registry-protocol.ts');
        expect(protocol).not.toMatch(/'writeAgents'|'writeWorkspaces'/);
        // The Registry (window and phone alike) writes records, never the arrays.
        const registry = code('src/main/registry.ts');
        expect(registry).not.toMatch(/\.writeAgents\(|\.writeWorkspaces\(/);
        expect(code('src/main/agent-stores-replica.ts')).not.toMatch(/writeAgents|writeWorkspaces/);
        expect(code('src/main/agent-stores-host.ts')).not.toMatch(/'writeAgents'|'writeWorkspaces'/);
        // main builds its registry over no file store of its own: genie-host's is the one.
        const main = code('src/main/main.ts');
        expect(main).not.toMatch(/new Store\(/);
        expect(main).not.toMatch(/new Registry\(store\)/);
    });
});
