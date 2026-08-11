import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import {
    BUNDLED_PLUGIN_SOURCES,
    isBundledPluginId,
    bundledPluginManifest,
    materialiseBundled,
    listBundledPlugins,
} from '../official';
import { PLUGIN_MANIFEST_FILENAME, validatePluginManifest, type PluginManifest } from '../manifest';
import { collectPluginPanels, PANEL_CAPABILITY } from '../panels';
import { emptyPluginGrants, type PluginRow } from '../../db';

/**
 * The bundled first-party "Repository" plugin (repo-management) — genie #63 line.
 *
 * Repository ships BUNDLED exactly like Presentation/Spreadsheet/Document (embedded
 * in `official.ts`, materialised to disk), so it appears in Settings → Plugins with
 * no marketplace. As of the plugin-panel surface it is a PANEL plugin: it declares
 * a vetted, Genie-bundled Fancy git component (the primary UX), gated by the
 * grantable `ui.panel` capability; its git EXECUTION is core host IPC (main/repo/*),
 * so it declares no MCP tools and — deliberately — no recipes. This suite pins:
 * it is bundled + first-party, its manifest validates, it declares the `ui.panel`
 * capability + the Changes panel, it materialises to disk with the panel intact,
 * and — once granted — it surfaces the panel as launchable while contributing
 * NOTHING without the grant.
 */

const REPO_ID = 'ai.genie.repository';

const repoSource = () => BUNDLED_PLUGIN_SOURCES.find((b) => b.id === REPO_ID);

describe('Repository bundled plugin — embedded source', () => {
    it('is bundled + recognised as first-party', () => {
        const src = repoSource();
        expect(src).toBeTruthy();
        expect(src!.name).toBe('Repository');
        expect(isBundledPluginId(REPO_ID)).toBe(true);
        expect(bundledPluginManifest(REPO_ID)).not.toBeNull();
    });

    it('has a manifest that VALIDATES against the strict schema', () => {
        const res = validatePluginManifest(repoSource()!.manifest);
        expect(res.ok).toBe(true);
    });

    it('declares the grantable `ui.panel` capability (else the panel cannot surface)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        expect(manifest.capabilities?.genieApi).toContain(PANEL_CAPABILITY);
    });

    it('declares a Changes panel mounting a vetted Genie-bundled Fancy git component', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        const panels = manifest.panels ?? [];
        expect(panels.map((p) => p.id)).toContain('changes');
        const changes = panels.find((p) => p.id === 'changes')!;
        expect(changes.fancyComponent.package).toBe('@particle-academy/fancy-git-ui');
        expect(changes.fancyComponent.export).toBe('RepoChangesPanel');
    });

    it('registers NO MCP tools and NO recipes (git runs as core host IPC, not a sandbox)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        expect(manifest.mcpTools ?? []).toHaveLength(0);
        expect(manifest.recipes ?? []).toHaveLength(0);
    });
});

describe('Repository bundled plugin — materialisation + surfacing', () => {
    let userData: string;

    beforeAll(() => {
        userData = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-repo-plugin-'));
    });
    beforeEach(() => {
        vi.spyOn(app, 'getPath').mockReturnValue(userData);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    afterAll(() => {
        try {
            fs.rmSync(userData, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    });

    it('appears in listBundledPlugins() (the Settings → Official list)', () => {
        const listed = listBundledPlugins();
        const repo = listed.find((b) => b.id === REPO_ID);
        expect(repo).toBeTruthy();
        expect(repo!.name).toBe('Repository');
        expect(fs.existsSync(repo!.path)).toBe(true);
    });

    it('materialises a valid genie-plugin.json to disk with its panel intact', () => {
        const mat = materialiseBundled(REPO_ID);
        const manifestPath = path.join(mat.path, PLUGIN_MANIFEST_FILENAME);
        expect(fs.existsSync(manifestPath)).toBe(true);

        const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = validatePluginManifest(onDisk);
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect((res.manifest.panels ?? []).map((p) => p.id)).toEqual(['changes']);
            expect(res.manifest.capabilities?.genieApi).toContain(PANEL_CAPABILITY);
        }
    });

    it('surfaces the panel as launchable once the `ui.panel` grant is held', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        const out = collectPluginPanels([row(manifest, true)]);
        expect(out.map((p) => p.launchId)).toEqual(['repository.changes']);
        expect(out[0].panel.fancyComponent.export).toBe('RepoChangesPanel');
    });

    it('contributes NOTHING without the `ui.panel` grant (permission gate, fail-closed)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        expect(collectPluginPanels([row(manifest, false)])).toHaveLength(0);
    });
});

/** Build a surfaceable PluginRow from the bundled manifest, optionally granting `ui.panel`. */
function row(manifest: PluginManifest, grantPanel: boolean): PluginRow {
    const grants = emptyPluginGrants();
    if (grantPanel) grants.genieApi[PANEL_CAPABILITY] = true;
    return {
        id: manifest.id,
        namespace: manifest.namespace,
        name: manifest.name,
        version: manifest.version,
        source_type: 'folder',
        source_url: null,
        source_ref: null,
        install_path: `/plugins/${manifest.id}`,
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
