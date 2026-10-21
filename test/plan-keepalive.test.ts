import { describe, expect, it } from 'vitest';
import { PlanKeepalive, type KeepGoingState } from '../src/core/plan-keepalive.js';

/**
 * AN AUTOMATED AGENT WITH AN OPEN PLAN DOES NOT JUST STOP (the owner, 2026-10-21: "when you have a plan open genie should
 * have a way to make sure you don't just stop if an agent is set to auto mode").
 *
 * A turn that ends with plan steps left, from an agent set to `automated`, gets ONE nudge after a short grace: what is
 * left, and to carry on. Never when the person stopped it, when it failed or is held, when it is waiting on the person
 * (its own open question, a parked approval), or when something else already reached it in the grace. And never forever:
 * three nudges in a row that move nothing stop the nudging, and that is said.
 */

const PLAN = { step: 2, of: 5, doing: 'wire the tray' };
const base: KeepGoingState = { mode: 'automated', lastTurnEnd: 'replied', plan: PLAN, promptable: true, waitingOnPerson: false };

function harness(initial: Partial<KeepGoingState> = {}) {
    let state: KeepGoingState | null = { ...base, ...initial };
    const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
    const prompts: string[] = [];
    const stalls: string[] = [];
    const k = new PlanKeepalive({
        graceMs: 5_000,
        schedule: (ms, fn) => { const t = { ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
        read: () => state,
        prompt: (_id, text) => { prompts.push(text); },
        stalled: (_id, text) => { stalls.push(text); },
    });
    const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
    return { k, prompts, stalls, fire, timers, set: (over: Partial<KeepGoingState> | null) => { state = over === null ? null : { ...(state ?? base), ...over }; } };
}

describe('the nudge', () => {
    it('an automated agent that ends a turn with steps left is told what is left and to carry on — once, after the grace', () => {
        const h = harness();
        h.k.turnEnded('a1');
        expect(h.prompts).toEqual([]);
        expect(h.timers.map((t) => t.ms)).toEqual([5_000]);
        h.fire();
        expect(h.prompts).toHaveLength(1);
        expect(h.prompts[0]).toMatch(/3 of 5 steps/);
        expect(h.prompts[0]).toMatch(/wire the tray/);
        expect(h.prompts[0]).toMatch(/ForceTheQuestion/);
    });

    it('a second turn end inside the grace does not schedule a second nudge (COUNTED: one timer, one prompt)', () => {
        const h = harness();
        h.k.turnEnded('a1');
        h.k.turnEnded('a1');
        expect(h.timers.filter((t) => t.live)).toHaveLength(1);
        h.fire();
        expect(h.prompts).toHaveLength(1);
    });
});

describe('never when it should not', () => {
    const cases: Array<[string, Partial<KeepGoingState>]> = [
        ['a manual agent', { mode: 'manual' }],
        ['a plan with nothing left', { plan: { step: 5, of: 5, doing: '' } }],
        ['no plan at all', { plan: null }],
        ['a turn the person STOPPED', { lastTurnEnd: 'stopped' }],
        ['a FAILED turn', { lastTurnEnd: 'failed' }],
        ['a turn HELD for the limit', { lastTurnEnd: 'held' }],
        ['a SIGNED-OUT login', { lastTurnEnd: 'signed-out' }],
        ['an agent waiting on the person (its question, its approval)', { waitingOnPerson: true }],
    ];
    for (const [name, over] of cases) {
        it(name, () => {
            const h = harness(over);
            h.k.turnEnded('a1');
            h.fire();
            expect(h.prompts).toEqual([]);
        });
    }

    it('something else reached it in the grace (the person, its mail): at the nudge it is busy, so nothing is sent', () => {
        const h = harness();
        h.k.turnEnded('a1');
        h.set({ promptable: false });
        h.fire();
        expect(h.prompts).toEqual([]);
    });

    it('it asked the person in the grace: nothing is sent', () => {
        const h = harness();
        h.k.turnEnded('a1');
        h.set({ waitingOnPerson: true });
        h.fire();
        expect(h.prompts).toEqual([]);
    });

    it('the agent went away in the grace: nothing is sent', () => {
        const h = harness();
        h.k.turnEnded('a1');
        h.set(null);
        h.fire();
        expect(h.prompts).toEqual([]);
    });
});

describe('never forever', () => {
    it('three nudges in a row that complete no step stop the nudging, and it is said ONCE', () => {
        const h = harness();
        for (let i = 0; i < 6; i += 1) { h.k.turnEnded('a1'); h.fire(); }
        expect(h.prompts).toHaveLength(3);
        expect(h.stalls).toHaveLength(1);
        expect(h.stalls[0]).toMatch(/3 nudges/);
        expect(h.stalls[0]).toMatch(/2 of 5/);
    });

    it('a step completed between nudges resets the count (COUNTED: progress keeps it going)', () => {
        const h = harness();
        for (let i = 0; i < 6; i += 1) {
            h.k.turnEnded('a1');
            h.fire();
            h.set({ plan: { step: 2 + i + 1, of: 10, doing: `step ${i}` } });
        }
        expect(h.prompts.length).toBeGreaterThan(3);
        expect(h.stalls).toEqual([]);
    });

    it('a stalled agent is nudged again once its plan moves', () => {
        const h = harness();
        for (let i = 0; i < 4; i += 1) { h.k.turnEnded('a1'); h.fire(); }
        expect(h.prompts).toHaveLength(3);
        h.set({ plan: { step: 3, of: 5, doing: 'next' } });
        h.k.turnEnded('a1');
        h.fire();
        expect(h.prompts).toHaveLength(4);
    });
});
