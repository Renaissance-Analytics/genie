/**
 * PURE. May this caller register this folder as a workspace, and is it a legal
 * thing to register?
 *
 * WHY THIS EXISTS: an operator could UNREGISTER a workspace and could not
 * REGISTER one. `manageWorkspaces` shipped `list | status | open | activate |
 * remove` — so an agent holding authority over the whole workstation could take
 * a workspace off Genie's list and had no verb to put one back.
 *
 * The capability was never missing from Genie: `addWorkspace` (db.ts) exists and
 * the UI reaches it through the `workspaces:add` IPC. It was simply never given
 * to agents. The asymmetry was in the surface, not the model.
 *
 * `provisionWorkspaces` is not this verb, and is not a substitute: it clones
 * envelopes for the child projects an OPS PROJECT governs — a different feature
 * behind a different gate, which is why it correctly refuses on a workstation
 * that has operator authority but is not an Ops project.
 *
 * Kept pure, and separate from the effect, because "who may do this" is the part
 * worth being able to test without a disk or a database.
 */

export interface WorkspaceAddRequest {
    path: string;
    /** Does this caller hold WORKSTATION operator authority? */
    callerIsOperator: boolean;
    exists: (path: string) => boolean;
    isDirectory: (path: string) => boolean;
    /** Paths Genie already has registered. */
    known: string[];
}

export interface WorkspaceAddDecision {
    allowed: boolean;
    reason?: string;
    /** True when the refusal is "Genie already has this" rather than a fault —
     *  the caller usually wants to carry on rather than treat it as an error. */
    alreadyKnown?: boolean;
}

/** Compare two paths the way the filesystem does: separators and, on Windows,
 *  case are not meaningful. Without this the same folder registers twice, and a
 *  list that shows it twice cannot be cleaned up by removing one. */
function samePath(a: string, b: string): boolean {
    const norm = (p: string) =>
        p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

/** Absolute on either platform: a drive-letter root, or a POSIX root. */
function isAbsolute(p: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}

export function decideWorkspaceAdd(req: WorkspaceAddRequest): WorkspaceAddDecision {
    // Authority FIRST, so a non-operator learns it may not do this at all rather
    // than which paths on the machine exist. Probing for a folder is a small
    // thing to leak, and there is no reason to leak it.
    if (!req.callerIsOperator) {
        return {
            allowed: false,
            reason:
                'Registering a workspace needs this workstation’s operator authority — it introduces a folder Genie did not know about to every surface that lists workspaces. Your own workspace is not authority to add another.',
        };
    }

    const path = String(req.path ?? '').trim();
    if (!path) return { allowed: false, reason: 'A path is required.' };

    if (!isAbsolute(path)) {
        // A relative path resolves against whatever cwd the host happens to have,
        // which is not a property of the request being made.
        return {
            allowed: false,
            reason: `“${path}” is not an absolute path. Give the full path to the folder, so what gets registered is unambiguous.`,
        };
    }

    // Already-registered is checked BEFORE the disk: it is the common case when a
    // caller retries, and it is an answer rather than a fault.
    if (req.known.some((k) => samePath(k, path))) {
        return {
            allowed: false,
            alreadyKnown: true,
            reason: `Genie already has a workspace at ${path}.`,
        };
    }

    if (!req.exists(path)) {
        return { allowed: false, reason: `${path} does not exist.` };
    }
    if (!req.isDirectory(path)) {
        return { allowed: false, reason: `${path} is not a directory — a workspace is a folder.` };
    }

    return { allowed: true };
}
