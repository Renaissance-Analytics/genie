import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FAILED_STARTS, startSpawnHost, type SpawnHostClient } from '../src/main/spawn-host-client.js';

/**
 * WHEN THE SPAWN HOST GOES (genie#1397). Main creates no processes itself; the spawn host does. So its loss must not leave
 * anything half-alive: a call in flight fails with a code its caller can read, every pty it held is ENDED (its helper
 * killed by pid, so no orphan keeps a site's port) and reported exited, and the next call is served by a new child.
 * A child that cannot start at all is given up on after MAX_FAILED_STARTS, and commands run in-process, said in the log.
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const until = async (ok: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return ok();
};

let client: SpawnHostClient | null = null;
afterEach(async () => { await client?.stop(); client = null; });

/*
 * THE FIRST CHILD IS STARTED BEFORE THE TESTS (2026-11-01). Each child is `fork(--import tsx)`, and the first one in a
 * worker compiles the fixture cold. On a loaded genie-test-windows (batch E: 1,705 s suite) the FIRST test of this file
 * — two children, the first cold — ran out its 30 s with no step named, while every later test took about 1 s (and the
 * same test 424–713 ms in batches C and D). The cold start is not what any test here names, so it is paid once here and
 * measured; the tests then name the step that stalls, if one does.
 */
beforeAll(async () => {
    const began = Date.now();
    const warm = startSpawnHost({ entry: fixture('slow-spawn-host.ts'), execArgv: ['--import', 'tsx'], env: { SLOW_SPAWN_MS: '0' } });
    try { await warm.exec('docker', ['version']); } finally { await warm.stop(); }
    console.log(`WARM: the first spawn host child answered in ${Date.now() - began} ms`);
}, 60_000);

/** `promise`, or a failure naming `what` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms); });
    try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

describe('the spawn host goes away (genie#1397)', () => {
    it('a lost child: its ptys are ended (helper killed by pid) and exit -1; the next command runs in a new child', async () => {
        const killed: number[] = [];
        const lines: string[] = [];
        // Each step's time, said in every failure with the client's log: a stall names its step.
        const t0 = Date.now();
        const steps: string[] = [];
        const step = (name: string) => steps.push(`${name} @${Date.now() - t0} ms`);
        const said = () => `steps: ${steps.join(', ') || '(none)'}; log: ${lines.join(' | ') || '(none)'}`;
        client = startSpawnHost({ entry: fixture('slow-spawn-host.ts'), execArgv: ['--import', 'tsx'], env: { SLOW_SPAWN_MS: '0' }, killPid: (pid) => killed.push(pid), pidAlive: () => false, log: (l) => lines.push(l) });
        const pty = client.ptyPort();
        const exits: Array<[string, number]> = [];
        const pids: number[] = [];
        pty.onExit((id, code) => exits.push([id, code]));
        pty.onPid?.((_id, pid) => pids.push(pid));
        const opened = pty.open({ cwd: process.cwd(), command: 'php-cgi -b 127.0.0.1:4102' });
        expect(opened.pid).toBe(0); // not known yet: it arrives as onPid
        expect(await until(() => pids.includes(4242), 8_000), `the pty's pid from the first child; ${said()}`).toBe(true);
        step('pid');
        expect(pty.isLive?.(opened.id)).toBe(true);
        const first = client.pid!;
        process.kill(first);
        expect(await until(() => exits.length === 1, 8_000), `the pty reported exited after its child was lost; ${said()}`).toBe(true);
        step('exit');
        expect(exits[0]).toEqual([opened.id, -1]);
        expect(killed).toEqual([4242]);
        expect(pty.isLive?.(opened.id)).toBe(false);
        const r = await within(client.exec('docker', ['container', 'inspect', 'x']), 8_000, `the next command, in a new child; ${said()}`);
        step('new child answered');
        expect(r.exitCode).toBe(0);
        expect(client.pid).not.toBe(first);
        expect(lines.some((l) => l.startsWith(`spawn host ${first} exited`)), said()).toBe(true);
    }, 30_000);

    it("a lost child's ptys are reported exited only once their helpers are GONE, so a restart never races the old process for its port", async () => {
        // genie-test-windows, 2026-11-01: reported at once, the supervisor restarted php-cgi and Caddy on their ports a second
        // later while the old trees were still dying; each new one failed to bind, backed off (23 s once, past 120 s
        // another time), and workers gave up. Here the helper takes a while to die after its kill.
        let polls = 0;
        const alive = new Set<number>();
        client = startSpawnHost({
            entry: fixture('slow-spawn-host.ts'), execArgv: ['--import', 'tsx'], env: { SLOW_SPAWN_MS: '0' },
            killPid: (pid) => { alive.add(pid); },
            pidAlive: (pid) => { polls += 1; if (polls >= 5) alive.delete(pid); return alive.has(pid); },
        });
        const pty = client.ptyPort();
        const exits: Array<[string, number, number]> = [];
        const pids: number[] = [];
        pty.onExit((id, code) => exits.push([id, code, polls]));
        pty.onPid?.((_id, pid) => pids.push(pid));
        const opened = pty.open({ cwd: process.cwd(), command: 'php-cgi -b 127.0.0.1:4102' });
        expect(await until(() => pids.includes(4242))).toBe(true);
        process.kill(client.pid!);
        expect(await until(() => exits.length === 1)).toBe(true);
        expect(exits[0]![0]).toBe(opened.id);
        expect(exits[0]![1]).toBe(-1);
        // Not before the helper was seen gone (the 5th look).
        expect(exits[0]![2]).toBeGreaterThanOrEqual(5);
    }, 30_000);

    it('a call in flight when the child dies fails with code ESPAWNHOST', async () => {
        /*
         * IN FLIGHT FOR CERTAIN (2026-11-01). This killed the child 1.5 s after it had a pid while the call took 4 s, and
         * on a loaded genie-test-windows the test's own timers ran late enough for the call to ANSWER first: "promise
         * resolved … instead of rejecting" (batch D). Now the child's exec never answers, and says when the call reached
         * it (a marker file); the child is killed only after that, with the call provably still waiting.
         */
        const dir = mkdtempSync(join(tmpdir(), 'genie-spawn-inflight-'));
        try {
            const marker = join(dir, 'exec-started');
            client = startSpawnHost({ entry: fixture('slow-spawn-host.ts'), execArgv: ['--import', 'tsx'], env: { SLOW_SPAWN_MS: '0', EXEC_NEVER_ANSWERS: marker } });
            let settled = false;
            const pending = client.exec('docker', ['version']);
            pending.then(() => { settled = true; }, () => { settled = true; });
            expect(await until(() => existsSync(marker)), 'the call reached the child').toBe(true);
            expect(settled, 'and it is in flight: the child never answers it').toBe(false);
            process.kill(client.pid!);
            await expect(pending).rejects.toMatchObject({ code: 'ESPAWNHOST' });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it("a command starts with main's environment NOW (set after the fork), never the fork's ELECTRON_RUN_AS_NODE — the real spawn host", async () => {
        client = startSpawnHost({ entry: fileURLToPath(new URL('../src/main/spawn-host.ts', import.meta.url)), execArgv: ['--import', 'tsx'] });
        const probe = ['-e', 'process.stdout.write(String(process.env.GENIE_ENV_PROBE) + "|" + String(process.env.ELECTRON_RUN_AS_NODE))'];
        process.env['GENIE_ENV_PROBE'] = 'first';
        try {
            expect((await client.exec(process.execPath, probe)).stdout).toBe('first|undefined');
            // A toolchain install changes main's PATH after the fork: the next command sees the change.
            process.env['GENIE_ENV_PROBE'] = 'later';
            expect((await client.exec(process.execPath, probe)).stdout).toBe('later|undefined');
            delete process.env['GENIE_ENV_PROBE'];
            expect((await client.exec(process.execPath, probe)).stdout).toBe('undefined|undefined');
        } finally {
            delete process.env['GENIE_ENV_PROBE'];
        }
    }, 30_000);

    it(`a child that cannot start: given up after ${MAX_FAILED_STARTS} tries, commands run in-process, and the log says so`, async () => {
        const lines: string[] = [];
        client = startSpawnHost({ entry: fixture('dead-spawn-host.ts'), execArgv: ['--import', 'tsx'], log: (l) => lines.push(l) });
        // Each call starts a child that dies before it is ready, until the client gives up.
        for (let i = 0; i < MAX_FAILED_STARTS && !client.inProcess; i += 1) await client.exec(process.execPath, ['-e', '0']).catch(() => {});
        expect(await until(() => client!.inProcess)).toBe(true);
        const r = await client.exec(process.execPath, ['-e', 'process.stdout.write("in-process")']);
        expect(r.stdout).toBe('in-process');
        expect(lines.some((l) => /could not start 3 times/.test(l))).toBe(true);
    }, 60_000);
});
