import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SpawnFrame } from '../src/main/spawn-host-protocol.js';
import { startSpawnRelay, type RelayChild } from '../src/main/spawn-relay.js';

/**
 * GENIE-HOST'S SPAWN-HOST CHILDREN (the host split, P2.1: plan §11a). The host forks two profiles of #1405's spawn host —
 * `processes` (exec, streams, supervised ptys) and `terminals` (interactive shells, with the cwd hook) — and relays their
 * frames to and from the window. A child that dies takes its ptys' helpers with it: the relay ends them by pid, reports
 * each pty exited (-1) to the window ONLY once its helper is gone (#1405's lesson: never race the old process for its
 * port), and starts the child again. A window that goes leaves no stream running for nobody.
 */

class FakeChild extends EventEmitter implements RelayChild {
    sent: SpawnFrame[] = [];
    pid: number;
    connected = true;
    constructor(pid: number, readonly env: Record<string, string>) { super(); this.pid = pid; }
    send(frame: SpawnFrame): boolean { this.sent.push(frame); return true; }
    kill(): boolean { return true; }
    /** The child says something. */
    say(frame: SpawnFrame): void { this.emit('message', frame); }
    die(): void { this.connected = false; this.emit('exit', 1, null); }
}

function relay() {
    const children: FakeChild[] = [];
    const toWindows: Array<{ profile: string; frame: SpawnFrame }> = [];
    const killed: number[] = [];
    const alive = new Set<number>();
    const timers: Array<() => void> = [];
    let next = 100;
    const logged: string[] = [];
    const r = startSpawnRelay({
        entry: 'spawn-host.js',
        fork: (_entry, env) => { const c = new FakeChild(next++, env); children.push(c); return c; },
        send: (profile, frame) => toWindows.push({ profile, frame }),
        killPid: (pid) => { killed.push(pid); },
        pidAlive: (pid) => alive.has(pid),
        schedule: (fn) => { timers.push(fn); return () => {}; },
        log: (line) => { logged.push(line); },
    });
    return { r, children, toWindows, killed, alive, logged, runTimers: () => { const t = timers.splice(0); for (const fn of t) fn(); } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the spawn relay in genie-host', () => {
    it('forks one child per profile, each told its profile', () => {
        const { children } = relay();
        expect(children.map((c) => c.env.GENIE_SPAWN_PROFILE)).toEqual(['processes', 'terminals']);
    });

    it('a child that says it is ready is named in the lifecycle log with its pid and profile (the real-window CI gate reads it)', () => {
        const { children, logged } = relay();
        expect(logged.filter((l) => l.startsWith('spawn host ready'))).toEqual([]); // CONTROL: nothing claims ready before the child says so
        children[0]!.say({ kind: 'event', channel: 'host.ready', payload: {} });
        expect(logged.filter((l) => l.startsWith('spawn host ready'))).toEqual([`spawn host ready pid=${children[0]!.pid} profile=processes (a child of genie-host)`]);
    });

    it('a window\'s frame goes to its profile\'s child; a child\'s frame goes to the window under its profile', () => {
        const { r, children, toWindows } = relay();
        const frame: SpawnFrame = { kind: 'call', id: 0, method: 'pty.write', args: ['t1', 'x'] };
        r.send('terminals', frame);
        expect(children[1]!.sent).toEqual([frame]);
        expect(children[0]!.sent).toEqual([]);
        const back: SpawnFrame = { kind: 'event', channel: 'pty.data', payload: { id: 't1', data: 'x' } };
        children[1]!.say(back);
        expect(toWindows).toEqual([{ profile: 'terminals', frame: back }]);
    });

    it('a child that dies: its ptys\' helpers are ended by pid, reported exited (-1) once GONE, and the child is started again', async () => {
        const { children, toWindows, killed, alive, runTimers } = relay();
        const processes = children[0]!;
        processes.say({ kind: 'event', channel: 'pty.opened', payload: { id: 'site', pid: 7001 } });
        processes.say({ kind: 'event', channel: 'pty.opened', payload: { id: 'done', pid: 7002 } });
        processes.say({ kind: 'event', channel: 'pty.exit', payload: { id: 'done', code: 0 } });
        alive.add(7001);
        toWindows.length = 0;
        processes.die();
        expect(killed).toEqual([7001]); // only the one still running
        await tick();
        // Not reported while its helper still runs: never race the dying process for its port.
        expect(toWindows.filter((w) => w.frame.kind === 'event' && w.frame.channel === 'pty.exit')).toEqual([]);
        alive.delete(7001);
        for (let i = 0; i < 20 && toWindows.length === 0; i += 1) await new Promise((r) => setTimeout(r, 120));
        expect(toWindows).toEqual([{ profile: 'processes', frame: { kind: 'event', channel: 'pty.exit', payload: { id: 'site', code: -1 } } }]);
        runTimers();
        expect(children.filter((c) => c.env.GENIE_SPAWN_PROFILE === 'processes')).toHaveLength(2);
    });

    it('a window that goes: the processes child ends its streams (their lines would go nowhere)', () => {
        const { r, children } = relay();
        r.windowGone();
        expect(children[0]!.sent).toEqual([{ kind: 'call', id: 0, method: 'spawn.unstreamAll', args: [] }]);
    });
});
