import type { TerminalSpec, WorkspaceRow } from './genie';
import { readWorkspaceView, type ViewStateStore } from './view-state';

/**
 * The EFFECTIVE workspace id a spec belongs to. Mirrors master.tsx's
 * `specWorkspaceId`: System Workspace specs persist UNATTACHED (`workspace_id:
 * null` + `meta.system`, because the synthetic `__system__` workspace has no DB
 * row to FK against), so map those onto the System Workspace id; every other
 * spec uses its stored `workspace_id`.
 */
export function effectiveWorkspaceId(
    s: Pick<TerminalSpec, 'workspace_id' | 'meta'>,
    systemWorkspaceId: string,
): string | null {
    if (s.workspace_id === null && s.meta?.system === true) return systemWorkspaceId;
    return s.workspace_id;
}

export interface LaunchSelection {
    /** Workspace that fills the grid on launch (null when there's nothing to show). */
    activeWorkspaceId: string | null;
    /** Spec ids restored as panels — the active workspace's enabled (live) specs. */
    selectedIds: string[];
}

/**
 * Resolve which workspace fills the grid on launch + which of its specs are
 * restored as live panels.
 *
 * This is the launch-restore brain, factored out of the master.tsx mount effect
 * so it's PURE and unit-testable — and, crucially, so the caller can feed it the
 * FRESHLY-FETCHED spec/workspace arrays directly instead of reading them back
 * through a React-effect closure. The old effect fired on `[workspaces.length]`
 * but read `specs` via closure and latched a one-shot `seededActiveRef`; if it
 * ever ran in a render where the target's specs weren't yet in `specs`, it
 * seeded an EMPTY selection and the latch meant it never retried — the grid then
 * came up empty for the whole session even though the specs were present. Seeding
 * from the fetched arrays removes that timing/closure fragility entirely.
 *
 * Target precedence:
 *   1. an explicit Stage workspace (`?stage=`), when it still exists;
 *   2. the persisted `active_workspace` setting, when it still exists;
 *   3. the most-recent workspace (the caller passes `workspaces` pre-sorted).
 *
 * Selection precedence for the target workspace:
 *   1. THIS window's CLIENT-LOCAL saved view (`viewStore`, keyed by
 *      `connKey|workspaceId`) when present — so a panel the user HID in this
 *      window stays hidden across a relaunch, and a host window's layout is its
 *      own rather than dictated by the host's `enabled` flags. Stored ids whose
 *      spec no longer exists are dropped.
 *   2. FIRST RUN for that `(connKey, workspace)` — no saved view — falls back to
 *      the workspace's ENABLED specs (today's behaviour), so nothing that was
 *      visible disappears on upgrade. A suspended (disabled) terminal stays out
 *      of the grid until explicitly re-enabled.
 *
 * Process specs are included here exactly as the original seed did — they're
 * harmless in `selected` because the grid memo filters `type === 'process'` out
 * on its own.
 */
export function computeLaunchSelection(args: {
    specs: TerminalSpec[];
    workspaces: WorkspaceRow[];
    savedActiveWorkspace: string | null;
    stageSeedWorkspace: string | null;
    systemWorkspaceId: string;
    /** This window's client-local view store (parsed `view_state_json`). */
    viewStore?: ViewStateStore;
    /** This window's connection key (`'local'` or a host key). */
    connKey?: string;
}): LaunchSelection {
    const {
        specs,
        workspaces,
        savedActiveWorkspace,
        stageSeedWorkspace,
        systemWorkspaceId,
        viewStore = {},
        connKey = 'local',
    } = args;

    let target: string | null = null;
    if (stageSeedWorkspace && workspaces.some((w) => w.id === stageSeedWorkspace)) {
        target = stageSeedWorkspace;
    } else if (
        savedActiveWorkspace &&
        workspaces.some((w) => w.id === savedActiveWorkspace)
    ) {
        target = savedActiveWorkspace;
    } else {
        target = workspaces[0]?.id ?? null;
    }

    if (!target) return { activeWorkspaceId: null, selectedIds: [] };

    const inTarget = specs.filter(
        (s) => effectiveWorkspaceId(s, systemWorkspaceId) === target,
    );

    const saved = readWorkspaceView(viewStore, connKey, target);
    if (saved) {
        // Restore THIS window's saved visible set, dropping any stored id whose
        // spec was since deleted.
        const present = new Set(inTarget.map((s) => s.id));
        const selectedIds = saved.visibleIds.filter((id) => present.has(id));
        return { activeWorkspaceId: target, selectedIds };
    }

    // First run for (connKey, target): seed from the host's enabled specs.
    const selectedIds = inTarget.filter((s) => s.enabled !== false).map((s) => s.id);
    return { activeWorkspaceId: target, selectedIds };
}
