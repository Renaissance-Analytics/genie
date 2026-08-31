import { describe, expect, it } from 'vitest';
import {
    agentGridRows,
    amsAgentCard,
    splitAmsSpecs,
    type AgentRecordSpec,
} from '../ams-grid';

describe('AMS sidebar grid', () => {
    const terminal = (id: string, agent?: string) => ({
        id,
        label: agent ? `${agent} worker` : 'shell',
        meta: agent ? { agent, whisper_purpose: 'frontend' } : {},
    }) as never;

    it('separates configured agent terminals from ordinary panels', () => {
        const result = splitAmsSpecs([terminal('a', 'claude'), terminal('t')]);
        expect(result.agents.map((spec) => spec.id)).toEqual(['a']);
        expect(result.panels.map((spec) => spec.id)).toEqual(['t']);
    });

    it('keeps running and active as independent states', () => {
        expect(amsAgentCard(terminal('a', 'codex'), { running: true, active: false })).toMatchObject({
            name: 'frontend',
            provider: 'codex',
            running: true,
            active: false,
        });
    });
});

/**
 * The grid draws REGISTERED AGENTS, not agent-stamped terminal specs.
 *
 * This is the fix for the phantom squares, at the source. `main` has always had
 * a durable agent record; the renderer had none of it and read
 * `TerminalSpec.meta` instead — so a leftover spec WAS an agent as far as the UI
 * was concerned, and a registered agent that was not running was invisible. The
 * Tynn workspace showed three "tynn" squares for one registered agent, and its
 * per-workspace `role: 'workspace'` agent had never been shown to anyone.
 *
 * Reading the record inverts both: a dormant agent appears (with no runtime), and
 * a spec nothing owns can no longer masquerade as an agent — it is surfaced AS
 * orphaned, so it can be repaired rather than lived with.
 */
describe('agentGridRows', () => {
    const agent = (over: Partial<AgentRecordSpec> & { id: string; name: string }) => ({
        purpose: '',
        avatar: null,
        role: 'specialized' as const,
        collisionGroup: null,
        ...over,
    });
    const runtime = (over: { id: string; agentId: string; provider: string; specId?: string | null; fronted?: boolean }) => ({
        terminalSpecId: over.specId ?? null,
        fronted: over.fronted ?? false,
        ...over,
    });
    const spec = (id: string, purpose?: string) =>
        ({ id, label: 'l', meta: { agent: 'claude', whisper_purpose: purpose ?? 'x' } }) as never;

    it('draws a registered agent that has never been started', () => {
        // The state that was previously unrenderable: `registerAgent` creates no
        // spec, so a dormant agent appeared nowhere at all.
        const rows = agentGridRows({
            agents: [agent({ id: 'a1', name: 'tynn' })],
            runtimes: [],
            specs: [],
            isLive: () => false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'agent', name: 'tynn', running: false, tuis: [] });
    });

    it('shows the fronted TUI and every sidecar beside it', () => {
        const rows = agentGridRows({
            agents: [agent({ id: 'a1', name: 'tynn' })],
            runtimes: [
                runtime({ id: 'r1', agentId: 'a1', provider: 'claude', specId: 't1', fronted: true }),
                runtime({ id: 'r2', agentId: 'a1', provider: 'codex', specId: 't2' }),
            ],
            specs: [spec('t1'), spec('t2')],
            isLive: (id) => id === 't1',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'agent', provider: 'claude', running: true });
        expect(rows[0]!.tuis.map((t) => t.provider).sort()).toEqual(['claude', 'codex']);
    });

    it('counts an agent as running when ANY of its TUIs is live', () => {
        // A fronted TUI that exited while a sidecar keeps working is still a
        // working agent, and showing it as stopped would be a lie.
        const rows = agentGridRows({
            agents: [agent({ id: 'a1', name: 'tynn' })],
            runtimes: [
                runtime({ id: 'r1', agentId: 'a1', provider: 'claude', specId: 't1', fronted: true }),
                runtime({ id: 'r2', agentId: 'a1', provider: 'codex', specId: 't2' }),
            ],
            specs: [spec('t1'), spec('t2')],
            isLive: (id) => id === 't2',
        });
        expect(rows[0]!.running).toBe(true);
    });

    it('surfaces an agent-stamped spec that NO runtime owns as orphaned', () => {
        // Exactly the leftover the old grid drew as a second agent.
        const rows = agentGridRows({
            agents: [agent({ id: 'a1', name: 'tynn' })],
            runtimes: [runtime({ id: 'r1', agentId: 'a1', provider: 'claude', specId: 't1', fronted: true })],
            specs: [spec('t1'), spec('t-orphan', 'tynn')],
            isLive: () => true,
        });
        expect(rows.filter((r) => r.kind === 'agent')).toHaveLength(1);
        const orphans = rows.filter((r) => r.kind === 'orphan');
        expect(orphans).toHaveLength(1);
        expect(orphans[0]!.specId).toBe('t-orphan');
    });

    it('never counts an owned spec as an orphan', () => {
        // POSITIVE CONTROL for the rule above: "one orphan" would also be true of
        // a build that called every spec orphaned and happened to have one.
        const rows = agentGridRows({
            agents: [agent({ id: 'a1', name: 'tynn' })],
            runtimes: [runtime({ id: 'r1', agentId: 'a1', provider: 'claude', specId: 't1', fronted: true })],
            specs: [spec('t1')],
            isLive: () => true,
        });
        expect(rows.filter((r) => r.kind === 'orphan')).toEqual([]);
    });

    it('marks agents caught in a name collision so they can be resolved', () => {
        const rows = agentGridRows({
            agents: [
                agent({ id: 'a1', name: 'general', collisionGroup: 'ws:general' }),
                agent({ id: 'a2', name: 'general', collisionGroup: 'ws:general' }),
            ],
            runtimes: [],
            specs: [],
            isLive: () => false,
        });
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.collisionGroup === 'ws:general')).toBe(true);
    });

    it('puts the workspace agent first', () => {
        // It is the default target for most actions, so it should not sort by
        // whatever its name happens to be.
        const rows = agentGridRows({
            agents: [
                agent({ id: 'a1', name: 'aardvark' }),
                agent({ id: 'a2', name: 'workspace', role: 'workspace' }),
            ],
            runtimes: [],
            specs: [],
            isLive: () => false,
        });
        expect(rows[0]!.name).toBe('workspace');
    });
});
