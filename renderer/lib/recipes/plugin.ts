import { api, type PluginRecipeStepView, type PluginRecipeView } from '../genie';
import { demoRecipe } from './demo';
import type { Recipe, RecipeField, RecipeOption, RecipeStep } from './types';

/**
 * Bridge from a plugin's DECLARED (serializable) recipe manifest — as delivered
 * over IPC by the recipe registry — to a runtime `Recipe` the WizardModal runs.
 * The declarative subset (form/choice/terminal/browser with a string url) maps
 * 1:1 onto the runtime step types; a plugin recipe never carries the
 * function-valued fields (task.run, browser.check, onComplete) that only
 * first-party in-code recipes use.
 */

function toField(f: NonNullable<PluginRecipeStepView['fields']>[number]): RecipeField {
    return {
        key: f.key,
        label: f.label,
        type: f.type,
        placeholder: f.placeholder,
        description: f.description,
        required: f.required,
        options: f.options as RecipeOption[] | undefined,
        defaultValue: f.defaultValue,
    };
}

function toStep(s: PluginRecipeStepView): RecipeStep {
    switch (s.type) {
        case 'form':
            return { type: 'form', id: s.id, title: s.title, fields: (s.fields ?? []).map(toField) };
        case 'choice':
            return {
                type: 'choice',
                id: s.id,
                title: s.title,
                options: (s.options ?? []) as RecipeOption[],
                multi: s.multi,
            };
        case 'terminal':
            return {
                type: 'terminal',
                id: s.id,
                title: s.title,
                command: s.command ?? '',
                args: s.args,
                cwd: s.cwd,
                until: s.until,
                capture: s.capture,
            };
        case 'browser':
            return { type: 'browser', id: s.id, title: s.title, url: s.url ?? '' };
    }
}

/** Reconstitute a plugin recipe view into a launchable runtime Recipe. */
export function pluginRecipeToRecipe(view: PluginRecipeView): Recipe {
    return {
        // Key by the namespaced launchId so plugin recipes never collide with a
        // built-in recipe id (or each other).
        id: view.launchId,
        title: view.recipe.title,
        steps: view.recipe.steps.map(toStep),
    };
}

/** A recipe the launcher can offer, from either a built-in or a plugin. */
export interface LaunchableRecipe {
    launchId: string;
    title: string;
    source: 'builtin' | 'plugin';
    /** For plugin recipes, the contributing plugin's display name. */
    pluginName?: string;
    recipe: Recipe;
}

/**
 * The launcher registry: the built-in recipes plus every plugin-contributed
 * recipe the main-side registry surfaces (enabled + `recipes`-granted plugins).
 * Fail-soft — if the plugin IPC is unavailable, only the built-ins are returned.
 */
export async function listLaunchableRecipes(): Promise<LaunchableRecipe[]> {
    const out: LaunchableRecipe[] = [
        { launchId: 'demo', title: demoRecipe.title, source: 'builtin', recipe: demoRecipe },
    ];
    try {
        const contributed = await api().plugins.recipes();
        for (const v of contributed) {
            out.push({
                launchId: v.launchId,
                title: v.recipe.title,
                source: 'plugin',
                pluginName: v.pluginName,
                recipe: pluginRecipeToRecipe(v),
            });
        }
    } catch {
        /* no plugin recipes available — built-ins only */
    }
    return out;
}
