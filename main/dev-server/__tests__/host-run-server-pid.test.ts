import { describe, expect, it, vi } from 'vitest';
import { createHostProcessRun, parsePortOwner, portOwnerArgv } from '../host-process-run';
import type { HostSpawnPrimitives } from '../host-site-process';

/**
 * The tracked pid must be the process HOLDING THE PORT, not the shell that
 * launched it (genie#391).
 *
 * ## What was measured
 *
 * On a real workstation, `host-runs.json` against the live process table — six
 * entries, six for six:
 *
 * | registry key            | recorded pid | what actually served      |
 * |-------------------------|--------------|---------------------------|
 * | `806e0eda321a21df`      | 24884        | caddy 56880, parent 24884 |
 * | `9be02b42baa25d0b`      | 89952        | caddy 47212, parent 89952 |
 * | `fcf1247b642f9850`      | 53820        | caddy 69944, parent 53820 |
 * | `806e0eda321a21df-fcgi` | 13696        | php-cgi 25340, parent 13696 |
 * | `9be02b42baa25d0b-fcgi` | 35544        | php-cgi 53632, parent 35544 |
 * | `fcf1247b642f9850-fcgi` | 58952        | php-cgi 70960, parent 58952 |
 *
 * Every recorded pid was a `cmd.exe`. That is not a slip: `hostSpawnInvocation`
 * runs the command THROUGH the shell on win32 deliberately, so a `.cmd`/`.bat`
 * dev-server shim resolves at all, and `child_process.spawn` hands back the
 * shell's pid. The shell's lifetime is not the server's — 151 orphaned
 * caddy/php-cgi processes on that machine had dead parents and were still
 * serving, the oldest eleven days old.
 *
 * ## Why it could not self-heal
 *
 * The shell exits; `running()` correctly drops a record whose pid is dead;
 * `adopt` therefore re-attaches nothing; the next start spawns a duplicate — and
 * the survivor's real pid was never written anywhere, so no later `stop`, no
 * orphan map and no boot pass can reach it. One new orphan per site per Genie
 * restart, unkillable through Genie by construction.
 *
 * `stop` appeared to work throughout, because `killTreeWinArgv` is
 * `taskkill /pid <shell> /t /f` and the `/t` walks the tree. It survived the
 * wrong pid by accident, which is why every visible behaviour stayed correct
 * while the recorded state was wrong.
 *
 * ## What these tests assert
 *
 * NOT "a pid was recorded" — the old code satisfies that perfectly, and a test
 * written to it would have passed against the bug. The claim under test is that
 * the recorded pid is the process holding the port, proved from the side that
 * distinguishes them: a restart in which the SHELL is dead and the server is not.
 */

/** No `portOwnerPid` by default — an absent lookup must leave every existing
 *  behaviour exactly as it was. */
function fakePrims(over: Partial<HostSpawnPrimitives> = {}): HostSpawnPrimitives {
    return {
        platform: 'linux',
        spawnDetached: vi.fn().mockReturnValue(4242),
        signal: vi.fn().mockReturnValue(true),
        killTreeWin: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
}

/** An in-memory stand-in for the on-disk registry, shared by two successive
 *  `createHostProcessRun`s — i.e. across a Genie restart. */
function registryFile() {
    let text: string | null = null;
    return {
        readRegistry: (_path: string) => text,
        writeRegistry: (_path: string, next: string) => {
            text = next;
        },
    };
}

/** win32: `spawn` returns the SHELL's pid; the server that binds the port is its
 *  child. The two numbers are what the whole mechanism turns on. */
const SHELL = 500;
const SERVER = 900;

describe('the tracked pid is the process holding the port, not the shell', () => {
    it('a run whose SHELL died with Genie is still adopted, because the server is', async () => {
        const file = registryFile();
        const before = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                spawnDetached: vi.fn().mockReturnValue(SHELL),
                portOwnerPid: vi.fn().mockResolvedValue(SERVER),
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        await before.start({
            siteId: 's',
            workspaceId: 'ws',
            command: ['caddy', 'run', '--config', 'x.caddyfile'],
            cwd: '/r',
            env: {},
            port: 5321,
        });

        // Genie restarts. The shell is GONE — the measured fact this test exists
        // for — and the server it launched is still serving.
        const after = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                signal: vi.fn().mockImplementation((pid: number) => pid === SERVER),
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        expect(await after.running?.()).toEqual([{ siteId: 's', port: 5321 }]);
        expect(await after.alive('s')).toBe(true);
    });

    it('NEGATIVE CONTROL: when the server is gone too, the run is still dropped', async () => {
        // Without this, "it adopts" would pass just as well against a registry that
        // never drops anything — and dropping is not optional: a pid the OS will one
        // day hand to something else must not stay in the file.
        const file = registryFile();
        const before = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                spawnDetached: vi.fn().mockReturnValue(SHELL),
                portOwnerPid: vi.fn().mockResolvedValue(SERVER),
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });

        const after = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({ platform: 'win32', signal: vi.fn().mockReturnValue(false) }),
            ensureDir: vi.fn(),
            ...file,
        });
        expect(await after.running?.()).toEqual([]);
        expect(await after.alive('s')).toBe(false);
    });

    it('stop reaches the SERVER, not only the shell that is already gone', async () => {
        // The orphan half of the bug: once the shell has exited, `taskkill /t` on it
        // reaches nothing, and today that is the only pid `stop` knows.
        const killTreeWin = vi.fn().mockResolvedValue(undefined);
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                spawnDetached: vi.fn().mockReturnValue(SHELL),
                portOwnerPid: vi.fn().mockResolvedValue(SERVER),
                signal: vi.fn().mockImplementation((pid: number) => pid === SERVER),
                killTreeWin,
            }),
            ensureDir: vi.fn(),
        });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
        await run.stop('s');
        expect(killTreeWin.mock.calls.map((c) => c[0])).toContain(SERVER);
    });

    it('POSITIVE CONTROL: a posix run, where spawn already returns the server, still adopts', async () => {
        // The mechanism must not "fix" the platform that was never broken. On posix
        // the command runs with NO shell, so the spawned process is the group leader
        // that binds the port and the lookup simply agrees with it.
        const file = registryFile();
        const before = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'linux',
                spawnDetached: vi.fn().mockReturnValue(4242),
                portOwnerPid: vi.fn().mockResolvedValue(4242),
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });

        const after = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'linux',
                signal: vi.fn().mockImplementation((pid: number) => pid === 4242),
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        expect(await after.running?.()).toEqual([{ siteId: 's', port: 5321 }]);
    });

    it('a port nothing answers for leaves the run exactly as it was before', async () => {
        // No regression for a dev server that never binds, or a platform with no
        // lookup: the spawn pid stays the tracked pid and every existing behaviour is
        // the one it always had.
        const file = registryFile();
        const before = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                spawnDetached: vi.fn().mockReturnValue(SHELL),
                portOwnerPid: vi.fn().mockResolvedValue(null),
            }),
            ensureDir: vi.fn(),
            wait: vi.fn().mockResolvedValue(undefined),
            ...file,
        });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });

        const after = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                signal: vi.fn().mockImplementation((pid: number) => pid === SHELL),
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        expect(await after.running?.()).toEqual([{ siteId: 's', port: 5321 }]);
    });

    it('a start with NO port never asks for an owner — there is nothing to ask about', async () => {
        const portOwnerPid = vi.fn().mockResolvedValue(SERVER);
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                spawnDetached: vi.fn().mockReturnValue(SHELL),
                portOwnerPid,
            }),
            ensureDir: vi.fn(),
        });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {} });
        expect(portOwnerPid).not.toHaveBeenCalled();
    });
});

/**
 * The `netstat -ano` reader.
 *
 * Written AFTER the parser it tests, so each trap below was checked against the
 * naive implementation it exists to rule out, and only the ones that actually
 * went RED were kept. Naming which parser each one catches, because a first
 * attempt at this comment claimed all of them caught
 * `line.includes(':' + port)` and that was simply false — `:62307` is not a
 * substring of `:162307`, so the suffix trap needs the colon-less variant to
 * bite:
 *
 *   - `line.includes(':' + port)` → caught by the ESTABLISHED trap (returns the
 *     client that dialled the port, 4242).
 *   - `local.includes(String(port))` → caught by the longer-port trap (returns
 *     55555, a different application).
 *   - matching the local address but not the STATE → caught by the outbound trap
 *     (returns 7777, a client connecting FROM that port).
 *
 * The fixture is real output from a Windows workstation, and the ports are the
 * ones the bug was measured on. Run against that live machine, this exact logic
 * returned 93368 / 90624 / 66292 — the `php.exe` servers — where the run registry
 * had recorded 80864 / 92532 / 85056, their `cmd.exe` shells.
 */
describe('parsePortOwner', () => {
    const NETSTAT = [
        '',
        'Active Connections',
        '',
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1616',
        // Listed BEFORE the real owner, so an order-dependent sloppy match takes it.
        '  TCP    127.0.0.1:162307       0.0.0.0:0              LISTENING       55555',
        '  TCP    127.0.0.1:62307        0.0.0.0:0              LISTENING       93368',
        '  TCP    127.0.0.1:53904        0.0.0.0:0              LISTENING       90624',
        // A client that DIALLED 61828 — its own local port is something else.
        '  TCP    127.0.0.1:49812        127.0.0.1:61828        ESTABLISHED     4242',
        // A client connecting OUT of 45050 — local address matches, state does not.
        '  TCP    127.0.0.1:45050        93.184.216.34:443      ESTABLISHED     7777',
        '  TCP    127.0.0.1:61828        0.0.0.0:0              LISTENING       66292',
        '',
    ].join('\r\n');

    it('names the LISTENING owner of exactly that port', () => {
        expect(parsePortOwner(NETSTAT, 62307, 'win32')).toBe(93368);
        expect(parsePortOwner(NETSTAT, 53904, 'win32')).toBe(90624);
    });

    it('a LONGER port containing the one asked for is not a match', () => {
        // Asking for 62307 must not be answered by 162307's owner (55555), which is
        // some other application entirely — Genie would record it as this site's
        // server and later try to stop it. 55555 appears first in the fixture, so
        // this fails loudly rather than by luck of ordering.
        expect(parsePortOwner(NETSTAT, 62307, 'win32')).not.toBe(55555);
        expect(parsePortOwner(NETSTAT, 2307, 'win32')).toBeNull();
    });

    it('an ESTABLISHED connection TO the port names the CLIENT, so it is ignored', () => {
        // The client's row comes BEFORE the server's LISTENING row on purpose: a
        // parser that takes the first line mentioning the port returns 4242, the
        // process that merely dialled it.
        expect(parsePortOwner(NETSTAT, 61828, 'win32')).toBe(66292);
    });

    it('an OUTBOUND connection from that local port is not a listener', () => {
        // Local address matches exactly; the state is what makes it wrong. Nothing
        // is listening on 45050, so the honest answer is null.
        expect(parsePortOwner(NETSTAT, 45050, 'win32')).toBeNull();
    });

    it('is null when nothing is listening yet — the ordinary answer during a start', () => {
        expect(parsePortOwner(NETSTAT, 5321, 'win32')).toBeNull();
        expect(parsePortOwner('', 5321, 'win32')).toBeNull();
    });

    it('reads bare pids on posix, and asks the right command on each platform', () => {
        expect(parsePortOwner('4242\n', 5321, 'linux')).toBe(4242);
        expect(parsePortOwner('\n', 5321, 'linux')).toBeNull();
        // The parser and the command have to agree about whose output is being
        // read: netstat prints the whole table, lsof -t prints only pids.
        expect(portOwnerArgv(5321, 'win32')).toEqual(['netstat', '-ano', '-p', 'TCP']);
        expect(portOwnerArgv(5321, 'linux')).toContain('-t');
        expect(portOwnerArgv(5321, 'linux')).toContain('-iTCP:5321');
    });
});
