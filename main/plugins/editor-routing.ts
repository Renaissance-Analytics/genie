/**
 * Extension -> plugin editor routing (design §6.1). Builds the "which editor
 * opens this file" decision from every ENABLED plugin's declared `editors[]`
 * file-type mapping. The open-file flow (main/editor/open-file.ts) consults this
 * at the single choke point: a claimed extension routes to a `type:'plugin'`
 * spec, an unclaimed one falls through to the default fancy-code editor.
 *
 * This is a CLIENT-side decision (see `side.ts`): it reads the plugin registry of
 * whichever Genie the user is sitting at, and `remote-bridge` deliberately keeps
 * `editorFor` local rather than asking the host which editor to use.
 *
 * Fail-closed: a disabled or malformed plugin contributes NOTHING to the map,
 * and any unexpected error degrades to "no plugin editor" (default code editor).
 */
import { listEnabledPlugins, type PluginRow } from '../db';
import { manifestContributions, validatePluginManifest, type PluginManifest } from './manifest';
import { pluginRowIsSurfaceable } from './trust';
import { pluginFileExtension } from './side';

/** A plugin editor resolved for a file's extension. */
export interface ResolvedPluginEditor {
    pluginId: string;
    editorId: string;
    /** The declared first-party Fancy component export (e.g. 'DeckEditor'). */
    fancyExport: string;
    fancyPackage: string;
    fancyVersion: string;
}

function manifestOf(plugin: PluginRow): PluginManifest | null {
    try {
        const res = validatePluginManifest(JSON.parse(plugin.manifest_json));
        return res.ok ? res.manifest : null;
    } catch {
        return null;
    }
}

/**
 * PURE: the first enabled plugin whose editor claims `fileName`'s extension.
 * First match wins (install-time conflict resolution is the earlier concern);
 * an unclaimed extension returns null so the caller keeps the code editor.
 */
export function matchEditorForExtension(
    plugins: PluginRow[],
    fileName: string,
): ResolvedPluginEditor | null {
    const ext = pluginFileExtension(fileName);
    if (!ext) return null;
    for (const plugin of plugins) {
        const manifest = manifestOf(plugin);
        if (!manifest) continue; // fail-closed: skip a malformed plugin
        for (const editor of manifestContributions(manifest).editors) {
            const exts = (editor.extensions ?? []).map((e) => e.toLowerCase());
            if (exts.includes(ext)) {
                return {
                    pluginId: plugin.id,
                    editorId: editor.id,
                    fancyExport: editor.fancyEditor.export,
                    fancyPackage: editor.fancyEditor.package,
                    fancyVersion: editor.fancyEditor.version,
                };
            }
        }
    }
    return null;
}

/**
 * DB-backed resolver the open-file flow injects. Reads the live enabled-plugin
 * set each call so an enable/disable takes effect immediately. Fail-closed.
 */
export function resolvePluginEditor(fileName: string): ResolvedPluginEditor | null {
    try {
        // Trust gate (Phase 3): only trusted / dev-approved plugins may own a file
        // type. An untrusted plugin never captures the open flow (fail-closed).
        const surfaceable = listEnabledPlugins().filter(pluginRowIsSurfaceable);
        return matchEditorForExtension(surfaceable, fileName);
    } catch {
        return null;
    }
}
