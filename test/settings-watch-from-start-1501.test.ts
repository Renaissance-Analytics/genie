import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCAL_EVENTS } from '../src/core/remote-protocol.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { SettingValue, SettingsData } from '../src/main/settings-read.js';
import { settingsWatchFeed } from '../src/main/settings-watch.js';

/*
 * GENIE-HOST SAYS ITS SETTINGS TO MAIN'S OWN CLIENT FROM ITS START (P6-3, Tynn #1501). The logon row measured it on both
 * platforms (items 1125-031830-0b4ed2, 1125-034839-4e4d16): a relaunch with "Launch at sign-in" on REMOVED the entry. The
 * window's log said "applying at boot: setting off" while genie-host's settings.json and the page both said on. RemoteHost
 * answers `settings.watch` with its api's settingsWatch(), and the api genie-host gives it is hostRemoteApi's, which never
 * carried settingsWatch: the answer was null, which the window reads as no settings at all, and its boot read the defaults
 * (start minimised too). The settings store is open long before the host's own answers are built, so, like the registry and
 * the front door, they are said from the host's start.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

const DATA: SettingsData = { values: { launch_at_login: true, start_minimized: true }, workspaces: {}, carriedOver: null };

describe('hostRemoteApi carries the settings, with genie-host’s own answers still unbuilt', () => {
    const build = () => {
        let data = DATA;
        let poke: (key: string, value: SettingValue) => void = () => {};
        const feed = settingsWatchFeed({ data: () => data, onChange: (l) => { poke = l; return () => {}; } });
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, alone: () => null, settings: feed } as never);
        return { api, change: (next: SettingsData, key: string, value: SettingValue) => { data = next; poke(key, value); } };
    };

    it('settings.watch’s answer is the settings now, not null', () => {
        const { api } = build();
        expect(api.settingsWatch?.()).toEqual({ data: DATA, key: null, value: null, workspaceId: null });
    });

    it('a change is said on local-settings, once', () => {
        const { api, change } = build();
        const heard: Array<[string, unknown]> = [];
        api.onEvent((channel, payload) => { if (channel === LOCAL_EVENTS.settings) heard.push([channel, payload]); });
        const next = { ...DATA, values: { ...DATA.values, launch_at_login: false } };
        change(next, 'launch_at_login', false);
        expect(heard).toEqual([[LOCAL_EVENTS.settings, { data: next, key: 'launch_at_login', value: false, workspaceId: null }]]);
    });
});

describe('genie-host wires it so', () => {
    it('the feed is made before RemoteAccessHost.open and given to hostRemoteApi; the host’s own answers no longer say it (a change is said once)', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/const settingsWatch = settingsWatchFeed\(\{ data: \(\) => settings\.data\(\), onChange: \(listener\) => settings\.onChange\(listener\) \}\);/);
        expect(host.indexOf('const settingsWatch = settingsWatchFeed(')).toBeLessThan(host.indexOf('const remoteAccessHost = await RemoteAccessHost.open({'));
        expect(host).toMatch(/\n\s*settings: settingsWatch,/);
        expect(host).not.toMatch(/\n\s*settingsWatch,\n/);
        expect(code('src/main/remote-access-host.ts')).toMatch(/ports\.settings\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.settings, view\)\)/);
    });
});
