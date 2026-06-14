import { spawn, IPty } from 'node-pty';
import { EventEmitter } from 'node:events';
import { scanOsc7Cwd } from './osc7';
import { cwdHookEnv } from './shells';
import type { PtyBackend } from './backend';
import type { CreateTerminalOpts, TerminalInfo, AttachResult } from './types';
import type { SettingsProvider } from './ports';
import type { SnapshotStore } from './sessions';

export type { CreateTerminalOpts, TerminalInfo, AttachResult } from './types';

/**
 * Centralised PTY manager. Owns every spawned pty, routes I/O to/from
 * the renderer via the events on this emitter, and cleans up on close.
 *
 * Why an emitter, not direct IPC: the manager doesn't know which
 * BrowserWindow is hosting a terminal — that's the IPC layer's job. The
 * manager just emits `data:<id>` and `exit:<id>` and lets ipc.ts wire
 * them to the right webContents.
 *
 * RUNTIME-AGNOSTIC: this module imports neither `electron` nor `../db`. The
 * settings (for the OSC-7 cwd hook) + snapshot store (for cold-spawn restore)
 * are injected via BackendDeps, and the live cwd learned from OSC-7 is EMITTED
 * as a `'cwd'` event rather than written to the DB directly. Genie's adapter
 * subscribes to `'cwd'` → `updateTerminalSpec({ live_cwd })`.
 */

/** ~1 MB per pty. Enough for an hour of typical dev output without runaway memory. */
const SCROLLBACK_MAX = 1_000_000;

/** Debounce window for emitting an OSC-7 cwd change (the adapter persists it). */
const CWD_PERSIST_DEBOUNCE_MS = 750;

/**
 * Dependencies the in-process backend needs that used to be direct `../db` /
 * `electron` reaches: a SettingsProvider (cwd-hook gating) and a SnapshotStore
 * (cold-spawn restore). Injected by the composition root via
 * configureInProcessBackend; defaults are inert so a test/pre-config load is
 * harmless (no settings → cwd hook degrades to {}, no-op snapshot store → no
 * restore), preserving the historical "db not ready → best-effort" behaviour.
 */
export interface BackendDeps {
    settings: SettingsProvider;
    snapshots: SnapshotStore;
}

const inertDeps: BackendDeps = {
    settings: { get: () => undefined },
    snapshots: {
        writeSnapshot: () => null,
        readSnapshot: () => null,
        deleteSnapshot: () => {},
    },
};

/**
 * InProcessBackend — node-pty instances owned directly by the Electron main
 * process. This is the historical TerminalManager body verbatim; it now also
 * formally implements the PtyBackend interface so the IPC layer can hold it
 * behind that abstraction interchangeably with the Tier 3 HostClient.
 *
 * EventEmitter gives us the `on('data'|'exit', …)` half of PtyBackend for free.
 */
class InProcessBackend extends EventEmitter implements PtyBackend {
    constructor(private deps: BackendDeps = inertDeps) {
        super();
    }

    /** Swap injected deps (only used if configure lands after lazy construction). */
    setDeps(deps: BackendDeps): void {
        this.deps = deps;
    }

    private readonly ptys = new Map<string, IPty>();
    private readonly scrollback = new Map<string, string>();
    private readonly shells = new Map<string, string>();
    /** Last cwd reported by each pty via OSC-7 (in-memory, authoritative). */
    private readonly liveCwd = new Map<string, string>();
    /** Pending debounced cwd-persist timers, keyed by terminal id. */
    private readonly cwdTimers = new Map<string, NodeJS.Timeout>();
    /**
     * Tier 2: ids that must keep their pty alive even with zero attached
     * windows (a disabled-but-retained terminal — e.g. a dev server the user
     * suspended). The IPC layer consults this in detachOwner: a retained id is
     * left running on the last detach instead of killed, so re-enable reattaches
     * to the LIVE session (scrollback replays) rather than spawning fresh.
     * Insertion order is preserved so the cap can evict the oldest if needed.
     */
    private readonly retained = new Set<string>();

    /**
     * Spawn a new pty for the given id, OR return the existing one if a
     * window has already attached. Idempotent: a Stage window can attach
     * to a spec that TheFloor is already running and get the same live
     * shell + a buffered scrollback to catch up.
     */
    create(opts: CreateTerminalOpts): AttachResult {
        const existing = this.ptys.get(opts.id);
        if (existing) {
            return {
                id: opts.id,
                pid: existing.pid,
                shell: this.shells.get(opts.id) ?? existing.process,
                existing: true,
                scrollback: this.scrollback.get(opts.id) ?? '',
            };
        }
        const shell = opts.shell ?? defaultShell();
        const args = opts.args ?? defaultShellArgs(shell);
        // Inject the OSC-7 prompt hook (gated by the track_cwd setting) so the
        // shell reports its cwd on every prompt. cwdHookEnv returns {} when
        // tracking is off or the shell can't be hooked — degrade silently.
        const env = {
            ...process.env,
            ...cwdHookEnv(shell, this.deps.settings),
            ...(opts.env ?? {}),
        } as Record<string, string>;
        // Most TUI apps key off TERM to decide whether to emit ANSI / use the
        // alt screen. xterm.js handles xterm-256color cleanly; without this,
        // some apps degrade to dumb mode.
        env.TERM = env.TERM || 'xterm-256color';

        const pty = spawn(shell, args, {
            name: 'xterm-color',
            cwd: opts.cwd,
            cols: opts.cols ?? 80,
            rows: opts.rows ?? 24,
            env,
        });

        this.ptys.set(opts.id, pty);
        this.shells.set(opts.id, shell);
        this.scrollback.set(opts.id, '');

        pty.onData((data) => {
            const buf = this.scrollback.get(opts.id) ?? '';
            const next = buf + data;
            this.scrollback.set(
                opts.id,
                next.length > SCROLLBACK_MAX ? next.slice(-SCROLLBACK_MAX) : next,
            );
            // Tier 1.5: watch for OSC-7 cwd reports and persist the latest,
            // debounced. The in-memory map is authoritative; the spec row is a
            // durable mirror for the next launch.
            const cwd = scanOsc7Cwd(data);
            if (cwd && cwd !== this.liveCwd.get(opts.id)) {
                this.liveCwd.set(opts.id, cwd);
                this.scheduleCwdPersist(opts.id, cwd);
            }
            this.emit('data', opts.id, data);
        });
        pty.onExit(({ exitCode, signal }) => {
            this.cleanupCwd(opts.id);
            this.ptys.delete(opts.id);
            this.scrollback.delete(opts.id);
            this.shells.delete(opts.id);
            // A dead pty can't be retained — drop the flag so the cap frees up.
            this.retained.delete(opts.id);
            this.emit('exit', opts.id, { exitCode, signal });
        });

        // Cold spawn: surface any previous-session snapshot so the renderer can
        // replay history + divider + reset before this fresh shell takes over.
        const snap = this.deps.snapshots.readSnapshot(opts.id);

        return {
            id: opts.id,
            pid: pty.pid,
            shell,
            existing: false,
            scrollback: '',
            snapshot: snap ?? undefined,
        };
    }

    private scheduleCwdPersist(id: string, cwd: string): void {
        const existing = this.cwdTimers.get(id);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            this.cwdTimers.delete(id);
            this.emit('cwd', id, cwd);
        }, CWD_PERSIST_DEBOUNCE_MS);
        // Don't let a pending cwd-write hold the process open at quit.
        if (typeof t.unref === 'function') t.unref();
        this.cwdTimers.set(id, t);
    }

    private cleanupCwd(id: string): void {
        const t = this.cwdTimers.get(id);
        if (t) {
            clearTimeout(t);
            this.cwdTimers.delete(id);
        }
        // Flush the last known cwd synchronously so a quit right after a `cd`
        // doesn't lose it. The adapter persists on the `cwd` event.
        const cwd = this.liveCwd.get(id);
        if (cwd) this.emit('cwd', id, cwd);
        this.liveCwd.delete(id);
    }

    /** Last cwd reported by this pty via OSC-7, or undefined when unknown. */
    getLiveCwd(id: string): string | undefined {
        return this.liveCwd.get(id);
    }

    write(id: string, data: string): boolean {
        const pty = this.ptys.get(id);
        if (!pty) return false;
        pty.write(data);
        return true;
    }

    resize(id: string, cols: number, rows: number): boolean {
        const pty = this.ptys.get(id);
        if (!pty) return false;
        // pty.resize throws when called with non-positive dims (and xterm-fit
        // can produce 0×0 transiently during layout). Clamp defensively.
        pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
        return true;
    }

    kill(id: string): boolean {
        const pty = this.ptys.get(id);
        if (!pty) return false;
        try {
            pty.kill();
        } catch {
            /* already exited */
        }
        this.cleanupCwd(id);
        this.ptys.delete(id);
        this.scrollback.delete(id);
        this.shells.delete(id);
        // An explicit kill (delete) also clears any retained flag.
        this.retained.delete(id);
        return true;
    }

    killAll(): void {
        for (const id of Array.from(this.ptys.keys())) {
            this.kill(id);
        }
    }

    list(): TerminalInfo[] {
        return Array.from(this.ptys.entries()).map(([id, pty]) => ({
            id,
            pid: pty.pid,
            shell: this.shells.get(id) ?? pty.process,
        }));
    }

    isLive(id: string): boolean {
        return this.ptys.has(id);
    }

    // --- Tier 2: retained-PTY (disabled-not-deleted) -----------------------

    /**
     * Mark/unmark a terminal as retained. A retained terminal's pty is kept
     * alive by the IPC layer even when its last window detaches. Returns the
     * resulting retained-id set size. Retaining a terminal that isn't live is
     * harmless (the flag simply has no pty to protect yet).
     */
    setRetained(id: string, retained: boolean): void {
        if (retained) this.retained.add(id);
        else this.retained.delete(id);
    }

    isRetained(id: string): boolean {
        return this.retained.has(id);
    }

    /** Number of currently-retained terminals (for the resource cap). */
    retainedCount(): number {
        return this.retained.size;
    }

    /** Snapshot of retained ids in insertion order (oldest first). */
    retainedIds(): string[] {
        return Array.from(this.retained);
    }

    /**
     * Buffered scrollback for a live pty (raw ANSI text), or undefined when the
     * id has no pty. Tier 2 uses this to serialize a windowless retained pty at
     * quit so its post-disable output still lands in a snapshot (T2→T1 degrade).
     */
    getScrollback(id: string): string | undefined {
        return this.scrollback.get(id);
    }
}

/** Back-compat alias. The class was renamed InProcessBackend in Tier 3; existing
 *  imports of `TerminalManager` as a TYPE keep working. */
export type TerminalManager = InProcessBackend;

/**
 * Injected dependencies for the in-process backend, set ONCE by the composition
 * root (genie-adapter.ts) before the backend is first constructed. Defaults are
 * inert so a test/pre-config load is harmless. Stored module-side rather than
 * threaded through every call site because the backend is a lazy singleton.
 */
let configuredDeps: BackendDeps = inertDeps;

/**
 * Wire the in-process backend's settings + snapshot store. Must be called by the
 * adapter at app-ready, before any terminal is created. Idempotent if the
 * singleton hasn't been built yet; if it already exists this updates the deps it
 * uses (the adapter calls this exactly once, before first use).
 */
export function configureInProcessBackend(deps: BackendDeps): void {
    configuredDeps = deps;
    if (inProcess) inProcess.setDeps(deps);
}

/**
 * In-process backend singleton. Created lazily so importing this module from a
 * test context doesn't attempt to load node-pty before vi.mock has had a chance
 * to substitute it. This is ALSO the Tier 1/Tier 2 fallback floor: the quit-time
 * snapshot helpers reach for the in-process scrollback through it.
 */
let inProcess: InProcessBackend | null = null;
export function inProcessBackend(): InProcessBackend {
    if (!inProcess) inProcess = new InProcessBackend(configuredDeps);
    return inProcess;
}

/**
 * The ACTIVE backend the IPC layer talks to. Defaults to the in-process backend;
 * Tier 3 swaps in a HostClient at startup via setActiveBackend() when the
 * detached pty-host is available. Everything in ipc.ts / T1 / T2 goes through
 * here, oblivious to which concrete backend is mounted.
 */
let active: PtyBackend | null = null;
export function terminalManager(): PtyBackend {
    if (!active) active = inProcessBackend();
    return active;
}

/**
 * Subscribers that want to follow whichever backend is active (the IPC layer's
 * data/exit fan-out). Re-bound on every backend swap so events always come from
 * the LIVE backend, not a stale one left behind after a fallback.
 */
interface BackendEventHandlers {
    onData: (id: string, data: string) => void;
    onExit: (id: string, payload: { exitCode: number; signal?: number }) => void;
}
let eventHandlers: BackendEventHandlers | null = null;
/** Backends already wired to the fan-out, so a fallback back to a previously
 *  active backend doesn't double-subscribe (which would duplicate every byte). */
const boundBackends = new WeakSet<PtyBackend>();

function bindEvents(backend: PtyBackend): void {
    if (!eventHandlers) return;
    if (boundBackends.has(backend)) return;
    boundBackends.add(backend);
    backend.on('data', eventHandlers.onData);
    backend.on('exit', eventHandlers.onExit);
}

/**
 * Register the data/exit fan-out once. Binds to the current active backend and
 * is automatically re-bound to any backend swapped in via setActiveBackend, so
 * the IPC layer never has to know the backend changed underneath it.
 */
export function subscribeBackendEvents(handlers: BackendEventHandlers): void {
    eventHandlers = handlers;
    bindEvents(terminalManager());
}

/**
 * Swap the active backend (Tier 3 connect/spawn success → HostClient). Idempotent
 * and safe to call before any pty exists. Passing null reverts to the in-process
 * backend — used by the graceful-fallback path when the host dies mid-session.
 * Re-binds the IPC event fan-out to the new backend.
 */
export function setActiveBackend(backend: PtyBackend | null): void {
    const next = backend ?? inProcessBackend();
    if (next === active) return;
    active = next;
    bindEvents(active);
}

export function defaultShell(): string {
    if (process.platform === 'win32') {
        // PowerShell wins for TUI compatibility (ConPTY support + full ANSI).
        // cmd.exe stays as fallback if pwsh isn't present in PATH.
        return process.env.COMSPEC ?? 'cmd.exe';
    }
    return process.env.SHELL ?? '/bin/bash';
}

function defaultShellArgs(shell: string): string[] {
    const base = shell.toLowerCase();
    if (base.endsWith('powershell.exe') || base.endsWith('pwsh.exe')) {
        return ['-NoLogo'];
    }
    return [];
}
