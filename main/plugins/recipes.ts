/**
 * Plugin recipe registry (mirrors editor-routing §6.1). Builds the launchable
 * set of recipes the WizardModal launcher offers, drawn from every ENABLED +
 * SURFACEABLE plugin that DECLARES `recipes[]` AND HOLDS the grantable `recipes`
 * Genie-API permission the user consented to at enable-time.
 *
 * Fail-closed on every axis: a disabled / untrusted plugin never reaches here
 * (pluginRowIsSurfaceable), a malformed manifest is skipped, and a plugin that
 * declares recipes but was NOT granted the `recipes` capability contributes
 * NOTHING. Any unexpected error degrades to "no plugin recipes".
 */
import { listEnabledPlugins, type PluginRow } from '../db';
import {
    RECIPE_CAPABILITY,
    validatePluginManifest,
    type PluginManifest,
    type PluginRecipeManifest,
} from './manifest';
import { pluginRowIsSurfaceable } from './trust';

/** A plugin recipe resolved into a launchable entry for the renderer. */
export interface ResolvedPluginRecipe {
    pluginId: string;
    pluginName: string;
    namespace: string;
    /** Namespaced, collision-free launch id: `${namespace}.${recipe.id}`. */
    launchId: string;
    /** The declared (serializable) recipe the renderer reconstitutes + runs. */
    recipe: PluginRecipeManifest;
}

export { RECIPE_CAPABILITY } from './manifest';

function manifestOf(plugin: PluginRow): PluginManifest | null {
    try {
        const res = validatePluginManifest(JSON.parse(plugin.manifest_json));
        return res.ok ? res.manifest : null;
    } catch {
        return null;
    }
}

/**
 * PURE: collect the launchable recipes from a set of plugin rows. Skips a
 * malformed manifest and any plugin that lacks the `recipes` grant (the
 * permission gate). First-declared wins on a launchId clash across plugins.
 */
export function collectPluginRecipes(plugins: PluginRow[]): ResolvedPluginRecipe[] {
    const out: ResolvedPluginRecipe[] = [];
    const seen = new Set<string>();
    for (const plugin of plugins) {
        // Permission gate: the plugin must HOLD the granted `recipes` capability.
        if (plugin.grants.genieApi[RECIPE_CAPABILITY] !== true) continue;
        const manifest = manifestOf(plugin);
        if (!manifest) continue; // fail-closed: skip a malformed plugin
        for (const recipe of manifest.recipes ?? []) {
            const launchId = `${plugin.namespace}.${recipe.id}`;
            if (seen.has(launchId)) continue;
            seen.add(launchId);
            out.push({
                pluginId: plugin.id,
                pluginName: plugin.name,
                namespace: plugin.namespace,
                launchId,
                recipe,
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
export function listPluginRecipes(): ResolvedPluginRecipe[] {
    try {
        const surfaceable = listEnabledPlugins().filter(pluginRowIsSurfaceable);
        return collectPluginRecipes(surfaceable);
    } catch {
        return [];
    }
}

/** Resolve one launchable recipe by its namespaced launch id, or null. */
export function resolvePluginRecipe(launchId: string): ResolvedPluginRecipe | null {
    return listPluginRecipes().find((r) => r.launchId === launchId) ?? null;
}
