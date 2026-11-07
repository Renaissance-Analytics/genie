import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { startForWork, type StartOnDemandPorts } from '../src/main/start-on-demand.js';

/**
 * START ON FIRST MESSAGE (the owner, 2026-11-01, q_04ce323c): opening an agent does not start it; something sending it
 * work does — the person's first message, mail that wakes it, a flow's prompt, Start. `startForWork` is the one rule those
 * senders share: a session already here is used as it is (never restarted, never a second one); an agent with none is
 * started, unless its workspace or the agent cap refuses, which is said by name and starts nothing.
 */

const record = { id: 'agent_a', workspaceId: 'pa', provider: 'claude', name: 'pa-ops' } as unknown as AgentRecord;

function ports(over: { probe?: { running: boolean } | null; refusal?: string | null; start?: { ok: true } | { ok: false; reason: string } } = {}) {
    const calls: string[] = [];
    const p: StartOnDemandPorts = {
        probe: () => (over.probe === undefined ? null : over.probe),
        start: (r, cwd) => { calls.push(`start:${r.id}:${cwd}`); return over.start ?? { ok: true }; },
        cwdFor: () => '/w/pa',
        startRefusal: () => over.refusal ?? null,
    };
    return { p, calls };
}

describe('startForWork', () => {
    it('never started (no session): started, in its folder — once', async () => {
        const { p, calls } = ports();
        expect(await startForWork(p, record)).toEqual({ ok: true, started: true });
        expect(calls).toEqual(['start:agent_a:/w/pa']);
    });

    it('running: used as it is — nothing started, nothing restarted (the control: the same counter that saw the start above)', async () => {
        const { p, calls } = ports({ probe: { running: true } });
        expect(await startForWork(p, record)).toEqual({ ok: true, started: false });
        expect(calls).toEqual([]);
    });

    it('a session that ended on its own (Broken) is left to be read: no silent restart — the chat offers Restart', async () => {
        const { p, calls } = ports({ probe: { running: false } });
        expect(await startForWork(p, record)).toEqual({ ok: true, started: false });
        expect(calls).toEqual([]);
    });

    it('an asleep workspace or the agent cap refuses by name, and nothing is started', async () => {
        const { p, calls } = ports({ refusal: 'Particle Academy Operations is hibernated' });
        expect(await startForWork(p, record)).toEqual({ ok: false, reason: 'Particle Academy Operations is hibernated' });
        expect(calls).toEqual([]);
    });

    it('a start the host refuses is the refusal, with its reason', async () => {
        const { p } = ports({ start: { ok: false, reason: 'claude is not installed' } });
        expect(await startForWork(p, record)).toEqual({ ok: false, reason: 'claude is not installed' });
    });

    /*
     * THE AGENT ENGINE IN genie-host (the host split): the window's engine is a replica, and its `start` ANSWERS LATER
     * (a Promise from the host). The answer is the host's, awaited — a refusal there is the refusal here, never a
     * Promise object read as "started".
     */
    it('an engine whose start answers later (genie-host): its answer is awaited — a refusal is the refusal', async () => {
        const p: StartOnDemandPorts = {
            probe: () => null,
            start: () => Promise.resolve({ ok: false as const, reason: 'claude is not installed' }),
            cwdFor: () => '/w/pa',
            startRefusal: () => null,
        };
        expect(await startForWork(p, record)).toEqual({ ok: false, reason: 'claude is not installed' });
    });

    it('an engine whose start answers later (genie-host): started once it says so', async () => {
        let said = false;
        const p: StartOnDemandPorts = {
            probe: () => null,
            start: () => new Promise((r) => setTimeout(() => { said = true; r({ ok: true }); }, 5)),
            cwdFor: () => '/w/pa',
            startRefusal: () => null,
        };
        expect(await startForWork(p, record)).toEqual({ ok: true, started: true });
        expect(said).toBe(true); // not before the host answered
    });
});
