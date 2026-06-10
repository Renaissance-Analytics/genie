import { spawn, IPty } from 'node-pty';
import os from 'node:os';
import { EventEmitter } from 'node:events';

/**
 * Centralised PTY manager. Owns every spawned pty, routes I/O to/from
 * the renderer via the events on this emitter, and cleans up on close.
 *
 * Why an emitter, not direct IPC: the manager doesn't know which
 * BrowserWindow is hosting a terminal — that's the IPC layer's job. The
 * manager just emits `data:<id>` and `exit:<id>` and lets ipc.ts wire
 * them to the right webContents.
 */

export interface CreateTerminalOpts {
    /** Stable id chosen by the renderer (ulid). The manager uses it as the key. */
    id: string;
    /** Working directory for the spawned shell. */
    cwd: string;
    /** Shell executable. Defaults to the user's preferred login shell per platform. */
    shell?: string;
    /** Extra args for the shell. */
    args?: string[];
    /** Initial cols × rows. Renderer should send a `resize` immediately after mount. */
    cols?: number;
    rows?: number;
    /** Extra env overrides. Merged on top of process.env. */
    env?: Record<string, string>;
}

export interface TerminalInfo {
    id: string;
    pid: number;
    shell: string;
}

interface AttachResult extends TerminalInfo {
    /** True when an existing pty was returned (caller is "joining"). */
    existing: boolean;
    /** Bounded scrollback so a late-joining window can replay history. */
    scrollback: string;
}

/** ~1 MB per pty. Enough for an hour of typical dev output without runaway memory. */
const SCROLLBACK_MAX = 1_000_000;

class TerminalManager extends EventEmitter {
    private readonly ptys = new Map<string, IPty>();
    private readonly scrollback = new Map<string, string>();
    private readonly shells = new Map<string, string>();

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
        const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
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
            this.emit('data', opts.id, data);
        });
        pty.onExit(({ exitCode, signal }) => {
            this.ptys.delete(opts.id);
            this.scrollback.delete(opts.id);
            this.shells.delete(opts.id);
            this.emit('exit', opts.id, { exitCode, signal });
        });

        return {
            id: opts.id,
            pid: pty.pid,
            shell,
            existing: false,
            scrollback: '',
        };
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
        this.ptys.delete(id);
        this.scrollback.delete(id);
        this.shells.delete(id);
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
}

/**
 * Singleton instance. Created lazily so importing this module from a test
 * context doesn't attempt to load node-pty before vi.mock has had a chance
 * to substitute it.
 */
let instance: TerminalManager | null = null;
export function terminalManager(): TerminalManager {
    if (!instance) instance = new TerminalManager();
    return instance;
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
