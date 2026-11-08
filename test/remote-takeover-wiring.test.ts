import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * TAKE OVER FROM ANOTHER MACHINE OPENS A WINDOW ON THIS ONE (Tynn #529 part A) — the Electron half, read from source
 * (main.ts and the App's hooks are not composed in a test; the host's rules are test/remote-host.test.ts, the companion
 * connection test/remote-bridge.test.ts). Line comments stripped (CRLF-safe).
 *
 * The ticket the host answers Take over with is a credential for one terminal: it never rides in a URL, a window title or
 * a log. Main holds it for the window it opens, and that window reads it ONCE.
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
const preload = strip(readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string): string {
    const at = source.indexOf(start);
    expect(at, `missing: ${start}`).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('\n    });', at));
}

describe('main opens the Take Over window and hands it its ticket once', () => {
    it('a handler opens the window for the remote terminal; the ticket goes into main’s own map, never the URL, the title or a log', () => {
        const open = body(main, "ipcMain.handle('genie:remote-takeover-open'");
        expect(open).toMatch(/openRemoteTakeOverWindow\(/);
        const opener = main.slice(main.indexOf('function openRemoteTakeOverWindow('), main.indexOf('\n}\n', main.indexOf('function openRemoteTakeOverWindow(')));
        expect(opener).toMatch(/takeOverWindow\(route, request, \{ search, ticket \}\)/);
        // The one Take Over window maker (main/main.ts `takeOverWindow`): the ticket goes to main's map, nowhere else.
        const maker = main.slice(main.indexOf('function takeOverWindow('), main.indexOf('\n}\n', main.indexOf('function takeOverWindow(')));
        expect(maker).toMatch(/takeOverTickets\.set\(win\.webContents\.id, remote\.ticket\)/);
        const fn = `${opener}\n${maker}`;
        expect(fn).not.toMatch(/remoteWindowSearch\([^)]*ticket/);
        expect(fn).not.toMatch(/hash:[^}]*ticket/);
        expect(fn).not.toMatch(/title:[^,}]*ticket/);
        expect(`${open}\n${fn}`).not.toMatch(/console\.[a-z]+\([^)]*ticket/);
    });

    it('the window reads its ticket once: the read deletes it', () => {
        const read = body(main, "ipcMain.handle('genie:takeover-ticket'");
        expect(read).toMatch(/takeOverTickets\.get\(event\.sender\.id\)/);
        expect(read).toMatch(/takeOverTickets\.delete\(event\.sender\.id\)/);
        expect(read).not.toMatch(/console\./);
    });

    it('a Take Over window for another machine is a remote window: it gets none of this host’s own powers', () => {
        expect(main).toMatch(/const isRemoteWindow = \(sender: Electron\.WebContents\): boolean => \[\.\.\.remoteWindows\.values\(\), \.\.\.remoteTakeOverWindows\]/);
    });

    it('preload exposes the opener and the one read', () => {
        expect(preload).toMatch(/openTakeOver: \(url, terminalId, ticket, name\) => ipcRenderer\.invoke\('genie:remote-takeover-open', url, terminalId, ticket, name\)/);
        expect(preload).toMatch(/takeOverTicket: \(\) => ipcRenderer\.invoke\('genie:takeover-ticket'\)/);
    });
});

describe('the App asks for the window, and the window connects as its companion', () => {
    it('Take over in a window driving another machine opens this machine’s Take Over window with the host’s ticket', () => {
        expect(app).toMatch(/remoteWindows\?\.openTakeOver\?\.\(/);
    });

    it('a Take Over window bound to another machine connects with its ticket, and does not drive', () => {
        expect(app).toMatch(/companion: ticket/);
        expect(app).toMatch(/takeOverTicket\?\.\(\)/);
    });
});
