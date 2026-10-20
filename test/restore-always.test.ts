import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, searchSettings } from '../src/core/settings.js';
import { relaunchPlan } from '../src/core/upgrade-drain.js';
import { SettingsStore } from '../src/main/settings-store.js';

/**
 * AGENTS THAT WERE RUNNING ALWAYS COME BACK (the owner, 2026-10-20, after an upgrade left `tynn` stopped and his message
 * undelivered: "get rid of the fucking option. this should happen all of the time, not a god damn setting"). There is no
 * `restore_agents_on_launch`: every launch — a relaunch, an upgrade, after a crash — starts the agents that were running,
 * the mid-turn ones first and told to continue. An agent the person stopped was not running, so it is not on the list.
 */
describe('the relaunch, always', () => {
    it('every agent that was running is started — no setting is asked', () => {
        expect(relaunchPlan({ runningAtQuit: ['tynn', 'atlas'], interruptedAtQuit: [] }).map((s) => s.agentId)).toEqual(['tynn', 'atlas']);
    });

    it('CONTROL: an agent that was not running (the person stopped it) is not started', () => {
        expect(relaunchPlan({ runningAtQuit: ['tynn'], interruptedAtQuit: [] }).map((s) => s.agentId)).not.toContain('wren');
    });
});

describe('the switch is gone', () => {
    it('no setting, and Settings search does not find one', () => {
        expect(SETTINGS.map((s) => s.key)).not.toContain('restore_agents_on_launch');
        expect(searchSettings('restore agents')).toEqual([]);
    });

    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-restore-always-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('an install that had it stored opens as before, and the value is simply not read (CONTROL: its other values are)', async () => {
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(join(dir, 'runtime', 'settings.json'), JSON.stringify({ restore_agents_on_launch: false, theme: 'light' }));
        const store = await SettingsStore.open(dir);
        expect(store.get('theme')).toBe('light');
        expect(Object.keys(store.snapshot())).not.toContain('restore_agents_on_launch');
        expect(() => store.get('restore_agents_on_launch')).toThrow(/not a setting/);
    });
});
