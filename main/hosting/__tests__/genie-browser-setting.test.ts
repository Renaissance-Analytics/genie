import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAllSettings, initDatabase, setSettings } from '../../db';

/**
 * The Genie Browser master switch (`genie_browser_enabled`, #232).
 *
 * It gates the ONE way a `.gen` site is opened, so its default is load-bearing:
 * shipping it default-OFF would silently break every existing install's site
 * preview — the click would do nothing and read as Genie being broken. It is a
 * switch to turn the browser OFF, never a feature to opt in to.
 */

beforeAll(() => {
    initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'genie-browser-setting-')));
});

afterAll(() => {
    // Leave the shared singleton as it was for whichever suite runs next.
    setSettings({ genie_browser_enabled: 'on' });
});

describe('genie_browser_enabled', () => {
    it('defaults to ON — an unset install keeps its working site preview', () => {
        expect(getAllSettings().genie_browser_enabled).toBe('on');
    });

    it('round-trips an explicit off, so the switch actually turns it off', () => {
        setSettings({ genie_browser_enabled: 'off' });
        expect(getAllSettings().genie_browser_enabled).toBe('off');
        setSettings({ genie_browser_enabled: 'on' });
        expect(getAllSettings().genie_browser_enabled).toBe('on');
    });
});
