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

function fakePty(options: { isLive?: boolean } = {}) {
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
        // The engine's own answer, asked every time (fancy-term-host `isLive`); left out to model an engine without it.
        ...(options.isLive === false ? {} : { isLive: (id: string) => live.has(id) }),
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
        /** The pty is gone and NO exit event comes — what a lost pty host does to every pty it held. */
        vanish(id: string) {
            live.delete(id);
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

function make(options: { isLive?: boolean; pidAlive?: (pid: number) => boolean } = {}) {
    const pty = fakePty({ ...(options.isLive === undefined ? {} : { isLive: options.isLive }) });
    const clock = fakeClock();
    const sup = new ProcessSupervisor(pty.port, { now: clock.now, schedule: clock.schedule }, options.pidAlive ? { pidAlive: options.pidAlive } : {});
    return { pty, clock, sup };
}

/** The log as lines — what a person reads under the row and an agent gets from `processes logs`. */
const logLines = (sup: ProcessSupervisor, id = 'proc_queue') => sup.log(id)?.split('\n') ?? [];

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

    it('the log is what the process printed — kept by the supervisor, not the pty’s scrollback — and output is streamed to listeners with the process id', () => {
        const { pty, sup } = make();
        const seen: Array<[string, string]> = [];
        sup.onOutput((id, d) => seen.push([id, d]));
        sup.start(spec());
        pty.output('term_1', 'Processing job 1\r\n');
        expect(logLines(sup)).toEqual(['[genie] started (pid 1001): php artisan queue:work', 'Processing job 1']);
        expect(sup.log('proc_queue')).not.toContain('log of term_1');
        expect(seen).toEqual([['proc_queue', 'Processing job 1\r\n']]);
    });
});

describe('the log outlives the run (P1)', () => {
    it('survives a clean exit — counted: the start, two lines of output, the exit', () => {
        const { pty, sup } = make();
        sup.start(spec({ restart: 'never' }));
        pty.output('term_1', 'migrated 3 tables\nready\n');
        pty.exits('term_1', 0);
        expect(sup.status('proc_queue')!.state).toBe('exited');
        // The pty is gone (its scrollback with it); the log is not.
        expect(pty.port.scrollback('term_1')).toBeUndefined();
        expect(logLines(sup)).toEqual(['[genie] started (pid 1001): php artisan queue:work', 'migrated 3 tables', 'ready', '[genie] exited with code 0']);
    });

    it('survives a CRASH and the policy’s restart: both runs’ output, and why it restarted, in one log — counted', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'on-failure' }));
        pty.output('term_1', 'PDOException: could not connect\n');
        pty.exits('term_1', 1);
        // Mid-backoff, nothing running: the crash is readable now, which is when it is needed.
        expect(sup.status('proc_queue')!.state).toBe('restarting');
        expect(logLines(sup)).toContain('PDOException: could not connect');
        clock.advance(1_000);
        pty.output('term_2', 'Processing job 2\n');
        expect(logLines(sup)).toEqual([
            '[genie] started (pid 1001): php artisan queue:work',
            'PDOException: could not connect',
            '[genie] exited with code 1; restarting in 1s',
            '[genie] started (pid 1002): php artisan queue:work',
            'Processing job 2',
        ]);
    });

    it('a process that gave up says so in its log, and a manual restart keeps what came before', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'always' }));
        for (let i = 1; i <= 6; i++) {
            pty.output(`term_${i}`, `attempt ${i}\n`);
            pty.exits(`term_${i}`, 1);
            clock.advance(60_000 - 1); // never healthy: each run dies inside the minute
        }
        expect(sup.status('proc_queue')!.state).toBe('failed');
        expect(logLines(sup).filter((l) => /^attempt \d$/.test(l))).toHaveLength(6);
        expect(logLines(sup).at(-1)).toMatch(/^\[genie\] exited with code 1; gave up after 5 consecutive failures/);
        sup.restart('proc_queue');
        expect(logLines(sup).filter((l) => /^attempt \d$/.test(l))).toHaveLength(6);
        expect(logLines(sup).at(-1)).toBe('[genie] started (pid 1007): php artisan queue:work');
    });

    it('is bounded — counted: 3 000 lines printed, 2 000 kept, the cut reported (control: a short log is whole)', () => {
        const { pty, sup } = make();
        sup.start(spec());
        pty.output('term_1', `${Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
        const log = sup.readLog('proc_queue')!;
        expect(log.lines).toBe(2_000);
        expect(logLines(sup)).toHaveLength(2_000);
        expect(logLines(sup)[0]).toBe('line 1001');
        expect(log.dropped).toBe(1_001); // the start line and the first 1 000 printed
        expect(sup.readLog('proc_queue', 5)!.text.split('\n')).toEqual(['line 2996', 'line 2997', 'line 2998', 'line 2999', 'line 3000']);

        const short = make();
        short.sup.start(spec());
        short.pty.output('term_1', 'one\ntwo\n');
        expect(short.sup.readLog('proc_queue')).toMatchObject({ lines: 3, dropped: 0 });
    });

    it('a stop keeps the log (the row is still listed); forget drops it with the process', () => {
        const { pty, sup } = make();
        sup.start(spec());
        pty.output('term_1', 'hello\n');
        sup.stop('proc_queue');
        expect(logLines(sup)).toContain('hello');
        sup.forget('proc_queue');
        expect(sup.log('proc_queue')).toBeUndefined();
        expect(sup.readLog('proc_queue')).toBeNull();
    });
});

describe('running means running: the liveness check (P2)', () => {
    it('a running process whose pty vanished with NO exit event is a crash: suspect first, then restarted by its policy', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'on-failure' }));
        pty.vanish('term_1');
        expect(sup.recheck()).toEqual([]);
        // Suspect, not yet declared: its own exit may still be on its way.
        expect(sup.status('proc_queue')!.state).toBe('running');
        clock.advance(5_000);
        // The second look was scheduled by the first, not left to the next heartbeat.
        expect(sup.status('proc_queue')).toMatchObject({ state: 'restarting', exitCode: -1 });
        expect(logLines(sup)).toContain('[genie] this process is no longer running, and Genie never saw it exit (the pty engine or the OS has no process for it); treating it as a crash');
        clock.advance(1_000);
        expect(pty.opened).toHaveLength(2);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'running', pid: 1002, restarts: 1 });
    });

    it('a LIVE process is untouched — counted, beside a lost one (the control)', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ id: 'lost', restart: 'always' }));
        sup.start(spec({ id: 'alive', restart: 'always' }));
        pty.vanish('term_1');
        sup.recheck();
        clock.advance(5_000);
        expect(sup.status('lost')!.state).toBe('restarting');
        expect(sup.status('alive')).toMatchObject({ state: 'running', pid: 1002, restarts: 0 });
        expect(pty.killed).not.toContain('term_2');
        clock.advance(60_000);
        expect(pty.opened.map((o) => o.id)).toEqual(['term_1', 'term_2', 'term_3']);
        expect(sup.status('alive')).toMatchObject({ state: 'running', pid: 1002 });
    });

    it('an exit that arrives inside the grace is routed with ITS code: a clean exit is never read as a crash', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ restart: 'on-failure' }));
        pty.vanish('term_1');
        sup.recheck();
        pty.exits('term_1', 0);
        clock.advance(60_000);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'exited', exitCode: 0 });
        expect(pty.opened).toHaveLength(1);
    });

    it('a pty the engine still holds for a DEAD pid is lost too, and the engine is told to let it go', () => {
        const dead = new Set<number>();
        const { pty, clock, sup } = make({ pidAlive: (pid) => !dead.has(pid) });
        sup.start(spec({ restart: 'on-failure' }));
        dead.add(1001);
        sup.recheck();
        clock.advance(5_000);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'restarting', exitCode: -1 });
        expect(pty.killed).toEqual(['term_1']);
    });

    it('the policy still decides: `never` ends exited with -1; a process the person stopped is never revived', () => {
        const n = make();
        n.sup.start(spec({ restart: 'never' }));
        n.pty.vanish('term_1');
        n.sup.recheck();
        n.clock.advance(60_000);
        expect(n.sup.status('proc_queue')).toMatchObject({ state: 'exited', exitCode: -1 });
        expect(n.pty.opened).toHaveLength(1);

        const s = make();
        s.sup.start(spec({ restart: 'always' }));
        s.sup.stop('proc_queue');
        s.sup.recheck();
        s.clock.advance(60_000);
        expect(s.sup.status('proc_queue')!.state).toBe('stopped');
        expect(s.pty.opened).toHaveLength(1);
    });

    it('runs on a 30 s heartbeat until stopped — no one has to ask', () => {
        const { pty, clock, sup } = make();
        const stop = sup.watchLiveness();
        sup.start(spec({ restart: 'always' }));
        pty.vanish('term_1');
        clock.advance(29_999);
        expect(sup.status('proc_queue')!.state).toBe('running');
        clock.advance(1); // the heartbeat: suspect
        clock.advance(5_000); // the scheduled second look: lost
        expect(sup.status('proc_queue')!.state).toBe('restarting');
        clock.advance(1_000);
        expect(pty.opened).toHaveLength(2);

        stop();
        pty.vanish('term_2');
        clock.advance(120_000);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'running', pid: 1002 });
    });

    it('any pty exit is the cue to look at the rest: a lost process is found without waiting for the heartbeat', () => {
        const { pty, clock, sup } = make();
        sup.start(spec({ id: 'worker', restart: 'on-failure' }));
        sup.start(spec({ id: 'watcher', restart: 'never' }));
        pty.vanish('term_1'); // the worker's pty went with the host…
        pty.exits('term_2', 0); // …and the one exit Genie DID see makes it look
        clock.advance(5_000);
        expect(sup.status('worker')).toMatchObject({ state: 'restarting', exitCode: -1 });
        expect(sup.status('watcher')).toMatchObject({ state: 'exited', exitCode: 0 });
    });

    it('an engine with no `isLive` and no pid probe cannot tell — and nothing is guessed (control for the claims above)', () => {
        const { pty, clock, sup } = make({ isLive: false });
        sup.start(spec({ restart: 'always' }));
        pty.vanish('term_1');
        sup.recheck();
        clock.advance(60_000);
        expect(sup.status('proc_queue')).toMatchObject({ state: 'running', pid: 1001 });
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
