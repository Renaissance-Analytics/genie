import {
    selectTerminalBackend,
    activateHostService,
    removeRunKeyAutostart,
    hostBackendKind,
} from '../terminal/host-service';
import { getSnapshotStore } from '../terminal/genie-adapter';
import { getHostClient, initTerminalBackend, isHostBacked } from '@particle-academy/fancy-term-host';

/**
 * The terminal-backend fallback chain (per-user OS service → detached host →
 * in-process), GUI-free. Extracted from background.ts's private wrapper so BOTH
 * the desktop shell and the headless host-core run the SAME selection. The shell
 * injects the Electron/E2E-derived bits (userData path + whether the detached
 * host is even attempted); the terminal functions are imported directly.
 *
 * Returns `{ kind, host, reattachIds, serviceAction?, serviceReason? }` —
 * `setHostBackendKind` is recorded inside `selectTerminalBackend`, so
 * `hostBackendKind()` / `isHostBacked()` reflect the winner afterwards.
 */
export interface BackendSelectionOptions {
    /** Where the host service keeps its socket/pidfile (desktop: userData). */
    userDataDir: string;
    /**
     * Whether the detached/service host is attempted at all (`detached_terminals`
     * ON and not under E2E). The desktop computes this; headless passes its own.
     */
    detachedEnabled: boolean;
}

export async function runBackendSelection(opts: BackendSelectionOptions) {
    // Detached terminals turned OFF → the host shouldn't keep relaunching at
    // logon either. Best-effort, fire-and-forget (win32 Run-key fallback only).
    if (!opts.detachedEnabled) {
        void removeRunKeyAutostart(opts.userDataDir);
    }
    return selectTerminalBackend({
        detachedEnabled: opts.detachedEnabled,
        activateService: () =>
            activateHostService({
                snapshots: getSnapshotStore(),
                userDataDir: opts.userDataDir,
            }),
        initDetached: () => initTerminalBackend(),
        isHostBackedProbe: () => isHostBacked(),
        // genie#774 — ADOPT a host that is already serving rather than spawning a
        // rival that collides on the pipe and takes the fleet down with it. Both
        // halves must agree: the package says a host is backed, AND there is a
        // live client to read the terminals off. Either alone is not evidence of
        // a host this process can actually talk to.
        adoptExisting: () => {
            let backed = false;
            try {
                backed = isHostBacked();
            } catch {
                return null;
            }
            if (!backed) return null;
            const client = getHostClient();
            if (!client) return null;
            let ids: string[] = [];
            try {
                ids = client.liveIds();
            } catch {
                ids = []; // adopting with no id list still beats spawning a rival
            }
            // Whatever kind it was selected as last time ('detached' or
            // 'service') is the truth; never relabel a live host.
            return { kind: hostBackendKind(), ids };
        },
    });
}

export type BackendSelection = Awaited<ReturnType<typeof runBackendSelection>>;
