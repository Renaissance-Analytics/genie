/**
 * WHERE a plugin's surfaces run: the CLIENT / HOST split.
 *
 * A Genie plugin is not wholly "client" or "host" — its individual SURFACES are,
 * and conflating the two is what broke remote document editing:
 *
 *   - `editors[]`  → a CLIENT surface. The plugin ships no editor code (§12.2 —
 *     it DECLARES a first-party Fancy component + the file types it opens); the
 *     component renders in whichever window the user is sitting at. Which editor
 *     claims a file, and whether the user wants that editor at all, are the
 *     CLIENT's decisions ({@link ../plugins/editor-routing} runs client-side, and
 *     `remote-bridge` deliberately keeps `editorFor` local).
 *
 *   - `mcpTools[]` / `recipes[]` → HOST surfaces. That code RUNS on the host: the
 *     worker executes tool handlers against the host filesystem, recipes spawn
 *     host terminals. Enabling them, and granting their capabilities, is the HOST
 *     user's decision, and stays fully gated (`pluginRowIsSurfaceable`).
 *
 * So over a remote connection the host is asked for ONE thing on behalf of a
 * client editor: the document's BYTES. It must not demand that the client's
 * editor plugin also be switched on locally — but it must still sandbox the read
 * (see `editor-bridge.ts` → `runPluginDocumentFsOp`).
 *
 * PURE: no Electron, no DB, no fs — so the classification is unit-testable and
 * usable from both the desktop shell and a headless host.
 */

import type { PluginManifest, PluginEditorMapping } from './manifest';

/** Which sides of the split a manifest's declared surfaces land on. */
export interface PluginSides {
    /** Declares editors/viewers → renders in the CLIENT window. */
    client: boolean;
    /** Declares MCP tools or recipes → runs code on the HOST. */
    host: boolean;
}

/** Classify a manifest's surfaces. A plugin may be both (e.g. Presentation). */
export function pluginSides(manifest: PluginManifest): PluginSides {
    return {
        client: (manifest.editors ?? []).length > 0,
        host: (manifest.mcpTools ?? []).length > 0 || (manifest.recipes ?? []).length > 0,
    };
}

/**
 * Does this plugin need to be ENABLED (and consent-granted) on the machine that
 * hosts the workspace? Only if it has a HOST surface — a client-side editor is
 * the client's business, and gating it on a host toggle is the bug this split
 * fixes. Drives the Settings copy so the model is legible, not just enforced.
 */
export function requiresHostEnablement(manifest: PluginManifest): boolean {
    return pluginSides(manifest).host;
}

/** Lowercased dotted extension of a path/filename (e.g. '.pptx'), or '' if none. */
export function pluginFileExtension(fileName: string): string {
    const base = fileName.split(/[\\/]/).pop() ?? fileName;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** The plugin's own editor that claims `fileName`'s type, or null. */
export function editorClaiming(
    manifest: PluginManifest,
    fileName: string,
): PluginEditorMapping | null {
    const ext = pluginFileExtension(fileName);
    if (!ext) return null;
    for (const editor of manifest.editors ?? []) {
        if ((editor.extensions ?? []).some((e) => e.toLowerCase() === ext)) return editor;
    }
    return null;
}

/**
 * The extension allow-list the host will serve to a CLIENT editor for `fileName`:
 * the claiming editor's declared types INTERSECT the manifest's declared
 * workspace fs scope. Strictly TIGHTER than the worker's allow-list — a plugin
 * can declare fs access to types none of its editors open (or no fs scope at
 * all), and the document path serves neither.
 *
 * EMPTY means "not authorised" — and an empty list is itself fail-closed at
 * `resolvePluginPath`, so a caller that forgets to check still denies.
 */
export function clientEditorExtensions(manifest: PluginManifest, fileName: string): string[] {
    const editor = editorClaiming(manifest, fileName);
    if (!editor) return [];
    const fsCap = manifest.capabilities?.fs;
    if (!fsCap || fsCap.scope !== 'workspace') return [];
    const declared = new Set((fsCap.extensions ?? []).map((e) => e.toLowerCase()));
    return (editor.extensions ?? [])
        .map((e) => e.toLowerCase())
        .filter((e) => declared.has(e));
}
