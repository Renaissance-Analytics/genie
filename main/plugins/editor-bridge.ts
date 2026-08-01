/**
 * The BINARY file bridge for plugin editors (design §6.2 / §12.4) — the HOST end
 * of a CLIENT-side document surface.
 *
 * A plugin editor is client-side (see `side.ts`): the client routes the file to a
 * first-party Fancy component and renders it in the user's own window. The host's
 * only job is the document's BYTES — the general `files:*` surface is text-only
 * (it rejects binary), so this exposes a NARROW base64 read/write, available only
 * through the plugin editor path, never on `window.genie.files`.
 *
 * AUTHORIZATION (two halves, deliberately separated):
 *   - TRUST is the host's: the manifest must come from an installed row that is
 *     trusted / dev-approved, or from Genie's OWN bundled first-party sources
 *     (trusted by construction — they are materialised from the signed app
 *     bundle, so the host always has them whether or not this machine's user ever
 *     installed them). A tampered or unapproved-unsigned plugin is refused.
 *   - ENABLEMENT is NOT required. Whether an editor plugin is switched on, and
 *     which capabilities it was granted, is consent for the plugin's HOST code
 *     (its MCP tools) to run — a document editor runs none. Demanding it here is
 *     what made every remote `.md` fail with "plugin file operation failed"
 *     (`getPlugin() → null`, or a row that was off, or a headless host's enabled
 *     row with empty grants).
 *
 * The SANDBOX is unchanged and in fact tighter: `runPluginDocumentFsOp` keeps the
 * workspace guard + size cap and limits the extensions to what THIS plugin's own
 * editor declares it opens. Fail-closed on every failure.
 *
 * `root` is the editor panel's workspace root — host-derived when the file was
 * first opened (planOpenFile) and carried on the spec, mirroring how the existing
 * `files:*` IPC trusts the renderer-supplied workspace path for first-party views.
 * The remote route additionally checks it against the host's own workspace list.
 */
import { ipcMain } from 'electron';
import { getPlugin } from '../db';
import { validatePluginManifest, type PluginManifest } from './manifest';
import { runPluginDocumentFsOp, type PluginFsResult } from './fs-bridge';
import { pluginRowIsTrusted } from './trust';
import { resolvePluginEditor } from './editor-routing';
import { bundledPluginManifest } from './official';

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

/** A validated bundled first-party manifest, or null when `id` isn't bundled. */
function bundledManifest(id: string): PluginManifest | null {
    const raw = bundledPluginManifest(id);
    if (!raw) return null;
    const res = validatePluginManifest(raw);
    return res.ok ? res.manifest : null;
}

/**
 * The manifest the host will authorise a CLIENT editor's document I/O against —
 * TRUST only, never enablement.
 *
 * An installed row must pass the provenance gate; a first-party BUNDLED plugin
 * needs no row at all, because its manifest ships inside Genie. A row that IS
 * present but untrusted is refused outright — the bundled sources are never a
 * back door around a tamper verdict.
 */
function editorManifestFor(pluginId: string): { manifest: PluginManifest } | { error: string } {
    const row = getPlugin(pluginId);
    if (row && !pluginRowIsTrusted(row)) return { error: 'plugin is not trusted' };
    const manifest = (row ? manifestOf(row.manifest_json) : null) ?? bundledManifest(pluginId);
    if (!manifest) return { error: row ? 'invalid plugin manifest' : 'unknown plugin' };
    return { manifest };
}

/**
 * Resolve a trusted editor manifest, then run the guarded document fs op.
 * Exported (not just the IPC handler) so it is unit-testable without Electron.
 */
export async function runPluginEditorFs(
    pluginId: string,
    root: string,
    relPath: string,
    op: 'fs.readBytes' | 'fs.writeBytes',
    base64?: string,
): Promise<PluginFsResult> {
    const resolved = editorManifestFor(String(pluginId));
    if ('error' in resolved) return deny(resolved.error);
    const params: Record<string, unknown> = { rel: String(relPath) };
    if (op === 'fs.writeBytes') params.base64 = String(base64 ?? '');
    return runPluginDocumentFsOp(resolved.manifest, String(root), op, params);
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
    // Which enabled plugin's editor claims this file, if any (§6.1). The treenav
    // asks this BEFORE text-opening a file so claimed binary formats (.pptx,
    // .xlsx, …) route to their plugin editor panel, never the text reader.
    ipcMain.handle('plugins:editor-for', (_e, fileName: string) =>
        resolvePluginEditor(String(fileName ?? '')),
    );
}
