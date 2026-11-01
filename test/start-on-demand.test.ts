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
    it('never started (no session): started, in its folder — once', () => {
        const { p, calls } = ports();
        expect(startForWork(p, record)).toEqual({ ok: true, started: true });
        expect(calls).toEqual(['start:agent_a:/w/pa']);
    });

    it('running: used as it is — nothing started, nothing restarted (the control: the same counter that saw the start above)', () => {
        const { p, calls } = ports({ probe: { running: true } });
        expect(startForWork(p, record)).toEqual({ ok: true, started: false });
        expect(calls).toEqual([]);
    });

    it('a session that ended on its own (Broken) is left to be read: no silent restart — the chat offers Restart', () => {
        const { p, calls } = ports({ probe: { running: false } });
        expect(startForWork(p, record)).toEqual({ ok: true, started: false });
        expect(calls).toEqual([]);
    });

    it('an asleep workspace or the agent cap refuses by name, and nothing is started', () => {
        const { p, calls } = ports({ refusal: 'Particle Academy Operations is hibernated' });
        expect(startForWork(p, record)).toEqual({ ok: false, reason: 'Particle Academy Operations is hibernated' });
        expect(calls).toEqual([]);
    });

    it('a start the host refuses is the refusal, with its reason', () => {
        const { p } = ports({ start: { ok: false, reason: 'claude is not installed' } });
        expect(startForWork(p, record)).toEqual({ ok: false, reason: 'claude is not installed' });
    });
});
