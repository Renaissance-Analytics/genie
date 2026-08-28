import type { ViewType, ViewMeta, TerminalSpec } from './genie';

/**
 * PURE routing helpers for the plugin-editor seam (design §6.1 / §2.2). Two
 * decisions live here so they are unit-testable without a DOM:
 *
 *   1. `panelKindForSpecType` — which panel component `PanelFor` renders for a
 *      spec (the new 'plugin' branch beside 'code' and 'terminal').
 *   2. `specTypeForOpen` + `pluginSpecMeta` — the open-file receiver's decision:
 *      a plugin editor spec when the file's extension is claimed by an enabled
 *      plugin, else the default code editor (everything else unchanged).
 */

/** The panel component kind a view spec dispatches to. */
export type PanelKind = 'terminal' | 'agent' | 'code' | 'plugin' | 'plugin-panel';

/** Map a spec's `type` to its panel component kind. Drives PanelFor's dispatch. */
export function panelKindForSpecType(type: ViewType, meta: ViewMeta = {}): PanelKind {
    if (type === 'code') return 'code';
    if (type === 'plugin') return 'plugin';
    if (type === 'plugin-panel') return 'plugin-panel';
    if (type === 'terminal' && typeof meta.agent === 'string') return 'agent';
    return 'terminal';
}

/** A plugin-editor association resolved for an opened file (sent from main). */
export interface PluginEditorRef {
    pluginId: string;
    editorId: string;
    fancyExport: string;
    fancyPackage: string;
    fancyVersion: string;
}

/**
 * The spec type the open-file receiver creates for a file: a plugin editor when
 * the file's extension is claimed by an enabled plugin (main resolved a
 * `pluginEditor`), else the default fancy-code editor. Non-plugin extensions are
 * unchanged.
 */
export function specTypeForOpen(pluginEditor: PluginEditorRef | null | undefined): 'code' | 'plugin' {
    return pluginEditor ? 'plugin' : 'code';
}

/** Build the persisted meta for a plugin editor spec seeded on the opened file. */
export function pluginSpecMeta(
    pluginEditor: PluginEditorRef,
    relPath: string,
    system: boolean,
): ViewMeta {
    return {
        ...(system ? { system: true } : {}),
        plugin_id: pluginEditor.pluginId,
        editor_id: pluginEditor.editorId,
        file: relPath,
        fancy_export: pluginEditor.fancyExport,
        fancy_package: pluginEditor.fancyPackage,
        fancy_version: pluginEditor.fancyVersion,
    };
}

/**
 * A plugin PANEL contribution resolved for opening (sent from main via
 * `plugins.panels()`). Mirror of {@link PluginEditorRef} for the non-file panel
 * surface: the renderer mounts the declared Fancy component through the
 * compile-time adapter registry keyed by `fancyExport`.
 */
export interface PluginPanelRef {
    pluginId: string;
    panelId: string;
    title: string;
    icon?: string;
    fancyExport: string;
    fancyPackage: string;
    fancyVersion: string;
}

/** Build the persisted meta for a `plugin-panel` spec created from a launcher pick. */
export function pluginPanelSpecMeta(panel: PluginPanelRef, system: boolean): ViewMeta {
    return {
        ...(system ? { system: true } : {}),
        plugin_id: panel.pluginId,
        panel_id: panel.panelId,
        panel_title: panel.title,
        ...(panel.icon ? { panel_icon: panel.icon } : {}),
        fancy_export: panel.fancyExport,
        fancy_package: panel.fancyPackage,
        fancy_version: panel.fancyVersion,
    };
}

/**
 * Choose an already-open plugin-editor panel to REUSE for an open-file request,
 * or null when a new one should be created. A candidate is a selected (mounted)
 * `type:'plugin'` spec for the same plugin + the same file. Pure → testable.
 */
export function pickReusePluginPanel(
    specs: TerminalSpec[],
    target: { pluginId: string; file: string },
    selected: ReadonlySet<string>,
): string | null {
    const match = specs.find(
        (s) =>
            s.type === 'plugin' &&
            selected.has(s.id) &&
            s.meta?.plugin_id === target.pluginId &&
            s.meta?.file === target.file,
    );
    return match ? match.id : null;
}
