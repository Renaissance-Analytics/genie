import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UPDATE_CHANNEL, channelFrom, releaseTypeForTag, updaterConfigFor } from '../src/core/update-channel.js';
import { SETTINGS, carryOverV1, type SettingDef } from '../src/core/settings.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';

/**
 * UPDATE CHANNELS — the owner, 2026-10-12: "stable and dev update channels".
 *
 * Before this, `update_channel` (`beta | stable`) existed and NOTHING read it: the updater was
 * configured once from a constant, and every tag published as a prerelease. A setting that does
 * nothing is the §0.8 shape — configured, tested, inert. So this file holds every link:
 *
 *   - the value → the channel (`channelFrom`, legacy `beta` → `dev`);
 *   - the channel → what electron-updater is told (`updaterConfigFor`), and that `UpdateHost`
 *     actually re-tells it when the channel changes — COUNTED, not a boolean;
 *   - the setting's registry entry, and a stored or v1 `beta` migrating to `dev`;
 *   - main.ts reading the setting at boot and on change;
 *   - the publish half: the workflow turns a plain tag into a full release (what stable sees)
 *     while electron-builder.yml's default stays prerelease (what dev sees).
 */

describe('channelFrom', () => {
    it('reads the two channels as themselves', () => {
        expect(channelFrom('stable')).toBe('stable');
        expect(channelFrom('dev')).toBe('dev');
    });

    it('migrates the legacy "beta" to dev — it is the dev channel by its old name', () => {
        expect(channelFrom('beta')).toBe('dev');
    });

    it('reads anything else as the default, and the default is dev', () => {
        expect(DEFAULT_UPDATE_CHANNEL).toBe('dev');
        for (const v of ['', 'nightly', 'toString', 'constructor', undefined, null, true, 3]) expect(channelFrom(v), String(v)).toBe('dev');
    });
});

describe('updaterConfigFor', () => {
    it('dev allows prereleases; stable does not; neither downloads by itself', () => {
        expect(updaterConfigFor('dev')).toEqual({ allowPrerelease: true, autoDownload: false });
        expect(updaterConfigFor('stable')).toEqual({ allowPrerelease: false, autoDownload: false });
    });
});

describe('releaseTypeForTag', () => {
    it('a plain version publishes as a full release, with or without the v', () => {
        expect(releaseTypeForTag('v2.0.0')).toBe('release');
        expect(releaseTypeForTag('2.0.0')).toBe('release');
        expect(releaseTypeForTag('v10.4.12')).toBe('release');
    });

    it('a prerelease suffix publishes as a prerelease', () => {
        expect(releaseTypeForTag('v2.0.0-beta.20')).toBe('prerelease');
        expect(releaseTypeForTag('2.0.0-rc.1')).toBe('prerelease');
    });
});

describe('UpdateHost follows the channel', () => {
    function fake() {
        const configured: Array<{ allowPrerelease: boolean; autoDownload: boolean }> = [];
        const port: UpdaterPort = {
            configure: (c) => { configured.push({ ...c }); },
            check: async () => null,
            download: async () => undefined,
            quitAndInstall: () => undefined,
        };
        return { port, configured };
    }
    const make = (port: UpdaterPort, channel?: 'stable' | 'dev') => new UpdateHost({
        port,
        installDir: '/opt/programs/Genie',
        ownPid: 1,
        processes: () => [],
        kill: () => true,
        ...(channel ? { channel } : {}),
    });

    it('constructed on stable, the library is told allowPrerelease FALSE — once', () => {
        const f = fake();
        const h = make(f.port, 'stable');
        expect(f.configured).toEqual([{ allowPrerelease: false, autoDownload: false }]);
        expect(h.channel()).toBe('stable');
    });

    it('constructed with no channel, it is on the default (dev) channel', () => {
        const f = fake();
        const h = make(f.port);
        expect(f.configured).toEqual([{ allowPrerelease: true, autoDownload: false }]);
        expect(h.channel()).toBe('dev');
    });

    it('setChannel re-configures on a change, and ONLY on a change — counted', () => {
        const f = fake();
        const h = make(f.port, 'stable');
        h.setChannel('dev');
        expect(f.configured).toHaveLength(2);
        expect(f.configured[1]).toEqual({ allowPrerelease: true, autoDownload: false });
        expect(h.channel()).toBe('dev');

        h.setChannel('dev');
        expect(f.configured).toHaveLength(2);

        h.setChannel('stable');
        expect(f.configured).toHaveLength(3);
        expect(f.configured[2]).toEqual({ allowPrerelease: false, autoDownload: false });
    });
});

describe('the setting', () => {
    const def = SETTINGS.find((s) => s.key === 'update_channel') as Extract<SettingDef, { type: 'enum' }>;

    it('offers stable and dev, defaulting to dev', () => {
        expect(def).toMatchObject({ type: 'enum', options: ['stable', 'dev'], default: 'dev', scope: 'host', group: 'general' });
        expect(def.description).toMatch(/stable/);
        expect(def.description).toMatch(/dev/);
    });

    it('a v1 "beta" carries over as dev — migrated, not dropped', () => {
        const r = carryOverV1({ update_channel: 'beta' });
        expect(r.applied).toEqual({ update_channel: 'dev' });
        expect(r.dropped).toEqual([]);
    });

    it('CONTROL: a v1 value that is no channel at all is still dropped with the reason', () => {
        const r = carryOverV1({ update_channel: 'nightly' });
        expect(r.applied).toEqual({});
        expect(r.dropped.map((d) => d.key)).toEqual(['update_channel']);
    });

    describe('a stored "beta" in settings.json', () => {
        let dir: string | null = null;
        afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

        it('reads as dev after a restart', async () => {
            dir = await mkdtemp(join(tmpdir(), 'genie2-channels-'));
            const first = await SettingsStore.open(dir);
            await mkdir(dirname(first.file), { recursive: true });
            await writeFile(first.file, JSON.stringify({ update_channel: 'beta', theme: 'light' }));
            const reopened = await SettingsStore.open(dir);
            expect(reopened.get('update_channel')).toBe('dev');
            expect(reopened.snapshot().update_channel).toBe('dev');
            // CONTROL: the migration touches that one value only.
            expect(reopened.get('theme')).toBe('light');
        });
    });
});

describe('main.ts wires the setting to the updater', () => {
    const main = () => readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');

    it('sets the channel from the stored setting at boot', () => {
        expect(main()).toContain('updates?.setChannel(channelFrom(composed.settings.snapshot().update_channel))');
    });

    it('and again whenever update_channel changes', () => {
        expect(main()).toMatch(/settings\.onChange\(\(key, value\) => \{ if \(key === 'update_channel'\) updates\?\.setChannel\(channelFrom\(value\)\); \}\)/);
    });
});

describe('the publish half', () => {
    const workflow = () => readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');
    const builder = () => readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');

    it('the workflow decides the release type from the tag and passes it to electron-builder', () => {
        expect(workflow()).toContain('tag="${GITHUB_REF_NAME#v}"');
        expect(workflow()).toContain('case "$tag" in *-*) type=prerelease ;; *) type=release ;; esac');
        expect(workflow()).toContain('npx electron-builder --publish always --config.publish.releaseType=$type');
    });

    it('electron-builder.yml still DEFAULTS to prerelease — what dev sees — and names this test as its pair', () => {
        expect(builder()).toMatch(/releaseType:\s*prerelease/);
        expect(builder()).toContain('test/update-channels.test.ts');
    });

    it('CONTROL: the override is what lets stable see anything — a plain tag maps to release while the yml default is prerelease', () => {
        // If the override were dropped, a plain tag would publish as the yml default (prerelease),
        // and the stable channel (allowPrerelease false) would never be offered it.
        expect(releaseTypeForTag('v2.0.0')).toBe('release');
        expect(builder()).not.toMatch(/releaseType:\s*release\b/);
        expect(updaterConfigFor('stable').allowPrerelease).toBe(false);
        expect(updaterConfigFor('dev').allowPrerelease).toBe(true);
    });
});
