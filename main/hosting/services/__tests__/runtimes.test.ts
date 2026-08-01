import { describe, expect, it } from 'vitest';
import {
    createPostgresRuntime,
    initdbArgs,
    postgresArgs,
    PG_READY_MARKER,
    PG_VERSION_FILE,
} from '../postgres';
import { createRedisRuntime, garnetArgs, GARNET_READY_MARKER } from '../redis';
import type {
    CommandRunner,
    HostedProcessHandle,
    ProcessSpawner,
    ServiceFs,
    ServiceInstance,
    SpawnOptions,
} from '../types';

/**
 * The two service runtimes' lifecycles, with no engine on the machine.
 *
 * The property worth the most defending here is that `running` MEANS running.
 * Both engines bind their port before they can serve — Postgres answers "the
 * database system is starting up" and Garnet refuses outright — so a runtime
 * that reported ready on spawn would hand a Laravel app a connection that fails
 * on its first request. That is the exact class of failure the hosting runtime
 * exists to remove, so readiness is observed on the log and these tests drive
 * the log by hand.
 */

// --- fakes -----------------------------------------------------------------

interface FakeProc extends HostedProcessHandle {
    stderr(chunk: string): void;
    exit(code: number | null): void;
    stopped: boolean;
}

interface FakeSpawner extends ProcessSpawner {
    calls: Array<{ command: string; args: string[]; opts: SpawnOptions }>;
    last(): FakeProc;
}

function fakeSpawner(): FakeSpawner {
    const procs: FakeProc[] = [];
    const calls: FakeSpawner['calls'] = [];
    return {
        calls,
        last: () => procs[procs.length - 1]!,
        spawn(command, args, opts) {
            calls.push({ command, args, opts });
            let resolveExit: (code: number | null) => void = () => {};
            const exited = new Promise<number | null>((r) => {
                resolveExit = r;
            });
            const proc: FakeProc = {
                pid: 4242,
                exited,
                stopped: false,
                stop() {
                    proc.stopped = true;
                    resolveExit(0);
                },
                stderr: (chunk) => opts.onStderr?.(chunk),
                exit: (code) => resolveExit(code),
            };
            procs.push(proc);
            return proc;
        },
    };
}

function fakeRunner(
    results: Record<string, { code: number | null; stdout?: string; stderr?: string }> = {},
): CommandRunner & { calls: Array<{ command: string; args: string[] }> } {
    const calls: Array<{ command: string; args: string[] }> = [];
    return {
        calls,
        async run(command, args) {
            calls.push({ command, args });
            const key = Object.keys(results).find((k) => command.includes(k));
            const result = key ? results[key]! : { code: 0 };
            return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
        },
    };
}

function fakeFs(existing: string[] = []): ServiceFs & { written: Map<string, string> } {
    const files = new Set(existing.map((p) => p.replace(/\\/g, '/')));
    const written = new Map<string, string>();
    return {
        written,
        async exists(p) {
            return files.has(p.replace(/\\/g, '/'));
        },
        async mkdir() {},
        async write(p, contents) {
            written.set(p.replace(/\\/g, '/'), contents);
            files.add(p.replace(/\\/g, '/'));
        },
        async read(p) {
            return written.get(p.replace(/\\/g, '/')) ?? null;
        },
        async remove(p) {
            files.delete(p.replace(/\\/g, '/'));
            written.delete(p.replace(/\\/g, '/'));
        },
    };
}

/**
 * Wait until the runtime has actually spawned its server.
 *
 * `start()` awaits work before spawning — `ensureCluster` for Postgres, the data
 * directory for Garnet — so the fake process does not exist on the line after
 * `start()` is called.
 *
 * Polls for the spawn rather than sleeping a fixed tick. A `setTimeout(0)` looks
 * equivalent and is not: it fires after ONE turn of the loop, while the awaited
 * work is a variable number of them, so it passes or fails depending on how
 * quickly the seam resolved. That is exactly the flake this replaced — three
 * different Garnet tests failed across three consecutive full-suite runs.
 */
async function spawned(spawner: FakeSpawner, count = 1): Promise<void> {
    for (let i = 0; i < 1000 && spawner.calls.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (spawner.calls.length < count) throw new Error('runtime never spawned its server');
}

const pg: ServiceInstance = {
    id: 'pg1',
    workspaceId: 'w1',
    kind: 'postgres',
    engine: 'postgres',
    port: 21432,
    dataDir: '/data/pg1',
    user: 'genie',
    password: 'sekrit',
    database: 'genie',
};

const redis: ServiceInstance = {
    id: 'rd1',
    workspaceId: 'w1',
    kind: 'redis',
    engine: 'garnet',
    port: 21379,
    dataDir: '/data/rd1',
};

// --- postgres argv ---------------------------------------------------------

describe('postgresArgs', () => {
    it('binds LOOPBACK ONLY and disables the unix socket', () => {
        const args = postgresArgs('/data/pg1', 21432).join(' ');
        // A managed development database must not be reachable from the
        // network, and a socket file is a second way in that bypasses the port.
        expect(args).toContain('listen_addresses=127.0.0.1');
        expect(args).toContain('unix_socket_directories=');
        expect(args).toContain('-p 21432');
    });

    it('keeps the log on stderr where readiness is watched for', () => {
        // With the collector on, the ready line goes to a file and every start
        // times out.
        expect(postgresArgs('/d', 1).join(' ')).toContain('logging_collector=off');
    });
});

describe('initdbArgs', () => {
    it('requires a password on BOTH local and host connections', () => {
        const args = initdbArgs('/data/pg1', 'genie', '/tmp/pw').join(' ');
        expect(args).toContain('--auth-local=scram-sha-256');
        expect(args).toContain('--auth-host=scram-sha-256');
    });

    it('reads the password from a FILE, never an argument', () => {
        // argv is world-readable in the process list on every platform Genie
        // runs on.
        const args = initdbArgs('/data/pg1', 'genie', '/tmp/pw');
        expect(args).toContain('--pwfile=/tmp/pw');
        expect(args.join(' ')).not.toContain('sekrit');
    });

    it('initialises a reproducible cluster', () => {
        const args = initdbArgs('/d', 'genie', '/pw').join(' ');
        expect(args).toContain('-E UTF8');
        expect(args).toContain('--no-locale');
    });
});

// --- postgres lifecycle ----------------------------------------------------

describe('createPostgresRuntime', () => {
    const runtime = (over: Parameters<typeof createPostgresRuntime>[0] extends never ? never : Partial<Parameters<typeof createPostgresRuntime>[0]>) =>
        createPostgresRuntime({ binDir: '/bin', platform: 'linux', ...over } as never);

    it('reports RUNNING only after the ready line, not on spawn', async () => {
        const spawner = fakeSpawner();
        const fs = fakeFs([`/data/pg1/${PG_VERSION_FILE}`]);
        const rt = runtime({ spawner, runner: fakeRunner(), fs });

        const started = rt.start(pg);
        await spawned(spawner);
        // The process exists — but the server is not accepting connections yet.
        expect(rt.status('pg1').state).toBe('starting');
        spawner.last().stderr(`LOG: ${PG_READY_MARKER}\n`);
        const status = await started;

        expect(status.state).toBe('running');
        expect(status.endpoint).toEqual({ host: '127.0.0.1', port: 21432 });
        expect(status.pid).toBe(4242);
    });

    it('runs initdb ONCE — never over an existing cluster', async () => {
        const spawner = fakeSpawner();
        const runner = fakeRunner();
        // PG_VERSION present ⇒ the directory already holds a cluster.
        const rt = runtime({ spawner, runner, fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]) });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        await started;
        expect(runner.calls.some((c) => c.command.includes('initdb'))).toBe(false);
    });

    it('creates the cluster when there is none', async () => {
        const spawner = fakeSpawner();
        const runner = fakeRunner();
        const rt = runtime({ spawner, runner, fs: fakeFs() });
        const started = rt.start(pg);
        // initdb is awaited before the server is spawned.
        await new Promise((r) => setTimeout(r, 0));
        spawner.last().stderr(PG_READY_MARKER);
        await started;
        expect(runner.calls[0]!.command).toContain('initdb');
    });

    it('removes the password file even when initdb FAILS', async () => {
        const fs = fakeFs();
        const rt = runtime({
            spawner: fakeSpawner(),
            runner: fakeRunner({ initdb: { code: 1, stderr: 'permission denied' } }),
            fs,
        });
        const status = await rt.start(pg);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('initdb failed');
        // A credential left on disk indefinitely is the failure mode this
        // guards.
        expect(await fs.exists('/data/pg1.pw')).toBe(false);
    });

    it('treats an already-existing database as success, not an error', async () => {
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner({
                createdb: { code: 1, stderr: 'database "genie" already exists' },
            }),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
        });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        expect((await started).state).toBe('running');
    });

    it('explains a cluster whose password no longer matches the stored one', async () => {
        // The data directory outlived the config that created it (a reset
        // genie.db, a restored backup). Nothing can recover it automatically —
        // changing the role's password requires authenticating as the role — so
        // the only useful thing to do is name the directory. Found in the
        // end-to-end run.
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner({
                createdb: {
                    code: 1,
                    stderr: 'createdb: error: FATAL:  password authentication failed for user "genie"',
                },
            }),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
        });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        const status = await started;
        expect(status.state).toBe('failed');
        expect(status.error).toContain('/data/pg1');
        expect(status.error).toContain('different password');
    });

    it('never puts the password on the createdb command line', async () => {
        const spawner = fakeSpawner();
        const runner = fakeRunner();
        const rt = runtime({ spawner, runner, fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]) });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        await started;
        const createdb = runner.calls.find((c) => c.command.includes('createdb'))!;
        expect(createdb.args.join(' ')).not.toContain('sekrit');
    });

    it('fails with the server log when the process dies before ready', async () => {
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner(),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
        });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr('FATAL: could not bind IPv4 address\n');
        spawner.last().exit(1);
        const status = await started;
        expect(status.state).toBe('failed');
        expect(status.error).toContain('could not bind');
    });

    it('times out rather than hanging on a server that never reports ready', async () => {
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner(),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
            startTimeoutMs: 10,
        });
        const status = await rt.start(pg);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('did not report ready');
        expect(spawner.last().stopped).toBe(true);
    });

    it('is idempotent — starting a running cluster does not spawn a second', async () => {
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner(),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
        });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        await started;
        await rt.start(pg);
        expect(spawner.calls.filter((c) => c.command.includes('postgres'))).toHaveLength(1);
    });

    it('stops CLEANLY through pg_ctl rather than killing the postmaster', async () => {
        // A kill is differently wrong on each platform: SIGTERM asks for a
        // SMART shutdown that one idle client holds open forever, and on
        // Windows there are no signals so it is a TerminateProcess that costs
        // crash recovery on the next start.
        const spawner = fakeSpawner();
        const runner = fakeRunner();
        // Model what pg_ctl actually does: the postmaster goes away.
        const realRun = runner.run.bind(runner);
        runner.run = async (command, args, o) => {
            const result = await realRun(command, args, o);
            if (command.includes('pg_ctl')) spawner.last().exit(0);
            return result;
        };

        const rt = runtime({ spawner, runner, fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]) });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        await started;

        await rt.stop('pg1');
        const stop = runner.calls.find((c) => c.command.includes('pg_ctl'))!;
        expect(stop.args).toEqual(['stop', '-D', '/data/pg1', '-m', 'fast', '-w']);
        // The child was shut down, never killed.
        expect(spawner.last().stopped).toBe(false);
        expect(rt.status('pg1').state).toBe('stopped');
    });

    it('kills the child when a "successful" pg_ctl left it behind', async () => {
        // `pg_ctl` returning 0 is not the same fact as "the child is gone", and
        // a stop that waits forever on the difference would hang app quit.
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner(),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
            stopGraceMs: 10,
        });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        await started;
        await rt.stop('pg1');
        expect(spawner.last().stopped).toBe(true);
    });

    it('falls back to killing when pg_ctl cannot run', async () => {
        // Leaving a postmaster holding the port would make the NEXT start of
        // this workspace fail to bind — worse than an unclean exit.
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner({ pg_ctl: { code: 1, stderr: 'not found' } }),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
        });
        const started = rt.start(pg);
        await spawned(spawner);
        spawner.last().stderr(PG_READY_MARKER);
        await started;
        await rt.stop('pg1');
        expect(spawner.last().stopped).toBe(true);
    });

    it('does not report a deliberate stop as a crash', async () => {
        const spawner = fakeSpawner();
        const rt = runtime({
            spawner,
            runner: fakeRunner(),
            fs: fakeFs([`/data/pg1/${PG_VERSION_FILE}`]),
            startTimeoutMs: 5_000,
            stopGraceMs: 10,
        });
        const started = rt.start(pg);
        await spawned(spawner);
        await rt.stop('pg1');
        const status = await started;
        expect(status.error).toContain('stopped before it finished starting');
        expect(status.error).not.toContain('exited');
    });
});

// --- redis / garnet --------------------------------------------------------

describe('garnetArgs', () => {
    it('binds loopback and uses this instance PRIVATE data directory', () => {
        const args = garnetArgs(redis).join(' ');
        expect(args).toContain('--bind 127.0.0.1');
        expect(args).toContain('--port 21379');
        expect(args).toContain('--checkpointdir /data/rd1');
    });

    it('ENABLES Lua', () => {
        // Off by default in Garnet. Laravel's queue driver and its atomic cache
        // locks are EVAL scripts; without this every EVAL answers "Lua scripting
        // support disabled" and the queue silently does nothing.
        expect(garnetArgs(redis)).toContain('--lua');
    });
});

describe('createRedisRuntime', () => {
    it('reports RUNNING only after the ready line', async () => {
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({
            serverPath: '/g/GarnetServer',
            dotnetRoot: '/dotnet',
            spawner,
            fs: fakeFs(),
        });
        const started = rt.start(redis);
        await spawned(spawner);
        expect(rt.status('rd1').state).toBe('starting');
        spawner.last().stderr(`* ${GARNET_READY_MARKER}\n`);
        const status = await started;
        expect(status.state).toBe('running');
        expect(status.kind).toBe('redis');
        expect(status.engine).toBe('garnet');
        expect(status.endpoint).toEqual({ host: '127.0.0.1', port: 21379 });
    });

    it('points the app host at the PRIVATE .NET runtime', async () => {
        // Without DOTNET_ROOT the server looks for a system .NET and refuses to
        // start with "You must install .NET to run this application".
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({
            serverPath: '/g/GarnetServer',
            dotnetRoot: '/base/hosting/dotnet/10.0.10',
            spawner,
            fs: fakeFs(),
        });
        const started = rt.start(redis);
        await spawned(spawner);
        spawner.last().stderr(GARNET_READY_MARKER);
        await started;
        expect(spawner.calls[0]!.opts.env).toEqual({ DOTNET_ROOT: '/base/hosting/dotnet/10.0.10' });
    });

    it('fails with the log when the server dies before ready', async () => {
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({ serverPath: '/g/x', dotnetRoot: '/d', spawner, fs: fakeFs() });
        const started = rt.start(redis);
        await spawned(spawner);
        spawner.last().stderr('You must install .NET to run this application.\n');
        spawner.last().exit(150);
        const status = await started;
        expect(status.state).toBe('failed');
        expect(status.error).toContain('install .NET');
    });

    it('creates its data directory before spawning into it', async () => {
        // The data dir is BOTH the checkpoint target and the child's cwd, and a
        // spawn into a missing cwd fails with a null exit code and an empty
        // log. Found in the end-to-end run, where the runtime was driven
        // directly rather than through the manager.
        const spawner = fakeSpawner();
        const fs = fakeFs();
        const made: string[] = [];
        fs.mkdir = async (p: string) => {
            made.push(p);
        };
        const rt = createRedisRuntime({ serverPath: '/g/x', dotnetRoot: '/d', spawner, fs });
        const started = rt.start(redis);
        await spawned(spawner);
        spawner.last().stderr(GARNET_READY_MARKER);
        await started;
        expect(made).toContain('/data/rd1');
    });

    it('says the server could not START when the spawn itself failed', async () => {
        // Exit code `null` means the child never ran, so the log is empty —
        // "garnet exited (null): " is a status with nothing in it.
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({
            serverPath: '/nope/GarnetServer.exe',
            dotnetRoot: '/d',
            spawner,
            fs: fakeFs(),
        });
        const started = rt.start(redis);
        await spawned(spawner);
        spawner.last().exit(null);
        const status = await started;
        expect(status.error).toContain('could not be started');
        expect(status.error).toContain('/nope/GarnetServer.exe');
    });

    it('times out rather than hanging', async () => {
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({
            serverPath: '/g/x',
            dotnetRoot: '/d',
            spawner,
            fs: fakeFs(),
            startTimeoutMs: 10,
        });
        const status = await rt.start(redis);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('did not report ready');
    });

    it('is idempotent', async () => {
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({ serverPath: '/g/x', dotnetRoot: '/d', spawner, fs: fakeFs() });
        const started = rt.start(redis);
        await spawned(spawner);
        spawner.last().stderr(GARNET_READY_MARKER);
        await started;
        await rt.start(redis);
        expect(spawner.calls).toHaveLength(1);
    });

    it('does not report a deliberate stop as a crash', async () => {
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({
            serverPath: '/g/x',
            dotnetRoot: '/d',
            spawner,
            fs: fakeFs(),
            startTimeoutMs: 5_000,
        });
        const started = rt.start(redis);
        await spawned(spawner);
        await rt.stop('rd1');
        const status = await started;
        expect(status.error).toContain('stopped before it finished starting');
    });

    it('exposes the log tail for the Site Manager', async () => {
        const spawner = fakeSpawner();
        const rt = createRedisRuntime({ serverPath: '/g/x', dotnetRoot: '/d', spawner, fs: fakeFs() });
        const started = rt.start(redis);
        await spawned(spawner);
        spawner.last().stderr(`Garnet 2.1.1\n* ${GARNET_READY_MARKER}\n`);
        await started;
        expect(rt.logs('rd1')).toContain('Garnet 2.1.1');
    });
});
