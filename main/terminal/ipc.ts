import { BrowserWindow, ipcMain, WebContents } from 'electron';
import {
    terminalManager,
    subscribeBackendEvents,
    detectShells,
    defaultShellId,
    resolveDefaultShell,
    type CreateTerminalOpts,
    type TerminalInfo,
} from '@particle-academy/fancy-term-host';
import { getAllSettings, updateTerminalSpec } from '../db';
import { buildWishCliEnv } from '../cli/wish-cli';
import { getSnapshotStore, dbSettingsProvider } from './genie-adapter';

/**
 * Tier 2 resource cap. The number of terminals that may be RETAINED (kept
 * running with zero attached windows) at once. Disabling a terminal past this
 * cap is blocked with a clear message rather than silently evicting a live
 * session — losing a dev server you forgot about is worse than a "cap reached"
 * toast. Tune here; the renderer surfaces the limit in its hint.
 */
export const MAX_RETAINED = 8;

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

/**
 * Owner registry, module-scoped so the quit-time helper
 * (snapshotRetainedWindowless) can tell which retained ptys currently have no
 * attached window. registerTerminalIpc is called exactly once at app-ready.
 */
const ownersByTerminal = new Map<string, OwnerEntry>();

export function registerTerminalIpc(): void {
    // Always resolve the LIVE active backend per-call. Tier 3 can swap the
    // backend (in-process ↔ host client) under us; capturing it once would
    // leave handlers pointed at a stale backend after a fallback.
    const mgr = () => terminalManager();

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
            // Tier 2: a RETAINED terminal (disabled-not-deleted) keeps its pty
            // alive with zero owners. The manager still lists it and holds its
            // scrollback, so re-enabling reattaches via the create() rejoin path
            // and replays history — the LIVE session, not a snapshot replay.
            // A non-retained terminal is killed as before.
            if (!mgr().isRetained(id)) {
                mgr().kill(id);
            }
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
                const resolved = resolveDefaultShell(dbSettingsProvider());
                opts = {
                    ...opts,
                    shell: resolved.command,
                    args: opts.args?.length ? opts.args : resolved.args,
                };
            }
            // Make the bundled wish-cli (resetme/reload/…) available + inject
            // GENIE_* workspace context. Additive + behind a setting (default
            // on); user-supplied opts.env wins on any key collision.
            const cliEnabled =
                getAllSettings().cli_tools_in_terminals !== 'off';
            const cliEnv = buildWishCliEnv(opts.cwd, cliEnabled);
            if (Object.keys(cliEnv).length) {
                opts = { ...opts, env: { ...cliEnv, ...opts.env } };
            }
            const result = mgr().create(opts);
            trackOwner(opts.id, event.sender);
            return result;
        },
    );

    ipcMain.handle('terminal:shells', () => {
        const shells = detectShells();
        return { shells, defaultId: defaultShellId(shells) };
    });

    ipcMain.handle('terminal:write', (_event, id: string, data: string): boolean => {
        return mgr().write(id, data);
    });

    ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number): boolean => {
        return mgr().resize(id, cols, rows);
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
        // kill() also clears the retained flag in the manager.
        const killed = mgr().kill(id);
        // Delete (not just disable): drop the Tier 1 snapshot too so a deleted
        // terminal can never resurrect on the next launch. Best-effort.
        getSnapshotStore().deleteSnapshot(id);
        broadcastTerminalCount();
        return killed;
    });

    /**
     * Tier 2: mark a terminal as retained (kept alive on zero owners) or not.
     * CRITICAL ordering: the renderer MUST set retained=true BEFORE the last
     * window detaches (before unmounting the XTerm), otherwise the detach kills
     * the pty first. The disable flow awaits this call, then unmounts.
     *
     * Enforces the MAX_RETAINED cap on the way IN (retained=true): if retaining
     * this id would exceed the cap it is REFUSED — the disable is blocked and
     * the renderer keeps the panel visible with a "cap reached" toast. Clearing
     * retention (retained=false) is always allowed.
     *
     * Returns { ok, retainedCount, max, reason? } so the renderer can both gate
     * and surface the count.
     */
    ipcMain.handle(
        'terminal:set-retained',
        (
            _event,
            id: string,
            retained: boolean,
        ): { ok: boolean; retainedCount: number; max: number; reason?: string } => {
            if (retained) {
                // Already retained → idempotent success.
                if (!mgr().isRetained(id) && mgr().retainedCount() >= MAX_RETAINED) {
                    return {
                        ok: false,
                        retainedCount: mgr().retainedCount(),
                        max: MAX_RETAINED,
                        reason: `Retained-terminal limit reached (${MAX_RETAINED}). Re-enable or delete a suspended terminal first.`,
                    };
                }
                mgr().setRetained(id, true);
            } else {
                mgr().setRetained(id, false);
            }
            broadcastTerminalCount();
            return {
                ok: true,
                retainedCount: mgr().retainedCount(),
                max: MAX_RETAINED,
            };
        },
    );

    ipcMain.handle('terminal:list', (): TerminalInfo[] => {
        return mgr().list();
    });

    // Tier 1 capture: the renderer sends a SerializeAddon reconstruction of a
    // terminal's buffer. Persist it (encrypted gz on disk) and record the
    // pointer metadata on the spec row so the next launch knows a snapshot
    // exists. Best-effort — a failed write must not reject the renderer.
    ipcMain.handle(
        'terminal:snapshot',
        (_event, id: string, serialized: string): boolean => {
            try {
                const bytes = getSnapshotStore().writeSnapshot(id, serialized);
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

    // Fan-out pty output/exit to the owning windows. Routed through
    // subscribeBackendEvents so the binding FOLLOWS the active backend across a
    // Tier 3 swap (in-process ↔ host client) — a captured `mgr.on` would keep
    // firing from a stale backend after a fallback.
    subscribeBackendEvents({
        onData: (id: string, data: string) => {
            const entry = ownersByTerminal.get(id);
            if (!entry) return;
            for (const target of entry.owners) {
                if (target.isDestroyed()) continue;
                target.send('terminal:data', { id, data });
            }
        },
        onExit: (id: string, payload: { exitCode: number; signal?: number }) => {
            const entry = ownersByTerminal.get(id);
            ownersByTerminal.delete(id);
            if (!entry) return;
            for (const target of entry.owners) {
                if (target.isDestroyed()) continue;
                target.send('terminal:exit', { id, ...payload });
            }
        },
    });
}

/** Tear down every pty on app quit so dangling shell processes don't survive. */
export function stopAllTerminals(): void {
    terminalManager().killAll();
}

/**
 * True when terminal `id` currently has at least one attached window (its
 * SerializeAddon can produce a snapshot via the before-quit broadcast).
 * Exposed so the update-path host snapshot (genie-adapter
 * snapshotHostTerminalsForUpdate) can skip windowed terminals without this
 * module's owner registry leaking out.
 */
export function terminalHasWindow(id: string): boolean {
    const entry = ownersByTerminal.get(id);
    return !!entry && entry.owners.size > 0;
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

/**
 * Tier 2 → Tier 1 degrade. On a real app quit, retained ptys still die via
 * stopAllTerminals (the detached pty-host is a later tier, T3). To make
 * reopening replay correctly we capture a Tier 1 snapshot for every retained
 * pty that has NO attached window — those windows are gone, so the renderer's
 * SerializeAddon can't snapshot them. We serialize the manager's raw scrollback
 * buffer instead; T1's restore path resets the screen (\x1bc) before the fresh
 * shell, so raw history-above-divider is exactly the intended shape.
 *
 * Retained terminals that DO still have a window are covered by the normal
 * requestFinalSnapshots broadcast (their SerializeAddon produces a cleaner
 * reconstruction), so we skip those here to avoid clobbering with raw bytes.
 *
 * Called from before-quit alongside requestFinalSnapshots. Best-effort and
 * synchronous so it completes inside the bounded quit window.
 */
export function snapshotRetainedWindowless(): void {
    const mgr = terminalManager();
    for (const id of mgr.retainedIds()) {
        const entry = ownersByTerminal.get(id);
        const hasWindow = !!entry && entry.owners.size > 0;
        if (hasWindow) continue; // covered by the renderer snapshot broadcast
        const scrollback = mgr.getScrollback(id);
        if (!scrollback) continue;
        try {
            const bytes = getSnapshotStore().writeSnapshot(id, scrollback);
            if (bytes == null) continue;
            try {
                updateTerminalSpec(id, {
                    snapshot_at: Date.now(),
                    snapshot_bytes: bytes,
                });
            } catch {
                /* spec gone / db not ready — file is still written */
            }
        } catch {
            /* best-effort */
        }
    }
}
