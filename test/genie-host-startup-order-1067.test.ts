import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHostRecord } from '../src/core/engine-protocol.js';
import { readStartupProgress } from '../src/main/startup-updates-file.js';

const TSX = import.meta.resolve('tsx');

/**
 * NOTHING STARTS BEFORE THE START'S UPDATES (Tynn #1067), read from the real genie-host's own lifecycle log. The host is
 * run as its own process with a test update that takes a known time (GENIE_TEST_STARTUP_UPDATE_MS, honoured only with
 * GENIE_TEST_MACHINE=1): its `startup updates: done` line must come BEFORE the host composes hosting (sites), opens its
 * process book (kept processes, schedules) and its flows, and before it serves any window (host.json), which is what starts
 * agents. While it runs, the progress file says it, for the window that waits. With a limit shorter than the update, the
 * host starts at the limit and says so.
 *
 * Runs in the test VMs (spawns the host); never on the owner's desktop.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return ''; } };
let host: ChildProcess | null = null;
let home = '';
let out = '';

afterEach(async () => {
    if (host && host.exitCode === null) host.kill('SIGKILL');
    host = null;
    await sleep(300);
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    home = '';
    out = '';
});

async function boot(env: Record<string, string>): Promise<{ log: () => Promise<string>; served: () => Promise<boolean> }> {
    home = await mkdtemp(join(tmpdir(), 'genie-host-startup-'));
    await mkdir(join(home, 'runtime'), { recursive: true });
    await writeFile(join(home, 'runtime', 'workspaces.json'), JSON.stringify([]));
    host = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'test-build', GENIE_HOST_IDLE_MS: '600000', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts'), GENIE_TEST_MACHINE: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    host.stdout?.on('data', (d) => { out += String(d); });
    host.stderr?.on('data', (d) => { out += String(d); });
    return {
        log: () => readText(join(home, 'runtime', 'lifecycle.log')),
        served: async () => parseHostRecord(await readText(join(home, 'runtime', 'host.json')))?.pid === host?.pid,
    };
}

async function until(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- host output ---\n${out}`);
        await sleep(100);
    }
}

const at = (log: string, pattern: RegExp): number => log.split(/\r?\n/).findIndex((l) => pattern.test(l));

describe('genie-host applies the start’s updates before anything starts', () => {
    it('ORDER, from the lifecycle log: begin → done, then hosting, the process book, flows, then serving; the wait could read the progress meanwhile', async () => {
        const h = await boot({ GENIE_TEST_STARTUP_UPDATE_MS: '6000' });
        // While the update runs the host does not serve, and the progress file names the step (what a waiting window shows).
        await until('the startup update to begin', async () => /startup updates: begin/.test(await h.log()), 120_000);
        await until('the progress file', async () => readStartupProgress(join(home, 'runtime'), Date.now()) !== null, 10_000);
        expect(readStartupProgress(join(home, 'runtime'), Date.now())?.step).toMatch(/test update/i);
        expect(await h.served()).toBe(false);
        await until('host.json', h.served, 120_000);
        await until('the process book to open', async () => /process book open/.test(await h.log()), 60_000);
        const log = await h.log();
        const begin = at(log, /startup updates: begin/);
        const done = at(log, /startup updates: done/);
        const hosting = at(log, /boot step=hosting/);
        const book = at(log, /process book open/);
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(done).toBeGreaterThan(begin);
        expect(hosting).toBeGreaterThan(done);
        expect(book).toBeGreaterThan(done);
        // No agent started (spawned) before the updates were done (positive control: the gauge finds the done line).
        expect(log.split(/\r?\n/).slice(0, done).some((l) => /spawn kind=agent|agent start owner=/.test(l))).toBe(false);
        // Cleared once done: a later window is not told about an update that is over.
        expect(readStartupProgress(join(home, 'runtime'), Date.now())).toBeNull();
    }, 240_000);

    it('THE LIMIT: an update longer than it does not hold the host; it starts at the limit and the log says so', async () => {
        const h = await boot({ GENIE_TEST_STARTUP_UPDATE_MS: '120000', GENIE_TEST_STARTUP_LIMIT_MS: '4000' });
        await until('host.json', h.served, 120_000);
        const log = await h.log();
        expect(log).toMatch(/startup updates: time limit 4s reached during "Test update"; starting as usual/);
        expect(at(log, /boot step=hosting/)).toBeGreaterThan(at(log, /startup updates: time limit/));
        expect(readStartupProgress(join(home, 'runtime'), Date.now())).toBeNull();
    }, 240_000);
});
