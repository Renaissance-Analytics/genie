/**
 * WHICH MACHINE a plugin's surfaces run on: the CLIENT / HOST split.
 *
 * This adds NO manifest field and NO new runtime. It names, in one place, the
 * split the existing surface registries already draw — so the two sides can be
 * enforced on their own terms instead of one gate standing in for both:
 *
 *   - `editors[]` → a CLIENT surface, served by `editor-routing.ts` (which editor
 *     claims a file type) and `editor-bridge.ts` (the renderer-facing document
 *     I/O). The plugin ships no editor code (§12.2 — it DECLARES a first-party
 *     Fancy component plus the file types it opens), so the component renders in
 *     whichever window the user is sitting at. `remote-bridge` already treats it
 *     this way: it keeps `editorFor` client-local and forwards only the bytes.
 *   - `panels[]` → also a CLIENT surface, served by `panels.ts` (which panels a
 *     workspace can open) and rendered by `PluginPanelHost` through the renderer's
 *     compile-time adapter registry. Like editors, the plugin ships no UI code;
 *     any host work a panel triggers (the repo panel's git ops) runs through CORE
 *     Genie IPC, not the plugin worker sandbox (first-party-with-a-plugin-seam).
 *
 *   - `mcpTools[]` → a HOST surface, served by `registry.ts`
 *     (`pluginToolDescriptors` / tool dispatch / `pluginAgentSkills`, each gated
 *     on `pluginRowIsSurfaceable`) and executed by `worker-host.ts`.
 *   - `recipes[]` → a HOST surface, served by `recipes.ts` (same gate); its
 *     terminal steps spawn processes on the machine holding the workspace.
 *
 * `host` here therefore means exactly "the set `registry.ts` + `recipes.ts`
 * surface". Note the deliberate distinction from `worker-host.ts`, where "host"
 * is the MAIN PROCESS hosting the utility-process worker — a different axis
 * (which process) from this one (which machine). Both host surfaces above run in
 * the main process AND on the host machine, so the two readings never disagree
 * about a plugin; they just answer different questions.
 *
 * A plugin is commonly BOTH — Presentation contributes a deck editor and
 * `presentation.createDeck` — which is why the classification is per-surface and
 * never a single label on the plugin.
 *
 * Over a remote connection the host is asked for ONE thing on behalf of a client
 * editor: the document's BYTES. It must not demand that the client's editor
 * plugin also be switched on locally — but it must still sandbox the read (see
 * `editor-bridge.ts` → `runPluginDocumentFsOp`).
 *
 * PURE: no Electron, no DB, no fs — so the classification is unit-testable and
 * usable from both the desktop shell and a headless host.
 */

import { manifestContributions, type PluginManifest, type PluginEditorMapping } from './manifest';

/** Which sides of the split a manifest's declared surfaces land on. */
export interface PluginSides {
    /** Declares editors/viewers → renders in the CLIENT window. */
    client: boolean;
    /** Declares MCP tools or recipes → runs code on the HOST. */
    host: boolean;
}

/** Classify a manifest's surfaces. A plugin may be both (e.g. Presentation). */
export function pluginSides(manifest: PluginManifest): PluginSides {
    const c = manifestContributions(manifest);
    return {
        client: c.editors.length > 0 || c.panels.length > 0,
        host: c.mcpTools.length > 0 || c.recipes.length > 0,
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
    for (const editor of manifestContributions(manifest).editors) {
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
