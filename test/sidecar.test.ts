import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_RECORD_FIELDS, type AgentRecord } from '../src/core/identity.js';
import { sidecarName, sidecarPlan } from '../src/core/sidecar.js';
import { sidecarTools, type SidecarToolsDeps } from '../src/main/mcp-tools-sidecar.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * SIDECARS (§6.2): `<driver>-slave`, an agent's own review partner — its own identity, its own context,
 * registered in the caller's workspace and tied to the caller by `sidecarOf`. One per agent per driver:
 * a second ask REJOINS the existing one. A sidecar never spawns a sidecar. Genie never stops one for you:
 * stopping the parent leaves it running; only the person, a hibernate or an upgrade ends it.
 */

describe('core', () => {
    it('names the sidecar after the driver; the plan registers once and rejoins after', () => {
        expect(sidecarName('claude')).toBe('claude-slave');
        expect(sidecarName('codex')).toBe('codex-slave');
        const caller = { id: 'agent_a', name: 'atlas', workspaceId: 'tynn' };
        expect(sidecarPlan({ caller, driver: 'claude', existing: [] })).toEqual({ kind: 'register', name: 'claude-slave', workspaceId: 'tynn', provider: 'claude', sidecarOf: 'agent_a' });
        const existing = { id: 'agent_s', name: 'claude-slave', workspaceId: 'tynn', provider: 'claude', sidecarOf: 'agent_a' } as unknown as AgentRecord;
        expect(sidecarPlan({ caller, driver: 'claude', existing: [existing] })).toEqual({ kind: 'existing', record: existing });
        // Another agent's claude-slave in the same workspace is not this caller's.
        const other = { ...existing, id: 'agent_t', sidecarOf: 'agent_b' } as unknown as AgentRecord;
        expect(sidecarPlan({ caller, driver: 'claude', existing: [other] })).toMatchObject({ kind: 'register' });
        expect(sidecarPlan({ caller: { id: 'agent_s', name: 'claude-slave', workspaceId: 'tynn' }, driver: 'claude', existing: [] })).toEqual({ kind: 'refused', reason: 'claude-slave is a sidecar; a sidecar does not spawn a sidecar' });
    });
});

describe('registry', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-sidecar-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('persists sidecarOf; records written before the field existed still load (it is optional, like dailyBudgetUsd)', async () => {
        // Deliberately NOT a required field: adding one would drop every record written before it.
        expect(AGENT_RECORD_FIELDS).not.toContain('sidecarOf');
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const s = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'claude-slave', sidecarOf: a.id });
        expect(s.sidecarOf).toBe(a.id);
        expect(a.sidecarOf ?? null).toBeNull();
        expect(Object.keys(a)).not.toContain('sidecarOf');
        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.find(s.id)).toMatchObject({ sidecarOf: a.id });
    });
});

describe('runAgent sidecar tool', () => {
    function fakes() {
        const records: AgentRecord[] = [{ id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: 't', lastUsedAt: null, mode: 'manual', accessScope: 'self', sidecarOf: null } as AgentRecord];
        const started: string[] = [];
        const running = new Set<string>();
        let n = 0;
        const deps: SidecarToolsDeps = {
            resolveCaller: (id) => (id === 'term_a' ? { agentId: 'agent_a' as never, agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' } : null),
            roster: () => records,
            register: async (input) => { n += 1; const r = { ...records[0]!, id: `agent_s${n}`, name: input.name, provider: input.provider, sidecarOf: input.sidecarOf } as AgentRecord; records.push(r); return r; },
            start: (record, cwd) => { started.push(`${record.id}@${cwd}`); running.add(record.id); return { ok: true }; },
            running: (id) => running.has(id),
            addressOf: (record) => `${record.provider}:${record.name}`,
        };
        const tools = new Map(sidecarTools(deps).map((r) => [r.definition.name, r.handler]));
        const call = async (args: Record<string, unknown>) => { const r = await tools.get('runAgent')!(args as never, { headers: {} } as never); return { ...JSON.parse(r.text), isError: r.isError } as Record<string, unknown>; };
        return { call, started, running, records };
    }

    it('registers <driver>-slave in the caller’s workspace with sidecarOf and starts it at the caller’s cwd; a second call rejoins without a second start', async () => {
        const f = fakes();
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'claude' })).toMatchObject({ ok: true, agentId: 'agent_s1', name: 'claude-slave', address: 'claude:claude-slave', started: true, isError: false });
        expect(f.records[1]).toMatchObject({ name: 'claude-slave', sidecarOf: 'agent_a', workspaceId: 'tynn' });
        expect(f.started).toEqual(['agent_s1@/w/tynn']);
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'claude' })).toMatchObject({ ok: true, agentId: 'agent_s1', started: false });
        expect(f.started).toHaveLength(1);
        // A codex sidecar is a second, distinct partner.
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'codex' })).toMatchObject({ ok: true, name: 'codex-slave', started: true });
    });

    it('refuses a bad driver, a bad action and an unknown caller — in words', async () => {
        const f = fakes();
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'gemini' })).toMatchObject({ isError: true, error: expect.stringMatching(/agent is claude or codex/) });
        expect(await f.call({ terminalId: 'term_a', action: 'start' })).toMatchObject({ isError: true, error: expect.stringMatching(/action is "sidecar"/) });
        expect(await f.call({ terminalId: 'term_zzz', action: 'sidecar', agent: 'claude' })).toMatchObject({ isError: true });
        expect(f.started).toEqual([]);
    });
});
