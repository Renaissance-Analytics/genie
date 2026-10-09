import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAllSettings, initDatabase, setSettings } from '../db';

/**
 * AGENTS DO NOT COME BACK ON THEIR OWN — the default, where defaults live.
 *
 * The owner rebooted and every agent came back working, with no window open to reach or
 * stop any of them: *"No more forced terminals on reboot?"*
 *
 * `agentsToRevive` tests the RULE and the E2E specs test the PATH, but neither can assert
 * the default value — the E2E profile is shared between specs, so one that opts in leaks
 * into the next and a spec asserting "off" passes for the wrong reason. (Measured: it did.)
 * So the default is pinned here, against a real database, where nothing else can have set
 * it first.
 *
 * `'off'` is the safe direction: an agent that starts itself while nobody is watching is
 * the complaint, and the cost of being wrong the other way is only that someone presses
 * start.
 */
describe('restore_agents_on_launch', () => {
    beforeAll(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-restore-default-'));
        initDatabase(dir);
    });

    it('is OFF when nothing has been recorded', () => {
        expect(getAllSettings().restore_agents_on_launch).toBe('off');
    });

    it('POSITIVE CONTROL: the setting is real and does persist when set', () => {
        // Without this, "it is off" would also pass against a key that does not exist, is
        // never read, and could never be turned on — which looks identical from here.
        setSettings({ restore_agents_on_launch: 'on' });
        expect(getAllSettings().restore_agents_on_launch).toBe('on');
        setSettings({ restore_agents_on_launch: 'off' });
        expect(getAllSettings().restore_agents_on_launch).toBe('off');
    });

    it('never reads an EMPTY recorded value as ON', () => {
        /**
         * `setSettings({ k: '' })` is how this codebase clears a key, and `getAllSettings`
         * hands that empty string straight back — the `??` default only fires for an absent
         * row, not a blank one. So a cleared setting is `''`, not `'off'`.
         *
         * Asserted as "not on" rather than "is off", because that is the property the code
         * actually guarantees and the only one that matters here: every reader compares
         * `=== 'on'`, so a blank value disables revival exactly like the default does.
         *
         * Claiming it normalises to `'off'` would be asserting a behaviour this codebase
         * does not have — `detached_terminals` and every other `?? ` default behave the same
         * way, so it is a shared wart, not this setting's. Worth knowing before someone
         * writes `!== 'off'` somewhere and inverts the meaning of a cleared key.
         */
        setSettings({ restore_agents_on_launch: '' as 'on' | 'off' });
        expect(getAllSettings().restore_agents_on_launch).not.toBe('on');
    });
});
