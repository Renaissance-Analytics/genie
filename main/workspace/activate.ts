import { getAllSettings, observeActiveWorkspace } from '../db';
import { devLifecycle } from '../dev-server/lifecycle';
import type { DevServerLifecycle } from '../dev-server/lifecycle';

/**
 * "THIS is the workspace the user is working in" — the one door (genie#597).
 *
 * The Dev Server's open hook (`lifecycle.onWorkspaceOpen`) is the moment #234 P4
 * warms a workspace's sandbox, #559 takes an adoption pass boot could not, and
 * #573 starts the host-native services boot structurally cannot adopt. All three
 * are correct and all three were wired to `openWorkspace()`, which is reached
 * from the TRAY, the Add Workspace modal and MCP — and from nothing a person
 * does on the ordinary journey.
 *
 * What a person actually does is switch workspace in the master window, which
 * writes `active_workspace` through `settings:set` and stops there, or quit and
 * relaunch, where the launch restore READS that setting and writes nothing at
 * all. Neither told main anything, so for the workspace you were in, the hook
 * never ran: services came back only if some later read happened to repair them.
 *
 * ## Why the seam is the WRITE, not a new IPC
 *
 * A dedicated `workspaces:activate` IPC would have fixed the master window and
 * left the same shape of bug behind — a THIRD door that every future caller has
 * to remember. `setSettings` is the one place `active_workspace` can change at
 * all, and it already sees the old value, so a change there is the fact itself
 * rather than a report of it. Both of today's writers are covered without either
 * of them knowing — the `settings:set` IPC behind the master window's switch,
 * and `openWorkspace()` — and so is whatever writes it next. It stays a LOCAL
 * fact either way: `active_workspace` is not in `HOST_SOURCED_SETTINGS_KEYS`, so
 * even a remote-driven window's switch writes here, on the machine whose
 * services this starts, and never on a host.
 *
 * The launch restore is the one case a write hook cannot cover, because there is
 * no write: the value it lands on is the one already persisted.
 * {@link activateRestoredWorkspace} takes it once at boot, from main, so it is
 * not per-master-window work.
 *
 * ## What this must never do
 *
 * - **Fail the switch.** Switching workspace, and restoring the launch layout,
 *   must survive a service that cannot start, a daemon that hangs, a hook that
 *   throws synchronously. Every path here is fire-and-forget and swallowing.
 * - **Widen the gate.** This changes WHICH opens count, never whether an
 *   UNOPENED workspace starts anything. `onWorkspaceOpen` still returns
 *   `not-used-here` for a workspace with no dev sites or services, and boot
 *   still activates exactly one workspace: the one the user left active.
 * - **Acquire twice.** `acquireHostNative` and the sandbox ensure are both
 *   idempotent for SEQUENTIAL calls (`live.has`, and the sandbox by design), so
 *   what is added here is the guard those cannot supply: two passes for the same
 *   workspace IN FLIGHT AT ONCE. That is newly possible — `openWorkspace` writes
 *   the setting and then activates, so its own write would otherwise race its
 *   own call. Coalescing is per-workspace and lasts only as long as the pass, so
 *   a tray open of the workspace you are already in still warms its sandbox.
 */

export interface WorkspaceActivationDeps {
    /** Read lazily: the lifecycle is created during boot, and a headless or test
     *  process may never create one at all. */
    lifecycle: () => DevServerLifecycle | null;
}

export interface WorkspaceActivation {
    /** A workspace became the active one. Never throws, never blocks. */
    activated(workspaceId: string | null | undefined): void;
    /** Resolves when every pass started so far has settled. Tests only — nothing
     *  in the app waits for this, which is the point. */
    idle(): Promise<void>;
}

export function createWorkspaceActivation(
    deps: WorkspaceActivationDeps,
): WorkspaceActivation {
    /** Passes running right now, by workspace id. */
    const inFlight = new Map<string, Promise<void>>();

    return {
        activated(workspaceId) {
            if (typeof workspaceId !== 'string' || workspaceId === '') return;
            if (inFlight.has(workspaceId)) return;
            const lifecycle = deps.lifecycle();
            if (!lifecycle) return;

            let pass: Promise<unknown>;
            try {
                pass = lifecycle.onWorkspaceOpen(workspaceId);
            } catch {
                // A hook that throws before its first await would otherwise
                // reach the caller synchronously — i.e. break the switch.
                return;
            }
            inFlight.set(
                workspaceId,
                pass.then(
                    () => {
                        inFlight.delete(workspaceId);
                    },
                    () => {
                        // The lifecycle already reports failure as a result;
                        // there is nothing for a workspace switch to do with it.
                        inFlight.delete(workspaceId);
                    },
                ),
            );
        },

        async idle() {
            while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
        },
    };
}

// --- the process-wide door ---------------------------------------------------

const activation = createWorkspaceActivation({ lifecycle: devLifecycle });

/** A workspace became the one the user is working in. */
export function workspaceActivated(workspaceId: string | null | undefined): void {
    activation.activated(workspaceId);
}

/**
 * Run the open hook whenever `active_workspace` CHANGES, wherever it is written
 * from. Installed once, at boot.
 */
export function watchActiveWorkspace(): void {
    observeActiveWorkspace(workspaceActivated);
}

/**
 * The launch restore (genie#597): the workspace the user LEFT active is the one
 * they land in, and landing there writes nothing — so there is no change for
 * {@link watchActiveWorkspace} to see. Taken once per process at boot, from
 * main, rather than once per master window.
 *
 * This does not widen the gate: `active_workspace` is only ever set by a
 * workspace being opened or switched to, so the workspace it names is one
 * somebody opened. Nothing is persisted here — the value is already the truth.
 */
export function activateRestoredWorkspace(): void {
    workspaceActivated(getAllSettings().active_workspace ?? null);
}

/** Test-only: resolves when the process-wide door's passes have settled. */
export function workspaceActivationIdleForTests(): Promise<void> {
    return activation.idle();
}
