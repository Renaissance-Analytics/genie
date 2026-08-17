import { spawn } from 'node:child_process';
import {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describeHostSpawnFailure,
    hostSiteAlive,
    hostSpawnInvocation,
    killTreeWinArgv,
    startHostSite,
    stopHostSite,
    type HostSiteSpawnSpec,
    type HostSpawnPrimitives,
} from './host-site-process';
import type { HostProcessRun } from './site-manager';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Site ids are `devSiteIdFor` hashes; anything else must not reach a path. */
const SITE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The registry file, beside the logs it indexes. */
const REGISTRY_FILE = 'host-runs.json';

/** What the registry remembers about ONE host-native run, across restarts. */
interface TrackedRun {
    pid: number;
    logPath: string;
    /** The loopback port this run is serving on — what `.gen` routes to. Absent on
     *  a record written before ports were tracked; such a run can still be stopped
     *  and read, it just cannot be re-ROUTED without a restart. */
    port?: number;
}

export interface HostProcessRunDeps {
    /** Where each site's captured output is written. */
    logDir: string;
    platform?: NodeJS.Platform;
    /** Injected for tests; defaults to the real Node child_process / process.kill. */
    primitives?: HostSpawnPrimitives;
    /** Read the last `tail` lines of a log file. Default: real fs. */
    readLogTail?: (path: string, tail: number) => string;
    /** Ensure the log dir exists. Default: real fs mkdir. */
    ensureDir?: (dir: string) => void;
    /** Append a line to a site's log (the start-time `[genie]` note). Default: real fs. */
    appendLog?: (path: string, text: string) => void;
    /** Read the persisted run registry (null when there is none). Default: real fs. */
    readRegistry?: (path: string) => string | null;
    /** Replace the persisted run registry, atomically. Default: real fs. */
    writeRegistry?: (path: string, text: string) => void;
}

/**
 * The real {@link HostProcessRun} (story #238) — runs a host-native site's dev
 * server as a detached HOST process, keyed by siteId. The Node primitives are
 * injectable so the registry orchestration (start tracks a pid+log, stop signals +
 * forgets it, alive/readLog look it up) is unit-tested; the defaults are the real
 * bindings a real machine / CI exercises. Never throws — a failure is `ok:false` /
 * `false` / `''`.
 *
 * ## The registry is PERSISTED (genie#190)
 *
 * The whole point of the spawn is that the dev server outlives the call that
 * started it — which means it routinely outlives GENIE, across a restart and
 * across an update. An in-memory registry could not survive that, so every such
 * run became an orphan: still serving on its port, but with `alive` saying no,
 * `stop` a no-op and `readLog` empty, while the Site Manager showed a stopped
 * site that was in fact running. The pid + log + port are written beside the logs
 * so the next Genie process can re-attach what is still up (and see that the rest
 * really is gone). The file is a CACHE of the OS's truth, never the truth itself:
 * every read is filtered through a liveness probe, so a stale record simply
 * disappears rather than inventing a running site.
 */
export function createHostProcessRun(deps: HostProcessRunDeps): HostProcessRun {
    const platform = deps.platform ?? process.platform;
    const prims = deps.primitives ?? realPrimitives(platform);
    const readLogTail = deps.readLogTail ?? realReadLogTail;
    const ensureDir = deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
    const appendLog = deps.appendLog ?? ((path: string, text: string) => appendFileSync(path, text));
    const readRegistry = deps.readRegistry ?? realReadRegistry;
    const writeRegistry = deps.writeRegistry ?? realWriteRegistry;
    const registryPath = join(deps.logDir, REGISTRY_FILE);
    const tracked = loadRegistry(readRegistry, registryPath);

    /** Persist the registry after every change. Best-effort: losing the FILE only
     *  costs the next process its re-attach, but throwing here would fail a start
     *  whose dev server is already up. */
    const save = (): void => {
        try {
            ensureDir(deps.logDir);
            writeRegistry(registryPath, JSON.stringify(Object.fromEntries(tracked)));
        } catch {
            /* advisory */
        }
    };

    return {
        async start({ siteId, command, cwd, env, note, port }) {
            if (!SITE_ID_RE.test(siteId)) return { ok: false, error: `unsafe site id ${JSON.stringify(siteId)}` };
            try {
                ensureDir(deps.logDir);
                const logPath = join(deps.logDir, `${siteId}.log`);
                // A start-time diagnostic (e.g. no service env resolved) goes to the
                // TOP of this run's log, before the dev server's own output, so
                // `manageSite logs` and the progress tail surface it. Same `[genie]`
                // convention as the async spawn-error note below.
                if (note) {
                    try {
                        appendLog(logPath, `\n[genie] ${note}\n`);
                    } catch {
                        // best-effort — the diagnostic is advisory, never fatal to the start.
                    }
                }
                const spec: HostSiteSpawnSpec = { command, cwd, env, logPath };
                const pid = startHostSite(spec, prims);
                tracked.set(siteId, { pid, logPath, ...(port ? { port } : {}) });
                save();
                return { ok: true, pid };
            } catch (e) {
                return { ok: false, error: messageOf(e) };
            }
        },
        async stop(siteId) {
            const t = tracked.get(siteId);
            if (!t) return;
            try {
                await stopHostSite(t.pid, prims);
            } catch {
                // best-effort — a dead process is already stopped.
            }
            tracked.delete(siteId);
            save();
        },
        async alive(siteId) {
            const t = tracked.get(siteId);
            if (!t) return false;
            try {
                return hostSiteAlive(t.pid, prims);
            } catch {
                return false;
            }
        },
        async running() {
            const out: Array<{ siteId: string; port: number }> = [];
            let dropped = false;
            for (const [siteId, t] of [...tracked]) {
                let live = false;
                try {
                    live = hostSiteAlive(t.pid, prims);
                } catch {
                    live = false;
                }
                if (!live) {
                    // The record outlived its process — forget it here rather than
                    // leaving a pid that will one day be REUSED by something else.
                    tracked.delete(siteId);
                    dropped = true;
                    continue;
                }
                if (t.port) out.push({ siteId, port: t.port });
            }
            if (dropped) save();
            return out;
        },
        async readLog(siteId, tail = 200) {
            const t = tracked.get(siteId);
            if (!t) return '';
            const n = Number.isInteger(tail) && tail > 0 ? Math.min(tail, 10_000) : 200;
            try {
                return readLogTail(t.logPath, n);
            } catch {
                return '';
            }
        },
    };
}

/**
 * Read the persisted registry back. Tolerant of every way a file written by a
 * process that was killed mid-update can be wrong — absent, truncated, corrupt,
 * or holding an entry of the wrong shape — because the alternative is a Genie
 * that will not start hosting at all. Anything unreadable is simply "no runs",
 * which is the state the old in-memory registry was always in.
 */
function loadRegistry(
    read: (path: string) => string | null,
    path: string,
): Map<string, TrackedRun> {
    const out = new Map<string, TrackedRun>();
    let raw: string | null = null;
    try {
        raw = read(path);
    } catch {
        return out;
    }
    if (!raw) return out;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [siteId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!SITE_ID_RE.test(siteId) || !value || typeof value !== 'object') continue;
        const entry = value as Partial<TrackedRun>;
        if (!Number.isInteger(entry.pid) || (entry.pid as number) <= 0) continue;
        if (typeof entry.logPath !== 'string' || !entry.logPath) continue;
        out.set(siteId, {
            pid: entry.pid as number,
            logPath: entry.logPath,
            ...(Number.isInteger(entry.port) ? { port: entry.port as number } : {}),
        });
    }
    return out;
}

function realReadRegistry(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null; // absent is the ordinary first-run state
    }
}

/** Atomic: temp file → rename, so a Genie killed mid-write leaves the previous
 *  registry intact rather than a truncated one. */
function realWriteRegistry(path: string, text: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
}

/** The real Node bindings behind the injectable primitives. */
function realPrimitives(platform: NodeJS.Platform): HostSpawnPrimitives {
    return {
        platform,
        spawnDetached(spec) {
            // Append so a restart keeps history; stdout+stderr to the log file, no
            // stdin. Detached so the dev server outlives THIS call — its own group
            // leader on posix, so stopHostSite can signal the whole tree. On win32
            // the command runs through the shell so a `.cmd`/`.bat` dev-server shim
            // (npm/pnpm/php) resolves — spawn launches `.exe` only, and its absence
            // is the "no pid" a host-native start otherwise dies on.
            const fd = openSync(spec.logPath, 'a');
            let child;
            try {
                const { file, args, shell, detached } = hostSpawnInvocation(spec.command, platform);
                child = spawn(file, args, {
                    cwd: spec.cwd,
                    env: { ...process.env, ...spec.env },
                    // posix: detach into its own process group so stopHostSite's `-pid`
                    // reaches the tree. Windows: NEVER detach — a detached console pops
                    // a stray terminal window; `windowsHide` keeps it invisible and
                    // `taskkill /t` kills the tree.
                    detached,
                    stdio: ['ignore', fd, fd],
                    windowsHide: true,
                    shell,
                });
            } finally {
                closeSync(fd);
            }
            // The spawn error (ENOENT, EACCES, …) arrives ASYNCHRONOUSLY and would
            // otherwise be lost — leaving `logs` empty and, worse, crashing main on
            // the unhandled 'error'. Capture it into the site's own log so the real
            // reason is diagnosable, not just "no pid".
            child.on('error', (err: NodeJS.ErrnoException) => {
                const detail = err.code ?? messageOf(err);
                try {
                    appendFileSync(
                        spec.logPath,
                        `\n[genie] ${describeHostSpawnFailure(spec.command, detail)}\n`,
                    );
                } catch {
                    // best-effort — the thrown message below still names the binary.
                }
            });
            child.unref();
            if (typeof child.pid !== 'number') {
                throw new Error(describeHostSpawnFailure(spec.command));
            }
            return child.pid;
        },
        signal(pid, sig) {
            try {
                return process.kill(pid, sig);
            } catch {
                return false;
            }
        },
        async killTreeWin(pid) {
            await new Promise<void>((resolve) => {
                const [cmd, ...args] = killTreeWinArgv(pid);
                const c = spawn(cmd, args, { windowsHide: true });
                c.on('exit', () => resolve());
                c.on('error', () => resolve());
            });
        },
    };
}

function realReadLogTail(path: string, tail: number): string {
    const content = readFileSync(path, 'utf8');
    const lines = content.split(/\r?\n/);
    return lines.slice(-tail).join('\n');
}
