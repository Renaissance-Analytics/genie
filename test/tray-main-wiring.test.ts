import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * TRAY-RESIDENT GENIE — main.ts wires it. Source guards, comments stripped by line (CRLF-safe), so prose cannot
 * satisfy them; the behaviour behind each wire is driven in tray-residence.test.ts, quit-sequence.test.ts and
 * tray-resident.test.ts. On origin/main every one of these is red: window-all-closed quit, the window always
 * showed, the close was never intercepted, a second launch only focused, and the OS ending a session ran no shutdown.
 */

describe('main.ts wiring', () => {
    // Comments stripped by line, CRLF-safe, so a guard cannot be satisfied by prose.
    const main = () => readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    /** From `start` to the end of its statement: the first `end` after it (a top-level `});` by default). */
    const block = (src: string, start: string, end = '\n});') => { const i = src.indexOf(start); expect(i).toBeGreaterThan(-1); const j = src.indexOf(end, i); expect(j).toBeGreaterThan(i); return src.slice(i, j); };

    it('window-all-closed no longer quits — Genie stays in the tray', () => {
        const handler = main().match(/app\.on\('window-all-closed', \(\) => \{([^}]*)\}\);/);
        expect(handler).not.toBeNull();
        expect(handler![1]).not.toMatch(/app\.quit\(/);
    });

    it('the main window boots by showOnBoot (start minimised) and its close goes through wireCloseToTray with the quit sequence', () => {
        const src = main();
        expect(src).toMatch(/window = createWindow\(showOnBoot\(\{ startMinimized: composed\.settings\.snapshot\(\)\.start_minimized === true, argv: process\.argv \}\)\);/);
        expect(src).toMatch(/if \(show\) win\.once\('ready-to-show', \(\) => win\.show\(\)\);/);
        expect(src).toMatch(/wireCloseToTray\(window, \{[\s\S]*?quitting: \(\) => quit\.quitting,/);
    });

    it('the tray’s Open and a second launch SHOW the window (focus alone does nothing to a hidden one)', () => {
        const src = main();
        expect(block(src, 'function revealMainWindow', '\n}\n')).toMatch(/window\.show\(\);/);
        expect(block(src, "app.on('second-instance'")).toMatch(/revealMainWindow\(\)/);
        expect(src).toMatch(/onOpen: revealMainWindow,/);
        expect(src).toMatch(/onQuit: \(\) => app\.quit\(\),/);
    });

    it('before-quit runs the one quit sequence: cancel prevents, record waits, the shutdown runs once', () => {
        const src = block(main(), "app.on('before-quit'");
        expect(src).toMatch(/const step = quit\.beforeQuit\(/);
        expect(src).toMatch(/if \(step === 'cancel'\) \{ event\.preventDefault\(\); return; \}/);
        expect(src).toMatch(/if \(step === 'pass'\) return;\s*\n\s*host\?\.stopAll\(\);/);
        expect(src).not.toMatch(/quitConfirmed|runningRecorded/);
    });

    it('the OS ending the session quits without a question: session-end on Windows, powerMonitor shutdown elsewhere', () => {
        const src = main();
        expect(src).toMatch(/window\.on\('session-end', \(\) => \{ quit\.force\(\); app\.quit\(\); \}\);/);
        expect(block(src, "powerMonitor.on('shutdown'")).toMatch(/quit\.force\(\);\s*\n\s*app\.quit\(\);/);
    });

    it('launch at sign-in is wired at boot with the installed exe', () => {
        expect(main()).toMatch(/void wireLoginItem\(composed\.settings, loginItemPort, \{[\s\S]*?packaged: app\.isPackaged,[\s\S]*?execPath: process\.execPath,/);
    });
});
