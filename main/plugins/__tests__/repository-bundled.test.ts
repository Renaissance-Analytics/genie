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
import {
    PLUGIN_MANIFEST_FILENAME,
    manifestContributions,
    validatePluginManifest,
    type PluginManifest,
} from '../manifest';
import { collectPluginPanels, PANEL_CAPABILITY } from '../panels';
import { collectPluginRecipes, RECIPE_CAPABILITY } from '../recipes';
import { emptyPluginGrants, type PluginRow } from '../../db';

/**
 * The bundled first-party "Repository" plugin (repo-management) — genie #63 line.
 *
 * Repository ships BUNDLED exactly like Presentation/Spreadsheet/Document (embedded
 * in `official.ts`, materialised to disk). It declares TWO surfaces in the unified
 * `contributes {}` block: a Changes PANEL (the PRIMARY git UX, mounting vetted
 * Genie-bundled Fancy git components) and the git recipe WIZARDS (the SECONDARY
 * entry, reachable from the recipe launcher). Its git EXECUTION is core host IPC
 * (main/repo/*) / recipe terminal steps — it declares no MCP tools. This suite
 * pins: it is bundled + first-party, its manifest validates, it declares BOTH the
 * `ui.panel` + `recipes` capabilities, it uses `contributes {}` (not legacy
 * top-level arrays), it materialises with both surfaces intact, and — once granted
 * — it surfaces both the panel and every recipe while contributing NOTHING for an
 * ungranted surface.
 */

const REPO_ID = 'ai.genie.repository';
const EXPECTED_RECIPE_IDS = ['status', 'stage', 'commit', 'branch', 'push', 'pull', 'pr'];
const FORBIDDEN_ARG_TOKENS = ['--force', '-f', '--force-with-lease', 'reset', 'clean'];

const repoSource = () => BUNDLED_PLUGIN_SOURCES.find((b) => b.id === REPO_ID);
const repoManifest = () => repoSource()!.manifest as unknown as PluginManifest;

describe('Repository bundled plugin — embedded source', () => {
    it('is bundled + recognised as first-party', () => {
        const src = repoSource();
        expect(src).toBeTruthy();
        expect(src!.name).toBe('Repository');
        expect(isBundledPluginId(REPO_ID)).toBe(true);
        expect(bundledPluginManifest(REPO_ID)).not.toBeNull();
    });

    it('has a manifest that VALIDATES against the strict schema', () => {
        expect(validatePluginManifest(repoSource()!.manifest).ok).toBe(true);
    });

    it('declares surfaces in the unified `contributes {}` block, not legacy top-level arrays', () => {
        const m = repoManifest();
        expect(m.contributes).toBeTruthy();
        expect(m.panels).toBeUndefined();
        expect(m.recipes).toBeUndefined();
        expect(m.mcpTools).toBeUndefined();
    });

    it('declares BOTH the ui.panel + recipes capabilities (else neither surface can appear)', () => {
        const genieApi = repoManifest().capabilities?.genieApi ?? [];
        expect(genieApi).toContain(PANEL_CAPABILITY);
        expect(genieApi).toContain(RECIPE_CAPABILITY);
    });

    it('contributes a Changes panel (primary) mounting a vetted Fancy git component', () => {
        const c = manifestContributions(repoManifest());
        const changes = c.panels.find((p) => p.id === 'changes');
        expect(changes).toBeTruthy();
        expect(changes!.fancyComponent.package).toBe('@particle-academy/fancy-git-ui');
        expect(changes!.fancyComponent.export).toBe('RepoChangesPanel');
    });

    it('contributes every git recipe wizard (secondary), each running real git/gh', () => {
        const recipes = manifestContributions(repoManifest()).recipes;
        const ids = recipes.map((r) => r.id);
        for (const id of EXPECTED_RECIPE_IDS) expect(ids).toContain(id);
        for (const r of recipes) {
            const terminals = r.steps.filter((s) => s.type === 'terminal');
            expect(terminals.length).toBeGreaterThan(0);
            for (const t of terminals) {
                if (t.type !== 'terminal') continue;
                expect(['git', 'gh']).toContain(t.command);
            }
        }
    });

    it('keeps destructive operations OUT of the recipes (no force-push / reset / clean)', () => {
        for (const r of manifestContributions(repoManifest()).recipes) {
            for (const s of r.steps) {
                if (s.type !== 'terminal') continue;
                for (const a of s.args ?? []) expect(FORBIDDEN_ARG_TOKENS).not.toContain(a);
            }
        }
    });

    it('registers NO MCP tools (git runs as core host IPC / recipe steps, not a sandbox)', () => {
        expect(manifestContributions(repoManifest()).mcpTools).toHaveLength(0);
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
        const repo = listBundledPlugins().find((b) => b.id === REPO_ID);
        expect(repo).toBeTruthy();
        expect(repo!.name).toBe('Repository');
        expect(fs.existsSync(repo!.path)).toBe(true);
    });

    it('materialises a valid genie-plugin.json to disk with BOTH surfaces intact', () => {
        const mat = materialiseBundled(REPO_ID);
        const manifestPath = path.join(mat.path, PLUGIN_MANIFEST_FILENAME);
        const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = validatePluginManifest(onDisk);
        expect(res.ok).toBe(true);
        if (res.ok) {
            const c = manifestContributions(res.manifest);
            expect(c.panels.map((p) => p.id)).toEqual(['changes']);
            expect(c.recipes.map((r) => r.id).sort()).toEqual([...EXPECTED_RECIPE_IDS].sort());
        }
    });

    it('surfaces the panel once the `ui.panel` grant is held; nothing without it', () => {
        const m = repoManifest();
        expect(collectPluginPanels([row(m, true, false)]).map((p) => p.launchId)).toEqual([
            'repository.changes',
        ]);
        expect(collectPluginPanels([row(m, false, false)])).toHaveLength(0);
    });

    it('surfaces every recipe once the `recipes` grant is held; nothing without it', () => {
        const m = repoManifest();
        const granted = collectPluginRecipes([row(m, false, true)]);
        expect(granted.map((r) => r.launchId).sort()).toEqual(
            EXPECTED_RECIPE_IDS.map((id) => `repository.${id}`).sort(),
        );
        expect(collectPluginRecipes([row(m, false, false)])).toHaveLength(0);
    });
});

/** A surfaceable PluginRow from the bundled manifest, granting either/both surface caps. */
function row(manifest: PluginManifest, grantPanel: boolean, grantRecipes: boolean): PluginRow {
    const grants = emptyPluginGrants();
    if (grantPanel) grants.genieApi[PANEL_CAPABILITY] = true;
    if (grantRecipes) grants.genieApi[RECIPE_CAPABILITY] = true;
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
