import { BrowserWindow, ipcMain, WebContents } from 'electron';
import { terminalManager, CreateTerminalOpts, TerminalInfo } from './manager';
import { detectShells, defaultShellId, resolveDefaultShell } from './shells';
import { writeSnapshot } from './sessions';
import { updateTerminalSpec } from '../db';

/**
 * IPC layer for the terminal subsystem. The manager owns ptys + emits
 * `data`/`exit` events; this layer fans those events out to whichever
 * webContents own each terminal id, and routes renderer-side write /
 * resize / kill calls back to the manager.
 *
 * Multi-attach is supported: a single pty can be displayed in more
 * than one window at the same time (TheFloor + a Stage, for example).
 * Owners are tracked as a Set per terminal id. The pty is killed only
 * when the LAST owner detaches.
 *
 * Channels (renderer → main):
 *   terminal:create  (opts: CreateTerminalOpts)
 *                   → { id, pid, shell, existing, scrollback }
 *   terminal:write   (id, data: string)         → boolean
 *   terminal:resize  (id, cols, rows)           → boolean
 *   terminal:detach  (id)                       → boolean   ← per-window
 *   terminal:kill    (id)                       → boolean   ← global
 *   terminal:list    ()                         → TerminalInfo[]
 *
 * Push (main → renderer):
 *   terminal:data    {id, data}
 *   terminal:exit    {id, exitCode, signal}
 */

interface OwnerEntry {
    /** Per-spec set of webContents currently rendering this terminal. */
    owners: Set<WebContents>;
    /** Cleanup hook bound to each owner via webContents.once('destroyed'). */
    cleanup: WeakMap<WebContents, () => void>;
}

export function registerTerminalIpc(): void {
    const mgr = terminalManager();
    const ownersByTerminal = new Map<string, OwnerEntry>();

    const trackOwner = (id: string, sender: WebContents) => {
        let entry = ownersByTerminal.get(id);
        if (!entry) {
            entry = { owners: new Set(), cleanup: new WeakMap() };
            ownersByTerminal.set(id, entry);
        }
        if (entry.owners.has(sender)) return;
        entry.owners.add(sender);
        const handler = () => detachOwner(id, sender);
        entry.cleanup.set(sender, handler);
        sender.once('destroyed', handler);
    };

    const detachOwner = (id: string, sender: WebContents) => {
        const entry = ownersByTerminal.get(id);
        if (!entry) return;
        if (!entry.owners.delete(sender)) return;
        const handler = entry.cleanup.get(sender);
        if (handler) {
            try {
                sender.off('destroyed', handler);
            } catch {
                /* sender already gone */
            }
            entry.cleanup.delete(sender);
        }
        if (entry.owners.size === 0) {
            ownersByTerminal.delete(id);
            mgr.kill(id);
        }
    };

    ipcMain.handle(
        'terminal:create',
        (
            event,
            opts: CreateTerminalOpts,
        ): TerminalInfo & {
            existing: boolean;
            scrollback: string;
            snapshot?: { serialized: string; savedAt: number };
        } => {
            // No explicit shell on the spec → the user's configured default
            // (Settings → Terminal), which itself falls back to detection
            // (Git Bash first on Windows). Resolution lives in shells.ts so
            // the manager stays a pure pty pool. An EMPTY args array counts
            // as "no explicit args" — terminal_specs rows default to '[]',
            // and that must not strip the shell's own defaults (git-bash
            // needs --login -i for a profile-loaded interactive session).
            if (!opts.shell) {
                const resolved = resolveDefaultShell();
                opts = {
                    ...opts,
                    shell: resolved.command,
                    args: opts.args?.length ? opts.args : resolved.args,
                };
            }
            const result = mgr.create(opts);
            trackOwner(opts.id, event.sender);
            return result;
        },
    );

    ipcMain.handle('terminal:shells', () => {
        const shells = detectShells();
        return { shells, defaultId: defaultShellId(shells) };
    });

    ipcMain.handle('terminal:write', (_event, id: string, data: string): boolean => {
        return mgr.write(id, data);
    });

    ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number): boolean => {
        return mgr.resize(id, cols, rows);
    });

    ipcMain.handle('terminal:detach', (event, id: string): boolean => {
        // Soft release: this window no longer renders the pty. Other
        // windows can keep it alive. The pty is killed only when the last
        // owner detaches.
        detachOwner(id, event.sender);
        return true;
    });

    ipcMain.handle('terminal:kill', (_event, id: string): boolean => {
        ownersByTerminal.delete(id);
        return mgr.kill(id);
    });

    ipcMain.handle('terminal:list', (): TerminalInfo[] => {
        return mgr.list();
    });

    // Tier 1 capture: the renderer sends a SerializeAddon reconstruction of a
    // terminal's buffer. Persist it (encrypted gz on disk) and record the
    // pointer metadata on the spec row so the next launch knows a snapshot
    // exists. Best-effort — a failed write must not reject the renderer.
    ipcMain.handle(
        'terminal:snapshot',
        (_event, id: string, serialized: string): boolean => {
            try {
                const bytes = writeSnapshot(id, serialized);
                if (bytes == null) return false;
                try {
                    updateTerminalSpec(id, {
                        snapshot_at: Date.now(),
                        snapshot_bytes: bytes,
                    });
                } catch {
                    /* spec may be unsaved/scratch — the file is still written */
                }
                return true;
            } catch {
                return false;
            }
        },
    );

    mgr.on('data', (id: string, data: string) => {
        const entry = ownersByTerminal.get(id);
        if (!entry) return;
        for (const target of entry.owners) {
            if (target.isDestroyed()) continue;
            target.send('terminal:data', { id, data });
        }
    });

    mgr.on(
        'exit',
        (id: string, payload: { exitCode: number; signal?: number }) => {
            const entry = ownersByTerminal.get(id);
            ownersByTerminal.delete(id);
            if (!entry) return;
            for (const target of entry.owners) {
                if (target.isDestroyed()) continue;
                target.send('terminal:exit', { id, ...payload });
            }
        },
    );
}

/** Tear down every pty on app quit so dangling shell processes don't survive. */
export function stopAllTerminals(): void {
    terminalManager().killAll();
}

/**
 * Two-phase quit support (Tier 1). Broadcast a snapshot-request to every
 * window so each live terminal serializes its current buffer and sends a final
 * `terminal:snapshot` before its pty is killed. Returns immediately — the
 * caller waits a bounded window (so quit can never hang) and THEN calls
 * stopAllTerminals(). If no windows are open, there's nothing to snapshot.
 */
export function requestFinalSnapshots(): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
            w.webContents.send('terminal:snapshot-request');
        } catch {
            /* window tearing down — skip */
        }
    }
}

/** Forward the broadcast helper for callers that want it. */
export function broadcastTerminalCount(): void {
    const count = terminalManager().list().length;
    for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('terminal:count', { count });
    }
}
