import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE CLIENT'S WINDOW AND ITS QUIT — main.ts wires it. Source guards, comments stripped by line (CRLF-safe), so prose
 * cannot satisfy them; the behaviour behind each wire is driven in quit-sequence.test.ts and launcher-quit-l5.test.ts.
 * Since Tynn #1058 L5 the tray, start minimised and the logon entry are the LAUNCHER's: the client has no tray, its last
 * window closing ends the client process (not a quit), and a client that runs shows its window.
 */

describe('main.ts wiring', () => {
    // Comments stripped by line, CRLF-safe, so a guard cannot be satisfied by prose.
    const main = () => readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    /** From `start` to the end of its statement: the first `end` after it (a top-level `});` by default). */
    const block = (src: string, start: string, end = '\n});') => { const i = src.indexOf(start); expect(i).toBeGreaterThan(-1); const j = src.indexOf(end, i); expect(j).toBeGreaterThan(i); return src.slice(i, j); };

    it('window-all-closed ends the client process (exit-window: not a quit, nothing of the host stops)', () => {
        const handler = main().match(/app\.on\('window-all-closed', \(\) => \{([^}]*)\}\);/);
        expect(handler).not.toBeNull();
        expect(handler![1]).toMatch(/endClientOnLastWindow\('every window closed'\);/);
    });

    it('the main window boots shown (the launcher decides whether a client starts at all), and its close is real', () => {
        const src = main();
        // As genie-host says it: its settings first (Tynn #998, 2g-4b1), then the window, always shown.
        expect(src).toMatch(/await settingsNow\.ready\(SETTINGS_BOOT_DEADLINE_MS\);[\s\S]{0,400}?mountMainWindow\(true\);/);
        expect(src).not.toMatch(/showOnBoot\(/);
        expect(src).toMatch(/window = createWindow\(show\);/);
        // Shown ACTIVE: this is the launch the person made (genie#1235: only a gesture may take focus).
        expect(src).toMatch(/if \(show\) onceShowable\(win, process\.platform, \(\) => showWhenReady\(win, \{ activation: 'user-gesture'/);
        expect(src).not.toMatch(/wireCloseToTray\(/);
    });

    it('a second launch SHOWS the window (focus alone does nothing to a hidden one); the app menu\u2019s Quit is the one quit entry', () => {
        const src = main();
        expect(block(src, 'function revealMainWindow', '\n}\n')).toMatch(/bringUp\(window, \{ activation: 'user-gesture'/);
        expect(block(src, "app.on('second-instance'")).toMatch(/reveal: \(\) => \{ revealMainWindow\('second launch'\); \},/);
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
        expect(handler).toMatch(/answerSecondInstance\(argv, additionalData, \{ quit: requestQuit, reveal: \(\) => \{ revealMainWindow\('second launch'\); \}, defer: \(run\) => \{ setImmediate\(run\); \}, open: openGenieUrl, openHost: \(address\) => \{ openRemoteWindow\(address\); \}, show: \(route\) => \{ showToPerson\(\{ activation: 'user-gesture', route, reason: 'launcher tray' \}\); \} \}\);/);
        // Never run inside the handler.
        expect(handler).not.toMatch(/requestQuit\(\)/);
        // Not a second, private quit path: the handler never calls app.quit itself.
        expect(handler).not.toMatch(/app\.quit\(/);
    });

    it('`--quit` rides the single-instance lock, and a launch that is not `boot` exits without booting, quitting or a window', () => {
        const src = main();
        // prism-acp's approval hook never reaches main: 0.30.0 runs it as Node (genie#1235, prism-hook-runs-as-node.test.ts).
        expect(src).toMatch(/const launch: LaunchDecision = launchDecision\(\{\s*\n\s*argv: process\.argv,\s*\n\s*primary: app\.requestSingleInstanceLock\(asksToQuit\(process\.argv\) \? \{ \.\.\.QUIT_DATA \} : undefined\),\s*\n\s*\}\);/);
        // EXIT, not quit: a quit would run this process's before-quit, which clears the RUNNING Genie's genie-running file.
        expect(block(src, "if (launch.kind === 'exit') {", '\n}\n')).toMatch(/app\.exit\(0\);/);
        expect(block(src, "if (launch.kind === 'exit') {", '\n}\n')).not.toMatch(/app\.quit\(/);
        // Only a boot launch boots; only boot() creates the main window — through mountMainWindow, the one place a main window
        // is created (P1b: also when the person opens Genie again from the tray, a reveal only a booted Genie can make).
        expect(src).toMatch(/if \(launch\.kind === 'boot'\) \{\s*\n\s*app\.whenReady\(\)\.then\(boot\)/);
        expect(src.match(/app\.whenReady\(\)\.then\(boot\)/g)).toHaveLength(1);
        expect(block(src, 'async function boot', '\n}\n')).toMatch(/mountMainWindow\(true\);/);
        expect(src.match(/window = createWindow\(/g)).toHaveLength(1);
        expect(block(src, 'function mountMainWindow(', '\n}\n')).toMatch(/window = createWindow\(show\);/);
        // And a launch that never booted owns nothing to shut down.
        expect(block(src, "app.on('before-quit'")).toMatch(/^app\.on\('before-quit', \(event\) => \{\s*\n\s*if \(launch\.kind !== 'boot'\) return;/);
    });

    it('before-quit runs the one quit sequence: cancel prevents, record waits, the shutdown runs once', () => {
        const src = block(main(), "app.on('before-quit'");
        expect(src).toMatch(/const step = quit\.beforeQuit\(/);
        expect(src).toMatch(/if \(step === 'cancel'\) \{ event\.preventDefault\(\); return; \}/);
        // The shutdown pass holds the quit until the sessions' writes land (quit-drains-writes.test.ts), then runs the answer:
        // the stops are core/quit.ts runQuit's, in order (quit-sequence.test.ts), through main's quitPorts (P1b).
        expect(src).toMatch(/if \(step === 'pass'\) return;\s*\n\s*event\.preventDefault\(\);\s*\n(\s*\/\/[^\n]*\n)*\s*void runQuit\(quitPorts, \{ drainMs: QUIT_WRITES_MS \}\)/);
        expect(src).not.toMatch(/quitConfirmed|runningRecorded/);
    });

    it('the OS ending the session quits without a question: session-end on Windows, powerMonitor shutdown elsewhere', () => {
        const src = main();
        expect(src).toMatch(/window\.on\('session-end', \(\) => \{ quit\.force\(\); app\.quit\(\); \}\);/);
        expect(block(src, "powerMonitor.on('shutdown'")).toMatch(/quit\.force\(\);\s*\n\s*app\.quit\(\);/);
    });

    it('start on logon: the client says its two settings to the launcher (which writes the entry), at boot and on change', () => {
        const src = main();
        expect(src).not.toMatch(/wireLoginItem\(/);
        expect(src).toMatch(/void launcherCall\('launcher\.logon', \[\{ setting: v\.launch_at_login === true, startMinimized: v\.start_minimized === true \}\]\)/);
        expect(src).toMatch(/sayLogon\('at boot'\);/);
        expect(src).toMatch(/settingsNow\.onChange\(\(key, _value, workspaceId\) => \{ if \(workspaceId === undefined && \(key === 'launch_at_login' \|\| key === 'start_minimized'\)\) sayLogon\('the setting changed'\); \}\);/);
    });
});
