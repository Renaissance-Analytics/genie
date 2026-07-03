/**
 * The renderer-facing BINARY file bridge for plugin editors (design §6.2 / §12.4).
 *
 * `PluginEditorHost` (a first-party Fancy editor in the renderer) opens/saves the
 * binary document (`.pptx`/`.xlsx`) it was routed for. The general `files:*`
 * surface is text-only (it rejects binary), so this exposes a NARROW,
 * capability-scoped base64 read/write — available ONLY to a granted plugin, never
 * on `window.genie.files`. Every op funnels through the SAME Phase-1
 * `runPluginFsOp` gate: the plugin must DECLARE `fs.scope:'workspace'`, the user
 * must have GRANTED it, and the path is guard-resolved + extension-limited exactly
 * like the worker's fs bridge. Fail-closed on every failure.
 *
 * `root` is the editor panel's workspace root — host-derived when the file was
 * first opened (planOpenFile) and carried on the spec, mirroring how the existing
 * `files:*` IPC trusts the renderer-supplied workspace path for first-party views.
 */
import { ipcMain } from 'electron';
import { getPlugin } from '../db';
import { validatePluginManifest, type PluginManifest } from './manifest';
import { runPluginFsOp, type PluginFsResult } from './fs-bridge';

function deny(error: string): PluginFsResult {
    return { ok: false, error };
}

function manifestOf(manifestJson: string): PluginManifest | null {
    try {
        const res = validatePluginManifest(JSON.parse(manifestJson));
        return res.ok ? res.manifest : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the enabled plugin + its manifest, then run a guarded binary fs op.
 * Exported (not just the IPC handler) so it is unit-testable without Electron.
 */
export async function runPluginEditorFs(
    pluginId: string,
    root: string,
    relPath: string,
    op: 'fs.readBytes' | 'fs.writeBytes',
    base64?: string,
): Promise<PluginFsResult> {
    const row = getPlugin(String(pluginId));
    if (!row) return deny('unknown plugin');
    if (!row.enabled) return deny('plugin is not enabled');
    const manifest = manifestOf(row.manifest_json);
    if (!manifest) return deny('invalid plugin manifest');
    const params: Record<string, unknown> = { rel: String(relPath) };
    if (op === 'fs.writeBytes') params.base64 = String(base64 ?? '');
    return runPluginFsOp(manifest, row.grants, String(root), op, params);
}

/** Register the plugin-editor binary bridge IPC. Call once at app-ready. */
export function registerPluginEditorBridge(): void {
    ipcMain.handle(
        'plugins:editor-read',
        (_e, pluginId: string, root: string, relPath: string) =>
            runPluginEditorFs(pluginId, root, relPath, 'fs.readBytes'),
    );
    ipcMain.handle(
        'plugins:editor-write',
        (_e, pluginId: string, root: string, relPath: string, base64: string) =>
            runPluginEditorFs(pluginId, root, relPath, 'fs.writeBytes', base64),
    );
}
