import { describe, expect, it } from 'vitest';
import {
    hibernateWorkspace,
    hibernationSpawnRefusal,
    wakeWorkspace,
    type HibernationDeps,
} from '../hibernation';

/**
 * HIBERNATE A WHOLE WORKSPACE, and wake it (genie#672).
 *
 * The owner: "Hibernated workspaces have all processes and terminals completely
 * shut down and do not wake up after upgrades or restarts, only when a user
 * manually wakes them up." And, on the decisions:
 *
 *   - "hibernation is a specific type of shutdown" — every running agent is asked
 *     for its handoff first, the way an upgrade asks, and then it all goes down;
 *   - shared engines: release this workspace's hold, and stop an engine nobody
 *     else uses, "so resources aren't burning for no reason";
 *   - AgentInbox: "agents in hibernation do not even list… On hibernation, delete
 *     all agent DMs for agents in the hibernating workspace";
 *   - wake brings back everything enabled, as a fresh boot would.
 *
 * This file pins the ORDER and the refusals. What each step does is its own
 * module's business, and tested there.
 */

function harness(over: Partial<HibernationDeps> & { hibernated?: boolean; system?: boolean } = {}) {
    const calls: string[] = [];
    let hibernated = over.hibernated ?? false;
    const deps: HibernationDeps = {
        workspace: (id) => (id === 'ws-1' ? { id, name: 'Prism', path: '/work/prism' } : null),
        isSystem: () => over.system ?? false,
        isHibernated: () => hibernated,
        setHibernated: (_id, on) => {
            calls.push(`flag:${on}`);
            hibernated = on;
        },
        runningAgents: () => [
            { name: 'docs', terminalIds: ['t-1'] },
            { name: 'labs', terminalIds: ['t-2'] },
        ],
        requestHandoff: async (_ws, agent) => {
            calls.push(`handoff:${agent.name}`);
            return true;
        },
        stopTerminals: async () => {
            calls.push('terminals');
            return 3;
        },
        disarmSchedules: () => calls.push('schedules:off'),
        hibernateDevServer: async () => {
            calls.push('devserver:off');
            return { errors: [] };
        },
        purgeAgentInbox: () => {
            calls.push('inbox:purge');
            return 7;
        },
        wakeDevServer: async () => {
            calls.push('devserver:on');
        },
        armSchedules: () => calls.push('schedules:on'),
        startProcesses: () => calls.push('processes:on'),
        changed: () => calls.push('changed'),
        ...over,
    };
    return { deps, calls, get hibernated() { return hibernated; } };
}

describe('hibernateWorkspace', () => {
    it('asks every running agent for a handoff, THEN marks it asleep, THEN shuts everything down', async () => {
        const h = harness();
        const res = await hibernateWorkspace('ws-1', h.deps);

        expect(res).toEqual({
            ok: true,
            handoffs: [
                { agent: 'docs', saved: true },
                { agent: 'labs', saved: true },
            ],
            stoppedTerminals: 3,
            purgedMessages: 7,
            errors: [],
        });
        expect(h.calls).toEqual([
            'handoff:docs',
            'handoff:labs',
            // Asleep BEFORE anything is killed: a terminal or site that something
            // tries to bring back during the shutdown is refused, not respawned.
            'flag:true',
            'terminals',
            'schedules:off',
            'devserver:off',
            // Last: an agent's final message during its handoff is gone too.
            'inbox:purge',
            'changed',
        ]);
        expect(h.hibernated).toBe(true);
    });

    it('asks the agents at the same time, not one after another', async () => {
        const pending: Array<(saved: boolean) => void> = [];
        const h = harness({
            requestHandoff: (_ws, agent) =>
                new Promise<boolean>((resolve) => {
                    h.calls.push(`asked:${agent.name}`);
                    pending.push(resolve);
                }),
        });
        const hibernating = hibernateWorkspace('ws-1', h.deps);
        await new Promise((r) => setTimeout(r, 0));
        // Both asked while neither has answered — so N agents cost one wait, not N.
        expect(h.calls.filter((c) => c.startsWith('asked:'))).toEqual(['asked:docs', 'asked:labs']);
        expect(h.calls).not.toContain('flag:true');
        pending.forEach((r) => r(false));
        const res = await hibernating;
        // An agent that wrote nothing is reported, and does not hold the workspace awake.
        expect(res).toMatchObject({ ok: true, handoffs: [{ agent: 'docs', saved: false }, { agent: 'labs', saved: false }] });
        expect(h.hibernated).toBe(true);
    });

    it('carries on past a step that fails, reports it, and still ends asleep', async () => {
        const h = harness({
            stopTerminals: async () => {
                throw new Error('pty host not answering');
            },
            hibernateDevServer: async () => {
                h.calls.push('devserver:off');
                return { errors: ['docker: network in use'] };
            },
        });
        const res = await hibernateWorkspace('ws-1', h.deps);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.errors).toEqual(['pty host not answering', 'docker: network in use']);
        expect(h.calls).toContain('devserver:off');
        expect(h.calls).toContain('inbox:purge');
        expect(h.hibernated).toBe(true);
    });

    it('refuses an unknown workspace, the System workspace, and one already asleep — changing nothing', async () => {
        for (const [id, h] of [
            ['nope', harness()],
            ['ws-1', harness({ system: true })],
            ['ws-1', harness({ hibernated: true })],
        ] as const) {
            const res = await hibernateWorkspace(id, h.deps);
            expect(res.ok, id).toBe(false);
            expect(h.calls, id).toEqual([]);
        }
    });
});

describe('wakeWorkspace', () => {
    it('clears the flag FIRST, then brings back everything enabled', async () => {
        const h = harness({ hibernated: true });
        const res = await wakeWorkspace('ws-1', h.deps);
        expect(res).toEqual({ ok: true, errors: [] });
        expect(h.calls).toEqual([
            // Awake first: the starts below are refused while it is asleep.
            'flag:false',
            'devserver:on',
            'schedules:on',
            'processes:on',
            'changed',
        ]);
        expect(h.hibernated).toBe(false);
    });

    it('reports a step that fails and still wakes the rest', async () => {
        const h = harness({
            hibernated: true,
            wakeDevServer: async () => {
                throw new Error('no container runtime');
            },
        });
        const res = await wakeWorkspace('ws-1', h.deps);
        expect(res).toEqual({ ok: true, errors: ['no container runtime'] });
        expect(h.calls).toContain('processes:on');
    });

    it('refuses a workspace that is not asleep, changing nothing', async () => {
        const h = harness();
        expect((await wakeWorkspace('ws-1', h.deps)).ok).toBe(false);
        expect(h.calls).toEqual([]);
    });
});

describe('one change at a time per workspace', () => {
    it('refuses a second hibernate, or a wake, while the handoffs of the first are still out', async () => {
        const answers: Array<(saved: boolean) => void> = [];
        const h = harness({
            requestHandoff: () => new Promise<boolean>((resolve) => answers.push(resolve)),
        });
        const first = hibernateWorkspace('ws-1', h.deps);
        await new Promise((r) => setTimeout(r, 0));

        // A second click during the handoff wait would otherwise pass the
        // "already asleep?" check too — the flag is only set once the agents answer.
        const again = await hibernateWorkspace('ws-1', h.deps);
        expect(again).toMatchObject({ ok: false });
        const wake = await wakeWorkspace('ws-1', h.deps);
        expect(wake).toMatchObject({ ok: false });

        answers.forEach((r) => r(true));
        expect((await first).ok).toBe(true);
        // Positive control: once the first is finished, the workspace answers again.
        expect((await wakeWorkspace('ws-1', h.deps)).ok).toBe(true);
    });
});

describe('hibernationSpawnRefusal — no terminal opens in a sleeping workspace', () => {
    it('refuses a workspace that is asleep, naming the way out', () => {
        const reason = hibernationSpawnRefusal('ws-1', () => true);
        expect(reason).toMatch(/hibernating/i);
        expect(reason).toMatch(/wake/i);
    });

    it('allows an awake workspace, and a terminal that belongs to none', () => {
        expect(hibernationSpawnRefusal('ws-1', () => false)).toBeNull();
        expect(hibernationSpawnRefusal(null, () => true)).toBeNull();
        expect(hibernationSpawnRefusal(undefined, () => true)).toBeNull();
    });

    it('reads a question it cannot answer as awake — never a terminal nobody can open', () => {
        expect(
            hibernationSpawnRefusal('ws-1', () => {
                throw new Error('db closed');
            }),
        ).toBeNull();
    });
});
