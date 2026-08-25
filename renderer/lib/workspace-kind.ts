/**
 * WHICH treatment a workspace's chrome wears — and, load-bearing, what cannot
 * decide it (genie#245).
 *
 * A Genie App defines its own window and pill styling. It does NOT define the
 * workspace around it: every GApp Development Workspace looks the same as every
 * other one, because the workspace is Genie's surface and a developer styling it
 * is a developer restyling the shell their app is judged inside.
 *
 * That boundary is STRUCTURAL rather than a convention anybody has to remember:
 *
 *  1. {@link resolveWorkspaceKind} reads exactly two fields, both Genie-owned
 *     database columns, and narrows each against a closed set of literals. There
 *     is no field a manifest could travel in, and an unrecognised value falls
 *     back to the ORDINARY workspace rather than the privileged one.
 *  2. {@link workspaceKindClass} is a lookup into a frozen table, never a
 *     concatenation and never a passthrough. Its range is four strings plus the
 *     empty string, so no value a developer writes can become a class name.
 *
 * The manifest's own styling surface is unaffected and stays where it belongs —
 * `main/apps/window-policy.ts` and the tray pill.
 */

/**
 * What a workspace IS, for chrome. The three `app-*` values mirror the
 * `app_kind` column (what Genie INSTALLED here); `gapp-dev-workspace` mirrors
 * `gapp_dev` (what the linked Tynn project says is BUILT here).
 */
export type WorkspaceKind = 'app' | 'app-dev' | 'app-preview' | 'gapp-dev-workspace';

/**
 * The ONLY class names workspace chrome can wear, keyed by kind.
 *
 * Frozen so a future in-process surface cannot redecorate the shell by writing
 * to the table — the same reason the lookup exists at all.
 */
export const WORKSPACE_KIND_CLASS: Readonly<Record<WorkspaceKind, string>> = Object.freeze({
    app: 'ws-app',
    'app-dev': 'ws-app-dev',
    'app-preview': 'ws-app-preview',
    'gapp-dev-workspace': 'ws-gapp-dev',
});

const WORKSPACE_KIND_LABEL: Readonly<Record<WorkspaceKind, string>> = Object.freeze({
    app: 'Genie App',
    'app-dev': 'Genie App · in development',
    'app-preview': 'Genie App · preview',
    'gapp-dev-workspace': 'GApp Development Workspace',
});

/**
 * Resolve a workspace row to the one kind its chrome shows.
 *
 * PRECEDENCE, strongest first — a workspace can legitimately be several of these
 * at once, and only one treatment can win:
 *
 *  1. `app-preview` — a throwaway workspace on the developer's own folder, swept
 *     when the preview window closes. Whatever else it is, "this is about to be
 *     deleted" is the fact the user needs on screen.
 *  2. `app` — a Genie-created envelope hosting somebody's INSTALLED app. Being a
 *     place a GApp runs is not being a place a GApp is built, so it must not wear
 *     development chrome or collect the development affordances.
 *  3. `gapp-dev-workspace` — a human marked the linked Tynn project as the home
 *     of this app's development.
 *  4. `app-dev` — the mechanical consequence of choosing "Install for
 *     development…" on a folder. It ranks below the GDW because when a workspace
 *     is both, the human's declaration says more than the install route taken.
 */
export function resolveWorkspaceKind(row: {
    app_kind?: unknown;
    gapp_dev?: unknown;
}): WorkspaceKind | null {
    if (row.app_kind === 'app-preview') return 'app-preview';
    if (row.app_kind === 'app') return 'app';
    if (row.gapp_dev === 1) return 'gapp-dev-workspace';
    if (row.app_kind === 'app-dev') return 'app-dev';
    return null;
}

/** The chrome class for a kind — `''` for an ordinary workspace. */
export function workspaceKindClass(kind: WorkspaceKind | null): string {
    return kind ? WORKSPACE_KIND_CLASS[kind] : '';
}

/** How a kind names itself in a tooltip — null when there is nothing to say. */
export function workspaceKindLabel(kind: WorkspaceKind | null): string | null {
    return kind ? WORKSPACE_KIND_LABEL[kind] : null;
}
