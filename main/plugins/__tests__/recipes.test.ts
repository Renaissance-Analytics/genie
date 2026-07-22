import { describe, expect, it } from 'vitest';
import { collectPluginRecipes, RECIPE_CAPABILITY, type ResolvedPluginRecipe } from '../recipes';
import type { PluginRow } from '../../db';
import { emptyPluginGrants } from '../../db';

/**
 * The recipe registry (mirrors editor-routing §6.1): a surfaceable plugin that
 * HOLDS the `recipes` Genie-API grant contributes its declared recipes as
 * launchable wizards; a malformed manifest, or a plugin that lacks the grant,
 * contributes NOTHING (fail-closed + permission-gated).
 */

function row(
    id: string,
    namespace: string,
    manifest: Record<string, unknown>,
    grantRecipes: boolean,
): PluginRow {
    const grants = emptyPluginGrants();
    if (grantRecipes) grants.genieApi[RECIPE_CAPABILITY] = true;
    return {
        id,
        namespace,
        name: id,
        version: '1.0.0',
        source_type: 'folder',
        source_url: null,
        source_ref: null,
        install_path: `/plugins/${id}`,
        marketplace_id: null,
        enabled: true,
        manifest_json: JSON.stringify(manifest),
        grants,
        integrity: null,
        signature: null,
        publisher_key_id: null,
        trust: 'trusted',
        dev_approved: false,
        installed_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    };
}

function recipeManifest(namespace: string): Record<string, unknown> {
    return {
        id: `com.example.${namespace}`,
        namespace,
        name: namespace,
        version: '1.0.0',
        capabilities: { genieApi: ['recipes'] },
        recipes: [
            {
                id: 'deploy',
                title: 'Deploy',
                steps: [
                    { type: 'terminal', id: 'run', title: 'Run', command: 'echo', args: ['hi'] },
                ],
            },
        ],
    };
}

describe('collectPluginRecipes', () => {
    it('surfaces recipes from a granted, valid plugin (namespaced launch id)', () => {
        const rows = [row('com.example.deployer', 'deployer', recipeManifest('deployer'), true)];
        const out = collectPluginRecipes(rows) as ResolvedPluginRecipe[];
        expect(out).toHaveLength(1);
        expect(out[0].pluginId).toBe('com.example.deployer');
        expect(out[0].namespace).toBe('deployer');
        expect(out[0].recipe.id).toBe('deploy');
        expect(out[0].launchId).toBe('deployer.deploy');
    });

    it('skips a plugin that lacks the recipes grant (permission gate)', () => {
        const rows = [row('com.example.deployer', 'deployer', recipeManifest('deployer'), false)];
        expect(collectPluginRecipes(rows)).toHaveLength(0);
    });

    it('fails closed on a malformed manifest', () => {
        const broken = { ...row('x', 'x', recipeManifest('x'), true), manifest_json: '{ not json' };
        expect(collectPluginRecipes([broken])).toHaveLength(0);
    });

    it('skips a plugin whose manifest fails validation', () => {
        // recipes present but the required genieApi permission is missing → invalid.
        const bad = recipeManifest('deployer');
        bad.capabilities = { genieApi: [] };
        const rows = [row('com.example.deployer', 'deployer', bad, true)];
        expect(collectPluginRecipes(rows)).toHaveLength(0);
    });

    it('collects across multiple granted plugins', () => {
        const rows = [
            row('com.example.a', 'a', recipeManifest('a'), true),
            row('com.example.b', 'b', recipeManifest('b'), true),
        ];
        const out = collectPluginRecipes(rows);
        expect(out.map((r) => r.launchId).sort()).toEqual(['a.deploy', 'b.deploy']);
    });
});
