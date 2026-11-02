import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * QUIT KEEPS THE HOST — the wiring (the host split, P1b). The behaviour behind each wire is driven elsewhere: the plan and
 * the answers in quit-plan.test.ts, the steps and their effects in quit-sequence.test.ts, the window-only shutdown in
 * compose-quit-stops-first.test.ts, the host's side in engine-leave-running.test.ts and host-idle-exit.test.ts, the tray
 * in tray.test.ts. Source guards, comments stripped by line (CRLF-safe), so prose cannot satisfy them.
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

    it('both answers run through runQuit; the before-quit handler stops nothing itself', () => {
        const quit = block(main(), "app.on('before-quit'");
        expect(quit).toMatch(/runQuit\(step, \{/);
        expect(quit).not.toMatch(/host\?\.stopAll\(\)/);
        expect(quit).not.toMatch(/terminals\?\.closeAll\(\)/);
        const ports = block(main(), 'const quitPorts: QuitPorts = {', '\n};');
        expect(ports).toMatch(/stopAgents: \(\) => \{ host\?\.stopAll\(\); \}/);
        expect(ports).toMatch(/closeTerminals: \(\) => \{ terminals\?\.closeAll\(\); \}/);
        expect(ports).toMatch(/void services\?\.shutdown\(how\);/);
        expect(ports).toMatch(/shutDownHost: \(\) => agentEngineLink\?\.shutdown\(QUIT_WRITES_MS\)/);
        expect(ports).toMatch(/leaveHostRunning: \(\) => agentEngineLink\?\.leave\(\)/);
    });

    it('a quit with an answer chosen up front (the tray) chooses it, then quits; the plain quit still asks', () => {
        const request = block(main(), 'function requestQuit', '\n}\n');
        expect(request).toMatch(/if \(answer\) quit\.choose\(answer\);\s*\n\s*app\.quit\(\);/);
    });

    it('the tray offers the two answers while the host is genie-host, and says the host is running', () => {
        const src = main();
        expect(src).toMatch(/\.\.\.\(agentEngineLink \? \{ onCloseUi: \(\) => \{ requestQuit\('close-ui'\); \}, onShutDown: \(\) => \{ requestQuit\('shut-down'\); \} \} : \{\}\),/);
        expect(block(src, 'function refreshTray', '\n}\n')).toMatch(/trayTooltip\(held, signedOut, paused, designLogin, trayWaiting, hostAgents\)/);
    });
});

describe('agent-engine.ts', () => {
    it('leave(): no reconnect from here, the host told it is left running, then the link let go — never engine.shutdown', () => {
        const leave = block(strip('src/main/agent-engine.ts'), 'leave: async () => {', '\n        },');
        expect(leave).toMatch(/stopping = true;/);
        expect(leave).toMatch(/await client\.leaveRunning\(\)/);
        expect(leave).toMatch(/client\.disconnect\(\);/);
        expect(leave).not.toMatch(/shutdown/);
    });
});

describe('genie-host.ts', () => {
    const src = () => strip('src/main/genie-host.ts');

    it('a window saying leaveRunning marks the host left running', () => {
        expect(src()).toMatch(/onLeftRunning: \(\) => \{ leftRunning = true;/);
    });

    it('the idle exit is hostIdle, with the left-running mark', () => {
        expect(src()).toMatch(/hostIdle\(\{ sessions: host\.count, windows: engine\.clients, livePtys: relay\?\.live\(\) \?\? 0, leftRunning \}, lastBusy, Date\.now\(\), IDLE_MS\)/);
    });
});
