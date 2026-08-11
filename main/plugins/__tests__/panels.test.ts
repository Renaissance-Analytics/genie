import { describe, expect, it } from 'vitest';
import { collectPluginPanels, PANEL_CAPABILITY, type ResolvedPluginPanel } from '../panels';
import type { PluginRow } from '../../db';
import { emptyPluginGrants } from '../../db';

/**
 * The panel registry (mirrors recipes.ts / editor-routing §6.1): a surfaceable
 * plugin that HOLDS the `ui.panel` Genie-API grant contributes its declared
 * panels as launchable workspace panels; a malformed manifest, or a plugin that
 * lacks the grant, contributes NOTHING (fail-closed + permission-gated).
 */

function row(
    id: string,
    namespace: string,
    manifest: Record<string, unknown>,
    grantPanel: boolean,
): PluginRow {
    const grants = emptyPluginGrants();
    if (grantPanel) grants.genieApi[PANEL_CAPABILITY] = true;
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

function panelManifest(namespace: string): Record<string, unknown> {
    return {
        id: `com.example.${namespace}`,
        namespace,
        name: namespace,
        version: '1.0.0',
        capabilities: { genieApi: ['ui.panel'] },
        panels: [
            {
                id: 'changes',
                title: 'Repository',
                icon: 'git-branch',
                fancyComponent: {
                    package: '@particle-academy/fancy-git-ui',
                    version: '>=0.5.0',
                    export: 'RepoChangesPanel',
                },
            },
        ],
    };
}

describe('collectPluginPanels', () => {
    it('surfaces panels from a granted, valid plugin (namespaced launch id)', () => {
        const rows = [row('com.example.repo', 'repository', panelManifest('repository'), true)];
        const out = collectPluginPanels(rows) as ResolvedPluginPanel[];
        expect(out).toHaveLength(1);
        expect(out[0].pluginId).toBe('com.example.repo');
        expect(out[0].namespace).toBe('repository');
        expect(out[0].panel.id).toBe('changes');
        expect(out[0].panel.fancyComponent.export).toBe('RepoChangesPanel');
        expect(out[0].launchId).toBe('repository.changes');
    });

    it('skips a plugin that lacks the ui.panel grant (permission gate)', () => {
        const rows = [row('com.example.repo', 'repository', panelManifest('repository'), false)];
        expect(collectPluginPanels(rows)).toHaveLength(0);
    });

    it('fails closed on a malformed manifest', () => {
        const broken = { ...row('x', 'x', panelManifest('x'), true), manifest_json: '{ not json' };
        expect(collectPluginPanels([broken])).toHaveLength(0);
    });

    it('skips a plugin whose manifest fails validation', () => {
        const bad = panelManifest('repository');
        bad.capabilities = { genieApi: [] }; // panels present but grant missing → invalid
        const rows = [row('com.example.repo', 'repository', bad, true)];
        expect(collectPluginPanels(rows)).toHaveLength(0);
    });

    it('collects across multiple granted plugins', () => {
        const rows = [
            row('com.example.a', 'a', panelManifest('a'), true),
            row('com.example.b', 'b', panelManifest('b'), true),
        ];
        const out = collectPluginPanels(rows);
        expect(out.map((p) => p.launchId).sort()).toEqual(['a.changes', 'b.changes']);
    });
});
