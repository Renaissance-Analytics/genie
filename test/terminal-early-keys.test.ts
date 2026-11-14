import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startSpawnHost, type SpawnHostClient } from '../src/main/spawn-host-client.js';

/**
 * KEYS TYPED BEFORE THE SHELL HAS DRAWN ITS PROMPT ARRIVE (Tynn issue #692).
 *
 * omarchy-test, 2026-11-11, run 3: the smoke typed `echo <token>` into a terminal pane 1200 ms after it mounted, the
 * shell's prompt drew at 1248 ms, and the command never showed, not even a minute later (smoke 37 and 38). A person can
 * type that early. scripts/ci/early-keys-probe.py then showed it is not the shell: on a plain kernel pty the same
 * machine's bash ran a command written before it had read a byte, 8 times of 8, start-up files and all.
 *
 * So this is the product's own path, below the window: the REAL spawn host (src/main/spawn-host.ts) on Electron's binary
 * as Node, the pty controller in the product, and the real fancy-pty helper under it. A terminal is opened with the
 * person's own shell and the command is written in the same tick, before the helper or the shell exists.
 *
 *   CONTROL: the same command written 4 s after the open runs, so the test can see a command run at all.
 *   The row: written at once, it runs too, each of five times. `EK_$((6*7))` comes back as EK_42 only when the SHELL
 *   ran it; the typed text echoed back does not contain that.
 *
 * It does not cover the window's side (the page, the local door's input queue, the terminals replica): those await the
 * write below them, and are the next place to look if this is green and the smoke still loses keys.
 *
 * Linux. It starts processes: test machines only, never a person's desktop.
 */

const electron = createRequire(import.meta.url)('electron') as unknown as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function shellRuns(delayMs: number, n: number): Promise<{ ran: boolean; accepted: boolean; firstOutputMs: number | null; tail: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'early-keys-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const client: SpawnHostClient = startSpawnHost({
        entry: resolve('src/main/spawn-host.ts'), execPath: electron, execArgv: ['--import', 'tsx'], env: { GENIE_SPAWN_PROFILE: 'terminals' },
        killPid: (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, log: () => {},
    });
    cleanups.push(() => client.stop(1_000));
    const pty = client.ptyPort();
    let seen = '';
    let firstOutputMs: number | null = null;
    const started = Date.now();
    const off = pty.onData((_id, data) => { if (firstOutputMs === null) firstOutputMs = Date.now() - started; seen += data; });
    cleanups.push(off);
    const opened = pty.open({ cwd: dir });
    cleanups.push(() => { pty.kill(opened.id); });
    if (delayMs > 0) await sleep(delayMs);
    const accepted = pty.write(opened.id, `echo EK_$((6*7))_${n}\r`);
    const want = `EK_42_${n}`;
    const end = Date.now() + 20_000;
    while (!seen.includes(want) && Date.now() < end) await sleep(100);
    return { ran: seen.includes(want), accepted, firstOutputMs, tail: seen.slice(-300) };
}

describe.skipIf(process.platform !== 'linux')('a terminal takes keys typed before its shell is up', () => {
    it('CONTROL: a command typed 4 s after the terminal opens runs', async () => {
        const late = await shellRuns(4_000, 0);
        expect(late, JSON.stringify(late)).toMatchObject({ accepted: true, ran: true });
    }, 60_000);

    it('a command typed in the same tick as the open runs, every time', async () => {
        const rounds = [];
        for (let n = 1; n <= 5; n += 1) rounds.push(await shellRuns(0, n));
        expect(rounds.map((r) => r.accepted), JSON.stringify(rounds)).toEqual([true, true, true, true, true]);
        expect(rounds.map((r) => r.ran), JSON.stringify(rounds)).toEqual([true, true, true, true, true]);
    }, 180_000);
});
