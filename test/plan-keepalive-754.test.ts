import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlanKeepalive, type KeepGoingState, type SkipReason, type TurnEndCause } from '../src/core/plan-keepalive.js';
import { DEFAULT_STALL_MINUTES, TurnStallWatchdog, stallMsFrom, type StallState } from '../src/core/turn-stall.js';
import { keepGoingStateOf } from '../src/main/host-plan-keepalive.js';

/**
 * TYNN #754 — THE PLAN NUDGES KEEP COMING. Three things the owner's logs showed (2026-11-16): the strike count never reset
 * (an agent working an in-progress step for hours was "stalled" for good, and sending a message did not clear it), a turn
 * Genie itself interrupted and restarted counted as the person's Stop (so the agent sat idle with 66 steps left), and the
 * whole keepalive lived in the window, not the host. Plus: nothing said why a nudge did not come, and nothing noticed a
 * turn that had simply gone silent. Tests named CONTROL pass before the fix; the rest are the RED.
 */

const PLAN = { step: 2, of: 5, doing: 'wire the tray' };
const base: KeepGoingState = { mode: 'automated', lastTurnEnd: 'replied', plan: PLAN, promptable: true, waitingOnPerson: false, background: 0, stoppedByYou: false };

function harness(initial: Partial<KeepGoingState> = {}) {
    let state: KeepGoingState | null = { ...base, ...initial };
    const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
    const prompts: string[] = [];
    const stalls: string[] = [];
    const skipped: SkipReason[] = [];
    const k = new PlanKeepalive({
        graceMs: 5_000,
        schedule: (ms, fn) => { const t = { ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
        read: () => state,
        prompt: (_id, text) => { prompts.push(text); },
        stalled: (_id, text) => { stalls.push(text); },
        skipped: (_id, reason) => { skipped.push(reason); },
    });
    const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
    const round = (cause?: TurnEndCause) => { k.turnEnded('a1', cause); fire(); };
    return { k, prompts, stalls, skipped, fire, round, set: (over: Partial<KeepGoingState> | null) => { state = over === null ? null : { ...(state ?? base), ...over }; } };
}

describe('strikes reset on progress or a persons turn', () => {
    it('CONTROL: three nudges that move nothing, with nobody else involved, still stop the nudging', () => {
        const h = harness();
        for (let i = 0; i < 5; i += 1) h.round();
        expect(h.prompts).toHaveLength(3);
        expect(h.stalls).toHaveLength(1);
    });

    it('a persons turn after the nudging stopped lets the next turn end be nudged again', () => {
        const h = harness();
        for (let i = 0; i < 4; i += 1) h.round();
        expect(h.prompts).toHaveLength(3);
        h.k.personTurnStarted('a1');
        h.round();
        expect(h.prompts).toHaveLength(4);
    });

    it('a persons turn between nudges starts the count again: five nudges, none of them the last straw', () => {
        const h = harness();
        h.round(); h.round();
        h.k.personTurnStarted('a1');
        h.round(); h.round(); h.round();
        expect(h.prompts).toHaveLength(5);
        expect(h.stalls).toEqual([]);
    });

    it('the step in progress changing is progress, though no step completed (a long plan is worked, not abandoned)', () => {
        const h = harness();
        for (let i = 0; i < 6; i += 1) {
            h.round();
            h.set({ plan: { step: 2, of: 5, doing: `working on part ${i}` } });
        }
        expect(h.prompts).toHaveLength(6);
        expect(h.stalls).toEqual([]);
    });
});

describe('Genies own stop is not the persons', () => {
    it('an interrupt Genie restarted from (a new session, no turn of its own yet) is nudged', () => {
        const h = harness({ lastTurnEnd: null });
        h.round('restarted');
        expect(h.prompts).toHaveLength(1);
    });

    it('a turn stopped, but not by the person, is nudged', () => {
        const h = harness({ lastTurnEnd: 'stopped', stoppedByYou: false });
        h.round('interrupted');
        expect(h.prompts).toHaveLength(1);
    });

    it('CONTROL: a turn the person stopped is not nudged, whatever ended it', () => {
        const h = harness({ lastTurnEnd: 'stopped', stoppedByYou: true });
        h.round('interrupted');
        expect(h.prompts).toEqual([]);
    });

    it('CONTROL: a reply cause with no turn ended is not nudged', () => {
        const h = harness({ lastTurnEnd: null });
        h.round('replied');
        expect(h.prompts).toEqual([]);
    });
});

describe('every turn end that is not nudged says why', () => {
    const cases: Array<[SkipReason, Partial<KeepGoingState>]> = [
        ['manual', { mode: 'manual' }],
        ['no-plan', { plan: null }],
        ['plan-complete', { plan: { step: 5, of: 5, doing: '' } }],
        ['stopped-by-you', { lastTurnEnd: 'stopped', stoppedByYou: true }],
        ['failed', { lastTurnEnd: 'failed' }],
        ['held', { lastTurnEnd: 'held' }],
        ['signed-out', { lastTurnEnd: 'signed-out' }],
        ['waiting-on-person', { waitingOnPerson: true }],
        ['background', { background: 2 }],
        ['no-turn', { lastTurnEnd: null }],
    ];
    for (const [reason, over] of cases) {
        it(`${reason}`, () => {
            const h = harness(over);
            h.round();
            expect(h.skipped).toEqual([reason]);
            expect(h.prompts).toEqual([]);
        });
    }

    it('busy: something else reached it in the grace', () => {
        const h = harness();
        h.k.turnEnded('a1');
        h.set({ promptable: false });
        h.fire();
        expect(h.skipped).toEqual(['busy']);
    });

    it('gone: the agent went away in the grace', () => {
        const h = harness();
        h.k.turnEnded('a1');
        h.set(null);
        h.fire();
        expect(h.skipped).toEqual(['gone']);
    });

    it('stalled: the nudging stopped, and each later turn end says so', () => {
        const h = harness();
        for (let i = 0; i < 5; i += 1) h.round();
        expect(h.skipped).toEqual(['stalled', 'stalled']);
    });

    it('CONTROL: a nudge that was sent skips nothing', () => {
        const h = harness();
        h.round();
        expect(h.prompts).toHaveLength(1);
        expect(h.skipped).toEqual([]);
    });
});

describe('it runs once, in the host', () => {
    const code = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
        .split(/\r?\n/).map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '')).join('\n');

    it('the window no longer builds a keepalive of its own (it would nudge twice)', () => {
        expect(code('../src/main/main.ts')).not.toMatch(/new PlanKeepalive/);
    });

    it('genie-host wires the keepalive', () => {
        expect(code('../src/main/genie-host.ts')).toMatch(/wireHostPlanKeepalive\(/);
    });
});

describe('what the keepalive reads of the host', () => {
    const live = (over: Record<string, unknown> = {}): never => ({ plan: PLAN, pendingApproval: null, background: 0, ...over }) as never;
    const view = (over: { live?: never | null; end?: KeepGoingState['lastTurnEnd']; promptable?: number | null; stoppedByYou?: boolean } = {}) => ({
        probe: () => (over.live === undefined ? live() : over.live),
        lastTurnEnd: () => over.end ?? 'replied',
        promptable: () => (over.promptable === undefined ? 3 : over.promptable),
        stoppedByYou: () => over.stoppedByYou ?? false,
    });
    const record = (mode: 'automated' | 'manual' = 'automated'): never => ({ id: 'a1', mode }) as never;

    it('an automated agent with a live session reads as its plan, its end, whether it can be prompted and whether it waits', () => {
        expect(keepGoingStateOf(view({ end: 'replied', stoppedByYou: false }), () => record(), () => false, 'a1' as never))
            .toEqual({ mode: 'automated', lastTurnEnd: 'replied', plan: PLAN, promptable: true, waitingOnPerson: false, background: 0, stoppedByYou: false });
    });

    it('its own open question means the next move is the persons', () => {
        expect(keepGoingStateOf(view(), () => record(), () => true, 'a1' as never)?.waitingOnPerson).toBe(true);
    });

    it('a parked approval means the next move is the persons', () => {
        expect(keepGoingStateOf(view({ live: live({ pendingApproval: { id: 'x' } }) }), () => record(), () => false, 'a1' as never)?.waitingOnPerson).toBe(true);
    });

    it('the persons Stop is carried through', () => {
        expect(keepGoingStateOf(view({ end: 'stopped', stoppedByYou: true }), () => record(), () => false, 'a1' as never)?.stoppedByYou).toBe(true);
    });

    it('CONTROL: an agent with no record reads as gone', () => {
        expect(keepGoingStateOf(view(), () => undefined, () => false, 'a1' as never)).toBeNull();
    });

    it('CONTROL: an agent with no live session reads as gone', () => {
        expect(keepGoingStateOf(view({ live: null }), () => record(), () => false, 'a1' as never)).toBeNull();
    });
});

describe('a turn gone silent', () => {
    const MIN = 60_000;
    function watch(stallMin: number, over: Partial<StallState> = {}) {
        let now = 1_000_000;
        let state: StallState | null = { inTurn: true, mode: 'manual', waitingOnPerson: false, ...over };
        const flags: number[] = [];
        const nudges: number[] = [];
        const w = new TurnStallWatchdog({
            now: () => now,
            stallMs: () => stallMin * MIN,
            agents: () => ['a1'],
            read: () => state,
            flag: (_id, ms) => { flags.push(ms); },
            nudge: (_id, ms) => { nudges.push(ms); },
        });
        return { w, flags, nudges, advance: (min: number) => { now += min * MIN; }, set: (s: StallState | null) => { state = s; } };
    }

    it('a turn with no output for the whole window is flagged once, however long the silence goes on', () => {
        const h = watch(20);
        h.w.activity('a1');
        h.advance(19); h.w.check();
        expect(h.flags).toEqual([]);
        h.advance(1); h.w.check();
        expect(h.flags).toHaveLength(1);
        h.advance(5); h.w.check();
        expect(h.flags).toHaveLength(1);
    });

    it('a manual agent is flagged, never prompted', () => {
        const h = watch(20, { mode: 'manual' });
        h.w.activity('a1');
        h.advance(21); h.w.check();
        expect(h.flags).toHaveLength(1);
        expect(h.nudges).toEqual([]);
    });

    it('an automated agent is flagged and prompted, once', () => {
        const h = watch(20, { mode: 'automated' });
        h.w.activity('a1');
        h.advance(21); h.w.check();
        h.advance(5); h.w.check();
        expect(h.flags).toHaveLength(1);
        expect(h.nudges).toHaveLength(1);
    });

    it('output re-arms it: a second silence is flagged again', () => {
        const h = watch(20);
        h.w.activity('a1');
        h.advance(21); h.w.check();
        h.w.activity('a1');
        h.advance(21); h.w.check();
        expect(h.flags).toHaveLength(2);
    });

    it('the window is the settings: five minutes flags at five', () => {
        const h = watch(5);
        h.w.activity('a1');
        h.advance(5); h.w.check();
        expect(h.flags).toHaveLength(1);
    });

    it('CONTROL: an agent not in a turn is never flagged', () => {
        const h = watch(20, { inTurn: false });
        h.w.activity('a1');
        h.advance(120); h.w.check();
        expect(h.flags).toEqual([]);
    });

    it('CONTROL: a window of 0 is off', () => {
        const h = watch(0);
        h.w.activity('a1');
        h.advance(600); h.w.check();
        expect(h.flags).toEqual([]);
    });

    it('CONTROL: an agent waiting on the person is not flagged: its silence is theirs', () => {
        const h = watch(20, { waitingOnPerson: true });
        h.w.activity('a1');
        h.advance(120); h.w.check();
        expect(h.flags).toEqual([]);
    });

    it('CONTROL: an agent that went away is not flagged', () => {
        const h = watch(20);
        h.w.activity('a1');
        h.set(null);
        h.advance(120); h.w.check();
        expect(h.flags).toEqual([]);
    });
});

describe('the stall setting', () => {
    it('defaults to 20 minutes', () => {
        expect(DEFAULT_STALL_MINUTES).toBe(20);
        expect(stallMsFrom({})).toBe(20 * 60_000);
    });

    it('reads the minutes it is given', () => {
        expect(stallMsFrom({ turn_stall_minutes: '30' })).toBe(30 * 60_000);
    });

    it('anything unreadable is the default', () => {
        expect(stallMsFrom({ turn_stall_minutes: 'soon' })).toBe(20 * 60_000);
    });

    it('CONTROL: 0 turns it off', () => {
        expect(stallMsFrom({ turn_stall_minutes: '0' })).toBe(0);
    });
});
