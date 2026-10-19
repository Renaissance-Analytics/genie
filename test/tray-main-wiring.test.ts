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
        expect(block(src, "app.on('second-instance'")).toMatch(/reveal: revealMainWindow,/);
        expect(src).toMatch(/onOpen: revealMainWindow,/);
        // The tray's Quit is the one quit entry `Genie --quit` also runs (quit-flag below).
        expect(src).toMatch(/onQuit: requestQuit,/);
    });

    it('`Genie --quit`: the second-instance handler runs the SAME quit entry as the tray, and a plain second launch still reveals', () => {
        const src = main();
        // The one entry: the tray's Quit and --quit both reach app.quit() through it, so before-quit decides the rest.
        expect(block(src, 'function requestQuit', '\n}\n')).toMatch(/app\.quit\(\);/);
        const handler = block(src, "app.on('second-instance'");
        expect(handler).toMatch(/\(_event, argv, _workingDirectory, additionalData\) =>/);
        // The SAME entry, deferred past the notification (core/quit-flag.ts `answerSecondInstance`, driven in
        // quit-second-instance.test.ts): its question asked inside the handler had Genie terminated as hung.
        // A genie:// URL in its argv (Tynn's sign-in coming back) is handed to openGenieUrl, deferred the same way.
        expect(handler).toMatch(/answerSecondInstance\(argv, additionalData, \{ quit: requestQuit, reveal: revealMainWindow, defer: \(run\) => \{ setImmediate\(run\); \}, open: openGenieUrl \}\);/);
        // Never run inside the handler.
        expect(handler).not.toMatch(/requestQuit\(\)/);
        // Not a second, private quit path: the handler never calls app.quit itself.
        expect(handler).not.toMatch(/app\.quit\(/);
    });

    it('`--quit` rides the single-instance lock, and a launch that is not `boot` exits without booting, quitting or a window', () => {
        const src = main();
        expect(src).toMatch(/const launch = launchDecision\(\{\s*\n\s*argv: process\.argv,\s*\n\s*primary: app\.requestSingleInstanceLock\(asksToQuit\(process\.argv\) \? \{ \.\.\.QUIT_DATA \} : undefined\),\s*\n\s*\}\);/);
        // EXIT, not quit: a quit would run this process's before-quit, which clears the RUNNING Genie's genie-running file.
        expect(block(src, "if (launch.kind === 'exit')", '\n}\n')).toMatch(/app\.exit\(0\);/);
        expect(block(src, "if (launch.kind === 'exit')", '\n}\n')).not.toMatch(/app\.quit\(/);
        // Only a boot launch boots; only boot() creates the main window.
        expect(src).toMatch(/if \(launch\.kind === 'boot'\) \{\s*\n\s*app\.whenReady\(\)\.then\(boot\)/);
        expect(src.match(/app\.whenReady\(\)\.then\(boot\)/g)).toHaveLength(1);
        expect(block(src, 'async function boot', '\n}\n')).toMatch(/window = createWindow\(/);
        expect(src.match(/window = createWindow\(/g)).toHaveLength(1);
        // And a launch that never booted owns nothing to shut down.
        expect(block(src, "app.on('before-quit'")).toMatch(/^app\.on\('before-quit', \(event\) => \{\s*\n\s*if \(launch\.kind !== 'boot'\) return;/);
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
