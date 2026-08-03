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
import { collectPluginRecipes, RECIPE_CAPABILITY } from '../recipes';
import { emptyPluginGrants, type PluginRow } from '../../db';

/**
 * The bundled first-party "Repository" plugin (repo-management) — genie #63 line.
 *
 * Repository ships BUNDLED exactly like Presentation/Spreadsheet/Document (embedded
 * in `official.ts`, materialised to disk), so it appears in Settings → Plugins with
 * no marketplace. Its git actions run for real via `recipes[]` TERMINAL steps (a
 * plugin worker sandbox cannot spawn git), gated by the grantable `recipes`
 * capability. This suite pins: it is bundled + first-party, its manifest validates,
 * it declares the `recipes` capability, its v1 git recipes are present, it
 * materialises to disk with the recipes intact, and — once granted — it surfaces
 * every recipe as a launchable wizard while contributing NOTHING without the grant.
 */

const REPO_ID = 'ai.genie.repository';

/** The v1 git recipes promised for the Repository plugin. */
const EXPECTED_RECIPE_IDS = ['status', 'stage', 'commit', 'branch', 'push', 'pull', 'pr'];

/** Destructive verbs/flags that must NOT appear in any v1 recipe (safety). */
const FORBIDDEN_ARG_TOKENS = ['--force', '-f', '--force-with-lease', 'reset', 'clean'];

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

    it('declares the grantable `recipes` capability (else recipes cannot surface)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        expect(manifest.capabilities?.genieApi).toContain(RECIPE_CAPABILITY);
    });

    it('declares every v1 git recipe, each running REAL git/gh via a terminal step', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        const recipes = manifest.recipes ?? [];
        const ids = recipes.map((r) => r.id);
        for (const id of EXPECTED_RECIPE_IDS) expect(ids).toContain(id);

        for (const r of recipes) {
            const terminals = r.steps.filter((s) => s.type === 'terminal');
            // Each recipe DOES something on the host: at least one terminal step.
            expect(terminals.length).toBeGreaterThan(0);
            for (const t of terminals) {
                if (t.type !== 'terminal') continue;
                expect(['git', 'gh']).toContain(t.command);
            }
        }
    });

    it('keeps destructive operations OUT of v1 (no force-push / reset / clean)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        for (const r of manifest.recipes ?? []) {
            for (const s of r.steps) {
                if (s.type !== 'terminal') continue;
                for (const a of s.args ?? []) {
                    expect(FORBIDDEN_ARG_TOKENS).not.toContain(a);
                }
            }
        }
    });

    it('wires wizard inputs into the git commands (commit message, branch name, PR title)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        const byId = new Map((manifest.recipes ?? []).map((r) => [r.id, r]));

        const formKeys = (recipeId: string): string[] => {
            const r = byId.get(recipeId);
            const out: string[] = [];
            for (const s of r?.steps ?? []) {
                if (s.type === 'form') for (const f of s.fields) out.push(f.key);
            }
            return out;
        };
        const argsBlob = (recipeId: string): string => {
            const r = byId.get(recipeId);
            const parts: string[] = [];
            for (const s of r?.steps ?? []) {
                if (s.type === 'terminal') parts.push([s.command, ...(s.args ?? [])].join(' '));
            }
            return parts.join(' ');
        };

        // commit: a required `message` field flows into `git commit -m {{message}}`.
        expect(formKeys('commit')).toContain('message');
        expect(argsBlob('commit')).toContain('{{message}}');
        // branch: a `name` field flows into the create+switch command.
        expect(formKeys('branch')).toContain('name');
        expect(argsBlob('branch')).toContain('{{name}}');
        // pr: a `title` field flows into `gh pr create --title {{title}} ...`.
        expect(formKeys('pr')).toContain('title');
        expect(argsBlob('pr')).toContain('{{title}}');
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

    it('materialises a valid genie-plugin.json to disk with its recipes intact', () => {
        const mat = materialiseBundled(REPO_ID);
        const manifestPath = path.join(mat.path, PLUGIN_MANIFEST_FILENAME);
        expect(fs.existsSync(manifestPath)).toBe(true);

        const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const res = validatePluginManifest(onDisk);
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect((res.manifest.recipes ?? []).map((r) => r.id).sort()).toEqual(
                [...EXPECTED_RECIPE_IDS].sort(),
            );
            expect(res.manifest.capabilities?.genieApi).toContain(RECIPE_CAPABILITY);
        }
    });

    it('surfaces EVERY recipe as a launchable wizard once the `recipes` grant is held', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        const granted = row(manifest, true);
        const out = collectPluginRecipes([granted]);
        expect(out.map((r) => r.launchId).sort()).toEqual(
            EXPECTED_RECIPE_IDS.map((id) => `repository.${id}`).sort(),
        );
    });

    it('contributes NOTHING without the `recipes` grant (permission gate, fail-closed)', () => {
        const manifest = repoSource()!.manifest as unknown as PluginManifest;
        expect(collectPluginRecipes([row(manifest, false)])).toHaveLength(0);
    });
});

/** Build a surfaceable PluginRow from the bundled manifest, optionally granting `recipes`. */
function row(manifest: PluginManifest, grantRecipes: boolean): PluginRow {
    const grants = emptyPluginGrants();
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
