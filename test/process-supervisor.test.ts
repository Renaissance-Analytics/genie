import { describe, expect, it } from 'vitest';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { ProcessSupervisor, type ProcessSpec } from '../src/main/process-supervisor.js';

/**
 * BACKGROUND PROCESSES AND SITE PROCESSES (§6.6) — Genie's supervisor over `PtyPort`.
 *
 * §1 names four things a pty is for; two of them are here: a background process Genie
 * supervises, and a hosted site's server process. There is no `agentId` anywhere in a
 * `ProcessSpec`, and the type test at the bottom keeps it that way.
 *
 * Restart is a POLICY, applied only to exits the supervisor did not cause: `stop()` means stop,
 * and a process the user stopped is never revived by its own policy. Backoff doubles from one
 * second and gives up after five consecutive failures with the state `failed` and the reason —
 * a process that is restarted forever looks running from across the room and is not.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const killed: string[] = [];
    const data = new Set<(id: string, d: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    const live = new Set<string>();
    let n = 0;
    const port: PtyPort = {
        open(options) {
            const id = `term_${++n}`;
            opened.push({ ...options, id });
            live.add(id);
            return { id, pid: 1000 + n, shell: options.command ?? '/bin/sh', scrollback: '' } satisfies PtyOpened;
        },
        write: () => true,
        resize: () => true,
        kill(id) {
            if (!live.has(id)) return false;
            live.delete(id);
            killed.push(id);
            return true;
        },
        scrollback: (id) => (live.has(id) ? `log of ${id}` : undefined),
        onData: (l) => { data.add(l); return () => data.delete(l); },
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
    };
    return {
        port,
        opened,
        killed,
        live,
        exits(id: string, code: number) {
            live.delete(id);
            for (const l of exit) l(id, code);
        },
        output(id: string, d: string) {
            for (const l of data) l(id, d);
        },
    };
}

/** A manual scheduler: `due()` fires every timer whose delay has elapsed. */
function fakeClock() {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    return {
        now: () => now,
        schedule(fn: () => void, ms: number) {
            const t = { at: now + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        advance(ms: number) {
            now += ms;
            for (const t of timers.splice(0)) {
                if (t.cancelled) continue;
                if (t.at <= now) t.fn();
                else timers.push(t);
            }
        },
        pending: () => timers.filter((t) => !t.cancelled).length,
    };
}

const spec = (over: Partial<ProcessSpec> = {}): ProcessSpec => ({
    id: 'proc_queue',
    workspaceId: 'tynn',
    name: 'queue worker',
    command: 'php artisan queue:work',
    cwd: '/repo',
    restart: 'on-failure',
    ...over,
});

function make() {
    const pty = fakePty();
    const clock = fakeClock();
    const sup = new ProcessSupervisor(pty.port, { now: clock.now, schedule: clock.schedule });
    return { pty, clock, sup };
}

describe('start / stop', () => {
    it('starts the command in its cwd with its env on a pty and reports running with the pid', () => {
        const { pty, sup } = make();
        const s = sup.start(spec({ env: { APP_ENV: 'local' } }));
        expect(pty.opened).toHaveLength(1);
        expect(pty.opened[0]).toMatchObject({ command: 'php artisan queue:work', cwd: '/repo', env: { APP_ENV: 'local' } });
        expect(s).toMatchObject({ id: 'proc_queue', state: 'running', pid: 1001, restarts: 0 });
    });

    it('starting an already-running process is a no-op that reports the running one (never a second pty)', () => {
        const { pty, sup } = make();
        sup.start(spec());
        const again = sup.start(spec());
        expect(pty.opened).toHaveLength(1);
        expect(again.state).toBe('running');
    });

    it('stop kills the pty, reports stopped, and the policy does NOT revive it', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'always' }));
        expect(sup.stop('proc_queue')).toBe(true);
        expect(pty.killed).toEqual(['term_1']);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'stopped' });
        // The pty exit that follows a kill is not a failure and schedules nothing.
        pty.exits('term_1', 143);
        clock.advance(60_000);
        expect(pty.opened).toHaveLength(1);
        expect(sup.status('proc_queue')!.state).toBe('stopped');
    });

    it('stop of an unknown process is false', () => {
        const { sup } = make();
        expect(sup.stop('proc_nope')).toBe(false);
    });

    it('the log is the pty scrollback, and output is streamed to listeners with the process id', () => {
        const { pty, sup } = make();
        const seen: Array<[string, string]> = [];
        sup.onOutput((id, d) => seen.push([id, d]));
        sup.start(spec());
        pty.output('term_1', 'Processing job 1');
        expect(sup.log('proc_queue')).toBe('log of term_1');
        expect(seen).toEqual([['proc_queue', 'Processing job 1']]);
    });
});

describe('restart policy — applied only to exits the supervisor did not cause', () => {
    it('on-failure: a non-zero exit restarts after a 1 s backoff; a zero exit ends as exited', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'on-failure' }));
        pty.exits('term_1', 1);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'restarting', exitCode: 1 });
        clock.advance(999);
        expect(pty.opened).toHaveLength(1);
        clock.advance(1);
        expect(pty.opened).toHaveLength(2);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'running', restarts: 1, pid: 1002 });

        pty.exits('term_2', 0);
        clock.advance(60_000);
        expect(pty.opened).toHaveLength(2);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'exited', exitCode: 0 });
    });

    it('always: a zero exit restarts too; never: nothing restarts', () => {
        const a = make();
        a.sup.start(spec({ restart: 'always' }));
        a.pty.exits('term_1', 0);
        a.clock.advance(1_000);
        expect(a.pty.opened).toHaveLength(2);

        const n = make();
        n.sup.start(spec({ restart: 'never' }));
        n.pty.exits('term_1', 1);
        n.clock.advance(60_000);
        expect(n.pty.opened).toHaveLength(1);
        expect(n.sup.status('proc_queue')).toMatchObject({ state: 'exited', exitCode: 1 });
    });

    it('backoff doubles (1, 2, 4, 8, 16 s) and the SIXTH consecutive failure gives up as failed with the reason', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'always' }));
        const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
        for (let i = 0; i < delays.length; i++) {
            pty.exits(`term_${i + 1}`, 1);
            clock.advance(delays[i]! - 1);
            expect(pty.opened).toHaveLength(i + 1);
            clock.advance(1);
            expect(pty.opened).toHaveLength(i + 2);
        }
        pty.exits('term_6', 1);
        clock.advance(600_000);
        // COUNTED: six ptys in total, not seven.
        expect(pty.opened).toHaveLength(6);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'failed', restarts: 5 });
        expect(sup.status('proc_queue')!.reason).toMatch(/5 consecutive/);
    });

    it('a run that stays up resets the consecutive-failure count', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'always' }));
        pty.exits('term_1', 1);
        clock.advance(1_000);
        pty.exits('term_2', 1);
        clock.advance(2_000);
        // term_3 runs for a minute — healthy — then dies: backoff is back to 1 s.
        clock.advance(60_000);
        pty.exits('term_3', 1);
        clock.advance(1_000);
        expect(pty.opened).toHaveLength(4);
    });

    it('a manual restart stops the current run and starts a new one, resetting the failure count', () => {
        const { pty, sup } = make();
        sup.start(spec());
        const s = sup.restart('proc_queue');
        expect(pty.killed).toEqual(['term_1']);
        expect(pty.opened).toHaveLength(2);
        expect(s).toMatchObject({ state: 'running', pid: 1002, restarts: 0 });
    });
});

describe('listing and change events', () => {
    it('lists per workspace, and fires onChange on every state change', () => {
        const { pty, clock, sup } = make();
        const states: string[] = [];
        sup.onChange((s) => states.push(`${s.id}:${s.state}`));
        sup.start(spec({ id: 'a', workspaceId: 'tynn' }));
        sup.start(spec({ id: 'b', workspaceId: 'fancy', restart: 'never' }));
        pty.exits('term_2', 0);
        sup.stop('a');
        clock.advance(10);
        expect(sup.list('tynn').map((s) => s.id)).toEqual(['a']);
        expect(sup.list().map((s) => s.id).sort()).toEqual(['a', 'b']);
        expect(states).toEqual(['a:running', 'b:running', 'b:exited', 'a:stopped']);
    });
});

describe('the one rule, in the type system', () => {
    it('a ProcessSpec has no agent field of any name', () => {
        const fields = Object.keys(spec({ env: {} })).sort();
        expect(fields).toEqual(['command', 'cwd', 'env', 'id', 'name', 'restart', 'workspaceId']);
        expect(fields.filter((f) => /agent/i.test(f))).toHaveLength(0);
    });
});
