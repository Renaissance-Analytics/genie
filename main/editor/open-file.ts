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
    /** Absolute file path. */
    abs: string;
    /** Directory the editor panel roots at (its tabs are relative to this). */
    root: string;
    /** The tab path relative to `root` (forward-slashed). */
    relPath: string;
}

/**
 * Plan how to open `inputPath` for `workspaceId`. PURE (no fs) → unit-testable.
 *
 *   - A relative path resolves against the workspace root (real workspace) or the
 *     home dir (System).
 *   - When the resolved file is UNDER a real workspace root, the panel roots at
 *     the WORKSPACE root (relative tab) — so the workspace's editor reuses across
 *     all its files.
 *   - Otherwise (the System workspace, or a file outside the workspace) the panel
 *     roots at the FILE'S directory (basename tab) — which keeps the Code view's
 *     workspace-root path-guard satisfied for arbitrary absolute/system paths.
 */
export function planOpenFile(
    workspaceId: string,
    workspaceRoot: string | null,
    homeDir: string,
    inputPath: string,
): { plan: OpenFilePlan } | { error: string } {
    const raw = (inputPath ?? '').trim();
    if (!raw) return { error: 'No file path given.' };

    const isSystem = workspaceId === SYSTEM_WORKSPACE_ID;
    const base = isSystem ? homeDir : workspaceRoot ?? homeDir;
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);

    let root: string;
    if (!isSystem && workspaceRoot) {
        const rel = path.relative(workspaceRoot, abs);
        // Under the workspace root ⇒ root at the workspace (relative tab, broad
        // reuse). A `..`/absolute rel means it escaped → root at the file's dir.
        root = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
            ? workspaceRoot
            : path.dirname(abs);
    } else {
        root = path.dirname(abs);
    }
    const relPath = path.relative(root, abs).split(path.sep).join('/');
    return { plan: { abs, root, relPath } };
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
    /** The user's home dir (System root + relative-path base). */
    homeDir: () => string;
    /** Surface the master Floor and push it the open-file request. */
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

    const planned = planOpenFile(workspaceId, workspaceRoot, deps.homeDir(), req.path);
    if ('error' in planned) return { ok: false, error: planned.error };
    const { abs, root, relPath } = planned.plan;

    try {
        if (!fs.statSync(abs).isFile()) return { ok: false, error: `Not a file: ${abs}` };
    } catch {
        return { ok: false, error: `File not found: ${abs}` };
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
            workspaceId,
            root,
            relPath,
            ...(typeof req.line === 'number' ? { line: req.line } : {}),
        });
    });

    return {
        ok: true,
        file: abs,
        workspaceId,
        // On a reply: trust it. On timeout (reply null): the file was still
        // dispatched to the Floor — report opened-new as the best-effort default.
        reused: reply?.reused ?? false,
        openedNew: reply ? !reply.reused : true,
    };
}
