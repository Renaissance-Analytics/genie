import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE ROW CARRIES WHAT THE WORKSPACE DASHBOARD DRAWS (q_09d1f4a0): what the agent was asked and the tool it is in now (from
 * its live session), and its last finished turn's handoff (from Genie's record of finished turns). Each is `null` when
 * not reported — never a guess.
 */

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: Date.now() - 120_000,
    pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null,
    ...over,
});
const record = { id: 'a1', name: 'kai', provider: 'claude', workspaceId: 'tynn' } as unknown as AgentRecord;

describe('agentRowFor', () => {
    it("carries the session's prompt and current tool", () => {
        expect(agentRowFor(record, live({ asked: 'Build the dashboard', tool: 'npm test' }), () => Date.now())).toMatchObject({ asked: 'Build the dashboard', tool: 'npm test' });
    });

    it('no session, or a session that reported neither: both null', () => {
        expect(agentRowFor(record, null, () => Date.now())).toMatchObject({ asked: null, tool: null });
        expect(agentRowFor(record, live(), () => Date.now())).toMatchObject({ asked: null, tool: null });
    });
});

describe('the registry row', () => {
    let dir: string;
    let registry: Registry;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-row-now-'));
        registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it("carries the agent's last handoff, by id; an agent with none carries null", async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const b = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'wren' });
        registry.setHandoffProbe((id) => (id === a.id ? { text: 'Drawer merged.', at: 5_000 } : null));
        const rows = registry.snapshot().agents;
        expect(rows.find((r) => r.id === a.id)?.handoff).toEqual({ text: 'Drawer merged.', at: 5_000 });
        expect(rows.find((r) => r.id === b.id)?.handoff).toBeNull();
    });
});
