import { describe, expect, it } from 'vitest';
import {
    createFrankenPhpRuntime,
    extensionDirFor,
    phpIniDir,
    runArgs,
    siteConfigPath,
    READY_MARKER,
} from '../frankenphp';
import type {
    ConfigWriter,
    HostedProcessHandle,
    HostedSite,
    ProcessSpawner,
    SpawnOptions,
} from '../types';

/**
 * Lifecycle of the FrankenPHP adapter, driven entirely through its injected
 * spawn + fs seams: no binary is downloaded, no process is started and no port
 * is bound by anything in this file.
 *
 * The contract worth defending hardest is READINESS. A spawned process proves
 * nothing — an invalid Caddyfile, a taken port or a bad document root all
 * produce a process that lives just long enough to exit non-zero. Reporting
 * `running` on spawn would hand the Testing Browser a target that refuses every
 * connection, which is the same class of "the preview is just broken" failure
 * this runtime exists to remove. So the adapter waits for Caddy's own
 * `serving initial configuration` line — verified against FrankenPHP 1.12.6 /
 * Caddy 2.11.4 during the P1 spike.
 */

// --- fakes -----------------------------------------------------------------

interface FakeProc extends HostedProcessHandle {
    command: string;
    args: string[];
    opts: SpawnOptions;
    emitStderr(chunk: string): void;
    exit(code: number | null): void;
    stopped: boolean;
}

function fakeSpawner(): { spawner: ProcessSpawner; procs: FakeProc[] } {
    const procs: FakeProc[] = [];
    const spawner: ProcessSpawner = {
        spawn(command, args, opts) {
            let resolveExit!: (code: number | null) => void;
            const exited = new Promise<number | null>((r) => {
                resolveExit = r;
            });
            const proc: FakeProc = {
                command,
                args,
                opts,
                pid: 4242 + procs.length,
                exited,
                stopped: false,
                emitStderr: (chunk) => opts.onStderr?.(chunk),
                exit: (code) => resolveExit(code),
                stop() {
                    proc.stopped = true;
                    resolveExit(0);
                },
            };
            procs.push(proc);
            return proc;
        },
    };
    return { spawner, procs };
}

function fakeWriter(): { writer: ConfigWriter; files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        writer: {
            async write(filePath, contents) {
                files.set(filePath.replace(/\\/g, '/'), contents);
            },
        },
    };
}

const SITE: HostedSite = {
    id: 'site-abc',
    hostname: 'tynn.test',
    root: 'C:/repos/tynn/public',
    kind: 'php',
};

function harness() {
    const { spawner, procs } = fakeSpawner();
    const { writer, files } = fakeWriter();
    const runtime = createFrankenPhpRuntime({
        binaryPath: 'C:/genie/frankenphp/frankenphp.exe',
        stateDir: 'C:/genie/state',
        spawner,
        writer,
        startTimeoutMs: 50,
    });
    return { runtime, procs, files };
}

/**
 * Wait until `start()` has actually spawned.
 *
 * `start()` awaits two config writes before spawning, so a bare
 * `await Promise.resolve()` lands BEFORE the spawn — the ready marker then goes
 * nowhere and every site times out. That is not a theoretical race: it made
 * `expect(b.target?.port).not.toBe(a.target?.port)` compare `undefined` with
 * `undefined` and pass vacuously. Hence also the `expectPort` guard below.
 */
async function spawned(h: ReturnType<typeof harness>, before: number): Promise<FakeProc> {
    for (let i = 0; i < 100 && h.procs.length === before; i += 1) {
        await new Promise((r) => setImmediate(r));
    }
    const proc = h.procs.at(-1);
    if (!proc || h.procs.length === before) throw new Error('start() never spawned a process');
    return proc;
}

/** Start a site and let it report ready once it has actually spawned. */
async function startReady(h: ReturnType<typeof harness>, site = SITE) {
    const before = h.procs.length;
    const started = h.runtime.start(site);
    (await spawned(h, before)).emitStderr(`{"msg":"${READY_MARKER}"}`);
    return started;
}

/** Assert a port exists before comparing it — see {@link spawned}. */
function expectPort(status: { target: { port: number } | null }): number {
    expect(status.target).not.toBeNull();
    expect(status.target?.port).toEqual(expect.any(Number));
    return status.target!.port;
}

// --- pure path helpers -----------------------------------------------------

describe('READY_MARKER', () => {
    it('is the exact line Caddy prints — pinned as a LITERAL, not via the constant', () => {
        // Every other test in this file emits `READY_MARKER` and then asserts on
        // it, so all of them keep passing if the constant is changed to any
        // other string: the marker's only real requirement — that it matches
        // what FrankenPHP actually writes to stderr — is invisible to them.
        // Mutation-checked: changing the constant makes ONLY this test fail.
        // Captured from FrankenPHP 1.12.6 / Caddy 2.11.4 during the P1 spike:
        //   {"level":"info","ts":...,"msg":"serving initial configuration"}
        expect(READY_MARKER).toBe('serving initial configuration');
    });
});

describe('path helpers', () => {
    it('names each site config `Caddyfile` so the adapter is unambiguous', () => {
        expect(siteConfigPath('C:/state', 'abc').replace(/\\/g, '/')).toBe(
            'C:/state/sites/abc/Caddyfile',
        );
    });

    it('derives ext/ from the binary location', () => {
        expect(extensionDirFor('C:/genie/frankenphp/frankenphp.exe').replace(/\\/g, '/')).toBe(
            'C:/genie/frankenphp/ext',
        );
    });

    it('points PHP at a DIRECTORY (PHP_INI_SCAN_DIR scans dirs, not files)', () => {
        expect(phpIniDir('C:/state').replace(/\\/g, '/')).toBe('C:/state/php-ini.d');
    });

    it('pins the argv, including an explicit adapter', () => {
        expect(runArgs('C:/state/sites/abc/Caddyfile')).toEqual([
            'run',
            '--config',
            'C:/state/sites/abc/Caddyfile',
            '--adapter',
            'caddyfile',
        ]);
    });
});

// --- lifecycle -------------------------------------------------------------

describe('createFrankenPhpRuntime', () => {
    it('reports stopped for a site it has never seen', () => {
        const { runtime } = harness();
        expect(runtime.status('nope')).toMatchObject({ state: 'stopped', target: null });
    });

    it('writes the Caddyfile before spawning, and spawns the configured binary', async () => {
        const h = harness();
        await startReady(h);
        expect(h.files.has('C:/genie/state/sites/site-abc/Caddyfile')).toBe(true);
        expect(h.procs[0]?.command).toBe('C:/genie/frankenphp/frankenphp.exe');
        expect(h.procs[0]?.args).toEqual(runArgs(siteConfigPath('C:/genie/state', 'site-abc')));
    });

    it('writes a php.ini and points the process at it', async () => {
        // The Windows archive ships no active php.ini, so without this a Laravel
        // app boots with no PDO driver and dies on its first query.
        const h = harness();
        await startReady(h);
        const ini = h.files.get('C:/genie/state/php-ini.d/genie.ini');
        expect(ini).toContain('extension_dir = "C:/genie/frankenphp/ext"');
        expect(ini).toContain('extension = pdo_sqlite');
        expect(h.procs[0]?.opts.env).toEqual({
            PHP_INI_SCAN_DIR: phpIniDir('C:/genie/state'),
        });
    });

    it('writes NO php.ini for a statically-linked runtime', async () => {
        // The macOS/Linux artifacts are single binaries with the extensions
        // compiled in — there is no `ext/` to point `extension_dir` at, and
        // `extension = curl` against a build that already has curl makes PHP
        // fail to load a library it has. So the layout says "no dynamic
        // extensions" (extensionDir: null) and the adapter must then write
        // nothing and set no PHP_INI_SCAN_DIR.
        const { spawner, procs } = fakeSpawner();
        const { writer, files } = fakeWriter();
        const runtime = createFrankenPhpRuntime({
            binaryPath: '/opt/genie/frankenphp/frankenphp',
            stateDir: '/opt/genie/state',
            spawner,
            writer,
            extensionDir: null,
            startTimeoutMs: 50,
        });
        const started = runtime.start(SITE);
        for (let i = 0; i < 100 && procs.length === 0; i += 1) {
            await new Promise((r) => setImmediate(r));
        }
        procs[0]?.emitStderr(`{"msg":"${READY_MARKER}"}`);
        expect((await started).state).toBe('running');
        expect([...files.keys()].some((f) => f.endsWith('genie.ini'))).toBe(false);
        expect(procs[0]?.opts.env).toEqual({});
    });

    it('runs the process from the document root', async () => {
        const h = harness();
        await startReady(h);
        expect(h.procs[0]?.opts.cwd).toBe('C:/repos/tynn/public');
    });

    it('stays `starting` until Caddy reports the config is live', async () => {
        const h = harness();
        const started = h.runtime.start(SITE);
        const proc = await spawned(h, 0);
        expect(h.runtime.status('site-abc').state).toBe('starting');
        proc.emitStderr('{"msg":"some unrelated log line"}');
        expect(h.runtime.status('site-abc').state).toBe('starting');
        proc.emitStderr(`{"msg":"${READY_MARKER}"}`);
        await started;
        expect(h.runtime.status('site-abc').state).toBe('running');
    });

    it('exposes a LocalTarget and a stable same-origin URL once running', async () => {
        const h = harness();
        const status = await startReady(h);
        expect(status.state).toBe('running');
        expect(status.target).toEqual({
            scheme: 'https',
            hostname: 'tynn.test',
            port: expect.any(Number),
            loopback: '127.0.0.1',
        });
        expect(status.origin).toBe(`https://tynn.test:${status.target?.port}`);
        expect(status.pid).toBe(4242);
    });

    it('gives the same site the same port across restarts', async () => {
        const first = expectPort(await startReady(harness()));
        const second = expectPort(await startReady(harness()));
        expect(second).toBe(first);
    });

    it('gives two concurrent sites different ports', async () => {
        const h = harness();
        const a = expectPort(await startReady(h));
        const b = expectPort(
            await startReady(h, { ...SITE, id: 'site-xyz', hostname: 'other.test' }),
        );
        expect(b).not.toBe(a);
    });

    it('fails when the process exits before reporting ready', async () => {
        const h = harness();
        const started = h.runtime.start(SITE);
        const proc = await spawned(h, 0);
        proc.emitStderr('Error: listen tcp :20431: bind: address already in use');
        proc.exit(1);
        const status = await started;
        expect(status.state).toBe('failed');
        expect(status.error).toContain('address already in use');
        expect(status.target).toBeNull();
    });

    it('fails, and kills the process, when readiness never arrives', async () => {
        const h = harness();
        const status = await h.runtime.start(SITE);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/did not report ready/);
        expect(h.procs[0]?.stopped).toBe(true);
    });

    it('marks a site failed when it crashes after coming up', async () => {
        const h = harness();
        const status = await startReady(h);
        expect(status.state).toBe('running');
        h.procs[0]?.exit(139);
        await h.procs[0]?.exited;
        await new Promise((r) => setImmediate(r));
        expect(h.runtime.status('site-abc').state).toBe('failed');
    });

    it('is idempotent — starting a live site never orphans a second process', async () => {
        const h = harness();
        await startReady(h);
        await h.runtime.start(SITE);
        expect(h.procs).toHaveLength(1);
    });

    it('stops a site and forgets it', async () => {
        const h = harness();
        await startReady(h);
        await h.runtime.stop('site-abc');
        expect(h.procs[0]?.stopped).toBe(true);
        expect(h.runtime.status('site-abc').state).toBe('stopped');
        expect(h.runtime.list()).toEqual([]);
    });

    it('does not blame FrankenPHP when a site is stopped mid-startup', async () => {
        // The exit that `stop()` causes arrives at the same handler a crash
        // does. Without an explicit "we asked for this" flag, stopping a site
        // that is still STARTING resolves its pending `start()` with
        // "frankenphp exited (0)" — the caller is told the server fell over
        // when it did exactly what it was told to do.
        const h = harness();
        const started = h.runtime.start(SITE);
        await spawned(h, 0);
        expect(h.runtime.status('site-abc').state).toBe('starting');
        await h.runtime.stop('site-abc');
        const status = await started;
        expect(status.error).not.toMatch(/frankenphp exited/);
        expect(status.error).toMatch(/stopped before it finished starting/);
        expect(h.runtime.status('site-abc').state).toBe('stopped');
    });

    it('stopping an unknown site is a no-op, not a throw', async () => {
        const h = harness();
        await expect(h.runtime.stop('never-started')).resolves.toBeUndefined();
    });

    it('stopAll stops every site', async () => {
        const h = harness();
        await startReady(h);
        await startReady(h, { ...SITE, id: 'site-xyz', hostname: 'other.test' });
        await h.runtime.stopAll();
        expect(h.procs.every((p) => p.stopped)).toBe(true);
        expect(h.runtime.list()).toEqual([]);
    });
});
