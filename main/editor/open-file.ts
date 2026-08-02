import { ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_WORKSPACE_ID } from '../terminal/workspace-of-terminal';
import type { OpenFileRequest, OpenFileResult } from '../mcp/protocol';

/**
 * Backs the `openFileForUser` MCP tool: resolve the caller's workspace + the
 * file path, then ask the renderer Floor to surface it — REUSING an editor panel
 * already open for that workspace or opening a new one. The reuse-vs-new decision
 * lives in the renderer (it owns the open-panel state); main resolves the path,
 * validates the file exists, and round-trips a request keyed by id, awaiting the
 * renderer's {reused, opened} reply. Works for the System workspace too.
 */

/** Where the editor panel should root + the tab path relative to that root. */
export interface OpenFilePlan {
    /**
     * The workspace the panel belongs to — the CALLER's when the file is inside
     * it, ANOTHER registered workspace when the file lives there, else the
     * System workspace. The panel's root is ALWAYS this workspace's own path (or
     * the file's directory for System), because an attached panel resolves its
     * tabs against the WORKSPACE root: attaching a panel rooted anywhere else
     * silently re-resolves `<file dir>/<tab>` as `<workspace>/<tab>`.
     */
    workspaceId: string;
    /** Absolute file path. */
    abs: string;
    /** Directory the editor panel roots at (its tabs are relative to this). */
    root: string;
    /** The tab path relative to `root` (forward-slashed). */
    relPath: string;
}

/** A registered workspace, for locating which one owns a resolved file. */
export interface WorkspaceRootRef {
    id: string;
    path: string;
}

/**
 * `abs` as a forward-slashed path RELATIVE to `root`, or null when it isn't
 * inside `root`. Case-insensitive on Windows, case-sensitive elsewhere — that's
 * `path.relative`'s own platform rule, which is the one the filesystem uses.
 */
function relWithin(root: string, abs: string): string | null {
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

/**
 * Plan how to open `inputPath` for `workspaceId`. PURE (no fs) → unit-testable.
 *
 *   - A relative path resolves against the workspace root (real workspace) or the
 *     home dir (System) — keeping its FULL relative path, subdirectories and all.
 *   - Inside the caller's own workspace ⇒ the panel roots at the WORKSPACE root
 *     (relative tab) — so the workspace's editor reuses across all its files.
 *   - Inside a DIFFERENT registered workspace ⇒ the panel opens in THAT
 *     workspace (a file belongs to the workspace that owns it, and only there
 *     does its relative tab path resolve).
 *   - Otherwise (a System caller, or a file no workspace owns) ⇒ a SYSTEM panel
 *     rooted at the FILE'S directory (basename tab), which reads unconfined.
 *
 * The invariant that matters: a non-System `workspaceId` ALWAYS comes with
 * `root` = that workspace's path. The renderer attaches a new panel to the
 * workspace and CodePanel then resolves tabs against the workspace path, so any
 * other root would drop the tab's directories (genie: an agent asked for
 * `.ai/plans/x.md` and the editor read `<workspace>/x.md`).
 */
export function planOpenFile(
    workspaceId: string,
    workspaceRoot: string | null,
    homeDir: string,
    inputPath: string,
    workspaces: ReadonlyArray<WorkspaceRootRef> = [],
): { plan: OpenFilePlan } | { error: string } {
    const raw = (inputPath ?? '').trim();
    if (!raw) return { error: 'No file path given.' };

    const isSystem = workspaceId === SYSTEM_WORKSPACE_ID;
    const base = isSystem ? homeDir : workspaceRoot ?? homeDir;
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);

    if (!isSystem && workspaceRoot) {
        const rel = relWithin(workspaceRoot, abs);
        if (rel) return { plan: { workspaceId, abs, root: workspaceRoot, relPath: rel } };

        // It escaped the caller's workspace — but another registered workspace
        // may OWN it (an agent surfacing a file it wrote in a sibling
        // workspace). Open it there; the DEEPEST match wins when they nest.
        let best: { id: string; root: string; rel: string } | null = null;
        for (const ws of workspaces) {
            if (!ws?.path || ws.id === workspaceId) continue;
            const r = relWithin(ws.path, abs);
            if (!r) continue;
            if (!best || ws.path.length > best.root.length) {
                best = { id: ws.id, root: ws.path, rel: r };
            }
        }
        if (best) {
            return { plan: { workspaceId: best.id, abs, root: best.root, relPath: best.rel } };
        }
    }

    return {
        plan: {
            workspaceId: SYSTEM_WORKSPACE_ID,
            abs,
            root: path.dirname(abs),
            relPath: path.basename(abs),
        },
    };
}

// --- renderer round-trip -----------------------------------------------------

type RendererReply = { reused: boolean; opened: boolean } | null;

const pending = new Map<string, { resolve: (r: RendererReply) => void; timer: NodeJS.Timeout }>();

/** How long to wait for the renderer's reply before giving up (the file still
 *  opens; we just can't report reused-vs-new). Generous for a cold master open. */
const REPLY_TIMEOUT_MS = 6000;

export interface OpenFileDeps {
    /** Terminal id → its workspace id (incl the System workspace), or null. */
    workspaceIdOfTerminal: (terminalId: string) => string | null;
    /** A real workspace's root path, or null when missing. (Not called for System.) */
    getWorkspaceRoot: (workspaceId: string) => string | null;
    /** Every registered workspace + its root — so a file that lives in ANOTHER
     *  workspace opens in that workspace's editor instead of being force-fit
     *  into the caller's (where its relative tab path cannot resolve). */
    listWorkspaces: () => WorkspaceRootRef[];
    /** The user's home dir (System root + relative-path base). */
    homeDir: () => string;
    /** Surface the master Floor and push it the open-file request. The Floor
     *  always opens into a code Editor panel — CodePanel itself routes a
     *  plugin-claimed extension to a plugin TAB (§6.1), so there is exactly one
     *  open path and no editor decision rides this payload. */
    sendOpenFile: (payload: {
        requestId: string;
        workspaceId: string;
        root: string;
        relPath: string;
        line?: number;
    }) => void;
}

let deps: OpenFileDeps | null = null;

/** Wire the renderer deps + register the reply IPC. Call once at app-ready. */
export function registerOpenFile(d: OpenFileDeps): void {
    deps = d;
    ipcMain.handle(
        'editor:open-file-result',
        (_e, requestId: string, result: { reused?: boolean; opened?: boolean }) => {
            const p = pending.get(requestId);
            if (p) {
                clearTimeout(p.timer);
                pending.delete(requestId);
                p.resolve({ reused: !!result?.reused, opened: !!result?.opened });
            }
            return { ok: true };
        },
    );
}

export async function openFileForUserForMcp(
    terminalId: string,
    req: OpenFileRequest,
): Promise<OpenFileResult> {
    if (!deps) return { ok: false, error: 'Editor not ready.' };

    const workspaceId = deps.workspaceIdOfTerminal(terminalId);
    if (!workspaceId) {
        return {
            ok: false,
            error: 'This terminal is not attached to a Genie workspace, so there is no editor to open into.',
        };
    }
    const workspaceRoot =
        workspaceId === SYSTEM_WORKSPACE_ID ? null : deps.getWorkspaceRoot(workspaceId);
    if (workspaceId !== SYSTEM_WORKSPACE_ID && !workspaceRoot) {
        return { ok: false, error: `Workspace ${workspaceId} not found.` };
    }

    const planned = planOpenFile(
        workspaceId,
        workspaceRoot,
        deps.homeDir(),
        req.path,
        deps.listWorkspaces(),
    );
    if ('error' in planned) return { ok: false, error: planned.error };
    const { abs, root, relPath, workspaceId: targetWorkspaceId } = planned.plan;

    try {
        if (!fs.statSync(abs).isFile()) return { ok: false, error: `Not a file: ${abs}` };
    } catch {
        // Name the FULLY resolved path — and, for a relative path, what it was
        // resolved against, since that is the mistake worth seeing (the agent
        // meant a file in another directory or another workspace entirely).
        const relativeInput = !path.isAbsolute(req.path.trim());
        const resolvedAgainst =
            workspaceId === SYSTEM_WORKSPACE_ID ? deps.homeDir() : workspaceRoot ?? deps.homeDir();
        return {
            ok: false,
            error: relativeInput
                ? `File not found: ${abs} — "${req.path}" resolved against ${resolvedAgainst}. Pass an absolute path if the file lives elsewhere.`
                : `File not found: ${abs}`,
        };
    }

    const reply = await new Promise<RendererReply>((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve(null);
        }, REPLY_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(requestId, { resolve, timer });
        deps!.sendOpenFile({
            requestId,
            workspaceId: targetWorkspaceId,
            root,
            relPath,
            ...(typeof req.line === 'number' ? { line: req.line } : {}),
        });
    });

    return {
        ok: true,
        file: abs,
        workspaceId: targetWorkspaceId,
        // On a reply: trust it. On timeout (reply null): the file was still
        // dispatched to the Floor — report opened-new as the best-effort default.
        reused: reply?.reused ?? false,
        openedNew: reply ? !reply.reused : true,
    };
}
