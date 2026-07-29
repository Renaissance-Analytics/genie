import { readProjectJson, type ProjectJsonTynn } from './project-json';

/**
 * WHICH Tynn project a workspace is linked to.
 *
 * Split out of `main/tynn/provision.ts` so callers that must NOT pull in the
 * provisioner's graph (electron `session`, the MCP config writer) can still ask
 * the question — notably IssueWatch, which has to map a server-pushed TYNN
 * PROJECT id back to the LOCAL workspace it belongs to (tynn.ai#134).
 * `main/tynn/provision.ts` re-exports these, so its existing import path keeps
 * working.
 */

/**
 * Pure: decide a workspace's effective Tynn link from its two possible homes.
 *
 * A Tynn link lives in TWO places: the secret-free `tynn` block in project.json
 * (written on link / provision) AND the durable `tynn_project_id` recorded on
 * the workspace row at creation. project.json is AUTHORITATIVE when it carries a
 * `tynn` key — *including an empty `{}`*, which is the deliberate "unlinked"
 * marker `unlinkWorkspaceTynn` writes, so an explicit unlink is never silently
 * re-linked from the row. Only when project.json has NO `tynn` key at all do we
 * fall back to the row, so a workspace that was associated with a Tynn project
 * but whose project.json never got (or lost) its `tynn` block is still
 * recognised as linked rather than reported 'unlinked'.
 */
export function pickTynnLink(input: {
    /** project.json's `tynn` value (may be {} for an explicit unlink). */
    projectJsonTynn: ProjectJsonTynn | undefined;
    /** Whether project.json carries a `tynn` key at all (vs the key absent). */
    hasTynnKey: boolean;
    /** The durable workspace row, if one matches this path. */
    row: {
        backend: string;
        tynnProjectId?: string | null;
        tynnProjectName?: string | null;
    } | null;
}): ProjectJsonTynn | null {
    if (input.hasTynnKey) {
        return input.projectJsonTynn?.projectId ? input.projectJsonTynn : null;
    }
    if (input.row && input.row.backend === 'tynn' && input.row.tynnProjectId) {
        return {
            projectId: input.row.tynnProjectId,
            project: input.row.tynnProjectName || undefined,
        };
    }
    return null;
}

/**
 * The link block AS STORED IN project.json — null unless it carries a
 * projectId. The narrow, file-only view; most callers want `resolveTynnLink`,
 * which also honours the durable workspace row.
 */
export function readTynnLink(workspacePath: string): ProjectJsonTynn | null {
    const pj = readProjectJson(workspacePath);
    const tynn = pj?.tynn;
    if (!tynn || !tynn.projectId) return null;
    return tynn;
}

/**
 * A workspace ROW's effective Tynn link (`pickTynnLink` applied to its
 * project.json). Row-based rather than path-based so a caller that already holds
 * the row — `listWorkspaces()` — resolves without a second db read;
 * `resolveTynnLink` is the path-based wrapper over this.
 */
export function resolveTynnLinkForRow(row: {
    backend: string;
    path: string;
    tynn_project_id?: string | null;
    tynn_project_name?: string | null;
}): ProjectJsonTynn | null {
    const pj = readProjectJson(row.path);
    return pickTynnLink({
        projectJsonTynn: pj?.tynn,
        hasTynnKey: !!pj && Object.prototype.hasOwnProperty.call(pj, 'tynn'),
        row: {
            backend: row.backend,
            tynnProjectId: row.tynn_project_id,
            tynnProjectName: row.tynn_project_name,
        },
    });
}
