import { isGenieOsTerminalSpec, type TerminalSpec, type WorkspaceRow } from './genie';
import { readWorkspaceView, type ViewStateStore } from './view-state';

/** The `max_views` default when the setting is unset or unusable. */
export const DEFAULT_MAX_VIEWS = 4;

/**
 * Read the `max_views` setting (k/v values are text) into a usable panel cap.
 *
 * ONE parser for every reader — master.tsx's cap state and the launch restore
 * both call it, so the grid can never disable the Add button at a different
 * number than the restore clamped to.
 */
export function parseMaxViews(raw: unknown): number {
    const n = parseInt(String(raw ?? DEFAULT_MAX_VIEWS), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_VIEWS;
}

/**
 * Does this spec occupy a slot in the grid? The cap counts what the user SEES,
 * so it has to count exactly what `master.tsx`'s `selectedSpecs` counts:
 * `workspaceSurfaceSpecs` (the Genie OS terminal is chrome, not a workspace
 * panel) minus `type === 'process'` (the grid memo filters processes out — they
 * ride along in `selected` so their rows stay live in the Processes list).
 */
function isGridPanel(spec: TerminalSpec): boolean {
    return spec.type !== 'process' && !isGenieOsTerminalSpec(spec);
}

/**
 * Rank panels for the cap: MOST-RECENTLY-ACTIVE first.
 *
 * `last_opened_at` is the recency signal, but note it is only written by
 * `terminal-spec:touch`, which nothing in the renderer calls today — so in
 * practice most specs carry `null` and the rank falls through to the workspace's
 * own panel order (`sort_order`, what the grid draws, then id). That fallthrough
 * is the point, not an accident: the cap must pick the SAME panels on every
 * reconnect, and array arrival order is not stable enough to decide it.
 */
function comparePanelRank(a: TerminalSpec, b: TerminalSpec): number {
    if (a.last_opened_at !== b.last_opened_at) {
        if (!a.last_opened_at) return 1;
        if (!b.last_opened_at) return -1;
        // ISO-8601 timestamps sort lexicographically; newest first.
        return a.last_opened_at < b.last_opened_at ? 1 : -1;
    }
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Clamp a restored selection to the `max_views` cap.
 *
 * genie#577: the cap was only ever consulted to DISABLE the Add affordances, so
 * a first connect for a `(connKey, workspace)` pair — every new REMOTE window —
 * opened every enabled host spec and landed on a grid that was already over its
 * own limit (6 panels against a cap of 4, Add greyed out). The cap now applies to
 * the restored set itself, on every path.
 *
 * Two properties the callers depend on:
 *  - non-panel ids (processes, the Genie OS terminal) neither consume a slot nor
 *    get dropped — clamping them out would silently unlist background processes;
 *  - the result keeps the INPUT order. The cap decides WHICH panels survive; it
 *    must not reshuffle the grid into rank order.
 */
export function clampToMaxViews(
    ids: readonly string[],
    specs: readonly TerminalSpec[],
    maxViews: number | undefined,
): string[] {
    if (!Number.isFinite(maxViews) || (maxViews as number) <= 0) return [...ids];
    const byId = new Map(specs.map((s) => [s.id, s]));
    const panels = ids
        .map((id) => byId.get(id))
        .filter((s): s is TerminalSpec => !!s && isGridPanel(s));
    if (panels.length <= (maxViews as number)) return [...ids];
    const keep = new Set(
        [...panels].sort(comparePanelRank).slice(0, maxViews as number).map((s) => s.id),
    );
    return ids.filter((id) => {
        const s = byId.get(id);
        return !s || !isGridPanel(s) || keep.has(id);
    });
}

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
    /**
     * True when there was NO saved view for `(connKey, activeWorkspaceId)` and the
     * selection was seeded from the host's `enabled` flags.
     *
     * genie#579: that fallback is not a neutral default — closing a panel hides it
     * in the client-local store and deliberately never clears the host's `enabled`,
     * so every connect that fails to find an entry resurrects every panel the user
     * ever closed. The caller PERSISTS the seed the moment it sees this flag, so
     * the fallback runs exactly once per `(connKey, workspace)` and every later
     * reconnect reads a real entry.
     */
    seeded: boolean;
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
    /**
     * This window's panel cap (`max_views`). Omitted/0 ⇒ no clamp, so a settings
     * read that failed can never empty the grid. See {@link clampToMaxViews}.
     */
    maxViews?: number;
}): LaunchSelection {
    const {
        specs,
        workspaces,
        savedActiveWorkspace,
        stageSeedWorkspace,
        systemWorkspaceId,
        viewStore = {},
        connKey = 'local',
        maxViews,
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

    if (!target) return { activeWorkspaceId: null, selectedIds: [], seeded: false };

    const inTarget = specs.filter(
        (s) => effectiveWorkspaceId(s, systemWorkspaceId) === target,
    );

    // A saved entry whose `visibleIds` is EMPTY is a recorded preference (the user
    // closed every panel in the workspace), NOT an absent one — `readWorkspaceView`
    // returns null only when there is no entry at all. Honour it, or the fallback
    // below reopens everything the user just closed.
    const saved = readWorkspaceView(viewStore, connKey, target);
    if (saved) {
        // Restore THIS window's saved visible set, dropping any stored id whose
        // spec was since deleted.
        const present = new Set(inTarget.map((s) => s.id));
        const selectedIds = saved.visibleIds.filter((id) => present.has(id));
        return {
            activeWorkspaceId: target,
            // Clamp the saved set too: lowering the cap in Settings has to take
            // effect on the next launch, not just on the Add button.
            selectedIds: clampToMaxViews(selectedIds, inTarget, maxViews),
            seeded: false,
        };
    }

    // First run for (connKey, target): seed from the host's enabled specs.
    const selectedIds = inTarget.filter((s) => s.enabled !== false).map((s) => s.id);
    return {
        activeWorkspaceId: target,
        selectedIds: clampToMaxViews(selectedIds, inTarget, maxViews),
        seeded: true,
    };
}
