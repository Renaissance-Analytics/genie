import {
    selectTerminalBackend,
    setHostBackendKind,
    activateHostService,
    logHostService,
    type BackendSelection as TerminalBackendSelection,
} from '../terminal/host-service';
import { getSnapshotStore } from '../terminal/genie-adapter';
import { initTerminalBackend, isHostBacked } from '@particle-academy/fancy-term-host';

/**
 * The terminal-backend fallback ladder (per-user OS service → detached host →
 * in-process), GUI-free. Extracted from background.ts's private wrapper so BOTH
 * the desktop shell and the headless host-core run the SAME selection. The shell
 * injects the Electron-derived bits (userData path); the terminal functions are
 * imported directly.
 *
 * genie #63 Phase 1 — THE HOST IS ALWAYS ON. This used to take a
 * `detachedEnabled` flag computed from the `detached_terminals` Settings opt-in,
 * and `inprocess` was the default whenever it was off. Both are gone: the local
 * Host starts on every launch, no setting, and `inprocess` is only the floor
 * beneath a genuine host-start failure (see `selectTerminalBackend`).
 *
 * Returns `{ kind, host, reattachIds, serviceAction?, serviceReason?,
 * inprocessReason? }` — `setHostBackendKind` is recorded inside
 * `selectTerminalBackend`, so `hostBackendKind()` / `isHostBacked()` reflect the
 * winner afterwards.
 *
 * CROSS-REPO NOTE: genie-cloud consumes this through `host-core` and today calls
 * it with `{ userDataDir, detachedEnabled: false }` — i.e. the headless cloud
 * Host deliberately ran its terminals IN-PROCESS. That key no longer exists, so
 * once genie-cloud picks up a bundle containing this change it will start
 * bringing a real Host up. That is the intended direction (north-star rule 5:
 * genie-cloud IS this Host), but it is a boot-path change over there and must be
 * verified in genie-cloud, not assumed.
 */
export interface BackendSelectionOptions {
    /** Where the host service keeps its socket/pidfile (desktop: userData). */
    userDataDir: string;
    /**
     * TEST-HARNESS ESCAPE HATCH — skip the Host entirely and run in-process.
     *
     * NOT a user setting and NOT reachable from the UI: the only caller is the
     * E2E boot path. The `--no-pack` test build ships no standalone Node runtime
     * (so the service can never activate) and a detached, unref'd host child
     * would by design outlive the test run; the E2E specs don't exercise
     * terminals, so in-process keeps their boot deterministic. Taking it is
     * LOGGED — running without a Host is a degraded mode, never a normal one.
     */
    forceInProcess?: boolean;
}

export async function runBackendSelection(
    opts: BackendSelectionOptions,
): Promise<TerminalBackendSelection> {
    if (opts.forceInProcess) {
        const reason =
            'forceInProcess — E2E harness only; the --no-pack test build ships no ' +
            'standalone runtime and must not leave a detached host behind';
        setHostBackendKind('inprocess');
        logHostService(`Host NOT started — ${reason}`);
        return { kind: 'inprocess', host: false, reattachIds: [], inprocessReason: reason };
    }
    return selectTerminalBackend({
        activateService: () =>
            activateHostService({
                snapshots: getSnapshotStore(),
                userDataDir: opts.userDataDir,
            }),
        initDetached: () => initTerminalBackend(),
        isHostBackedProbe: () => isHostBacked(),
    });
}

export type BackendSelection = Awaited<ReturnType<typeof runBackendSelection>>;
