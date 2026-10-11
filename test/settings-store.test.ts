import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { SettingsStore } from '../src/main/settings-store.js';

/**
 * THE SETTINGS STORE (§6.9) — values for the registry, durable, typed, and the v1 carry-over
 * applied ONCE on first run with every drop reported. A value the registry does not know is
 * refused; a value of the wrong type is refused; defaults are never written down, so a changed
 * default reaches an install that never touched the setting.
 */

let dir: string;
let store: SettingsStore;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-settings-'));
    store = await SettingsStore.open(dir);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('reading and writing', () => {
    it('an untouched setting reads its registry default and is NOT in the file', async () => {
        expect(store.get('theme')).toBe('dark');
        expect(store.get('restore_agents_on_launch')).toBe(false);
        await store.set('theme', 'light');
        const file = JSON.parse((await readFile(store.file)).toString()) as Record<string, unknown>;
        expect(file).toEqual({ theme: 'light' });
    });

    it('a set value round-trips through a restart; reset returns to the default and removes it from the file', async () => {
        await store.set('update_channel', 'stable');
        const reopened = await SettingsStore.open(dir);
        expect(reopened.get('update_channel')).toBe('stable');
        await reopened.reset('update_channel');
        expect(reopened.get('update_channel')).toBe('beta');
        expect(JSON.parse((await readFile(store.file)).toString())).toEqual({});
    });

    it('an unknown key and a wrong-typed value are refused with the reason, and nothing is written', async () => {
        await expect(store.set('no_such_setting', true)).rejects.toThrow(/no_such_setting/);
        await expect(store.set('theme', 'sepia')).rejects.toThrow(/sepia/);
        await expect(store.set('restore_agents_on_launch', 'yes')).rejects.toThrow(/boolean/);
        expect(store.get('theme')).toBe('dark');
    });

    it('snapshot reports every setting with its effective value — the user’s where set, else the default', async () => {
        await store.set('theme', 'light');
        const snap = store.snapshot();
        expect(Object.keys(snap).sort()).toEqual(SETTINGS.map((s) => s.key).sort());
        expect(snap.theme).toBe('light');
        expect(snap.restore_agents_on_launch).toBe(false);
    });

    it('every registry setting is readable with a value of its declared type', () => {
        for (const def of SETTINGS) {
            const v = store.get(def.key);
            expect(typeof v, def.key).toBe(def.type === 'boolean' ? 'boolean' : 'string');
        }
    });

    it('a change fires listeners with the key and value; a no-op set does not', async () => {
        const seen: Array<[string, unknown]> = [];
        store.onChange((key, value) => seen.push([key, value]));
        await store.set('theme', 'light');
        await store.set('theme', 'light');
        expect(seen).toEqual([['theme', 'light']]);
    });
});

describe('the v1 carry-over — once, on first run', () => {
    it('applies what still exists, records the drops, and marks the carry-over done so it never runs twice', async () => {
        const result = await store.carryOverFromV1({ theme: 'light', update_channel: 'beta', agent_command: 'claude', track_cwd: 'off' });
        expect(result.applied).toEqual({ theme: 'light', update_channel: 'beta', track_cwd: false });
        expect(result.dropped.map((d) => d.key)).toEqual(['agent_command']);
        expect(store.get('theme')).toBe('light');
        expect(store.carriedOver()).toEqual({ at: expect.any(String), applied: 3, dropped: [{ key: 'agent_command', reason: expect.stringMatching(/launch line/) }] });

        // A second call is a no-op that reports the earlier run, even with different input.
        const again = await store.carryOverFromV1({ theme: 'dark' });
        expect(again).toEqual({ applied: {}, dropped: [], alreadyDone: true });
        expect(store.get('theme')).toBe('light');
    });

    it('a user’s explicit value set BEFORE the carry-over wins over v1', async () => {
        await store.set('theme', 'system');
        await store.carryOverFromV1({ theme: 'light' });
        expect(store.get('theme')).toBe('system');
    });

    it('with no v1 database (null), the carry-over is recorded as done with nothing to carry', async () => {
        const r = await store.carryOverFromV1(null);
        expect(r).toEqual({ applied: {}, dropped: [], noV1: true });
        expect(store.carriedOver()).toMatchObject({ applied: 0, dropped: [] });
    });
});
