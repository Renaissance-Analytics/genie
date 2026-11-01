import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { droneRefusal, outboundDialRefusal } from '../src/core/workstation-role.js';

/**
 * A DRONE NEVER CONNECTS OUT (the owner, 2026-10-28; pairing vs share link audit M-b). Tynn already refuses a drone's
 * list, grants and shares, and main refused the Tynn relay open; but a tailnet host (`ws://`/`wss://`) was only hidden
 * in the window, and the socket is dialled from a renderer that main never asked. Main decides now, from the role Tynn
 * gave this machine and nothing the window sends: it refuses to open a remote host's window, and it cancels any
 * WebSocket an app window (the default session) tries to open while this machine is a drone.
 */
describe('outboundDialRefusal', () => {
    const tailnet = ['ws://100.101.102.103:7421', 'wss://alphar.tail1234.ts.net:7421/genie', 'WSS://alphar:7421'];

    it('a drone: every remote dial is refused with the drone sentence (a tailnet host, a Tynn workstation)', () => {
        for (const url of [...tailnet, 'relay:ws_1']) expect(outboundDialRefusal('drone', url)).toBe(droneRefusal('drone'));
    });

    it('a pilot, and a Genie not on the Tynn network: the same dials go through (CONTROL)', () => {
        for (const url of [...tailnet, 'relay:ws_1']) {
            expect(outboundDialRefusal('pilot', url)).toBeNull();
            expect(outboundDialRefusal(null, url)).toBeNull();
        }
    });

    it('what is not a dial is not judged here: the app’s own files and pages load on a drone', () => {
        for (const url of ['file:///C:/genie/renderer/index.html', 'https://tynn.ai/login', 'devtools://devtools/x', 'data:text/plain,x']) {
            expect(outboundDialRefusal('drone', url)).toBeNull();
        }
    });
});

/** main.ts with every comment line removed: a guard on code, not on a comment that mentions it. */
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
    .join('\n');

describe('main enforces it, not the window', () => {
    it('opening a remote host’s window asks outboundDialRefusal with the role main read from Tynn', () => {
        const at = main.indexOf("ipcMain.handle('genie:remote-open-window'");
        expect(at).toBeGreaterThan(-1);
        const handler = main.slice(at);
        expect(handler.slice(0, handler.indexOf('\n'))).toContain('outboundDialRefusal(workstationRoleNow');
    });

    it('the app windows’ session cancels a WebSocket main refuses', () => {
        expect(main).toMatch(/session\.defaultSession\.webRequest\.onBeforeRequest\([^\n]*outboundDialRefusal\(workstationRoleNow, details\.url\)/);
    });
});
