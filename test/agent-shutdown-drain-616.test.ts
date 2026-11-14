import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DRAIN_WAIT_MS, AgentShutdownDrain, type AgentDrainProgress, type ShutdownAgent } from '../src/core/agent-shutdown-drain.js';

afterEach(() => vi.useRealTimers());
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function rig(initial: ShutdownAgent[] = [{ id: 'a', name: 'atlas', running: true, inTurn: true }]) {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    let agents = initial;
    const notify = vi.fn(); const hold = vi.fn(); const states: AgentDrainProgress[] = [];
    const drain = new AgentShutdownDrain({ agents: () => agents, notify, hold });
    return { drain, notify, hold, states, set: (next: ShutdownAgent[]) => { agents = next; }, begin: (why: 'quit' | 'upgrade' = 'upgrade') => drain.begin(why, (state) => states.push(state)) };
}

describe('bounded safe-point wait before quit or upgrade (#616)', () => {
    it('a completed drain does not cache its outcome for the next shutdown', async () => {
        const r = rig([{ id: 'a', name: 'atlas', running: true, inTurn: false }]);
        const first = r.begin(); await first;
        r.set([{ id: 'a', name: 'atlas', running: true, inTurn: true }]);
        let done = false; const second = r.begin().then((value) => { done = true; return value; });
        await settle(); expect(done).toBe(false);
        expect(r.notify).toHaveBeenCalledTimes(1);
        r.drain.force(); await second;
    });

    it('an early force click is consumed by the next begin, without waiting for a timer', async () => {
        const r = rig();
        expect(r.drain.force()).toBe(true);
        expect(await r.begin()).toEqual({ interrupted: [{ id: 'a', name: 'atlas' }], forced: true, timedOut: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['tick', 'finish', 'begin'] as const)('a roster/probe throw in %s resolves safely instead of losing the bound', async (where) => {
        vi.useFakeTimers();
        let broken = where === 'begin';
        const drain = new AgentShutdownDrain({ agents: () => { if (broken) throw new Error('probe unavailable'); return [{ id: 'a', name: 'atlas', running: true, inTurn: true }]; }, notify: () => {} });
        let pending!: ReturnType<AgentShutdownDrain['begin']>;
        expect(() => { pending = drain.begin('upgrade', () => {}); }).not.toThrow();
        broken = true;
        if (where === 'finish') expect(() => drain.force()).not.toThrow();
        else expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
        const outcome = await Promise.race([pending, Promise.resolve('still pending')]);
        expect(outcome).toMatchObject({ interrupted: [] });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a throwing progress observer cannot strand the shutdown promise', async () => {
        vi.useFakeTimers();
        const drain = new AgentShutdownDrain({ agents: () => [{ id: 'a', name: 'atlas', running: true, inTurn: true }], notify: () => {} });
        let pending!: ReturnType<AgentShutdownDrain['begin']>;
        expect(() => { pending = drain.begin('upgrade', () => { throw new Error('window gone'); }); }).not.toThrow();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await pending).toMatchObject({ timedOut: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('explicit recovery releases the hold and allows a fresh wait, without releasing before record/stop', async () => {
        vi.useFakeTimers();
        const release = vi.fn();
        const drain = new AgentShutdownDrain({ agents: () => [], notify: () => {}, release });
        await drain.begin('quit', () => {});
        expect(release).not.toHaveBeenCalled(); // Keep queued work held until the caller commits or abandons shutdown.
        drain.release();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it.each(['upgrade', 'quit'] as const)('%s notifies working agents once and waits; idle agents are safe immediately', async (reason) => {
        const r = rig([{ id: 'a', name: 'atlas', running: true, inTurn: true }, { id: 'b', name: 'bolt', running: true, inTurn: false }]);
        let done = false; const result = r.begin(reason).then((outcome) => { done = true; return outcome; });
        await settle();
        expect(done).toBe(false);
        expect(r.notify).toHaveBeenCalledTimes(1);
        expect(r.notify).toHaveBeenCalledWith('a', expect.stringMatching(/thumbsUp.*shutdown/s));
        expect(r.notify.mock.calls[0]?.[1]).toContain(reason === 'quit' ? 'quit' : 'upgrade');
        expect(r.hold).toHaveBeenCalledTimes(1);
        expect(r.states.at(-1)).toEqual({ waiting: [{ id: 'a', name: 'atlas' }], deadline: 121_000 });
        r.set([{ id: 'a', name: 'atlas', running: true, inTurn: false }, { id: 'b', name: 'bolt', running: true, inTurn: false }]);
        await vi.advanceTimersByTimeAsync(250);
        expect(await result).toEqual({ interrupted: [], forced: false, timedOut: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('no working agents: no prompts, immediate safe completion, but new work is held', async () => {
        const r = rig([{ id: 'a', name: 'atlas', running: true, inTurn: false }]);
        expect(await r.begin()).toEqual({ interrupted: [], forced: false, timedOut: false });
        expect(r.notify).not.toHaveBeenCalled();
        expect(r.hold).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a fresh thumbsUp acknowledges only the named waiting agent; unrelated or late thumbs do not clear another agent', async () => {
        const r = rig([{ id: 'a', name: 'atlas', running: true, inTurn: true }, { id: 'b', name: 'bolt', running: true, inTurn: true }]);
        expect(r.drain.acknowledge('a')).toBe(false); // A thumb before this drain cannot satisfy it.
        let done = false; const result = r.begin().then((outcome) => { done = true; return outcome; });
        expect(r.drain.acknowledge('other')).toBe(false);
        expect(r.drain.acknowledge('a')).toBe(true);
        await settle(); expect(done).toBe(false);
        expect(r.states.at(-1)?.waiting).toEqual([{ id: 'b', name: 'bolt' }]);
        expect(r.drain.acknowledge('b')).toBe(true);
        expect((await result).timedOut).toBe(false);
        expect(r.drain.acknowledge('a')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waits for the full 120 seconds, then names the agents still mid-turn and leaves no timer', async () => {
        const r = rig(); let done = false;
        const result = r.begin().then((outcome) => { done = true; return outcome; });
        expect(AGENT_DRAIN_WAIT_MS).toBe(120_000);
        await vi.advanceTimersByTimeAsync(119_999); expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual({ interrupted: [{ id: 'a', name: 'atlas' }], forced: false, timedOut: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Upgrade now ends the wait immediately, with the actual mid-turn names; repeated force does nothing', async () => {
        const r = rig(); const result = r.begin();
        expect(r.drain.force()).toBe(true);
        expect(await result).toEqual({ interrupted: [{ id: 'a', name: 'atlas' }], forced: true, timedOut: false });
        expect(r.drain.force()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('repeated requests rejoin one wait and never re-notify; a gone agent cannot block shutdown', async () => {
        const r = rig(); const first = r.begin(); const second = r.begin();
        expect(second).toBe(first);
        expect(r.notify).toHaveBeenCalledTimes(1);
        r.set([]); await vi.advanceTimersByTimeAsync(250);
        expect(await first).toEqual({ interrupted: [], forced: false, timedOut: false });
        expect(vi.getTimerCount()).toBe(0);
    });
});
