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
    /**
     * The pid `spawn` returned. On win32 this is the SHELL's — the command runs
     * through cmd.exe so a `.cmd`/`.bat` dev-server shim resolves at all — and the
     * shell's lifetime is not the server's. Kept because it is what `taskkill /t`
     * must be pointed at while the shell is alive: that walks the tree and takes
     * the server with it.
     */
    pid: number;
    /**
     * The pid actually LISTENING on {@link port}, resolved right after the spawn
     * (genie#391). This is the process whose liveness answers "is this site still
     * serving", and the one a `stop` has to reach when the shell has already gone.
     *
     * Absent when nothing had bound the port before the resolve gave up, when the
     * run has no port, or on a binding with no `portOwnerPid` lookup — in every one
     * of those cases the registry falls back to {@link pid} and behaves exactly as
     * it did before this field existed.
     */
    serverPid?: number;
    logPath: string;
    /** The loopback port this run is serving on — what `.gen` routes to. Absent on
     *  a record written before ports were tracked; such a run can still be stopped
     *  and read, it just cannot be re-ROUTED without a restart. */
    port?: number;
    /**
     * Runs this site started EARLIER that were still alive when a new start
     * displaced them (genie#391).
     *
     * The registry is keyed by siteId and `set` overwrites, so a start reaching
     * that line while a previous run is up used to drop a live pair — shell and
     * server both — leaving nothing anywhere holding their pids. That is the
     * second leak on this issue, and the larger half of it: of 109 stranded
     * `php -S` servers measured after #496, 80 still had a LIVE parent shell, so
     * the wrong-pid mechanism cannot explain them. Thirty-one duplicates for one
     * site is a shape problem, not a pid problem.
     *
     * Retained to be STOPPABLE, never to be served — see {@link
     * HostProcessRun.running}. Pruned to the ones still alive on every start, so
     * this cannot grow without bound and `stop` never signals a long-dead pid the
     * OS may since have reused.
     */
    displaced?: DisplacedRun[];
}

/** A displaced run: only what a later stop needs to reach it. */
interface DisplacedRun {
    pid: number;
    serverPid?: number;
}

/**
 * The pid whose liveness IS the run's liveness. See {@link TrackedRun.serverPid}:
 * the spawn pid is only a proxy for it, and on win32 a short-lived one.
 */
const supervisedPid = (t: TrackedRun | DisplacedRun): number => t.serverPid ?? t.pid;

/**
 * How long a start looks for the port's owner before giving up, and how often.
 *
 * 2s in 80ms steps. The first attempt almost always wins for what actually leaked
 * — Genie's own Caddy and `php-cgi` bind within milliseconds of exec — and the
 * budget is bounded because a command that never binds must not hold up its own
 * start report. A dev server slower than this keeps the pre-genie#391 behaviour
 * rather than getting a wrong answer: `serverPid` simply stays unset.
 */
const OWNER_ATTEMPTS = 25;
const OWNER_INTERVAL_MS = 80;

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
    /** Sleep between port-owner attempts. Injected so a test that exercises the
     *  give-up path does not spend the real budget doing it. */
    wait?: (ms: number) => Promise<void>;
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
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const registryPath = join(deps.logDir, REGISTRY_FILE);
    const tracked = loadRegistry(readRegistry, registryPath);

    /**
     * Who holds `port` — polled, because the spawn has only just returned and the
     * server binds a moment later. Null when nothing answered inside the budget,
     * which is not a failure: the caller keeps the spawn pid.
     */
    async function resolvePortOwner(port: number): Promise<number | null> {
        const lookup = prims.portOwnerPid;
        if (!lookup) return null;
        for (let attempt = 0; attempt < OWNER_ATTEMPTS; attempt += 1) {
            let owner: number | null = null;
            try {
                owner = await lookup(port);
            } catch {
                // A lookup that cannot answer is "not yet", never a failed start.
                owner = null;
            }
            if (typeof owner === 'number' && Number.isInteger(owner) && owner > 0) return owner;
            if (attempt < OWNER_ATTEMPTS - 1) await wait(OWNER_INTERVAL_MS);
        }
        return null;
    }

    /**
     * Stop one tracked run, INCLUDING a server the shell can no longer reach.
     *
     * The first kill is the one that has always been here: on win32 `taskkill /t`
     * on the spawn pid walks the tree and takes the server with it, on posix the
     * `-pid` SIGTERM signals the group. The second exists because that is only true
     * while the shell is alive — once it has exited, the tree kill reaches nothing
     * and the server it launched is exactly the orphan genie#391 counted 151 of.
     *
     * Guarded on liveness, so an ordinary stop still issues ONE kill: the tree kill
     * has already taken the server, `alive` says so, and nothing further is asked.
     */
    /** Is this run's server still up? Unanswerable counts as dead — the callers
     *  either retain it (bounded by this) or stop it (best-effort anyway). */
    function runAlive(t: TrackedRun | DisplacedRun): boolean {
        try {
            return hostSiteAlive(supervisedPid(t), prims);
        } catch {
            return false;
        }
    }

    /**
     * The earlier runs a new start must not forget: the one it is displacing, plus
     * anything that displaced run was itself still carrying — each kept only while
     * genuinely alive.
     *
     * The prune is what makes this safe to persist. Retaining unconditionally would
     * grow the registry for the life of the site and have `stop` signal pids the OS
     * has since handed to somebody else, which is a worse bug than the leak.
     */
    function retainedFrom(previous: TrackedRun): DisplacedRun[] {
        const kept: DisplacedRun[] = [];
        for (const older of previous.displaced ?? []) {
            if (runAlive(older)) kept.push(older);
        }
        if (runAlive(previous)) {
            kept.push({ pid: previous.pid, ...(previous.serverPid ? { serverPid: previous.serverPid } : {}) });
        }
        return kept;
    }

    async function stopTracked(t: TrackedRun | DisplacedRun): Promise<void> {
        try {
            await stopHostSite(t.pid, prims);
        } catch {
            // best-effort — a dead process is already stopped.
        }
        const server = t.serverPid;
        if (server === undefined || server === t.pid) return;
        let survived = false;
        try {
            survived = hostSiteAlive(server, prims);
        } catch {
            survived = false;
        }
        if (!survived) return;
        try {
            await stopHostSite(server, prims);
        } catch {
            // best-effort, same as above.
        }
    }

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
                // A start must not silently drop a run that is still alive
                // (genie#391). Computed AFTER the spawn, so a failed spawn leaves
                // the previous record exactly as it was.
                const previous = tracked.get(siteId);
                const displaced = previous ? retainedFrom(previous) : [];
                tracked.set(siteId, {
                    pid,
                    logPath,
                    ...(port ? { port } : {}),
                    ...(displaced.length > 0 ? { displaced } : {}),
                });
                // Persisted BEFORE the port owner is resolved, so a Genie that dies
                // during the resolve still records what the old code recorded.
                save();
                // …then learn which process actually bound the port, because on
                // win32 the pid above is the shell's and the shell will not outlive
                // this Genie (genie#391). Nothing to ask when the run has no port.
                if (port) {
                    const serverPid = await resolvePortOwner(port);
                    const entry = tracked.get(siteId);
                    // The run may have been stopped or replaced while we looked;
                    // only write back to the one we actually started.
                    if (serverPid !== null && entry && entry.pid === pid) {
                        entry.serverPid = serverPid;
                        save();
                    }
                }
                return { ok: true, pid };
            } catch (e) {
                return { ok: false, error: messageOf(e) };
            }
        },
        async stop(siteId) {
            const t = tracked.get(siteId);
            if (!t) return;
            await stopTracked(t);
            // …and every run an earlier start displaced. Retaining them was only
            // ever so this line could reach them; a survivor of THIS stop is the
            // site manager's `orphans` map (genie#399/#421), one layer up.
            for (const older of t.displaced ?? []) await stopTracked(older);
            tracked.delete(siteId);
            save();
        },
        async alive(siteId) {
            const t = tracked.get(siteId);
            if (!t) return false;
            try {
                return hostSiteAlive(supervisedPid(t), prims);
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
                    // The SERVER's liveness, not the shell's (genie#391). Asking the
                    // shell is what dropped every record on win32 the moment Genie
                    // restarted, so nothing was ever re-attached and the next start
                    // spawned a duplicate beside a process still holding the port.
                    live = hostSiteAlive(supervisedPid(t), prims);
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
        // Displaced runs are pid-only records, so each is validated the same way
        // the primary pid is. Anything malformed is simply dropped: a bad entry
        // here would have `stop` signal a number nobody vouched for.
        const displaced: DisplacedRun[] = [];
        if (Array.isArray(entry.displaced)) {
            for (const raw of entry.displaced) {
                if (!raw || typeof raw !== 'object') continue;
                const older = raw as Partial<DisplacedRun>;
                if (!Number.isInteger(older.pid) || (older.pid as number) <= 0) continue;
                displaced.push({
                    pid: older.pid as number,
                    ...(Number.isInteger(older.serverPid) && (older.serverPid as number) > 0
                        ? { serverPid: older.serverPid as number }
                        : {}),
                });
            }
        }
        out.set(siteId, {
            pid: entry.pid as number,
            logPath: entry.logPath,
            ...(displaced.length > 0 ? { displaced } : {}),
            // Absent in every record written before genie#391 — those keep working,
            // they simply fall back to the spawn pid the way they always did.
            ...(Number.isInteger(entry.serverPid) && (entry.serverPid as number) > 0
                ? { serverPid: entry.serverPid as number }
                : {}),
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
        async portOwnerPid(port) {
            const [cmd, ...args] = portOwnerArgv(port, platform);
            let out = '';
            try {
                out = await runCapturing(cmd, args);
            } catch {
                return null;
            }
            return parsePortOwner(out, port, platform);
        },
    };
}

/**
 * The command that names the process listening on a loopback port.
 *
 * `netstat -ano` on Windows rather than PowerShell's `Get-NetTCPConnection`: it is
 * a single fast exe with no runtime to start, and it is present on every Windows
 * this ships to. `lsof -t` on posix prints bare pids and nothing else.
 *
 * Exported for the parser's tests — the two have to agree about which tool's
 * output is being read, and a parser tested against output no command produces is
 * the weaker-question failure this repository keeps finding.
 */
export function portOwnerArgv(port: number, platform: NodeJS.Platform): string[] {
    if (platform === 'win32') return ['netstat', '-ano', '-p', 'TCP'];
    return ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'];
}

/**
 * PURE. The pid LISTENING on `port` in that command's output, or null.
 *
 * On win32 the whole table comes back and the LISTENING row for this exact port is
 * picked here — matching on `:<port>` at the END of the local address, so port
 * 5321 is never satisfied by 15321 or by a REMOTE address that happens to contain
 * it. Only `LISTENING` rows count: an established connection TO the port names the
 * client, which is emphatically not the server.
 */
export function parsePortOwner(
    output: string,
    port: number,
    platform: NodeJS.Platform,
): number | null {
    if (platform !== 'win32') {
        // `lsof -t`: bare pids, one per line. First is enough — a listening socket
        // has one owner (pre-forked workers share it, and any of them answers the
        // question "is this still up").
        for (const line of output.split(/\r?\n/)) {
            const pid = Number(line.trim());
            if (Number.isInteger(pid) && pid > 0) return pid;
        }
        return null;
    }
    for (const line of output.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        // Proto Local Foreign State PID — a LISTENING TCP row has exactly five.
        if (cols.length < 5) continue;
        const [proto, local, , state, pidText] = cols;
        if (!/^TCP$/i.test(proto ?? '')) continue;
        if ((state ?? '').toUpperCase() !== 'LISTENING') continue;
        if (!(local ?? '').endsWith(`:${port}`)) continue;
        const pid = Number(pidText);
        if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
}

/** Run a command and return its stdout. Rejects on spawn failure; a non-zero exit
 *  still resolves, because `netstat` and `lsof` both use it to mean "nothing
 *  matched", which is a null answer rather than an error. */
function runCapturing(cmd: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let out = '';
        child.stdout?.on('data', (chunk) => {
            out += String(chunk);
        });
        child.on('error', reject);
        child.on('close', () => resolve(out));
    });
}

function realReadLogTail(path: string, tail: number): string {
    const content = readFileSync(path, 'utf8');
    const lines = content.split(/\r?\n/);
    return lines.slice(-tail).join('\n');
}
