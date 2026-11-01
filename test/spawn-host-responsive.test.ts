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

/** Hold this thread `ms`, the way a synchronous CreateProcess does. */
function hold(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* the thread is held */ }
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
 * How long MAIN'S THREAD was held during `run`, beyond what this whole process was held at the same moment: a 10 ms
 * heartbeat on main, and one on a worker thread of the same process. Every gap of main's is reduced by the worker's gap
 * that overlaps it. A held main thread (a synchronous spawn) reads its full length; a process the machine did not
 * schedule (the full suite saturating every CPU: measured 76 and 304 ms on omarchy-test) reads about 0, because the
 * worker was not run either. The worst remainder is returned.
 */
async function heartbeatDuring(run: () => Promise<unknown>): Promise<number> {
    // The worker's gaps over 20 ms, as [end, gap] pairs in a shared ring (slot 0 is the count).
    const shared = new Float64Array(new SharedArrayBuffer(8 * (1 + 2 * 4096)));
    const worker = new Worker(`
        const { workerData } = require('node:worker_threads');
        const ring = new Float64Array(workerData);
        let last = Date.now();
        setInterval(() => {
            const now = Date.now();
            const gap = now - last - 10;
            last = now;
            if (gap > 20) { const i = ring[0] % 4096; ring[1 + 2 * i] = now; ring[2 + 2 * i] = gap; ring[0] += 1; }
        }, 10);
    `, { eval: true, workerData: shared.buffer });
    await new Promise((r) => setTimeout(r, 100));
    const mine: Array<[number, number]> = [];
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); const gap = now - last - 10; last = now; if (gap > 20) mine.push([now, gap]); }, 10);
    try {
        await run();
        await new Promise((r) => setTimeout(r, 60));
    } finally {
        clearInterval(timer);
        await worker.terminate();
    }
    const theirs: Array<[number, number]> = [];
    for (let i = 0; i < Math.min(shared[0]!, 4096); i += 1) theirs.push([shared[1 + 2 * i]!, shared[2 + 2 * i]!]);
    let worst = 0;
    for (const [end, gap] of mine) {
        const start = end - gap;
        let process = 0;
        for (const [wEnd, wGap] of theirs) process = Math.max(process, Math.max(0, Math.min(end, wEnd) - Math.max(start, wEnd - wGap)));
        worst = Math.max(worst, gap - process);
    }
    return worst;
}

type HostModule = typeof import('../src/main/spawn-host-client.js');
let stopHost: (() => Promise<void>) | null = null;
afterEach(async () => {
    await stopHost?.();
    stopHost = null;
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
        console.log(`GAUGE: main held ${worst} ms by a ${SLOW_MS} ms spawn made on main (bar ${HELD_BAR_MS} ms)`);
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
