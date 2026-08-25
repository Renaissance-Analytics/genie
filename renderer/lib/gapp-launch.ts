/**
 * PURE. Which workspaces offer "launch the Genie App built here", and what that
 * offer is called (genie#245 follow-on).
 *
 * The launch itself lives in exactly one place before this file and one after:
 * `apps.previewFolder` in main, and the two affordances that call it — the
 * workspace row's GApp control and the Command Window's action. Both ask this
 * module the same question so they can never disagree about which workspaces
 * have an app to launch, which is the failure mode of two affordances that each
 * decide for themselves.
 *
 * Kept out of the components because the renderer's test environment has no DOM.
 */

import { resolveWorkspaceKind } from './workspace-kind';

/** A workspace row, reduced to what the launch decision needs. */
export interface GappLaunchRow {
    id: string;
    project_name: string;
    path: string;
    app_kind?: unknown;
    gapp_dev?: unknown;
}

/** A workspace whose app can be launched, with the folder already resolved. */
export interface GappLaunchTarget {
    id: string;
    name: string;
    /** The folder the preview opens over — the workspace root. */
    path: string;
}

/**
 * Can THIS workspace launch an app, and over which folder?
 *
 * Reads through {@link resolveWorkspaceKind}, so the offer follows the SAME
 * precedence as the chrome: a workspace hosting an INSTALLED app resolves to
 * `app`, not `gapp-dev-workspace`, and gets no launch — being a place a GApp
 * runs is not being a place a GApp is built, and previewing there would open a
 * second copy of somebody else's app.
 *
 * A GDW with no path is skipped rather than offered-and-failed: there is nothing
 * for a preview to open over, and an affordance that reliably fails is worse
 * than one that is not there.
 */
export function gappLaunchTarget(row: GappLaunchRow): GappLaunchTarget | null {
    if (resolveWorkspaceKind(row) !== 'gapp-dev-workspace') return null;
    if (!row.path) return null;
    return { id: row.id, name: row.project_name, path: row.path };
}

/** The same question over a list — for the Command Window's action group. */
export function gappLaunchTargets(rows: readonly GappLaunchRow[]): GappLaunchTarget[] {
    const out: GappLaunchTarget[] = [];
    for (const row of rows) {
        const target = gappLaunchTarget(row);
        if (target) out.push(target);
    }
    return out;
}

/**
 * How the launch names itself in the Command Window.
 *
 * Says the VERB and the OBJECT, because the palette is searched by typing what
 * you want: "launch" finds it, and so does "app". Naming the workspace matters
 * on a machine hosting several GDWs at once, which is the normal case here.
 */
export function gappLaunchLabel(row: Pick<GappLaunchRow, 'project_name'>): string {
    return `Launch ${row.project_name} (Genie App)`;
}
