import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import { restartAgent, type AgentOpsPorts } from '../src/main/agent-ops-host.js';

/**
 * ONE RESTART (genie#1238; the owner, 2026-10-26: "We have so many restart buttons across so many views and some of
 * them don't even work at all"). Every Restart and Start control calls `restartAgent(…, 'graceful')`, and it works from
 * EVERY state the agent can be in: a running or idle agent is stopped and started again on its conversation; a Broken
 * one (a crash, a failed preparation) and a stopped or never-started one is STARTED. After a start that went ahead it
 * delivers what the agent is owed (`deliverOwed`): the resume prompt and drafts that were never sent.
 *
 * Red on main: a Broken agent was refused ("only a fresh restart reaches a wedged agent") — the ONLY state the Agent
 * view's header Restart, the process-ended block's Restart and the Dashboard's broken-row Restart were drawn in — and
 * a never-started agent was refused ("no conversation to resume"); nothing delivered what was owed.
 */

const THREAD = 'sess-1';
const record = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({ id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: '.agents/atlas/AGENT.md', threadId: THREAD, createdAt: 't', lastUsedAt: 't', mode: 'manual', accessScope: 'self', ...over }) as unknown as AgentRecord;

const live = (over: Partial<LiveSession>): LiveSession =>
    ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, ...over }) as unknown as LiveSession;

/** Every state an agent can be in when a person presses Restart (or Start). `null` = no session in the host. */
const STATES: ReadonlyArray<{ name: string; probe: LiveSession | null; threadId?: string | null }> = [
    { name: 'running, mid-turn', probe: live({ turnState: 'working' }) },
    { name: 'idle', probe: live({}) },
    { name: 'Broken (the provider crashed)', probe: live({ running: false, turnState: 'failed', failure: { reason: 'codex: acp: transport closed (EOF)', fixes: ['Restart'] } as never }) },
    { name: 'Broken (preparation failed)', probe: live({ running: true, turnState: 'failed', failure: { reason: 'Preparation failed: the tynn token could not be minted', fixes: ['Restart'] } as never }) },
    { name: 'account paused', probe: live({ accountPaused: { reason: 'billing', words: 'the subscription is paused' } as never }) },
    { name: 'signed out', probe: live({ signedOut: true }) },
    { name: 'stopped', probe: null },
    { name: 'never started (no conversation yet)', probe: null, threadId: null },
];

function fakes(over: { record?: AgentRecord; probe?: LiveSession | null; refusal?: string | null; startResult?: { ok: true } | { ok: false; reason: string } } = {}) {
    const current = over.record ?? record();
    const calls: string[] = [];
    const ports = {
        registry: {
            find: (id: string) => (id === current.id ? current : null),
            clearThread: async () => current,
        },
        host: {
            start: (r: AgentRecord, cwd: string) => { calls.push(`start:${r.id}:${r.threadId}:${cwd}`); return over.startResult ?? { ok: true }; },
            stop: (id: string) => { calls.push(`stop:${id}`); return over.probe != null; },
            ended: async (id: string) => { calls.push(`ended:${id}`); return null; },
            probe: () => over.probe ?? null,
            deliverOwed: async (id: string) => { calls.push(`deliverOwed:${id}`); return 0; },
        },
        cwdFor: () => '/w/tynn',
        // The rules Start always had (§6.1): an asleep workspace or the agent cap refuses a start, by name.
        startRefusal: () => over.refusal ?? null,
    } as unknown as AgentOpsPorts;
    return { ports, calls };
}

describe('Restart works from every state', () => {
    for (const s of STATES) {
        it(`${s.name}: the agent is started on its conversation, then what it is owed is delivered`, async () => {
            const f = fakes({ probe: s.probe, record: record(s.threadId !== undefined ? { threadId: s.threadId } : {}) });
            expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toEqual({ ok: true, kind: 'graceful' });
            const thread = s.threadId === undefined ? THREAD : s.threadId;
            // Stop (a no-op with no session), wait for the old run to end, start on the SAME thread, then the owed prompts.
            expect(f.calls).toEqual(['stop:agent_a', 'ended:agent_a', `start:agent_a:${thread}:/w/tynn`, 'deliverOwed:agent_a']);
        });
    }
});

describe('the rules a start always had still hold', () => {
    it('an asleep workspace or a full agent cap refuses a stopped agent — by name, before anything is touched', async () => {
        const f = fakes({ probe: null, refusal: 'Tynn.ai is hibernating: nothing starts here until you wake it.' });
        expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toEqual({ ok: false, reason: 'Tynn.ai is hibernating: nothing starts here until you wake it.' });
        expect(f.calls).toEqual([]);
    });

    it('a running agent is not refused by the cap it is already counted in', async () => {
        const f = fakes({ probe: live({}), refusal: 'the workspace already runs 4 of 4 agents' });
        expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toEqual({ ok: true, kind: 'graceful' });
    });

    it('a start the host refuses is said with its reason, and nothing is delivered into a session that is not there', async () => {
        const f = fakes({ probe: null, startResult: { ok: false, reason: 'the folder is not there' } });
        expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toEqual({ ok: false, reason: 'the folder is not there' });
        expect(f.calls).not.toContain('deliverOwed:agent_a');
    });

    it('a stored thread id Genie will not hand to the provider is still refused — never a silent new chat', async () => {
        const f = fakes({ probe: null, record: record({ threadId: 'not a thread; rm -rf /' }) });
        expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toMatchObject({ ok: false, reason: expect.stringMatching(/thread id/) });
        expect(f.calls).toEqual([]);
    });

    it('Restart fresh is the separate, named way to drop the conversation, and owes nothing to the old one', async () => {
        const f = fakes({ probe: live({ running: false, turnState: 'failed', failure: { reason: 'x', fixes: [] } as never }) });
        expect(await restartAgent(f.ports, 'agent_a', 'fresh')).toEqual({ ok: true, kind: 'fresh', discarded: THREAD });
        expect(f.calls).not.toContain('deliverOwed:agent_a');
    });
});
