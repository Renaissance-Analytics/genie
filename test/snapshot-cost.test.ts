import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE ESTATE SNAPSHOT COSTS ONE PROBE PER AGENT, AND MAIL IS NOT RE-FILTERED PER READ (genie#1200; the owner, beta.44:
 * "The UI is still laggy with the number of agents I have going right now" — main measured at 78–98 % of a core). The
 * snapshot is rebuilt every 50 ms while agents work. It probed every agent TWICE (its row, then its live approvals), and
 * each probe's comms filtered the WHOLE mailbox for that agent: agents × messages per snapshot, twenty times a second.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-snapshot-cost-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const live = (): LiveSession => ({
    running: true, startedAt: 0, turnState: 'working', lastActivityAt: 0, stopReason: null, contextUsed: null, contextLimit: null,
    pendingApprovals: [],
} as unknown as LiveSession);

describe('the estate snapshot', () => {
    it('probes each agent ONCE per snapshot, however many surfaces read it', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        const ids: AgentId[] = [];
        for (const name of ['atlas', 'kai', 'wren', 'bolt']) ids.push((await registry.register({ workspaceId: 'tynn', provider: 'claude', name })).id);
        const calls = new Map<string, number>();
        registry.setProbe((id) => { calls.set(id, (calls.get(id) ?? 0) + 1); return ids.includes(id) ? live() : null; });
        registry.snapshot();
        for (const id of ids) expect(calls.get(id)).toBe(1);
    });
});

describe('mail involving an agent', () => {
    it('a second read with nothing sent in between is the SAME answer, not a new filter of every message', async () => {
        const store = await InboxStore.open(dir);
        const a = mintAgentId();
        const b = mintAgentId();
        await store.send({ from: a, to: b, text: 'one' });
        const first = store.involving(a, 2000);
        expect(store.involving(a, 2000)).toBe(first);
        await store.send({ from: b, to: a, text: 'two' });
        // CONTROL: mail sent in between is seen at once.
        expect(store.involving(a, 2000).map((m) => m.text)).toEqual(['one', 'two']);
    });
});
