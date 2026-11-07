import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * MAIN NEVER WAITS ON A SPAWN (genie#1397). The owner's beta.54 lifecycle.log: main held 600 s in 216 blocks (up to
 * 18.3 s, 9.7 s at boot) inside `spawn < execFile < execFileRunner < … status < state` — the Docker CLI, spawned on
 * Electron main, where Windows creates the process synchronously on the calling thread — and 20 s more in pty spawns for
 * supervised processes. The fix: every `execFileRunner` call and every supervised pty is made by the SPAWN HOST, a child
 * process main talks to over messages (main/spawn-host*.ts).
 *
 * The gauge: a spawner that holds its thread 5 s per call (a CreateProcess that takes 5 s), and main's heartbeat
 * (a 10 ms timer) while Docker's state is read through Genie's real runner and driver. In-process, main stops for the
 * full 5 s per call (it read 4,990 ms on the old code). Through the spawn host, the 5 s are the child's.
 *
 * THE BAR IS A FIFTH OF THE SPAWN (1 s), not 50 ms. What this test names is main held FOR the spawn: about 5,000 ms.
 * Under the full suite on omarchy-test (2 vCPU, every worker busy) the gauge read 57 and 122 ms on the fixed code — the
 * OS running the worker's thread and not main's, which no heartbeat can tell from a hold — and failed a 50 ms bar that
 * said nothing about a spawn. 1 s is 8x the worst jitter seen and 5x under the failure. The CONTROL below keeps the bar
 * honest: the same gauge, with the spawn made on main, must read most of the 5 s, in every run.
 *
 * The test wires the spawn host the way main.ts does when the module exists; a tree without it runs in-process (and
 * reads red, for the reason this test names: main held).
 */

const SLOW_MS = 5_000;
/** Main held for longer than this was held FOR the spawn (a fifth of it); under it is the machine's scheduling. */
const HELD_BAR_MS = SLOW_MS / 5;

/** What a hold reads: the wall clock, and the CPU this process has spent. */
interface HoldClocks {
    now(): number;
    spent(): number;
}

/** Hold this thread `ms`, the way a synchronous CreateProcess does. */
function hold(ms: number): void {
    holdFor(ms, { now: () => Date.now(), spent: () => cpuNow() });
}

/**
 * The hold itself, over the clocks it is given: until main has SPENT `ms`, so time the machine did not run it does not count, and a stopped or starved process cannot make the hold shorter
 * than the gauge expects. Capped at three times `ms` of wall time (well inside the 30 s test timeout), should the machine never give it the CPU.
 */
function holdFor(ms: number, clocks: HoldClocks): void {
    const cap = clocks.now() + 3 * ms;
    const from = clocks.spent();
    while (clocks.spent() - from < ms && clocks.now() < cap) { /* held */ }
}

/**
 * The longest worker gap overlapping [from, to] (worker gaps as [end, gap] pairs).
 */
function overlapWith(gaps: ReadonlyArray<readonly [number, number]>, from: number, to: number): number {
    let longest = 0;
    for (const [end, gap] of gaps) longest = Math.max(longest, Math.min(to, end) - Math.max(from, end - gap));
    return longest;
}

// IN-PROCESS, the spawner is node:child_process's execFile: made to take 5 s of this thread per call.
vi.mock('node:child_process', async (original) => {
    const real = await original<typeof import('node:child_process')>();
    return {
        ...real,
        execFile: (...args: unknown[]) => {
            hold(SLOW_MS);
            const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
            setImmediate(() => callback(null, '[{"State":{"Status":"running","StartedAt":"2026-11-01T00:00:00Z"}}]', ''));
            return { exitCode: 0 } as never;
        },
    };
});

/**
 * ONE OF MAIN'S GAPS, READ. A worker's gap says the worker did not run, and that alone cannot say why: the whole process stopped, or only the worker was kept off a loaded CPU while main
 * spun. CPU can: a stopped process spent none. So a gap counts as held by the larger of what is left once the worker's gap is off it (main blocked in the kernel spends no CPU, and the
 * worker ran) and the CPU spent during it (main spinning, whatever the worker did). A stopped process has neither, and main merely descheduled has no CPU to show.
 */
function heldOf(reading: { gap: number; cpu: number; stalled: number }): number {
    return Math.max(reading.gap - reading.stalled, reading.cpu);
}

/** CPU this process has spent, in ms. The gauge's worker is a timer's worth of it. */
const cpuNow = (): number => { const used = process.cpuUsage(); return (used.user + used.system) / 1000; };

/** While a gauge runs: stop the gauge's worker for `ms`, with main still running, as a loaded machine can. */
let starveWorker: (ms: number) => void = () => {};

/**
 * How long MAIN'S THREAD was held during `run`, beyond what this whole process was held at the same moment: a 10 ms
 * heartbeat on main, and one on a worker thread of the same process. Every gap of main's is reduced by the worker's gap
 * that overlaps it. A held main thread (a synchronous spawn) reads its full length; a process the machine did not
 * schedule (the full suite saturating every CPU: measured 76 and 304 ms on omarchy-test) reads about 0, because the
 * worker was not run either. The worst remainder is returned.
 */
async function heartbeatDuring(run: () => Promise<unknown>): Promise<number> {
    // The worker's gaps over 20 ms, as [end, gap] pairs in a shared ring (slot 0 is the count).
    const shared = new Float64Array(new SharedArrayBuffer(8 * (1 + 2 * 4096)));
    const control = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker(`
        const { workerData } = require('node:worker_threads');
        const ring = new Float64Array(workerData.ring);
        const control = new Int32Array(workerData.control);
        let last = Date.now();
        setInterval(() => {
            const starve = Atomics.exchange(control, 0, 0);
            if (starve > 0) Atomics.wait(control, 1, 0, starve);
            const now = Date.now();
            const gap = now - last - 10;
            last = now;
            if (gap > 20) { const i = ring[0] % 4096; ring[1 + 2 * i] = now; ring[2 + 2 * i] = gap; ring[0] += 1; }
        }, 10);
    `, { eval: true, workerData: { ring: shared.buffer, control: control.buffer } });
    starveWorker = (ms) => { Atomics.store(control, 0, ms); };
    await new Promise((r) => setTimeout(r, 100));
    const ringGaps = (): Array<[number, number]> => {
        const out: Array<[number, number]> = [];
        for (let i = 0; i < Math.min(shared[0]!, 4096); i += 1) out.push([shared[1 + 2 * i]!, shared[2 + 2 * i]!]);
        return out;
    };
    const mine: Array<[number, number, number]> = [];
    let last = Date.now();
    let lastCpu = cpuNow();
    const timer = setInterval(() => {
        const now = Date.now();
        const cpu = cpuNow();
        const gap = now - last - 10;
        if (gap > 20) mine.push([now, gap, cpu - lastCpu]);
        last = now;
        lastCpu = cpu;
    }, 10);
    try {
        await run();
        await new Promise((r) => setTimeout(r, 60));
    } finally {
        starveWorker = () => {};
        clearInterval(timer);
        await worker.terminate();
    }
    const theirs = ringGaps();
    let worst = 0;
    lastReading = { gap: 0, cpu: 0, stalled: 0 };
    for (const [end, gap, cpu] of mine) {
        const reading = { gap, cpu: Math.round(cpu), stalled: overlapWith(theirs, end - gap, end) };
        const held = heldOf(reading);
        if (held > worst) { worst = held; lastReading = reading; }
    }
    return worst;
}

/** The worst reading's parts: main's heartbeat gap, the CPU spent during it, and the longest worker gap inside it. */
let lastReading = { gap: 0, cpu: 0, stalled: 0 };

type HostModule = typeof import('../src/main/spawn-host-client.js');
let stopHost: (() => Promise<void>) | null = null;
afterEach(async () => {
    await stopHost?.();
    stopHost = null;
});

/*
 * THE CONTROL'S HOLD (batch C's 141 ms, batch Z's 936 ms). A hold timed by the wall clock ended having done almost nothing if the machine did not run it. It now lasts until it has spent the
 * time, which is what the gauge reads.
 */
describe('the hold a spawn on main is made of', () => {
    it('it spends the time it was asked for: a machine that stopped it for most of the wall clock does not shorten it', () => {
        let wall = 0;
        let cpu = 0;
        // A read costs 1 ms of both, and at 100 ms the machine stops it for 4,860 ms: the wall clock moves, the CPU does not.
        const clocks: HoldClocks = {
            now: () => { wall += 1; cpu += 1; if (wall === 100) wall += 4_860; return wall; },
            spent: () => cpu,
        };
        holdFor(SLOW_MS, clocks);
        expect(cpu).toBeGreaterThanOrEqual(SLOW_MS);
    });

    it('with nothing in its way, it is the time it was asked for, not more', () => {
        let t = 0;
        holdFor(SLOW_MS, { now: () => t, spent: () => (t += 1) });
        expect(t).toBeLessThanOrEqual(SLOW_MS + 2);
    });

    it('a machine that never gives it the CPU ends it at the cap, inside the test timeout', () => {
        let wall = 0;
        holdFor(SLOW_MS, { now: () => (wall += 1), spent: () => 0 });
        expect(wall).toBeLessThanOrEqual(3 * SLOW_MS + 2);
    });

    it('the worker gap read off main is the longest overlapping, not their sum', () => {
        expect(overlapWith([[200, 150], [1_000, 100]], 0, 950)).toBe(150);
        expect(overlapWith([[200, 150]], 300, 400)).toBe(0);
    });
});

describe('the gauge can trust its own control', () => {
    /*
     * BATCH Z, AND THREE BATCHES BEFORE IT: 936 ms for a 5,000 ms spawn on main, "main's gap 5032 ms, of it the whole process stopped 4096 ms". Main ran its full hold; the worker was
     * the one not scheduled (a loaded machine, and main spinning on one of its CPUs), and its gap was taken off main's as if the process had stopped. So a real hold could read as nothing.
     */
    it('PROBE: the worker kept off the CPU for most of a real hold: the hold is still read', async () => {
        const worst = await heartbeatDuring(async () => {
            // The worker's gap lands just AFTER the hold has ended, as batch Z's must have: a gap that lands during the hold made the old hold stretch by as much, which hid this.
            starveWorker(SLOW_MS + 100);
            await new Promise((r) => setTimeout(r, 30));
            hold(SLOW_MS);
            await new Promise((r) => setTimeout(r, 300));
        });
        expect(worst, `the gauge read ${worst} ms for a ${SLOW_MS} ms hold, with the worker stopped through it`).toBeGreaterThan(SLOW_MS / 2);
    }, 30_000);

    it('main spun through its gap: held, whatever the worker did', () => {
        expect(heldOf({ gap: 5_032, cpu: 5_000, stalled: 4_096 })).toBeGreaterThan(SLOW_MS / 2);
    });

    it('the whole process stopped: not held, because nothing ran', () => {
        expect(heldOf({ gap: 5_000, cpu: 60, stalled: 4_900 })).toBeLessThan(HELD_BAR_MS);
    });

    it('main blocked in the kernel with the worker running: held, though it used no CPU', () => {
        expect(heldOf({ gap: 5_000, cpu: 10, stalled: 0 })).toBeGreaterThan(SLOW_MS / 2);
    });
});

describe('main never waits on a spawn (genie#1397)', () => {
    it('Docker state read through the runner: main\'s heartbeat is never held for the spawn (under a fifth of it) while each spawn takes 5 s in the spawn host', async () => {
        const host = (await import('../src/main/spawn-host-client.js').catch(() => null)) as HostModule | null;
        const runnerModule = await import('../src/main/toolchain-runner.js');
        if (host) {
            // The slow spawner lives in the CHILD (the fixture serves the real protocol over a 5 s exec).
            const client = host.startSpawnHost({
                entry: fileURLToPath(new URL('./fixtures/slow-spawn-host.ts', import.meta.url)),
                execArgv: ['--import', 'tsx'],
                env: { SLOW_SPAWN_MS: String(SLOW_MS) },
            });
            host.routeExecThroughSpawnHost(client);
            stopHost = async () => { host.routeExecThroughSpawnHost(null); await client.stop(); };
        }
        const { ServiceDriver, dockerRunnerOver } = await import('../src/main/service-driver.js');
        const driver = new ServiceDriver(dockerRunnerOver(runnerModule.execFileRunner));
        let answer: unknown = null;
        const worst = await heartbeatDuring(async () => { answer = await driver.status('genie-postgres-17'); });
        // The answer is Docker's (the 5 s spawner's), read through the real driver: the call really went through.
        expect(answer).toEqual({ state: 'running', since: '2026-11-01T00:00:00Z' });
        expect(worst, `main was held ${worst} ms`).toBeLessThan(HELD_BAR_MS);
    }, 30_000);

    it('CONTROL: the same gauge, with the spawn made on main (the fix removed: the runner in-process), reads the 5 s', async () => {
        // The positive control for the bar above: what the gauge reads for the failure this file names. If this ever
        // reads under the bar, a pass above means nothing.
        const host = (await import('../src/main/spawn-host-client.js').catch(() => null)) as HostModule | null;
        host?.routeExecThroughSpawnHost(null);
        const runnerModule = await import('../src/main/toolchain-runner.js');
        const { ServiceDriver, dockerRunnerOver } = await import('../src/main/service-driver.js');
        const driver = new ServiceDriver(dockerRunnerOver(runnerModule.execFileRunner));
        let answer: unknown = null;
        const worst = await heartbeatDuring(async () => { answer = await driver.status('genie-postgres-17'); });
        expect(answer).toEqual({ state: 'running', since: '2026-11-01T00:00:00Z' });
        console.log(`GAUGE: main held ${worst} ms by a ${SLOW_MS} ms spawn made on main (bar ${HELD_BAR_MS} ms); main's gap ${lastReading.gap} ms, CPU ${lastReading.cpu} ms, longest worker gap ${lastReading.stalled} ms`);
        expect(worst, `the gauge read ${worst} ms for a ${SLOW_MS} ms spawn on main`).toBeGreaterThan(SLOW_MS / 2);
    }, 30_000);

    it("a supervised process (a site's php-cgi) whose pty takes 5 s to open: main is never held for it (under a fifth of it); it runs, its pid and output arrive, a stop ends it", async () => {
        const host = (await import('../src/main/spawn-host-client.js').catch(() => null)) as HostModule | null;
        const { ProcessSupervisor } = await import('../src/main/process-supervisor.js');
        type Port = ConstructorParameters<typeof ProcessSupervisor>[0];
        let pty: Port;
        if (host) {
            const client = host.startSpawnHost({
                entry: fileURLToPath(new URL('./fixtures/slow-spawn-host.ts', import.meta.url)),
                execArgv: ['--import', 'tsx'],
                env: { SLOW_SPAWN_MS: String(SLOW_MS) },
            });
            stopHost = () => client.stop();
            pty = client.ptyPort();
        } else {
            // TODAY: the supervisor's engine is in-process, so a spawn that takes 5 s takes them from main.
            const data = new Set<(id: string, d: string) => void>();
            pty = {
                open: () => { hold(SLOW_MS); setImmediate(() => { for (const l of data) l('p1', 'hello\n'); }); return { id: 'p1', pid: 4242, shell: 'php-cgi', scrollback: '' }; },
                write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
                onData: (l) => { data.add(l); return () => data.delete(l); }, onExit: () => () => {},
            };
        }
        const supervisor = new ProcessSupervisor(pty);
        const output: string[] = [];
        supervisor.onOutput((_id, d) => output.push(d));
        let status: ReturnType<typeof supervisor.start> | null = null;
        const worst = await heartbeatDuring(async () => {
            status = supervisor.start({ id: 'site_acme-fcgi', workspaceId: 'acme', name: 'acme.gen php worker', command: 'php-cgi -b 127.0.0.1:4102', cwd: process.cwd(), restart: 'always' });
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline && (supervisor.status('site_acme-fcgi')?.pid !== 4242 || output.join('') !== 'hello\n')) await new Promise((r) => setTimeout(r, 20));
        });
        expect(status!.state).toBe('running');
        expect(supervisor.status('site_acme-fcgi')?.pid).toBe(4242);
        expect(output.join('')).toBe('hello\n');
        expect(worst, `main was held ${worst} ms`).toBeLessThan(HELD_BAR_MS);
        supervisor.stop('site_acme-fcgi');
        expect(supervisor.status('site_acme-fcgi')?.state).toBe('stopped');
    }, 30_000);
});
