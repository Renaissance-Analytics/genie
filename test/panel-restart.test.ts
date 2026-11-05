import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { panelRestart } from '../src/core/panel-restart.js';

/**
 * A SITE PANEL'S RESTART WAITS FOR THE ANSWER. The tray's question became asynchronous (#1574: the busy marks are read off
 * main), and the panel's Restart still read it as a boolean: `if (confirmTray('restart'))` on a Promise is always true, so
 * the panel restarted Genie whatever the person answered, Cancel included. TypeScript caught it on the merge (TS2801).
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a site panel’s Restart', () => {
    it('answered Cancel, Genie is not restarted', async () => {
        let restarted = 0;
        panelRestart(async () => false, () => { restarted += 1; })();
        await tick();
        expect(restarted).toBe(0);
    });

    it('answered Restart, Genie restarts, once', async () => {
        let restarted = 0;
        panelRestart(async () => true, () => { restarted += 1; })();
        await tick();
        expect(restarted).toBe(1);
    });

    it('nothing restarts before the answer is in', () => {
        let restarted = 0;
        panelRestart(() => new Promise(() => {}), () => { restarted += 1; })();
        expect(restarted).toBe(0);
    });
});

describe('wired: every tray question is waited for', () => {
    const main = readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');
    it('the panel’s Restart goes through panelRestart, with the tray’s own question', () => {
        expect(main).toMatch(/restart: panelRestart\(confirmTray, restartGenie\)/);
    });
    it('no confirmTray answer is read as a boolean: each call is followed by .then or awaited', () => {
        const calls = [...main.matchAll(/confirmTray\('[a-z-]+'\)(.{0,6})/g)];
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c[1]).toMatch(/^\.then\(/);
        expect(main).not.toMatch(/if \(confirmTray\(/);
    });
});
