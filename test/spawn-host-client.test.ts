import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('the spawn host goes away (genie#1397)', () => {
    it('a lost child: its ptys are ended (helper killed by pid) and exit -1; the next command runs in a new child', async () => {
        const killed: number[] = [];
        const lines: string[] = [];
        client = startSpawnHost({ entry: fixture('slow-spawn-host.ts'), execArgv: ['--import', 'tsx'], env: { SLOW_SPAWN_MS: '0' }, killPid: (pid) => killed.push(pid), log: (l) => lines.push(l) });
        const pty = client.ptyPort();
        const exits: Array<[string, number]> = [];
        const pids: number[] = [];
        pty.onExit((id, code) => exits.push([id, code]));
        pty.onPid?.((_id, pid) => pids.push(pid));
        const opened = pty.open({ cwd: process.cwd(), command: 'php-cgi -b 127.0.0.1:4102' });
        expect(opened.pid).toBe(0); // not known yet: it arrives as onPid
        expect(await until(() => pids.includes(4242))).toBe(true);
        expect(pty.isLive?.(opened.id)).toBe(true);
        const first = client.pid!;
        process.kill(first);
        expect(await until(() => exits.length === 1)).toBe(true);
        expect(exits[0]).toEqual([opened.id, -1]);
        expect(killed).toEqual([4242]);
        expect(pty.isLive?.(opened.id)).toBe(false);
        const r = await client.exec('docker', ['container', 'inspect', 'x']);
        expect(r.exitCode).toBe(0);
        expect(client.pid).not.toBe(first);
        expect(lines.some((l) => l.startsWith(`spawn host ${first} exited`))).toBe(true);
    }, 30_000);

    it('a call in flight when the child dies fails with code ESPAWNHOST', async () => {
        client = startSpawnHost({ entry: fixture('slow-spawn-host.ts'), execArgv: ['--import', 'tsx'], env: { SLOW_SPAWN_MS: '4000' } });
        const pending = client.exec('docker', ['version']);
        await until(() => client!.pid !== null);
        await new Promise((r) => setTimeout(r, 1_500));
        process.kill(client.pid!);
        await expect(pending).rejects.toMatchObject({ code: 'ESPAWNHOST' });
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
