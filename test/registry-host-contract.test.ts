import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { HostRegistryStore } from '../src/main/agent-stores-replica.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { Registry } from '../src/main/registry.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';

/**
 * THE REGISTRY'S FILES ARE GENIE-HOST'S (the host split, P3.2: plan §11c). One writer of workspaces.json and agents.json:
 * the host. A window's Registry keeps its model and its snapshot, but reads and writes those files through the host
 * (HostRegistryStore), and the host keeps its OWN Registry over them — what its tools and approvals read with no window.
 * Two windows see one registry: what one registers, the other shows, without a restart.
 */

const TOKEN = 'registry-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const WORKSTATION = { name: 'test', healthy: true };

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
    for (const c of closers.splice(0)) c();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function rig() {
    const dir = await mkdtemp(join(tmpdir(), 'registry-contract-'));
    const wsDir = await mkdtemp(join(tmpdir(), 'registry-ws-'));
    dirs.push(dir, wsDir);
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    const knowledge = KnowledgeStore.open(dir);
    closers.push(() => knowledge.close());
    const store = new Store(dir);
    const hostRegistry = new HostRegistry(store);
    await hostRegistry.refresh();
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals: new ApprovalQueue(), registry: { store, model: hostRegistry } });
    const server = new SessionEngineServer({ token: TOKEN, build: 't', stores });
    const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        const registry = new Registry(new Store(dir)); // a store it must NOT use: replaced before load
        registry.useStore(new HostRegistryStore(client.stores()));
        client.stores().onRegistryChanged(() => { void registry.refresh(); });
        await registry.load(WORKSTATION);
        return registry;
    };
    return { dir, wsDir, store, hostRegistry, window };
}

describe('the registry through genie-host', () => {
    it('a window reads the host\'s registry (the OS agent the host seeded included), and writes through it', async () => {
        const r = await rig();
        const w = await r.window();
        expect(w.listAgents().map((a) => a.id)).toEqual(r.hostRegistry.listAgents().map((a) => a.id));
        const ws = { id: 'ws-a', path: r.wsDir };
        await w.addWorkspace(ws);
        await tick();
        // On disk, by the host's store (the one writer), and in the host's own model.
        expect((await new Store(r.dir).readWorkspaces()).map((x) => x.id)).toContain(ws.id);
        expect(r.hostRegistry.workspace(ws.id)?.path).toBe(r.wsDir);
    });

    it('two windows see one registry: an agent one registers, the other shows without a restart', async () => {
        const r = await rig();
        const a = await r.window();
        const b = await r.window();
        const ws = { id: 'ws-a', path: r.wsDir };
        await a.addWorkspace(ws);
        await tick();
        expect(b.workspace(ws.id)?.path).toBe(r.wsDir);
        const agent = await a.register({ workspaceId: ws.id, provider: 'claude', name: 'atlas' });
        await tick();
        expect(b.find(agent.id)?.name).toBe('atlas');
        expect(r.hostRegistry.find(agent.id)?.name).toBe('atlas');
    });

    it('CONTROL: a refresh with nothing changed announces nothing (a window does not redraw its own write twice)', async () => {
        const r = await rig();
        const a = await r.window();
        let emits = 0;
        a.subscribe(() => { emits += 1; });
        await a.refresh();
        expect(emits).toBe(0);
    });
});
