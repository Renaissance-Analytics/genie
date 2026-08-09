import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import {
    initDatabase,
    upsertPlugin,
    getPlugin,
    deletePlugin,
    emptyPluginGrants,
    setPluginEnabled,
    setSettings,
} from '../../db';
import {
    revalidateAllPluginTrust,
    reconcileBundledPlugins,
    ensureBundledPluginsInstalled,
} from '../install';
import { BUNDLED_PLUGIN_SOURCES } from '../official';
import { runPluginFsOp } from '../fs-bridge';
import { validatePluginManifest } from '../manifest';

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
    // The gate-disabled repair is a ONE-SHOT keyed on a settings flag — clear it so
    // each test drives it from a clean slate (the real app runs it once, ever).
    setSettings({ plugins_bundled_enable_repair: '' });
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

/**
 * Seed a bundled plugin whose stored manifest is ALREADY current (no drift, so the
 * self-heal has nothing to do) — the shape a profile is left in AFTER a self-heal.
 */
function seedCurrentBundled(over: Partial<Parameters<typeof upsertPlugin>[0]> = {}): void {
    upsertPlugin({
        id: 'ai.genie.presentation',
        namespace: 'presentation',
        name: 'Presentation',
        version: '0.1.0',
        source_type: 'folder',
        install_path: path.join(userData, 'plugins', 'ai.genie.presentation'),
        enabled: false,
        manifest_json: JSON.stringify(PRESENTATION.manifest),
        // The user completed the enable-time consent at some point: grants are only
        // ever written by that flow, so holding one means the plugin WAS on.
        grants: { fs: { workspace: true }, network: {}, genieApi: {} },
        trust: 'trusted',
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

/**
 * genie #83 — the damage the trust gate LEFT BEHIND.
 *
 * `enabled` is the user's INTENT, but the gate wrote to it (`setPluginEnabled(id,
 * false)`) whenever it refused a plugin — so the 7eeb297 schema tightening turned
 * Presentation + Spreadsheet OFF, and the 4b2cf01 self-heal then "preserved"
 * (`record()`: `enabled: prior?.enabled ?? false`) the zero the bug had written.
 * Live profile evidence: both sit trusted + disabled while STILL holding the
 * user's `fs.workspace` grant, and no boot ever brings them back — the stored
 * manifest is current, so the drift-triggered self-heal never fires again.
 */
describe('reconcileBundledPlugins — one-time repair of gate-disabled bundled plugins', () => {
    it('re-enables a bundled plugin the trust gate disabled, and only ONCE', async () => {
        seedCurrentBundled(); // trusted + disabled + holds the consent grant
        await reconcileBundledPlugins();
        expect(getPlugin('ai.genie.presentation')!.enabled).toBe(true);

        // …and once repaired it is never re-enabled again: a DELIBERATE "off" sticks.
        setPluginEnabled('ai.genie.presentation', false);
        await reconcileBundledPlugins();
        expect(getPlugin('ai.genie.presentation')!.enabled).toBe(false);
    });

    it('leaves a bundled plugin the user never consented to alone (no grants → never enabled)', async () => {
        seedCurrentBundled({ grants: emptyPluginGrants() });
        await reconcileBundledPlugins();
        // Installed-but-never-enabled is the desktop's user-choice model — untouched.
        expect(getPlugin('ai.genie.presentation')!.enabled).toBe(false);
    });

    it('never repairs a THIRD-PARTY plugin — the repair is scoped to first-party bundled ids', async () => {
        upsertPlugin({
            id: 'com.thirdparty.stale',
            namespace: 'stale',
            name: 'Third Party',
            version: '1.0.0',
            source_type: 'repo',
            install_path: path.join(userData, 'thirdparty-stale'),
            enabled: false,
            manifest_json: JSON.stringify({
                id: 'com.thirdparty.stale',
                namespace: 'stale',
                name: 'Third Party',
                version: '1.0.0',
            }),
            grants: { fs: { workspace: true }, network: {}, genieApi: {} },
            trust: 'trusted',
        });
        await reconcileBundledPlugins();
        expect(getPlugin('com.thirdparty.stale')!.enabled).toBe(false);
    });

    it('heals a bundled plugin whose trust verdict drifted off "trusted" even without manifest drift', async () => {
        // The trap door: a prior boot left it `outdated`; its manifest is CURRENT, so
        // the drift check alone would skip it forever.
        seedCurrentBundled({ trust: 'outdated' });
        await reconcileBundledPlugins();

        const row = getPlugin('ai.genie.presentation')!;
        expect(row.trust).toBe('trusted');
        expect(row.enabled).toBe(true);
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

    it('re-recognises a bundled plugin as FIRST-PARTY after its verdict left "trusted"', () => {
        // genie #83: `firstParty` was inferred from `row.trust === 'trusted'` — the
        // very verdict being recomputed. One boot at `outdated` and the plugin was
        // forever re-evaluated as an ordinary unsigned third-party → non-surfaceable,
        // unrecoverable. First-partyness is a property of the ID, not of the cache.
        seedCurrentBundled({ trust: 'outdated', enabled: true });
        revalidateAllPluginTrust();

        const row = getPlugin('ai.genie.presentation')!;
        expect(row.trust).toBe('trusted'); // NOT 'unsigned' (the trap door)
        expect(row.enabled).toBe(true);
    });

    it('keeps a bundled plugin ENABLED (user intent) when the gate cannot load it, and REPORTS the failure', async () => {
        seedStaleBundled(); // schema-invalid stored manifest → the self-heal path
        // Make the re-materialise fail deterministically: point userData at a FILE.
        const blocker = path.join(userData, 'blocked-userdata');
        fs.writeFileSync(blocker, 'not a directory');
        vi.spyOn(app, 'getPath').mockReturnValue(blocker);
        const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

        revalidateAllPluginTrust();
        await new Promise((r) => setImmediate(r)); // the self-heal .catch is a microtask

        const row = getPlugin('ai.genie.presentation')!;
        expect(row.trust).toBe('outdated'); // honestly gated — it genuinely can't load
        expect(row.enabled).toBe(true); // but the user's intent is NOT destroyed
        expect(reported).toHaveBeenCalled(); // and the failure is never swallowed
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

/**
 * genie #100 — auto-enabling a bundled first-party plugin on a HEADLESS host left
 * it with EMPTY grants, so `runPluginFsOp` failed EVERY fs op closed.
 *
 * The desktop grants a plugin's declared capabilities through the enable-time
 * CONSENT modal; a headless host has no such UI. Enabling alone therefore left the
 * grants map that `record()` writes — `emptyPluginGrants()` — untouched, and the
 * host fs gate denies at `grants.fs.workspace !== true`. A bundled plugin is
 * Genie's OWN signed code, so on the headless auto-enable path its manifest-DECLARED
 * capabilities ARE the consented set: grant exactly those (never more), so the fs
 * ops the manifest declares are permitted.
 */
describe('ensureBundledPluginsInstalled — auto-grants first-party DECLARED capabilities (#100)', () => {
    beforeEach(() => {
        for (const b of BUNDLED_PLUGIN_SOURCES) {
            try {
                deletePlugin(b.id);
            } catch {
                /* not present — fine */
            }
        }
    });

    it('records the DECLARED fs grant (not empty) so runPluginFsOp permits a declared fs op', async () => {
        await ensureBundledPluginsInstalled({ enable: true });

        const row = getPlugin('ai.genie.presentation')!;
        // The declared fs.workspace capability is GRANTED — not the empty map
        // record() leaves, which made every host fs op fail closed (#100).
        expect(row.grants.fs.workspace).toBe(true);

        // End-to-end: the host fs gate now PERMITS a declared fs write.
        const parsed = validatePluginManifest(JSON.parse(row.manifest_json));
        if (!parsed.ok) throw new Error('bundled manifest failed to validate');
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-plugin-ws-'));
        try {
            const res = await runPluginFsOp(parsed.manifest, row.grants, workspace, 'fs.writeFile', {
                rel: 'deck.pptx',
                data: 'hello',
            });
            expect(res.ok).toBe(true); // NOT 'fs access is not granted to this plugin'
            expect(fs.existsSync(path.join(workspace, 'deck.pptx'))).toBe(true);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('grants EXACTLY the declared set — Repository gets its genieApi recipe grant but NO fs grant it never declared', async () => {
        await ensureBundledPluginsInstalled({ enable: true });
        const row = getPlugin('ai.genie.repository')!;
        // It declares `genieApi: ['recipes']` — granted.
        expect(row.grants.genieApi.recipes).toBe(true);
        // …and no fs capability, so it is granted none (declared, never blanket).
        expect(row.grants.fs.workspace).toBeFalsy();
    });

    it('leaves grants EMPTY when enable is not requested (install-only stays fail-closed)', async () => {
        await ensureBundledPluginsInstalled();
        const row = getPlugin('ai.genie.presentation')!;
        expect(row.grants.fs.workspace).toBeFalsy();
    });
});
