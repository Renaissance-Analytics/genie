import { SYSTEM_WORKSPACE_ID, type TerminalSpec, type ViewMeta, type WorkspaceRow } from './genie';

/**
 * The renderer half of the `openFileForUser` MCP tool: reuse-vs-new arbitration,
 * the handler that acts on it, and a tiny "open this file in THIS panel" bus.
 * The MCP handler (main) resolves the workspace + path and pushes
 * `editor:open-file`; master.tsx hands the request straight to
 * `openFileInEditor`, which picks an already-open CodePanel to REUSE
 * (`pickReusePanel`) or creates a fresh seeded spec, and then either signals the
 * live panel via `emitOpenInPanel` or seeds a hidden one's meta and surfaces it.
 * Everything but the effects themselves lives here so it is unit-testable — the
 * renderer has no jsdom, so nothing inside a React component can be.
 */

/** A code panel's effective workspace id (system specs → `__system__`). */
function panelWorkspaceId(s: TerminalSpec): string | null {
    if (s.workspace_id) return s.workspace_id;
    if ((s.meta as { system?: boolean } | undefined)?.system) return SYSTEM_WORKSPACE_ID;
    return null;
}

/**
 * A code panel's effective ROOT directory — the folder its tabs are relative to.
 * A workspace-attached panel roots at the workspace path; a System / unattached
 * panel roots at its own `cwd` (which is exactly how `PanelFor` chooses the
 * CodePanel's `workspace` prop: attached → the row, else undefined → spec.cwd).
 */
function panelRoot(s: TerminalSpec, workspacesById: Map<string, WorkspaceRow>): string {
    if (s.workspace_id) return workspacesById.get(s.workspace_id)?.path ?? s.cwd;
    return s.cwd;
}

/** The editor panel an open-file request should land in. */
export interface ReusePanel {
    /** The `type:'code'` spec to open the file into. */
    id: string;
    /**
     * Whether that panel is currently SELECTED — i.e. mounted, with a live
     * `onOpenInPanel` listener. A mounted panel is signalled with
     * `emitOpenInPanel`; a HIDDEN one has no listener, so the caller seeds the
     * tab into its spec meta (`seedMetaForReuse`) and selects it — mounting is
     * what opens the file.
     */
    mounted: boolean;
}

/**
 * Choose which editor panel to reuse for an open-file request, or null when a
 * new one must be created. A candidate is a `type:'code'` spec that resolves to
 * `workspaceId` and is rooted at `root` (so its relative tabs address the same
 * tree) — that pair is the hard rule: a panel rooted elsewhere would resolve the
 * tab against the wrong directory. Pure → unit-testable.
 *
 * Preference: a MOUNTED panel (focused one first, else the first match), then
 * any HIDDEN match. The hidden fallback is the fix for editor panels piling up:
 * `selected` is THIS window's mounted set, and the launch restore only seeds it
 * for the workspace the app came up in, so an agent opening a file anywhere else
 * found "nothing to reuse" and created `<ws>-files-2`, `-3`, … one per app
 * session — even though that workspace's editor was in its saved visible set.
 * A user who simply closed the panel hit the same path. Only a workspace with no
 * matching panel AT ALL gets a new one.
 */
export function pickReusePanel(
    specs: TerminalSpec[],
    target: { workspaceId: string; root: string },
    focusId: string | null,
    selected: ReadonlySet<string>,
    workspacesById: Map<string, WorkspaceRow>,
): ReusePanel | null {
    const candidates = specs.filter(
        (s) =>
            s.type === 'code' &&
            panelWorkspaceId(s) === target.workspaceId &&
            panelRoot(s, workspacesById) === target.root,
    );
    if (candidates.length === 0) return null;
    const mounted = candidates.filter((s) => selected.has(s.id));
    if (mounted.length > 0) {
        const focused = mounted.find((s) => s.id === focusId);
        return { id: (focused ?? mounted[0]).id, mounted: true };
    }
    return { id: candidates[0].id, mounted: false };
}

/**
 * The spec meta a HIDDEN panel needs so that MOUNTING it opens `relPath`: the
 * file joins the panel's persisted tabs and becomes the active one. CodePanel
 * seeds its tabs from `meta` exactly once, on mount, which is why reopening a
 * hidden panel goes through meta instead of the `emitOpenInPanel` bus (nothing
 * is subscribed until it mounts). Returns the FULL next meta — `terminalSpec
 * .update` replaces meta wholesale — so every other panel setting is carried
 * over untouched. `reveal_line` is transient and file-agnostic: it is set only
 * for a request that names a line, and CLEARED otherwise so a stale line can't
 * scroll the new file to it. Pure → unit-testable.
 */
export function seedMetaForReuse(
    meta: ViewMeta | undefined,
    relPath: string,
    line?: number,
): ViewMeta {
    const open = meta?.open_files?.length
        ? meta.open_files
        : meta?.file_path
          ? [meta.file_path]
          : [];
    return {
        ...meta,
        open_files: open.includes(relPath) ? open : [...open, relPath],
        active_file: relPath,
        file_path: relPath,
        reveal_line: typeof line === 'number' ? line : undefined,
    };
}

/**
 * The next `maximizedId` when `panelId` is being surfaced. A maximized grid
 * shows ONE panel, so opening a file while a DIFFERENT panel is maximized would
 * hide it behind that panel — the file is "open" and invisible. Maximize the
 * opened panel instead, keeping the user's maximized mode. Nothing maximized →
 * unchanged (the normal grid already shows every selected panel). Pure.
 */
export function surfaceMaximized(maximizedId: string | null, panelId: string): string | null {
    return maximizedId === null ? null : panelId;
}

/**
 * How a NEW editor panel for an open-file request must be created: the spec's
 * `workspace_id` + whether it is a System panel.
 *
 * A panel may only be ATTACHED to a workspace when it roots exactly at that
 * workspace's own path. An attached panel resolves its tabs against the
 * WORKSPACE root (`CodePanel`: `workspace?.path ?? spec.cwd` — the row WINS over
 * the spec's cwd), so attaching a panel rooted anywhere else silently re-reads
 * `<file dir>/<tab>` as `<workspace>/<tab>`: that is exactly how a request for
 * `.ai/plans/x.md` surfaced as `ENOENT … <workspace>/x.md`. Anything else opens
 * as a System panel (unattached + `meta.system`), which roots at its OWN cwd and
 * reads full-FS. Pure → unit-testable.
 */
export function newPanelAttachment(
    target: { workspaceId: string; root: string },
    workspacePath: string | null | undefined,
): { workspaceId: string | null; system: boolean } {
    if (target.workspaceId !== SYSTEM_WORKSPACE_ID && workspacePath === target.root) {
        return { workspaceId: target.workspaceId, system: false };
    }
    return { workspaceId: null, system: true };
}

/**
 * The label for a NEW editor panel in `panelWorkspaceId`: `<base>-files`, then
 * `-2`, `-3`, … Numbering skips names already taken rather than counting the
 * panels — a count hands out a name twice as soon as one of them is deleted
 * (`-files` + `-files-3` counted 2, so the next panel was ANOTHER `-files-3`).
 * Pure → unit-testable.
 */
export function newPanelLabel(
    specs: TerminalSpec[],
    targetWorkspaceId: string,
    base: string,
): string {
    const taken = new Set(
        specs
            .filter((s) => s.type === 'code' && panelWorkspaceId(s) === targetWorkspaceId)
            .map((s) => s.label),
    );
    if (!taken.has(`${base}-files`)) return `${base}-files`;
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}-files-${n}`)) return `${base}-files-${n}`;
    }
}

/** What an open-file request asks for, as resolved by main (`planOpenFile`). */
export interface OpenFileRequest {
    workspaceId: string;
    /** The directory the panel must root at — main guarantees it is the
     *  workspace's own path for a real workspace, else the file's directory. */
    root: string;
    /** The tab path relative to `root`. */
    relPath: string;
    /** 1-based line to reveal. */
    line?: number;
}

/** Everything `openFileInEditor` needs from the Floor — live reads + effects. */
export interface OpenFileDeps {
    specs: () => TerminalSpec[];
    focusId: () => string | null;
    /** The MOUNTED panels (this window's visible + kept-alive background set). */
    selected: () => ReadonlySet<string>;
    workspacesById: () => Map<string, WorkspaceRow>;
    /** Persist a spec's meta; null when the write failed. */
    updateMeta: (id: string, meta: ViewMeta) => Promise<TerminalSpec | null>;
    /** Create the panel spec (main assigns nothing but the id, which the caller
     *  mints). Rejects if the write fails. */
    createPanel: (input: {
        workspace_id: string | null;
        label: string;
        cwd: string;
        type: 'code';
        meta: ViewMeta;
    }) => Promise<TerminalSpec>;
    /** Put a spec into renderer state (append a new one, replace an existing). */
    putSpec: (spec: TerminalSpec) => void;
    activateWorkspace: (workspaceId: string) => void;
    /** Make the panel visible, focused, and not stuck behind a maximized one. */
    surface: (panelId: string) => void;
    /** Reveal the System workspace in the rail (its panels are hidden by default). */
    revealSystem: () => void;
    emitOpenInPanel: (panelId: string, relPath: string, line?: number) => void;
}

/**
 * Open `req` in the built-in editor: REUSE the workspace's editor panel, or
 * create one. Lives here (not in master.tsx) so the whole decision — including
 * the ORDER of the effects, which is load-bearing — is unit-testable; the page
 * only supplies the deps. Returns what to report back to the MCP caller.
 *
 * Two orderings matter and are covered by tests:
 *   - `activateWorkspace` runs BEFORE `surface`, because activating RESTORES
 *     this window's saved visible set for the workspace and would otherwise
 *     immediately hide the panel we just surfaced.
 *   - a hidden panel's meta is written BEFORE it is surfaced, because CodePanel
 *     seeds its tabs from meta on MOUNT and surfacing is what mounts it.
 */
export async function openFileInEditor(
    req: OpenFileRequest,
    deps: OpenFileDeps,
): Promise<{ reused: boolean; opened: boolean }> {
    const { workspaceId, root, relPath, line } = req;
    const system = workspaceId === SYSTEM_WORKSPACE_ID;
    // Every file — plugin-claimed included — opens as a TAB in a code Editor
    // panel; CodePanel routes claimed extensions to a plugin tab itself (§6.1),
    // so there is exactly ONE open path here.
    const reuse = pickReusePanel(
        deps.specs(),
        { workspaceId, root },
        deps.focusId(),
        deps.selected(),
        deps.workspacesById(),
    );
    if (reuse) {
        if (system) deps.revealSystem();
        deps.activateWorkspace(workspaceId);
        if (reuse.mounted) {
            deps.surface(reuse.id);
            // Forward the target line so the live panel scrolls to + reveals it
            // (re-revealing if the file is already open at another line).
            deps.emitOpenInPanel(reuse.id, relPath, line);
            return { reused: true, opened: false };
        }
        // The panel exists but is HIDDEN, so nothing is subscribed to the
        // open-in-panel bus. Seed the tab into its meta and surface it —
        // mounting is what opens the file, alongside its other tabs. A failed
        // persist still opens it here; only the tab list is then unsaved.
        const target = deps.specs().find((s) => s.id === reuse.id);
        const meta = seedMetaForReuse(target?.meta, relPath, line);
        const updated = await deps.updateMeta(reuse.id, meta);
        if (updated) deps.putSpec(updated);
        else if (target) deps.putSpec({ ...target, meta });
        deps.surface(reuse.id);
        return { reused: true, opened: false };
    }

    // No editor panel for this workspace → create one seeded with the file (its
    // mount-seed opens the tab). The panel is ATTACHED to the workspace only
    // when it roots at that workspace's own path — an attached panel resolves
    // its tabs against the WORKSPACE root, so a panel rooted elsewhere (the
    // System workspace, or a file no workspace owns) must be unattached +
    // system, rooting at the file's directory so its tab resolves under it.
    const wsRow = deps.workspacesById().get(workspaceId);
    const attach = newPanelAttachment({ workspaceId, root }, wsRow?.path);
    const targetWorkspaceId = attach.workspaceId ?? SYSTEM_WORKSPACE_ID;
    const base = (attach.system ? 'system' : wsRow?.project_name ?? 'system')
        .toLowerCase()
        .replace(/\s+/g, '-');
    try {
        const created = await deps.createPanel({
            workspace_id: attach.workspaceId,
            label: newPanelLabel(deps.specs(), targetWorkspaceId, base),
            cwd: root,
            type: 'code',
            meta: {
                ...(attach.system ? { system: true } : {}),
                open_files: [relPath],
                active_file: relPath,
                file_path: relPath,
                // Transient: the new panel reveals this line on mount, then
                // clears it (see CodePanel's mount-seed).
                ...(typeof line === 'number' ? { reveal_line: line } : {}),
            },
        });
        if (attach.system) deps.revealSystem();
        deps.activateWorkspace(targetWorkspaceId);
        deps.putSpec(created);
        deps.surface(created.id);
        return { reused: false, opened: true };
    } catch {
        return { reused: false, opened: false };
    }
}

// --- "open this file in panel <id>" bus ------------------------------------
// A CodePanel seeds its tabs from spec.meta only on mount, so reusing a LIVE
// panel needs a side channel. Each mounted CodePanel subscribes by its spec id;
// `openFileInEditor` emits to the chosen panel after arbitration. A HIDDEN panel
// has no subscriber — it is reopened through its meta seed instead.

type OpenInPanelListener = (relPath: string, line?: number) => void;
const panelListeners = new Map<string, Set<OpenInPanelListener>>();

/** Subscribe a mounted CodePanel (by spec id) to open-file requests. Returns an
 *  unsubscribe. */
export function onOpenInPanel(specId: string, cb: OpenInPanelListener): () => void {
    let set = panelListeners.get(specId);
    if (!set) {
        set = new Set();
        panelListeners.set(specId, set);
    }
    set.add(cb);
    return () => {
        const s = panelListeners.get(specId);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) panelListeners.delete(specId);
    };
}

/** Tell the mounted CodePanel `specId` to open `relPath` as a tab + focus it. */
export function emitOpenInPanel(specId: string, relPath: string, line?: number): void {
    const set = panelListeners.get(specId);
    if (!set) return;
    for (const cb of set) cb(relPath, line);
}

/** A pending line-reveal scoped to the file it targets. */
export interface RevealTarget {
    file: string;
    line: number;
}

/**
 * Resolve the `cursorLine` to hand a CodePanel's `<CodeEditor>` for the active
 * tab. A reveal target only applies to the file it was requested for, so
 * switching to a DIFFERENT tab returns undefined (the editor keeps its own
 * scroll/caret instead of jumping to the other file's reveal line). Pure →
 * unit-testable. fancy-code's `cursorLine` is 1-based and clamps out-of-range.
 */
export function resolveCursorLine(
    reveal: RevealTarget | null,
    activeFile: string | null,
): number | undefined {
    if (!reveal || !activeFile || reveal.file !== activeFile) return undefined;
    return reveal.line;
}
