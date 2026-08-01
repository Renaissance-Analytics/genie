/**
 * The plugin capability bridge's FILESYSTEM gate (Plugin System, Phase 1).
 *
 * Every fs request a plugin worker makes funnels through {@link runPluginFsOp},
 * which enforces the plugin's GRANTED, workspace-guarded, extension-limited fs
 * capability BEFORE touching disk. It is the security seam deliverable #2 asks
 * for, kept PURE (no Electron, no worker plumbing) so the fail-closed behaviour
 * is unit-testable without spinning up a `utilityProcess`:
 *
 *   1. the manifest must DECLARE `capabilities.fs.scope === 'workspace'`,
 *   2. the user must have GRANTED that fs scope (§12.1 granular grant), and
 *   3. a per-call workspace ROOT must be resolved (host-authoritative — never
 *      supplied by the untrusted worker).
 *
 * Only then does it hand off to the guard-resolving, extension-limited,
 * size-capped helpers in `files/ipc.ts` (which share `guardedResolve` with the
 * general `files:*` surface). ANY failure — undeclared, ungranted, no workspace,
 * path escape, disallowed extension, oversize — comes back as a contained error
 * result the worker surfaces to the agent. Fail-closed, everywhere.
 */

import {
    writePluginBinary,
    readPluginBinary,
    writePluginText,
    readPluginText,
} from '../files/ipc';
import type { PluginManifest } from './manifest';
import type { PluginGrants } from '../db';
import { clientEditorExtensions } from './side';

/** The fs bridge ops the worker may request (text + binary read/write). */
export type PluginFsOp = 'fs.readFile' | 'fs.writeFile' | 'fs.readBytes' | 'fs.writeBytes';

/** True when `op` is one of the filesystem bridge ops. */
export function isPluginFsOp(op: string): op is PluginFsOp {
    return (
        op === 'fs.readFile' ||
        op === 'fs.writeFile' ||
        op === 'fs.readBytes' ||
        op === 'fs.writeBytes'
    );
}

/** A contained bridge result: `ok` with a value, or a denial with a reason. */
export interface PluginFsResult {
    ok: boolean;
    value?: unknown;
    error?: string;
}

function deny(error: string): PluginFsResult {
    return { ok: false, error };
}

/**
 * The SANDBOX itself, shared by both gates below: guard-resolve inside `root`,
 * enforce `exts`, cap the size. An empty `exts` denies everything (fail-closed in
 * `resolvePluginPath`), so a caller that computes no allow-list can't leak.
 */
async function performFsOp(
    root: string,
    op: PluginFsOp,
    params: Record<string, unknown>,
    exts: string[],
): Promise<PluginFsResult> {
    const rel = String(params.rel ?? '');
    try {
        switch (op) {
            case 'fs.writeBytes': {
                const bytes = Buffer.from(String(params.base64 ?? ''), 'base64');
                return { ok: true, value: await writePluginBinary(root, rel, bytes, exts) };
            }
            case 'fs.readBytes':
                return { ok: true, value: await readPluginBinary(root, rel, exts) };
            case 'fs.writeFile':
                return {
                    ok: true,
                    value: await writePluginText(root, rel, String(params.data ?? ''), exts),
                };
            case 'fs.readFile':
                return { ok: true, value: await readPluginText(root, rel, exts) };
            default:
                return deny(`unknown fs op "${op as string}"`);
        }
    } catch (e) {
        return deny(e instanceof Error ? e.message : String(e));
    }
}

/**
 * The HOST-SIDE (worker) fs gate. Enforce the plugin's fs grant + scope + per-call
 * root, then perform the op against the guarded, extension-limited helpers. `root`
 * is the CALLER's workspace root, resolved host-side from the terminal id
 * (authoritative — the worker never supplies it, so a plugin can't target another
 * workspace).
 *
 * This is for plugin CODE running on the host, so the host user's GRANT is
 * required. The client-side editor path is {@link runPluginDocumentFsOp}.
 */
export async function runPluginFsOp(
    manifest: PluginManifest,
    grants: PluginGrants,
    root: string | null,
    op: PluginFsOp,
    params: Record<string, unknown>,
): Promise<PluginFsResult> {
    // (1) declared? (2) granted? (3) workspace resolved? — all fail-closed.
    const fsCap = manifest.capabilities?.fs;
    if (!fsCap || fsCap.scope !== 'workspace') {
        return deny('fs access is not declared for this plugin');
    }
    if (grants.fs.workspace !== true) {
        return deny('fs access is not granted to this plugin');
    }
    if (!root) {
        return deny('no workspace is resolved for this call');
    }
    return performFsOp(root, op, params, fsCap.extensions ?? []);
}

/**
 * The CLIENT-SIDE DOCUMENT fs gate (client/host split — see `side.ts`).
 *
 * A plugin editor is a client surface: the client picked the editor, and the
 * member already holds access to the workspace this `root` names. What the host
 * still owes is the SANDBOX, and here it is TIGHTER than the worker's:
 *
 *   - workspace-contained + size-capped (the same `resolvePluginPath` guard), and
 *   - limited to {@link clientEditorExtensions} — the types the plugin's OWN
 *     editor declares it opens, intersected with its declared workspace fs scope.
 *     A type the manifest grants fs access to but no editor claims is refused, as
 *     is a plugin with no `capabilities.fs.scope:'workspace'` at all.
 *
 * What it deliberately does NOT require is the host user's enable toggle or
 * capability GRANT: those are consent for the plugin's HOST code to run, and a
 * document editor runs none. TRUST is still required — the caller
 * (`editor-bridge`) resolves the manifest only from a trusted installed row or
 * Genie's own bundled sources.
 */
export async function runPluginDocumentFsOp(
    manifest: PluginManifest,
    root: string | null,
    op: PluginFsOp,
    params: Record<string, unknown>,
): Promise<PluginFsResult> {
    if (!root) return deny('no workspace is resolved for this call');
    const rel = String(params.rel ?? '');
    const exts = clientEditorExtensions(manifest, rel);
    if (exts.length === 0) {
        return deny('no editor in this plugin opens this file type inside the workspace');
    }
    return performFsOp(root, op, params, exts);
}
