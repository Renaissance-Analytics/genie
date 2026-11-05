import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * QUIT KEEPS THE HOST, AND THE TRAY KEEPS GENIE (the host split, P1b; the owner, 2026-11-02: "Keep the tray up … as long as
 * any genie services are running, that tray should be there so users can shut them down or restart if needed").
 *
 * The behaviour behind each wire is driven elsewhere: the plan and the answers in quit-plan.test.ts, the steps in
 * quit-sequence.test.ts, the tray-only rule in tray-only.test.ts, the tray in tray.test.ts. Source guards, comments
 * stripped by line (CRLF-safe), so prose cannot satisfy them.
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

    it('"Just close the UI" is not a quit: the quit is prevented, the windows close, the process stays as the tray', () => {
        const quit = block(main(), "app.on('before-quit'");
        expect(quit).toMatch(/if \(step === 'close-ui'\) \{ event\.preventDefault\(\); closeUi\('the quit’s answer'\); return; \}/);
        const close = block(main(), 'function closeUi(', '\n}\n');
        // Every window goes — the main one and every other (Take Over, files, remote, the Genie browser).
        expect(close).toMatch(/for \(const w of BrowserWindow\.getAllWindows\(\)\) if \(!w\.isDestroyed\(\)\) w\.destroy\(\);/);
        expect(close).toMatch(/window = null;/);
        // Nothing of the host is touched: no stop, no shutdown, no leave.
        expect(close).not.toMatch(/stopAll|shutdown|leave/);
    });

    it('the shutdown pass runs runQuit; the before-quit handler stops nothing itself', () => {
        const quit = block(main(), "app.on('before-quit'");
        expect(quit).toMatch(/runQuit\(quitPorts\)/);
        expect(quit).not.toMatch(/host\?\.stopAll\(\)/);
        const ports = block(main(), 'const quitPorts: QuitPorts = {', '\n};');
        expect(ports).toMatch(/stopAgents: \(\) => \{ host\?\.stopAll\(\); \}/);
        expect(ports).toMatch(/closeTerminals: \(\) => \{ terminals\?\.closeAll\(\); \}/);
        expect(ports).toMatch(/void services\?\.shutdown\(\);/);
        expect(ports).toMatch(/shutDownHost: \(\) => agentEngineLink\?\.shutdown\(QUIT_WRITES_MS\)/);
    });

    it('the main window is REBUILT where there is none: Open Genie and a second launch reach mountMainWindow', () => {
        const src = main();
        expect(block(src, 'function revealMainWindow', '\n}\n')).toMatch(/if \(!window \|\| window\.isDestroyed\(\)\) \{ mountMainWindow\(true, reason\); return; \}/);
        // Everything bound to ONE window is bound in mountMainWindow, every time: the close, the session end, the browser pane, the site panels.
        const mount = block(src, 'function mountMainWindow(', '\n}\n');
        expect(mount).toMatch(/window = createWindow\(show\);/);
        expect(mount).toMatch(/wireCloseToTray\(window, \{/);
        expect(mount).toMatch(/window\.on\('session-end', \(\) => \{ quit\.force\(\); app\.quit\(\); \}\);/);
        expect(mount).toMatch(/browserPane = new BrowserPane\(electronBrowserView\(window, /);
        expect(mount).toMatch(/livePanels\?\.attach\(window\);/);
        expect(src).toMatch(/onOpen: \(\) => \{ revealMainWindow\('tray: Open'\); \},/);
        expect(block(src, "app.on('second-instance'")).toMatch(/reveal: \(\) => \{ revealMainWindow\('second launch'\); \}/);
    });

    it('the tray offers the host’s verbs while the host is genie-host, and says what it runs', () => {
        const src = main();
        // ALWAYS ASK (the owner, 2026-11-02): the tray's Restart and Shut down everything confirm first, every time.
        expect(src).toMatch(/\.\.\.\(agentEngineLink \? \{ onCloseUi: \(\) => \{ closeUi\('tray'\); \}, onRestart: \(\) => \{ void confirmTray\('restart'\)\.then\(\(ok\) => \{ if \(ok\) restartGenie\(\); \}\); \}, onShutDown: \(\) => \{ void confirmTray\('shut-down'\)\.then\(\(ok\) => \{ if \(ok\) requestQuit\('shut-down'\); \}\); \}, uiOpen: \(\) => window !== null && !window\.isDestroyed\(\) \} : \{\}\),/);
        expect(block(src, 'function refreshTray', '\n}\n')).toMatch(/trayTooltip\(held, signedOut, paused, designLogin, trayWaiting, hostNow\)/);
    });

    it('the tray’s question: what stops, named; Cancel the default and the cancel; only the confirm button goes on', () => {
        const ask = block(main(), 'async function confirmTray(', '\n}\n');
        // The busy marks come from a table read OFF main, and only for as long as the question can wait (ss-repeat5,
        // 2026-11-05: a synchronous read froze the window 30 s before the question came).
        expect(ask).toMatch(/const table = await tableWithin\(\(\) => systemProcessTree\.read\?\.\(\) \?\? Promise\.resolve\(null\), TRAY_TABLE_MS\);/);
        expect(ask).toMatch(/const q = trayConfirm\(action, stoppingNow\(table\)\);/);
        expect(block(main(), 'function stoppingNow(', '\n}\n')).not.toMatch(/systemProcessTree\.snapshot\(/);
        expect(ask).toMatch(/return trayConfirmed\(dialog\.showMessageBoxSync\(\{ type: 'question', title: q\.title, message: q\.message, buttons: \[\.\.\.q\.buttons\], defaultId: q\.defaultId, cancelId: q\.cancelId \}\)\);/);
    });

    it('never asked twice or of nobody: the quit dialog’s own answer, the tray-only exit, the OS ending the session', () => {
        const src = main();
        expect(block(src, "app.on('before-quit'")).not.toMatch(/confirmTray/);
        expect(block(src, 'function watchTrayOnly(', '\n}\n')).not.toMatch(/confirmTray/);
        expect(block(src, 'function restartGenie(', '\n}\n')).not.toMatch(/confirmTray/);
        // confirmTray is called from the two tray choices only.
        expect(src.match(/confirmTray\(/g) ?? []).toHaveLength(3); // its definition and the two tray handlers
    });

    it('Restart: recorded, everything shut down, and Genie started again in the tray (`--hidden`)', () => {
        const restart = block(main(), 'function restartGenie(', '\n}\n');
        expect(restart).toMatch(/app\.relaunch\(\{ args: \[\.\.\.process\.argv\.slice\(1\)\.filter\(\(a\) => a !== HIDDEN_ARG\), HIDDEN_ARG\] \}\);/);
        expect(restart).toMatch(/requestQuit\('shut-down'\);/);
    });

    it('tray-only, nothing left running for the grace: Genie shuts everything down and exits', () => {
        const src = main();
        const watch = block(src, 'function watchTrayOnly(', '\n}\n');
        expect(watch).toMatch(/trayOnlyStep\(\{ uiOpen: window !== null && !window\.isDestroyed\(\), activity: hostActivityNow\(\) \}, trayQuietSince, Date\.now\(\)\)/);
        expect(watch).toMatch(/if \(step\.exit\) \{[\s\S]*?requestQuit\('shut-down'\);/);
    });

    it('the tray and the quit count what waits on the host\u2019s clock, from the host\u2019s own replicas', () => {
        const src = main();
        const now = block(src, 'function onTheClockNow(', '\n}\n');
        expect(now).toMatch(/onTheClock\(agentEngineLink\.client\.flows\(\)\.list\(\), agentEngineLink\.client\.processBook\(\)\.kept\(\)\)/);
        expect(block(src, 'function hostActivityNow(', '\n}\n')).toMatch(/\.\.\.onTheClockNow\(\)/);
        expect(block(src, "app.on('before-quit'")).toMatch(/\{ keptProcesses: kept, \.\.\.onTheClockNow\(\) \}/);
    });

    it('a quit with an answer chosen up front (the tray, Restart, the tray-only exit) chooses it, then quits', () => {
        const request = block(main(), 'function requestQuit', '\n}\n');
        expect(request).toMatch(/if \(answer\) quit\.choose\(answer\);\s*\n\s*app\.quit\(\);/);
    });

    it('the tray probe (for the VM proof) is ABSENT without GENIE_TRAY_PROBE=1: installed only inside that gate', () => {
        const src = main();
        // The one assignment, inside the gate (trayProbeEnabled: only GENIE_TRAY_PROBE=1 — tray-only.test.ts).
        expect(src).toMatch(/if \(trayProbeEnabled\(process\.env\)\) \{\s*\n\s*\(globalThis as Record<symbol, unknown>\)\[Symbol\.for\('genie\.tray'\)\] = \{/);
        expect(src.match(/Symbol\.for\('genie\.tray'\)/g) ?? []).toHaveLength(1);
    });

    it('nothing else reaches the tray probe: no preload, renderer, remote method or MCP tool names it', () => {
        const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
        const naming = files('src').filter((f) => /genie\.tray/.test(readFileSync(f, 'utf8')));
        expect(naming.map((f) => f.split('\\').join('/'))).toEqual(['src/main/main.ts']);
    });
});

describe('the host and the link carry no "left running" any more', () => {
    it('genie-host has no leaveRunning; the link has no leave; the protocol has no engine.leaveRunning', () => {
        expect(strip('src/main/genie-host.ts')).not.toMatch(/leftRunning|onLeftRunning/);
        expect(strip('src/main/agent-engine.ts')).not.toMatch(/leave: async/);
        expect(strip('src/core/engine-protocol.ts')).not.toMatch(/engine\.leaveRunning/);
    });
});
