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
 * Enforce the plugin's fs grant + scope + per-call root, then perform the op
 * against the guarded, extension-limited helpers. `root` is the CALLER's
 * workspace root, resolved host-side from the terminal id (authoritative — the
 * worker never supplies it, so a plugin can't target another workspace).
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
    const exts = fsCap.extensions ?? [];
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
