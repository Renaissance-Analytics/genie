/**
 * Plugin PANEL registry (mirrors recipes.ts / editor-routing §6.1). Builds the
 * launchable set of workspace panels the Add-view launcher offers, drawn from
 * every ENABLED + SURFACEABLE plugin that DECLARES `panels[]` AND HOLDS the
 * grantable `ui.panel` Genie-API permission the user consented to at enable-time.
 *
 * A panel is a CLIENT surface (`side.ts`): it renders in the window the user is
 * sitting at (like an editor), resolving its declared Fancy component through a
 * COMPILE-TIME adapter registry — the renderer cannot dynamically import an
 * arbitrary package, so the vetting happens in that registry, not here.
 *
 * Fail-closed on every axis: a disabled / untrusted plugin never reaches here
 * (pluginRowIsSurfaceable), a malformed manifest is skipped, and a plugin that
 * declares panels but was NOT granted the `ui.panel` capability contributes
 * NOTHING. Any unexpected error degrades to "no plugin panels".
 */
import { listEnabledPlugins, type PluginRow } from '../db';
import {
    PANEL_CAPABILITY,
    validatePluginManifest,
    type PluginManifest,
    type PluginPanelContribution,
} from './manifest';
import { pluginRowIsSurfaceable } from './trust';

/** A plugin panel resolved into a launchable entry for the renderer. */
export interface ResolvedPluginPanel {
    pluginId: string;
    pluginName: string;
    namespace: string;
    /** Namespaced, collision-free launch id: `${namespace}.${panel.id}`. */
    launchId: string;
    /** The declared panel the renderer mounts (via the compile-time adapter registry). */
    panel: PluginPanelContribution;
}

export { PANEL_CAPABILITY } from './manifest';

function manifestOf(plugin: PluginRow): PluginManifest | null {
    try {
        const res = validatePluginManifest(JSON.parse(plugin.manifest_json));
        return res.ok ? res.manifest : null;
    } catch {
        return null;
    }
}

/**
 * PURE: collect the launchable panels from a set of plugin rows. Skips a
 * malformed manifest and any plugin that lacks the `ui.panel` grant (the
 * permission gate). First-declared wins on a launchId clash across plugins.
 */
export function collectPluginPanels(plugins: PluginRow[]): ResolvedPluginPanel[] {
    const out: ResolvedPluginPanel[] = [];
    const seen = new Set<string>();
    for (const plugin of plugins) {
        // Permission gate: the plugin must HOLD the granted `ui.panel` capability.
        if (plugin.grants.genieApi[PANEL_CAPABILITY] !== true) continue;
        const manifest = manifestOf(plugin);
        if (!manifest) continue; // fail-closed: skip a malformed plugin
        for (const panel of manifest.panels ?? []) {
            const launchId = `${plugin.namespace}.${panel.id}`;
            if (seen.has(launchId)) continue;
            seen.add(launchId);
            out.push({
                pluginId: plugin.id,
                pluginName: plugin.name,
                namespace: plugin.namespace,
                launchId,
                panel,
            });
        }
    }
    return out;
}

/**
 * DB-backed registry the launcher reads. Reads the live enabled + surfaceable
 * plugin set each call so an enable/disable/grant-change takes effect
 * immediately. Fail-closed on any error.
 */
export function listPluginPanels(): ResolvedPluginPanel[] {
    try {
        const surfaceable = listEnabledPlugins().filter(pluginRowIsSurfaceable);
        return collectPluginPanels(surfaceable);
    } catch {
        return [];
    }
}

/** Resolve one launchable panel by its namespaced launch id, or null. */
export function resolvePluginPanel(launchId: string): ResolvedPluginPanel | null {
    return listPluginPanels().find((p) => p.launchId === launchId) ?? null;
}
