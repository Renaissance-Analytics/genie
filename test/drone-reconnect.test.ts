import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DRONE_MIN_BUILD } from '../src/core/drone-version.js';
import { relayConnectView } from '../src/core/relay-connect.js';
import { inMemoryPair, type ClientTransport } from '../src/core/remote-protocol.js';
import { droneReconnect, type DroneHold } from '../src/renderer/drone-reconnect.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';

/*
 * A DRONE THAT RESTARTS IS RECONNECTED BY ITSELF (Tynn #651; the owner, 2026-11-12: "updating drone machines need to
 * reconnect after they upgrade"). A Tynn workstation's window said the drop with Retry and stayed there, so a Pilot whose
 * drone upgraded needed a click. The window keeps the connection's intent: "aion is restarting, reconnecting…", dials
 * again with backoff, and resumes when aion's new Genie answers. Past ~5 min it shows the failure with Retry. A drone that
 * comes back on a build still too old says so, and is dialled again until it has been updated.
 */

/**
 * A manual clock: `schedule` queues, `advance` runs what is due, in order, letting each dial settle.
 *
 * Two things it must get right (the first VM run of #1888 failed on both, in this clock, not in the code under test):
 * - What is already in flight settles BEFORE the time moves. A drop the in-memory pair delivers on the microtask queue
 *   happened "now"; with the clock jumped first it was heard at the end of the advance, so `dropped()` stamped its start
 *   4 min late (no give-up at 6 min) and scheduled its first dial past the end (still `restarting`, never `skew`).
 * - Settling uses setImmediate, not setTimeout(0): Windows clamps a 0 ms timer to its ~15.6 ms tick, so 20 of them per
 *   fired timer took the two-hour backoff test past vitest's 5 s. Everything the fakes do is microtasks, which one
 *   macrotask turn drains; a few turns are margin.
 */
function manualClock() {
    let at = 0;
    let timers: Array<{ due: number; fn: () => void; live: boolean }> = [];
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
    return {
        now: () => at,
        schedule: (ms: number, fn: () => void) => { const t = { due: at + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
        pending: () => timers.filter((t) => t.live).length,
        async advance(ms: number) {
            const end = at + ms;
            await settle();
            for (;;) {
                const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
                if (!next) break;
                at = next.due;
                next.live = false;
                timers = timers.filter((t) => t.live);
                next.fn();
                await settle();
            }
            at = end;
            await settle();
        },
    };
}

/** The drone's machine: down (its Genie is restarting), or up on a build. Every dial reaches whatever is there now. */
function droneMachine() {
    let build: string | null = '2.0.0-beta.61.2+abc';
    let up = true;
    let live: ClientTransport | null = null;
    let dials = 0;
    const dial = (): ClientTransport => {
        dials += 1;
        const { client, server } = inMemoryPair();
        if (!up) { queueMicrotask(() => server.close()); return client; }
        live = server;
        const welcome = build === null ? {} : { protocol: 1, build };
        server.onMessage((text) => {
            const raw = JSON.parse(text) as { kind: string; id?: number; method?: string };
            if (raw.kind === 'hello') server.send(JSON.stringify({ kind: 'welcome', connectionId: `c${dials}`, host: 'aion', isOwner: true, workspaceId: null, ...welcome }));
            else if (raw.kind === 'call') server.send(JSON.stringify({ kind: 'result', id: raw.id, ok: true, value: { driver: null, mine: true, locked: false } }));
        });
        return client;
    };
    return {
        dial,
        dials: () => dials,
        /** The drone's Genie quits (an upgrade's restart): the live link drops, and nothing answers until `start`. */
        stop: () => { up = false; live?.close(); live = null; },
        start: (next: string | null) => { build = next; up = true; },
    };
}

/** The window's side: dial with connectRemote and the minimum build, outcome as the reconnect wants it. */
function pilotWindow(machine: ReturnType<typeof droneMachine>, clock: ReturnType<typeof manualClock>) {
    let client: RemoteClient | null = null;
    const holds: DroneHold[] = [];
    let gaveUp = 0;
    const dial = async (): Promise<'connected' | 'skew' | 'failed'> => {
        const next = connectRemote(machine.dial(), { kind: 'relay', label: 'pilot' }, 'pilot', { minBuild: DRONE_MIN_BUILD });
        client = next;
        const r = await next.ready;
        if (r.ok) { next.onState((s) => { if (!s.connected) keep.dropped(); }); return 'connected'; }
        return r.skew ? 'skew' : 'failed';
    };
    const keep = droneReconnect({ dial, schedule: clock.schedule, now: clock.now, onHold: (h) => holds.push(h), onGiveUp: () => { gaveUp += 1; } });
    return { keep, dial, client: () => client, holds, gaveUp: () => gaveUp };
}

describe('a connected Pilot whose drone restarts on a newer build', () => {
    it('says it is restarting, dials again with backoff, and resumes with no click', async () => {
        const clock = manualClock();
        const machine = droneMachine();
        const pilot = pilotWindow(machine, clock);
        expect(await pilot.dial()).toBe('connected');

        machine.stop();
        await clock.advance(0);
        expect(pilot.holds.at(-1)).toBe('restarting');
        expect(pilot.client()!.state().connected).toBe(false);

        // Down for a minute: every dial fails, the hold stays, nothing asks for Retry.
        await clock.advance(60_000);
        const triedWhileDown = machine.dials();
        expect(triedWhileDown).toBeGreaterThan(2);
        expect(pilot.holds.at(-1)).toBe('restarting');

        // Its new Genie answers: connected again within 30 s, the hold lifted.
        machine.start('2.0.0-beta.62+def');
        await clock.advance(30_000);
        expect(pilot.client()!.state()).toMatchObject({ connected: true, host: 'aion', hostBuild: '2.0.0-beta.62+def' });
        expect(pilot.holds.at(-1)).toBeNull();
        expect(pilot.gaveUp()).toBe(0);
        // Connected: nothing more is dialled.
        const after = machine.dials();
        await clock.advance(120_000);
        expect(machine.dials()).toBe(after);
        pilot.keep.stop();
    });

    it('backs off: the gaps between dials grow, and never exceed 15 s', () => {
        const clock = manualClock();
        const delays: number[] = [];
        const keep = droneReconnect({ dial: async () => 'failed', schedule: (ms, fn) => { delays.push(ms); return clock.schedule(ms, fn); }, now: clock.now, onHold: () => {} });
        keep.dropped();
        return clock.advance(120_000).then(() => {
            expect(delays.length).toBeGreaterThan(3);
            expect(delays[0]).toBeLessThan(delays[3]!);
            expect(Math.max(...delays)).toBeLessThanOrEqual(15_000);
            keep.stop();
        });
    });

    it('a drone gone longer than ~5 min shows the failure with Retry, and dialling stops', async () => {
        const clock = manualClock();
        const machine = droneMachine();
        const pilot = pilotWindow(machine, clock);
        expect(await pilot.dial()).toBe('connected');
        machine.stop();
        await clock.advance(4 * 60_000);
        expect(pilot.holds.at(-1)).toBe('restarting');
        expect(pilot.gaveUp()).toBe(0);
        await clock.advance(2 * 60_000);
        expect(pilot.holds.at(-1)).toBeNull();
        expect(pilot.gaveUp()).toBe(1);
        const stopped = machine.dials();
        await clock.advance(10 * 60_000);
        expect(machine.dials()).toBe(stopped);
        expect(clock.pending()).toBe(0);
    });

    it('a drone that comes back still too old says so, and is dialled until it has been updated', async () => {
        const clock = manualClock();
        const machine = droneMachine();
        const pilot = pilotWindow(machine, clock);
        expect(await pilot.dial()).toBe('connected');
        machine.stop();
        machine.start(null); // a restart into an older Genie that says no build at all
        await clock.advance(5_000);
        expect(pilot.holds.at(-1)).toBe('skew');
        // Still too old ten minutes on: still said, never given up on, never a raw error.
        await clock.advance(10 * 60_000);
        expect(pilot.holds.at(-1)).toBe('skew');
        expect(pilot.gaveUp()).toBe(0);
        // Updated: connected by the next older-drone dial, at most 5 min after its new Genie answers.
        machine.start('2.0.0-beta.61.2+abc');
        await clock.advance(5 * 60_000);
        expect(pilot.client()!.state().connected).toBe(true);
        expect(pilot.holds.at(-1)).toBeNull();
        pilot.keep.stop();
    });
});

describe('a first connect that finds an older drone', () => {
    it('skewed() keeps dialling until the drone has been updated', async () => {
        const clock = manualClock();
        const machine = droneMachine();
        machine.start('2.0.0-beta.60+aaa');
        const pilot = pilotWindow(machine, clock);
        expect(await pilot.dial()).toBe('skew');
        pilot.keep.skewed();
        expect(pilot.holds.at(-1)).toBe('skew');
        await clock.advance(5 * 60_000);
        expect(pilot.client()!.state().connected).toBe(false);
        machine.start('2.0.0-beta.61.2+abc');
        await clock.advance(5 * 60_000);
        expect(pilot.client()!.state().connected).toBe(true);
        expect(pilot.holds.at(-1)).toBeNull();
        pilot.keep.stop();
    });

    it('Retry dials now and starts over; stop() ends every dial', async () => {
        const clock = manualClock();
        let dials = 0;
        const keep = droneReconnect({ dial: async () => { dials += 1; return 'failed'; }, schedule: clock.schedule, now: clock.now, onHold: () => {} });
        keep.dropped();
        await clock.advance(2_000);
        const before = dials;
        keep.retryNow();
        await clock.advance(0);
        expect(dials).toBe(before + 1);
        keep.stop();
        await clock.advance(10 * 60_000);
        expect(dials).toBe(before + 1);
        expect(clock.pending()).toBe(0);
    });
});

describe('an older drone is not asked every 20 s forever', () => {
    /*
     * Each dial asks Tynn for a way in: every 20 s, a window left open on an older drone was ~4,300 Tynn calls a day (the
     * coordinator's review of #1888). The older-drone dial backs off, 20 s doubling to a 5 min cap, never given up on.
     */
    it('backs off 20 s, 40 s, 80 s, 160 s, then every 5 min, and never gives up', async () => {
        const clock = manualClock();
        const delays: number[] = [];
        let gaveUp = 0;
        const holds: DroneHold[] = [];
        const keep = droneReconnect({ dial: async () => 'skew', schedule: (ms, fn) => { delays.push(ms); return clock.schedule(ms, fn); }, now: clock.now, onHold: (h) => holds.push(h), onGiveUp: () => { gaveUp += 1; } });
        keep.skewed();
        await clock.advance(2 * 60 * 60_000);
        expect(delays.slice(0, 6)).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
        expect(Math.max(...delays)).toBe(300_000);
        // Two hours on: about 28 dials, not 360; still dialling, still saying the update sentence.
        expect(delays.length).toBeLessThan(30);
        expect(clock.pending()).toBe(1);
        expect(holds.at(-1)).toBe('skew');
        expect(gaveUp).toBe(0);
        keep.stop();
    });

    it('Retry starts the backoff over at 20 s', async () => {
        const clock = manualClock();
        const delays: number[] = [];
        const keep = droneReconnect({ dial: async () => 'skew', schedule: (ms, fn) => { delays.push(ms); return clock.schedule(ms, fn); }, now: clock.now, onHold: () => {} });
        keep.skewed();
        await clock.advance(30 * 60_000);
        expect(delays.at(-1)).toBe(300_000);
        keep.retryNow();
        await clock.advance(0);
        expect(delays.at(-1)).toBe(20_000);
        keep.stop();
    });
});

describe('the connect screen while it reconnects', () => {
    it('says the drone is restarting and reconnecting, with no failure and no Retry', () => {
        const view = relayConnectView('aion', { kind: 'reconnecting' });
        expect(view.notice).toBe('aion is restarting, reconnecting…');
        expect(view.problem).toBeNull();
        expect(view.steps.some((s) => s.status === 'failed')).toBe(false);
    });
});

describe('the window wires it', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    it('a Tynn workstation’s window that dropped reconnects through droneReconnect, not a Retry', () => {
        expect(app).toMatch(/droneReconnect\(\{/);
        expect(app).toMatch(/reconnectDrone\.dropped\(\)/);
        expect(app).toMatch(/reconnectDrone\.skewed\(\)/);
        expect(app).toMatch(/kind: 'reconnecting'/);
    });
});
