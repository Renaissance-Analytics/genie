import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import { initDatabase, upsertPlugin, getPlugin, deletePlugin, emptyPluginGrants } from '../../db';
import {
    revalidateAllPluginTrust,
    reconcileBundledPlugins,
    ensureBundledPluginsInstalled,
} from '../install';
import { BUNDLED_PLUGIN_SOURCES } from '../official';

/**
 * Bundled-plugin trust SELF-HEAL (plugin plan Phase A).
 *
 * Root cause the suite pins: Presentation + Spreadsheet were installed (Jul-4)
 * with manifests that declare `mcpTools` but NO `agent` key. Commit 7eeb297 later
 * made `agent.guide` MANDATORY when `mcpTools` are present, but nothing
 * re-installed the already-installed bundled plugins — so every boot
 * `revalidateAllPluginTrust()` re-validated the STALE stored manifest, it failed
 * the schema, and the invalid-manifest branch WRONGLY flipped a FIRST-PARTY
 * bundled plugin to `untrusted` + disabled it.
 *
 * The fix: `reconcileBundledPlugins()` re-materialises + re-installs a drifted
 * bundled plugin from the embedded source (preserving enabled + grants), and the
 * invalid-manifest branch self-heals a bundled id rather than untrusting it. A
 * schema-failing THIRD-party plugin is reported as `outdated` (a distinct, honest
 * reason) — never conflated with a signature/tamper `untrusted`.
 */

const PRESENTATION = BUNDLED_PLUGIN_SOURCES.find((b) => b.id === 'ai.genie.presentation')!;

/** The Jul-4 stored manifest: `mcpTools` present but NO `agent` key (pre-7eeb297). */
function staleBundledManifest(): Record<string, unknown> {
    const m = JSON.parse(JSON.stringify(PRESENTATION.manifest)) as Record<string, unknown>;
    delete m.agent; // the exact drift that fails the tightened schema
    return m;
}

let userData: string;
const SEEDED = ['ai.genie.presentation', 'com.thirdparty.badsig', 'com.thirdparty.stale'];

beforeAll(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-reconcile-'));
    initDatabase(userData);
});

beforeEach(() => {
    // Bundled plugins materialise + install under app.getPath('userData')/plugins.
    vi.spyOn(app, 'getPath').mockReturnValue(userData);
});

afterEach(() => {
    for (const id of SEEDED)
        try {
            deletePlugin(id);
        } catch {
            /* ignore */
        }
    vi.restoreAllMocks();
});

afterAll(() => {
    try {
        fs.rmSync(userData, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

/** Seed the Jul-4 state: a bundled plugin, TRUSTED + ENABLED, with a stale manifest. */
function seedStaleBundled(over: Partial<Parameters<typeof upsertPlugin>[0]> = {}): void {
    upsertPlugin({
        id: 'ai.genie.presentation',
        namespace: 'presentation',
        name: 'Presentation',
        version: '0.1.0',
        source_type: 'folder',
        install_path: path.join(userData, 'plugins', 'ai.genie.presentation'),
        enabled: true, // the user had turned it on
        manifest_json: JSON.stringify(staleBundledManifest()),
        grants: { fs: { workspace: true }, network: {}, genieApi: {} },
        trust: 'trusted', // it was trusted the day it was installed
        ...over,
    });
}

describe('reconcileBundledPlugins (proactive self-heal)', () => {
    it('re-installs a drifted bundled plugin, ending TRUSTED + ENABLED with the healed manifest', async () => {
        seedStaleBundled();
        await reconcileBundledPlugins();

        const row = getPlugin('ai.genie.presentation')!;
        expect(row.trust).toBe('trusted');
        expect(row.enabled).toBe(true); // enabled state preserved
        // The stored manifest is healed to the embedded source (now carries agent.guide).
        expect(JSON.parse(row.manifest_json).agent?.guide).toBeTruthy();
        // Granted permissions survive the re-install.
        expect(row.grants.fs.workspace).toBe(true);
    });

    it('leaves an up-to-date bundled plugin untouched (no drift → no re-install)', async () => {
        // Seed the CURRENT embedded manifest but with a sentinel name a re-install
        // would overwrite from the manifest ("Presentation").
        upsertPlugin({
            id: 'ai.genie.presentation',
            namespace: 'presentation',
            name: 'SENTINEL-NoDrift',
            version: '0.1.0',
            source_type: 'folder',
            install_path: path.join(userData, 'plugins', 'ai.genie.presentation'),
            enabled: true,
            manifest_json: JSON.stringify(PRESENTATION.manifest),
            grants: emptyPluginGrants(),
            trust: 'trusted',
        });
        await reconcileBundledPlugins();
        // Untouched: a re-install would reset the name to "Presentation".
        expect(getPlugin('ai.genie.presentation')!.name).toBe('SENTINEL-NoDrift');
    });

    it('ignores a bundled id that is not installed', async () => {
        // Nothing seeded → reconcile must not install anything (fail-closed).
        await reconcileBundledPlugins();
        expect(getPlugin('ai.genie.presentation')).toBeNull();
    });
});

describe('revalidateAllPluginTrust — bundled self-heal + third-party split', () => {
    it('self-heals a stale bundled plugin instead of flipping it to untrusted', () => {
        seedStaleBundled();
        revalidateAllPluginTrust();

        const row = getPlugin('ai.genie.presentation')!;
        expect(row.trust).toBe('trusted'); // NOT 'untrusted' (the bug)
        expect(row.enabled).toBe(true); // NOT disabled (the bug)
        expect(JSON.parse(row.manifest_json).agent?.guide).toBeTruthy();
    });

    it('does NOT over-heal a third-party plugin with a bad signature — it stays untrusted + disabled', () => {
        const manifest = {
            id: 'com.thirdparty.badsig',
            namespace: 'badsig',
            name: 'Bad Sig',
            version: '1.0.0',
            publisher: { name: 'Someone', keyId: 'ed25519-not-in-store' },
            signature: 'AAAA',
        };
        upsertPlugin({
            id: 'com.thirdparty.badsig',
            namespace: 'badsig',
            name: 'Bad Sig',
            version: '1.0.0',
            source_type: 'repo',
            install_path: path.join(userData, 'thirdparty-badsig'),
            enabled: true,
            manifest_json: JSON.stringify(manifest),
            grants: emptyPluginGrants(),
            trust: 'trusted', // a stale-good verdict revalidate must correct
            signature: 'AAAA',
            publisher_key_id: 'ed25519-not-in-store',
        });
        revalidateAllPluginTrust();

        const row = getPlugin('com.thirdparty.badsig')!;
        expect(row.trust).toBe('untrusted'); // genuine signature failure
        expect(row.enabled).toBe(false);
    });

    it('reports a third-party plugin with a schema-invalid manifest as `outdated`, not untrusted, and never heals it to trusted', () => {
        const stale = {
            id: 'com.thirdparty.stale',
            namespace: 'stale',
            name: 'Stale',
            version: '1.0.0',
            entry: { tools: 'tools.cjs' },
            // mcpTools present but NO agent.guide → fails the tightened schema.
            mcpTools: [
                { name: 'doThing', description: 'd', inputSchema: { type: 'object' }, run: 'tools', process: 'worker' },
            ],
        };
        upsertPlugin({
            id: 'com.thirdparty.stale',
            namespace: 'stale',
            name: 'Stale',
            version: '1.0.0',
            source_type: 'repo',
            install_path: path.join(userData, 'thirdparty-stale'),
            enabled: true,
            manifest_json: JSON.stringify(stale),
            grants: emptyPluginGrants(),
            trust: 'trusted',
        });
        revalidateAllPluginTrust();

        const row = getPlugin('com.thirdparty.stale')!;
        expect(row.trust).toBe('outdated'); // distinct from a signature/tamper 'untrusted'
        expect(row.enabled).toBe(false); // an unloadable manifest cannot surface
    });
});

describe('ensureBundledPluginsInstalled (genie #56 — headless host install + enable)', () => {
    beforeEach(() => {
        // A fresh headless host: no bundled plugins installed yet (the desktop
        // installs them on user action; a host has no such UI).
        for (const b of BUNDLED_PLUGIN_SOURCES) {
            try {
                deletePlugin(b.id);
            } catch {
                /* not present — fine */
            }
        }
    });

    it('installs + ENABLES every bundled plugin (empty host registry → plugin editors resolve)', async () => {
        for (const b of BUNDLED_PLUGIN_SOURCES) expect(getPlugin(b.id)).toBeNull();
        await ensureBundledPluginsInstalled({ enable: true });
        for (const b of BUNDLED_PLUGIN_SOURCES) {
            const row = getPlugin(b.id);
            expect(row).not.toBeNull();
            // Enabled ⇒ surfaceable ⇒ runPluginEditorFs's trust gate passes on the host.
            expect(row!.enabled).toBe(true);
        }
    });

    it('installs DISABLED when enable is not requested', async () => {
        await ensureBundledPluginsInstalled();
        for (const b of BUNDLED_PLUGIN_SOURCES) {
            const row = getPlugin(b.id);
            expect(row).not.toBeNull();
            expect(row!.enabled).toBe(false);
        }
    });
});
