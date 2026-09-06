import { describe, expect, it, vi } from 'vitest';
import { createHostProcessRun } from '../host-process-run';
import type { HostSpawnPrimitives } from '../host-site-process';

/**
 * A start must not silently forget a run that is still alive (genie#391).
 *
 * ## What was measured, after #496
 *
 * #496 fixed WHICH pid the registry records. It did not change the registry's
 * SHAPE, and the shape is a second leak. On the reporting workstation, after
 * `caddy.exe` and `php-cgi.exe` had been reclaimed to zero:
 *
 *   109 of 128 `php.exe` were Genie's own toolchain PHP running
 *   `php -S 127.0.0.1:<port> …/server.php` — 2,155 MB, across five workspaces
 *   (moic-suite 31, tynn 31, px-ui-sandbox 8, gc-website 4, prism-labs 3),
 *   accumulating every day from 2026-08-28 to 16:51 that same afternoon.
 *
 * **80 of those 109 had a LIVE parent shell.** That rules out the #496 mechanism
 * for them: with the shell alive, even the old `hostSiteAlive(shellPid)` returned
 * true, the record survived, and adoption should have re-attached. Thirty-one
 * duplicates for ONE site is not a wrong-pid problem.
 *
 * It is this line:
 *
 *     tracked.set(siteId, { pid, logPath, ...(port ? { port } : {}) });
 *
 * One entry per `siteId`, and `set` OVERWRITES. Any start reaching it while a
 * previous run is alive — adoption skipped for that site, the workspace not
 * mounted, a start racing the boot pass — drops a live pair, shell and server
 * both, and nothing anywhere holds their pids afterwards. Unreachable for exactly
 * the reason this issue is about.
 *
 * ## What these tests assert
 *
 * NOT "no duplicates exist" — that passes just as well against a registry that
 * records nothing at all, which is the state being fixed. The claim is that a
 * displaced run stays REACHABLE: a later `stop` still reaches it, and it survives
 * to the next Genie. Reachability is the thing that was lost.
 */

function fakePrims(over: Partial<HostSpawnPrimitives> = {}): HostSpawnPrimitives {
    return {
        platform: 'linux',
        spawnDetached: vi.fn().mockReturnValue(4242),
        signal: vi.fn().mockReturnValue(true),
        killTreeWin: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
}

function registryFile() {
    let text: string | null = null;
    return {
        readRegistry: (_path: string) => text,
        writeRegistry: (_path: string, next: string) => {
            text = next;
        },
    };
}

/** Two successive runs of ONE site: shells 500/600, servers 900/901. */
const SHELL_A = 500;
const SERVER_A = 900;
const SHELL_B = 600;
const SERVER_B = 901;

/** win32 prims where both runs' servers are alive — the 80-of-109 shape. */
function twoLiveRuns(killTreeWin = vi.fn().mockResolvedValue(undefined)): HostSpawnPrimitives {
    return fakePrims({
        platform: 'win32',
        spawnDetached: vi.fn().mockReturnValueOnce(SHELL_A).mockReturnValueOnce(SHELL_B),
        portOwnerPid: vi.fn().mockResolvedValueOnce(SERVER_A).mockResolvedValueOnce(SERVER_B),
        // Everything spawned is still up: shells AND servers.
        signal: vi.fn().mockReturnValue(true),
        killTreeWin,
    });
}

describe('a start that displaces a LIVE run keeps it reachable', () => {
    it('stop reaches the displaced run as well as the current one', async () => {
        const killTreeWin = vi.fn().mockResolvedValue(undefined);
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: twoLiveRuns(killTreeWin),
            ensureDir: vi.fn(),
        });

        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
        // A SECOND start for the same site, with no stop in between. Today this
        // overwrites the first record and the first pair is lost.
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5322 });

        await run.stop('s');
        const killed = killTreeWin.mock.calls.map((c) => c[0]);
        expect(killed).toContain(SERVER_B); // the current run
        expect(killed).toContain(SERVER_A); // the displaced one — the whole point
    });

    it('the displaced run survives to the NEXT Genie, so a later stop can still reach it', async () => {
        const file = registryFile();
        const before = createHostProcessRun({
            logDir: '/logs',
            primitives: twoLiveRuns(),
            ensureDir: vi.fn(),
            ...file,
        });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5322 });

        // Genie restarts. Both pairs are still up.
        const killTreeWin = vi.fn().mockResolvedValue(undefined);
        const after = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                signal: vi.fn().mockReturnValue(true),
                killTreeWin,
            }),
            ensureDir: vi.fn(),
            ...file,
        });
        await after.stop('s');
        expect(killTreeWin.mock.calls.map((c) => c[0])).toContain(SERVER_A);
    });

    it('POSITIVE CONTROL: replacing a genuinely DEAD run retains nothing', async () => {
        // Without this, "it retains the old run" would pass against an
        // implementation that retains every run it has ever started — which would
        // grow the registry without bound and make `stop` signal long-dead pids
        // that the OS may since have reused.
        const killTreeWin = vi.fn().mockResolvedValue(undefined);
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({
                platform: 'win32',
                spawnDetached: vi.fn().mockReturnValueOnce(SHELL_A).mockReturnValueOnce(SHELL_B),
                portOwnerPid: vi.fn().mockResolvedValueOnce(SERVER_A).mockResolvedValueOnce(SERVER_B),
                // The FIRST run is gone; only the second one's pids answer.
                signal: vi
                    .fn()
                    .mockImplementation((pid: number) => pid === SHELL_B || pid === SERVER_B),
                killTreeWin,
            }),
            ensureDir: vi.fn(),
        });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5322 });

        await run.stop('s');
        expect(killTreeWin.mock.calls.map((c) => c[0])).not.toContain(SERVER_A);
    });

    it('the site still reports ONE live run — a displaced one is not routable', async () => {
        // `running()` feeds adoption, which turns a run into a `.gen` route. A
        // displaced run is retained so it can be STOPPED, never so it can be
        // served: two routes for one site would be a worse bug than the leak.
        const file = registryFile();
        const before = createHostProcessRun({
            logDir: '/logs',
            primitives: twoLiveRuns(),
            ensureDir: vi.fn(),
            ...file,
        });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
        await before.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5322 });

        const after = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims({ platform: 'win32', signal: vi.fn().mockReturnValue(true) }),
            ensureDir: vi.fn(),
            ...file,
        });
        expect(await after.running?.()).toEqual([{ siteId: 's', port: 5322 }]);
    });

    it('an ordinary stop-then-start retains nothing — the common path is unchanged', async () => {
        const killTreeWin = vi.fn().mockResolvedValue(undefined);
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: twoLiveRuns(killTreeWin),
            ensureDir: vi.fn(),
        });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
        await run.stop('s'); // the caller did the right thing
        killTreeWin.mockClear();
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5322 });

        await run.stop('s');
        expect(killTreeWin.mock.calls.map((c) => c[0])).not.toContain(SERVER_A);
    });
});
