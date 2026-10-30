import { lstat, realpath } from 'node:fs/promises';
import nodePath from 'node:path';

type PlatformPath = typeof nodePath.posix;

/**
 * AN AGENT'S FILES ARE ITS WORKSPACE'S FILES (genie#1347).
 *
 * The one confinement check AgentInbox attachments go through, at both ends: what an agent attaches is read from
 * inside its own workspace, and what it saves is written inside its own workspace. Genie 1 (v0.7.0-beta.342) did
 * the same through `guardedResolve` (main/files/ipc.ts) from `confine` in main/agentinbox/attachments.ts; Genie 2's
 * store had lost it, so an agent could attach any file on the disk and write a received one anywhere.
 *
 * Two halves, in this order, so a refusal never depends on what is on the disk:
 *
 * 1. LEXICAL (`insideRoot`): the path, resolved against the workspace root (a relative path is the WORKSPACE's,
 *    never Genie's working directory), must lie strictly below the root. `..`, absolute paths elsewhere, another
 *    drive and UNC paths fail here without the disk being touched — so the answer is the same whether the outside
 *    file exists or not. Windows compares without case, as its file system does.
 * 2. AFTER LINKS: the real path of what is read (or of the nearest folder that exists above what is written, and the
 *    target itself when it is a link) must lie inside the real path of the root. A symlink or junction inside the
 *    workspace that points out of it fails here. The root is resolved too, so a workspace opened through a link works.
 *
 * A refusal names the path the agent gave and nothing else: never where a link points.
 */

/** Whether `api` is the Windows flavour (case-insensitive, drives, UNC). */
const isWin = (api: PlatformPath): boolean => api.sep === '\\';

/** `target` lies strictly below `base` (both absolute, both from `api`). Never `base` itself. */
function below(base: string, target: string, api: PlatformPath): boolean {
    const fold = (p: string) => (isWin(api) ? p.toLowerCase() : p);
    const rel = api.relative(fold(base), fold(target));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/** `target` is `base` or lies below it. */
function within(base: string, target: string, api: PlatformPath): boolean {
    const fold = (p: string) => (isWin(api) ? p.toLowerCase() : p);
    return fold(api.resolve(base)) === fold(api.resolve(target)) || below(base, target, api);
}

/**
 * The absolute path `requested` names inside `root`, or `null` when it is outside it (or IS the root — not a file to
 * send, nor a place to write). A root that is not absolute confines nothing, so it fails closed. Pure: `api` lets the
 * Windows rules be checked on any machine.
 */
export function insideRoot(root: string, requested: string, api: PlatformPath = nodePath): string | null {
    if (!root || !api.isAbsolute(root)) return null;
    const base = api.resolve(root);
    const abs = api.resolve(base, requested);
    return below(base, abs, api) ? abs : null;
}

/** Thrown when a path leaves the workspace. Its message names only what the caller gave. */
export class OutsideWorkspaceError extends Error {
    constructor(given: string, consequence: string) {
        super(`${given} is outside your workspace; ${consequence}`);
        this.name = 'OutsideWorkspaceError';
    }
}

async function realRoot(root: string): Promise<string> {
    try {
        return await realpath(root);
    } catch {
        throw new Error('your workspace folder could not be found, so no file can be read from or written to it');
    }
}

const errno = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? 'unreadable';

/**
 * A file an agent wants to READ (an attachment it sends): its lexical path and the real path to read the bytes from.
 * Keep the lexical path's base name as the file's name — the link target's name is not the agent's to reveal.
 */
export async function confineRead(root: string, given: string, consequence: string): Promise<{ path: string; real: string }> {
    const abs = insideRoot(root, given);
    if (abs === null) throw new OutsideWorkspaceError(given, consequence);
    const base = await realRoot(root);
    let real: string;
    try {
        real = await realpath(abs);
    } catch (error) {
        throw new Error(`attachment ${given} could not be read; nothing was sent (${errno(error)})`);
    }
    if (!below(base, real, nodePath)) throw new OutsideWorkspaceError(given, consequence);
    return { path: abs, real };
}

/**
 * A file an agent wants to WRITE (an attachment it saves): the absolute path to write, once neither the nearest
 * existing folder above it nor the target itself (when it is a link, dangling or not) leads out of the workspace.
 * Nothing is created here — a refused save leaves no folder behind.
 */
export async function confineWrite(root: string, given: string, consequence: string): Promise<string> {
    const abs = insideRoot(root, given);
    if (abs === null) throw new OutsideWorkspaceError(given, consequence);
    const base = await realRoot(root);

    const existing = await lstat(abs).catch(() => null);
    if (existing?.isSymbolicLink()) {
        // Writing a link writes its target. A dangling one would create the target, wherever it points.
        const real = await realpath(abs).catch(() => null);
        if (real === null || !below(base, real, nodePath)) throw new OutsideWorkspaceError(given, consequence);
    }

    // The nearest folder above the target that exists: everything below it is created by the save, inside it.
    let probe = nodePath.dirname(abs);
    for (;;) {
        const real = await realpath(probe).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
            throw error;
        });
        if (real !== null) {
            if (!within(base, real, nodePath)) throw new OutsideWorkspaceError(given, consequence);
            break;
        }
        const up = nodePath.dirname(probe);
        // Lexically inside, so the walk reaches the root (which exists) before the top of the disk.
        if (up === probe) throw new OutsideWorkspaceError(given, consequence);
        probe = up;
    }
    return abs;
}

/** STUB (genie#1354, test-first commit): `requested` inside `root`, the root itself allowed. Lexical. */
export function insideOrRoot(root: string, requested: string, api: PlatformPath = nodePath): string | null {
    if (!root || !api.isAbsolute(root)) return null;
    const base = api.resolve(root);
    const abs = api.resolve(base, requested);
    return within(base, abs, api) ? abs : null;
}

/** STUB (genie#1354, test-first commit): lexical only — links are not followed yet. */
export function confinePathSync(root: string, given: string, consequence: string, options: { allowRoot?: boolean } = {}): string {
    const abs = options.allowRoot ? insideOrRoot(root, given) : insideRoot(root, given);
    if (abs === null) throw new OutsideWorkspaceError(given, consequence);
    return abs;
}

/** STUB (genie#1354, test-first commit). */
export async function confinePath(root: string, given: string, consequence: string, options: { allowRoot?: boolean } = {}): Promise<string> {
    return confinePathSync(root, given, consequence, options);
}
