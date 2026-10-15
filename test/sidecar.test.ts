import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_RECORD_FIELDS, type AgentRecord } from '../src/core/identity.js';
import { sidecarName, sidecarPlan } from '../src/core/sidecar.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { sidecarTools, type SidecarToolsDeps } from '../src/main/mcp-tools-sidecar.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * SIDECARS (§6.2): `<agent>-slave`, an agent's own review partner — its own identity, its own context,
 * registered in the caller's workspace and tied to the caller by `sidecarOf`. ONE per agent, named after the
 * AGENT — Genie 1's convention (`repos/genie/main/agents/sidecar.ts`: `sidecarNameFor(driverName)`, where the
 * "driver" is the agent that drives it; `codex:tynn-slave` is tynn's), carried over by the v1 import — never
 * after the provider: two agents in one workspace asking for a codex sidecar must not share one `codex-slave`.
 * A second ask REJOINS the existing one — by its name, or by the owner link when it is named otherwise — and
 * never registers a second. A sidecar never spawns a sidecar. Genie never stops one for you.
 *
 * B27 (owner 2026-10-15): tynn already had `tynn-slave` (codex, from Genie 1, no `sidecarOf`); runAgent
 * `{agent:"codex"}` registered and started a NEW `codex-slave`. "You also already had a slave but decided to
 * create a new one."
 */

const rec = (r: { id: string; name: string; provider: AgentRecord['provider']; workspaceId?: string; sidecarOf?: string | null }): AgentRecord =>
    ({ workspaceId: 'tynn', sidecarOf: null, ...r }) as unknown as AgentRecord;

describe('core', () => {
    const caller = { id: 'agent_a', name: 'atlas', workspaceId: 'tynn' };

    it('names the sidecar after the AGENT, not the provider', () => {
        expect(sidecarName('atlas')).toBe('atlas-slave');
        expect(sidecarName('tynn')).toBe('tynn-slave');
        expect(sidecarPlan({ caller, driver: 'codex', existing: [] })).toEqual({ kind: 'register', name: 'atlas-slave', workspaceId: 'tynn', provider: 'codex', sidecarOf: 'agent_a' });
    });

    it('two agents in one workspace asking for the same provider get two sidecars, not one shared codex-slave', () => {
        expect(sidecarPlan({ caller, driver: 'codex', existing: [] })).toMatchObject({ kind: 'register', name: 'atlas-slave' });
        expect(sidecarPlan({ caller: { id: 'agent_b', name: 'bea', workspaceId: 'tynn' }, driver: 'codex', existing: [] })).toMatchObject({ kind: 'register', name: 'bea-slave' });
    });

    it('B27: rejoins the agent’s Genie 1 sidecar by NAME when it carries no owner link', () => {
        const tynn = { id: 'agent_t', name: 'tynn', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk' };
        const v1 = rec({ id: 'agent_v1', name: 'tynn-slave', provider: 'codex', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk' });
        expect(sidecarPlan({ caller: tynn, driver: 'codex', existing: [v1] })).toEqual({ kind: 'existing', record: v1 });
        // The same name in ANOTHER workspace is not this agent's.
        const elsewhere = rec({ id: 'agent_x', name: 'tynn-slave', provider: 'codex', workspaceId: 'other' });
        expect(sidecarPlan({ caller: tynn, driver: 'codex', existing: [elsewhere] })).toMatchObject({ kind: 'register', name: 'tynn-slave' });
    });

    it('rejoins by the owner link when the sidecar is named otherwise (renamed, or a beta-era <provider>-slave)', () => {
        const linked = rec({ id: 'agent_s', name: 'codex-slave', provider: 'codex', sidecarOf: 'agent_a' });
        expect(sidecarPlan({ caller, driver: 'codex', existing: [linked] })).toEqual({ kind: 'existing', record: linked });
        // The canonical <agent>-slave wins over a linked one of another name — the owner's install has both.
        const canonical = rec({ id: 'agent_c', name: 'atlas-slave', provider: 'codex' });
        expect(sidecarPlan({ caller, driver: 'codex', existing: [linked, canonical] })).toEqual({ kind: 'existing', record: canonical });
    });

    it('never registers a second sidecar when the agent’s own runs on another provider — refuses, in words', () => {
        const v1 = rec({ id: 'agent_v1', name: 'atlas-slave', provider: 'codex' });
        expect(sidecarPlan({ caller, driver: 'claude', existing: [v1] })).toEqual({ kind: 'refused', reason: 'atlas-slave is your sidecar and runs on codex, not claude; ask for agent "codex" to rejoin it. Genie does not register a second sidecar for you.' });
        const linked = rec({ id: 'agent_s', name: 'reviewer', provider: 'claude', sidecarOf: 'agent_a' });
        expect(sidecarPlan({ caller, driver: 'codex', existing: [linked] })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/^reviewer is your sidecar and runs on claude, not codex/) });
    });

    it('another agent’s sidecar is never this caller’s, and a name another agent owns is refused rather than shared', () => {
        const theirs = rec({ id: 'agent_t', name: 'bea-slave', provider: 'codex', sidecarOf: 'agent_b' });
        expect(sidecarPlan({ caller, driver: 'codex', existing: [theirs] })).toMatchObject({ kind: 'register', name: 'atlas-slave' });
        const taken = rec({ id: 'agent_u', name: 'atlas-slave', provider: 'codex', sidecarOf: 'agent_b' });
        expect(sidecarPlan({ caller, driver: 'codex', existing: [taken] })).toEqual({ kind: 'refused', reason: 'atlas-slave in this workspace is the sidecar of another agent; Genie does not share or duplicate it' });
    });

    it('a sidecar does not spawn a sidecar', () => {
        expect(sidecarPlan({ caller: { id: 'agent_s', name: 'atlas-slave', workspaceId: 'tynn' }, driver: 'claude', existing: [] })).toEqual({ kind: 'refused', reason: 'atlas-slave is a sidecar; a sidecar does not spawn a sidecar' });
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
        const s = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas-slave', sidecarOf: a.id });
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
        const registrations = sidecarTools(deps);
        const tools = new Map(registrations.map((r) => [r.definition.name, r.handler]));
        const call = async (args: Record<string, unknown>) => { const r = await tools.get('runAgent')!(args as never, { headers: {} } as never); return { ...JSON.parse(r.text), isError: r.isError } as Record<string, unknown>; };
        const description = registrations.find((r) => r.definition.name === 'runAgent')!.definition.description ?? '';
        return { call, started, running, records, description };
    }

    it('registers <agent>-slave in the caller’s workspace with sidecarOf and starts it at the caller’s cwd; a second call rejoins without a second start', async () => {
        const f = fakes();
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'claude' })).toMatchObject({ ok: true, agentId: 'agent_s1', name: 'atlas-slave', address: 'claude:atlas-slave', started: true, isError: false });
        expect(f.records[1]).toMatchObject({ name: 'atlas-slave', sidecarOf: 'agent_a', workspaceId: 'tynn' });
        expect(f.started).toEqual(['agent_s1@/w/tynn']);
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'claude' })).toMatchObject({ ok: true, agentId: 'agent_s1', started: false, rejoined: true });
        expect(f.started).toHaveLength(1);
        // One sidecar per agent: asking for the other provider is refused, never a second partner.
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'codex' })).toMatchObject({ isError: true, error: expect.stringMatching(/atlas-slave is your sidecar and runs on claude, not codex/) });
        expect(f.records).toHaveLength(2);
        expect(f.started).toHaveLength(1);
    });

    it('B27: rejoins and starts the agent’s existing Genie 1 sidecar instead of registering codex-slave', async () => {
        const f = fakes();
        f.records.push({ ...f.records[0]!, id: 'agent_v1', name: 'atlas-slave', provider: 'codex', sidecarOf: null } as AgentRecord);
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'codex' })).toMatchObject({ ok: true, agentId: 'agent_v1', name: 'atlas-slave', address: 'codex:atlas-slave', started: true, rejoined: true, isError: false });
        expect(f.records.map((r) => r.name)).toEqual(['atlas', 'atlas-slave']);
        expect(f.started).toEqual(['agent_v1@/w/tynn']);
    });

    it('tells the agent its sidecar is named after IT, not after the provider — the tool and the skill', () => {
        const f = fakes();
        expect(f.description).toMatch(/<your name>-slave/);
        expect(f.description).not.toMatch(/<agent>-slave/);
        const skill = GENIE_SKILLS.flatMap((s) => s.body.split('\n')).filter((l) => /-slave/.test(l));
        expect(skill.length).toBeGreaterThan(0);
        expect(skill.filter((l) => !l.includes('<your name>-slave'))).toEqual([]);
    });

    it('refuses a bad driver, a bad action and an unknown caller — in words', async () => {
        const f = fakes();
        expect(await f.call({ terminalId: 'term_a', action: 'sidecar', agent: 'gemini' })).toMatchObject({ isError: true, error: expect.stringMatching(/agent is claude or codex/) });
        expect(await f.call({ terminalId: 'term_a', action: 'start' })).toMatchObject({ isError: true, error: expect.stringMatching(/action is "sidecar"/) });
        expect(await f.call({ terminalId: 'term_zzz', action: 'sidecar', agent: 'claude' })).toMatchObject({ isError: true });
        expect(f.started).toEqual([]);
    });
});
