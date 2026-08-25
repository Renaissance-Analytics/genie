/**
 * GApp Development Workspace (GDW) — the CONVERGENCE RULES (genie#245).
 *
 * A GDW is a workspace whose linked Tynn project is marked `is_gapp`: the place
 * a Genie App is BUILT, as opposed to the workspaces `app_kind` describes, which
 * are places a Genie App RUNS.
 *
 * The flag has exactly one home — a human sets it on the Tynn project — so
 * everything Genie does is converge on someone else's answer. That makes the
 * convergence rules the whole feature, which is why they live here as a pure
 * function with no database, no filesystem and no network: the interesting cases
 * are all "what does Genie do when the answer is incomplete", and those are
 * miserable to provoke through a live backend.
 *
 * The impure half — reading rows, resolving each workspace's Tynn link, writing
 * the column — is `gapp-dev-sync.ts`.
 */

/** A workspace, reduced to what the sync decision needs. */
export interface GappDevWorkspace {
    id: string;
    /** The `gapp_dev` column as stored. Anything but 1 means "not a GDW". */
    gapp_dev?: unknown;
    /** The Tynn project this workspace resolves to, or null when unlinked. */
    tynnProjectId: string | null;
}

/** A project as `listAllProjects()` returns it, reduced the same way. */
export interface GappDevProject {
    id: string;
    /** Absent on an older Tynn — reads as "not a GApp", never as "unknown". */
    isGapp?: boolean;
    /** Present on real rows; only Tynn declares `is_gapp`. */
    backend?: string;
}

export interface GappDevChange {
    id: string;
    next: boolean;
}

/**
 * Is this stored value a GApp Development Workspace?
 *
 * Same posture as {@link import('../db').toWorkspaceAppKind}: read through here
 * rather than off the row, so a hand edit, a newer Genie's value, or a `'1'` that
 * came back as text falls back to the ORDINARY workspace. Getting this wrong in
 * the other direction would hand a plain project the developer affordances.
 */
export function isGappDevValue(value: unknown): boolean {
    return value === 1;
}

/**
 * Which workspaces need their `gapp_dev` column changed, given the project list.
 *
 * Two asymmetries carry the design, and both are about how much Genie actually
 * KNOWS:
 *
 *  - **A project missing from the list changes nothing.** `TynnBackend.listProjects()`
 *    returns `[]` on any failure — a dead session, an offline laptop, a 500 — so
 *    treating absence as `is_gapp: false` would strip every GDW in the workspace
 *    the first time the network hiccuped, with no way for the user to tell why
 *    their chrome moved. Absence is "no answer", not "no".
 *  - **An unlinked workspace is downgraded.** That absence is decided on this
 *    machine and known for certain, so it is safe to act on.
 *
 * Only genuine changes are returned, so a caller can use the result's length to
 * decide whether a re-render broadcast is warranted at all.
 */
export function planGappDevSync(
    workspaces: readonly GappDevWorkspace[],
    projects: readonly GappDevProject[],
): GappDevChange[] {
    const known = new Map<string, boolean>();
    for (const p of projects) known.set(p.id, !!p.isGapp);

    const changes: GappDevChange[] = [];
    for (const ws of workspaces) {
        const current = isGappDevValue(ws.gapp_dev);
        let next: boolean;
        if (ws.tynnProjectId === null) {
            next = false;
        } else {
            const answer = known.get(ws.tynnProjectId);
            if (answer === undefined) continue; // no answer — leave it alone
            next = answer;
        }
        if (next !== current) changes.push({ id: ws.id, next });
    }
    return changes;
}
