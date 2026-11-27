import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * QUIT KEEPS THE HOST (the host split, P1b), AND SINCE Tynn #1058 L5 THE LAUNCHER KEEPS THE TRAY. The client has no tray of
 * its own: the quit's "Just close the UI" is the launcher's launcher.closeUi (every client window closes, this one too),
 * "Shut down everything" is launcher.shutDown (the host's graceful stop on its own progress, Tynn #1079), and the last
 * window closing ends the client process, which is not a quit. The left-running mark is the launcher's.
 *
 * The behaviour behind each wire is driven elsewhere: the plan and the answers in quit-plan.test.ts, the steps in
 * quit-sequence.test.ts, the launcher's routing in launcher-quit-l5.test.ts, the launcher itself in native/launcher's
 * cargo tests. Source guards, comments stripped by line (CRLF-safe), so prose cannot satisfy them.
 */

const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
const block = (src: string, start: string, end = '\n});') => { const i = src.indexOf(start); expect(i).toBeGreaterThan(-1); const j = src.indexOf(end, i); expect(j).toBeGreaterThan(i); return src.slice(i, j); };

describe('main.ts', () => {
    const main = () => strip('src/main/main.ts');

    it('the quit asks the two answers only while a live genie-host keeps what runs, and maps the button to the answer', () => {
        const quit = block(main(), "app.on('before-quit'");
        expect(quit).toMatch(/host: agentEngineLink\?\.live === true \? \{ keptProcesses: /);
        expect(quit).toMatch(/ask: \(plan\) => quitAnswer\(plan, dialog\.showMessageBoxSync\(/);
    });

    it('"Just close the UI" is the launcher’s launcher.closeUi; then this client ends; the host is never touched', () => {
        const quit = block(main(), "app.on('before-quit'");
        const close = quit.slice(quit.indexOf("if (step === 'close-ui') {"), quit.indexOf('return;', quit.indexOf("if (step === 'close-ui') {")));
        expect(close).toMatch(/event\.preventDefault\(\);/);
        expect(close).toMatch(/quitThroughLauncher\('close-ui', \{ call: launcherCall, windowShutDown: \(\) => Promise\.resolve\(\) \}\)/);
        expect(close).toMatch(/endClient\('the quit’s answer: Just close the UI'\);/);
        expect(close).not.toMatch(/stopAll|shutdown\(/);
    });

    it('the shutdown pass runs runQuit; "Shut down everything" ends the host through the launcher, the window only with no launcher', () => {
        const quit = block(main(), "app.on('before-quit'");
        expect(quit).toMatch(/runQuit\(quitPorts, \{ drainMs: QUIT_WRITES_MS \}\)/);
        expect(quit).not.toMatch(/host\?\.stopAll\(\)/);
        const ports = block(main(), 'const quitPorts: QuitPorts = {', '\n};');
        expect(ports).toMatch(/stopAgents: \(\) => \{ host\?\.stopAll\(\); \}/);
        expect(ports).not.toMatch(/closeTerminals/);
        expect(ports).not.toMatch(/services\?\.shutdown/);
        expect(ports).toMatch(/shutDownHost: \(\) => quitThroughLauncher\('shut-down', \{ call: launcherCall, windowShutDown: \(\) => agentEngineLink\?\.shutdown\(QUIT_WRITES_MS\) \?\? Promise\.resolve\(\) \}\)/);
    });

    it('the last window closing ends the client (exit-window: nothing of the host stops); it is not a quit', () => {
        const src = main();
        expect(src).toMatch(/app\.on\('window-all-closed', \(\) => \{ endClientOnLastWindow\('every window closed'\); \}\);/);
        const end = block(src, 'function endClient(', '\n}\n');
        expect(end).toMatch(/if \(quit\.quitting\) return;/);
        expect(end).toMatch(/quit\.choose\('exit-window'\);\s*\n\s*app\.quit\(\);/);
        const last = block(src, 'function endClientOnLastWindow(', '\n}\n');
        expect(last).toMatch(/BrowserWindow\.getAllWindows\(\)\.some\(\(w\) => !w\.isDestroyed\(\) && w\.isVisible\(\)\)/);
        // Only the person's close of the main window ends it: a window Genie destroys (the host-wait window at boot, the
        // page's recovery) never does (the first L5 gate: every window row's client ended itself at boot).
        expect(last).toMatch(/if \(!mainClosedByPerson\) return;/);
        const mount = block(src, 'function mountMainWindow(', '\n}\n');
        expect(mount).toMatch(/mainClosedByPerson = false;\s*\n\s*window\.on\('close', \(\) => \{ mainClosedByPerson = true; \}\);/);
        // TRAY_NOTICE once, and only for a client a launcher started (it is the launcher's tray that stays).
        expect(last).toMatch(/launcherLink\(process\.env\) !== null && settings && settings\.snapshot\(\)\.tray_notice_shown !== true/);
    });

    it('the main window is built where there is none; its close is real and the last one ends the client', () => {
        const src = main();
        expect(block(src, 'function revealMainWindow', '\n}\n')).toMatch(/if \(!window \|\| window\.isDestroyed\(\)\) \{ mountMainWindow\(true, reason\); return; \}/);
        const mount = block(src, 'function mountMainWindow(', '\n}\n');
        expect(mount).toMatch(/window = createWindow\(show\);/);
        expect(mount).not.toMatch(/wireCloseToTray/);
        expect(mount).toMatch(/window\.on\('closed', \(\) => \{ setImmediate\(\(\) => \{ endClientOnLastWindow\('the main window closed'\); \}\); \}\);/);
        expect(mount).toMatch(/window\.on\('session-end', \(\) => \{ quit\.force\(\); app\.quit\(\); \}\);/);
        expect(mount).toMatch(/browserPane = new BrowserPane\(electronBrowserView\(window, /);
        expect(mount).toMatch(/livePanels\?\.attach\(window\);/);
        expect(block(src, "app.on('second-instance'")).toMatch(/reveal: \(\) => \{ revealMainWindow\('second launch'\); \}/);
    });

    it('the client attaches to the launcher and ends when the launcher closes the UI', () => {
        expect(main()).toMatch(/void attachLauncher\(launcherWire\(runtimeDir\(genieRoot\(\)\), 'client'\), \{ pid: process\.pid, onCloseUi: \(\) => \{ endClient\('the launcher closed the UI'\); \}/);
    });

    it('a site panel’s Restart still asks first (panelRestart, confirmTray), and restarts through the launcher', () => {
        const src = main();
        expect(src).toMatch(/restart: panelRestart\(confirmTray, restartGenie\)/);
        const restart = block(src, 'function restartGenie(', '\n}\n');
        expect(restart).toMatch(/if \(launcherLink\(process\.env\) !== null\) \{\s*\n\s*void launcherCall\('launcher\.restart'\)/);
    });

    it('Restart with no launcher (a development run): recorded, everything shut down, and Genie started again (`--hidden`)', () => {
        const restart = block(main(), 'function restartGenie(', '\n}\n');
        expect(restart).toMatch(/app\.relaunch\(\{ args: \[\.\.\.process\.argv\.slice\(1\)\.filter\(\(a\) => a !== HIDDEN_ARG\), HIDDEN_ARG\] \}\);/);
        expect(restart).toMatch(/requestQuit\('shut-down'\);/);
        // The launcher's restart comes first, and returns before the relaunch.
        expect(restart.indexOf("launcherCall('launcher.restart')")).toBeLessThan(restart.indexOf('app.relaunch('));
    });

    it('the question (a site panel’s Restart): what stops, named; Cancel the default and the cancel; only the confirm button goes on', () => {
        const ask = block(main(), 'async function confirmTray(', '\n}\n');
        // The busy marks come from a table read OFF main, and only for as long as the question can wait (ss-repeat5,
        // 2026-11-05: a synchronous read froze the window 30 s before the question came).
        expect(ask).toMatch(/const table = await tableWithin\(\(\) => systemProcessTree\.read\?\.\(\) \?\? Promise\.resolve\(null\), TRAY_TABLE_MS\);/);
        expect(ask).toMatch(/const q = trayConfirm\(action, stoppingNow\(table\)\);/);
        expect(block(main(), 'function stoppingNow(', '\n}\n')).not.toMatch(/systemProcessTree\.snapshot\(/);
        expect(ask).toMatch(/return trayConfirmed\(dialog\.showMessageBoxSync\(\{ type: 'question', title: q\.title, message: q\.message, buttons: \[\.\.\.q\.buttons\], defaultId: q\.defaultId, cancelId: q\.cancelId \}\)\);/);
    });

    it('never asked twice or of nobody: the quit dialog’s own answer, Restart itself, the OS ending the session', () => {
        const src = main();
        expect(block(src, "app.on('before-quit'")).not.toMatch(/confirmTray/);
        expect(block(src, 'function restartGenie(', '\n}\n')).not.toMatch(/confirmTray/);
        expect(block(src, "powerMonitor.on('shutdown'")).not.toMatch(/confirmTray/);
        // Only its definition calls it by name: it is handed to a site panel's Restart (panelRestart waits for its answer).
        expect(src.match(/confirmTray\(/g) ?? []).toHaveLength(1);
    });

    it('the quit counts what waits on the host’s clock, from genie-host’s summary (Tynn #953, 2g-2)', () => {
        const src = main();
        const now = block(src, 'function onTheClockNow(', '\n}\n');
        expect(now).toMatch(/armedFlows: hostSummaryNow\.armedFlows\.length, scheduledTasks: hostSummaryNow\.scheduledTasks\.length/);
        expect(block(src, "app.on('before-quit'")).toMatch(/\{ keptProcesses: hostSummaryNow\.processes\.length, \.\.\.onTheClockNow\(\) \}/);
    });

    it('no tray of the client’s own, no tray-only watch, no left-running mark, no login item: all the launcher’s', () => {
        const src = main();
        for (const gone of [/\bcreateTray\(/, /new Tray\(/, /\bwatchTrayOnly\b/, /\bleftRunning\b/, /\bLeftRunningMark\b/, /\bwireLoginItem\(/, /\bloginItemPort\b/, /\bfunction closeUi\(/]) expect(src).not.toMatch(gone);
    });

    it('a quit with an answer chosen up front chooses it, then quits', () => {
        const request = block(main(), 'function requestQuit', '\n}\n');
        expect(request).toMatch(/if \(answer\) quit\.choose\(answer\);\s*\n\s*app\.quit\(\);/);
    });

    it('nothing in src names the old client tray probe any more', () => {
        const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
        expect(files('src').filter((f) => /genie\.tray/.test(readFileSync(f, 'utf8')))).toEqual([]);
    });
});

describe('the host and the link carry no "left running" any more', () => {
    it('genie-host has no leaveRunning; the link has no leave; the protocol has no engine.leaveRunning', () => {
        expect(strip('src/main/genie-host.ts')).not.toMatch(/leftRunning|onLeftRunning/);
        expect(strip('src/main/agent-engine.ts')).not.toMatch(/leave: async/);
        expect(strip('src/core/engine-protocol.ts')).not.toMatch(/engine\.leaveRunning/);
    });
});
