import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { remoteWindowSearch } from '../src/core/remote-window.js';
import { openRelayMember, PopKeypair } from '../src/main/relay-member.js';
import { fakeRelay } from './relay-fake.js';

/**
 * THE CONNECTING WINDOW SAYS THE MACHINE'S NAME AND WHAT IS HAPPENING (the owner, 2026-10-28, on beta.50: "So is the
 * actually connecting UX [ugly]"). beta.50's window was titled "Connecting to relay:01kxhty2z6…", put the raw
 * `relay:<id>` in an editable Host field under an open tailnet Host/PIN/"This screen's name" form, and said a bare red
 * "workstation not connected" when the machine was offline.
 *
 * Genie 1 (v0.7.0-beta.342, main/workstation-open.ts:31-87) carried the machine's NAME to the window ("The display name
 * drives the host window title"), and the tailnet form never appeared on the Tynn path.
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
const preload = strip(readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));

describe('the window is given the machine’s name', () => {
    it('the window address carries the name beside relay:<id>', () => {
        const search = remoteWindowSearch('relay:ws_aion', 'Aionima');
        const params = new URLSearchParams(search.slice(1));
        expect(params.get('remote')).toBe('relay:ws_aion');
        expect(params.get('name')).toBe('Aionima');
    });

    it('Open passes the row’s name from the popover and from ⌘K', () => {
        const opens = app.match(/onOpenWorkstation[^\n]*openRemoteHost\(`relay:\$\{w\.id\}`[^\n]*/g) ?? [];
        expect(opens.length).toBeGreaterThanOrEqual(2);
        for (const line of opens) expect(line).toContain('w.name');
    });

    it('preload and main carry the name to the window', () => {
        expect(preload).toMatch(/open: \(url, name\) => ipcRenderer\.invoke\('genie:remote-open-window', url, name\)/);
        expect(main).toMatch(/ipcMain\.handle\('genie:remote-open-window', \(_event, url: unknown, name: unknown\)/);
    });
});

describe('offline is known as offline', () => {
    it('the relay’s no-host answer comes back marked offline, not only as its words', async () => {
        const relay = fakeRelay(() => null);
        const opened = await openRelayMember({ socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: 'ws_off', grant: 'g', pop: PopKeypair.generate() });
        expect(opened).toMatchObject({ ok: false, offline: true });
    });

    it('main says which step failed, and tells the window when Tynn gave the way in', () => {
        const handler = /ipcMain\.handle\('genie:relay-open'([^]*?)\n {4}\}\);/.exec(main)?.[1] ?? '';
        expect(handler).toMatch(/stage: 'tynn'/);
        expect(handler).toMatch(/stage: 'relay'/);
        expect(handler).toContain("'genie:relay-open-step'");
        expect(handler.indexOf('mintConnectGrant(')).toBeLessThan(handler.indexOf("'genie:relay-open-step'"));
    });
});

describe('a relay window shows its own connecting screen, never the tailnet form', () => {
    const block = /if \(remote\.bound && !remote\.state\?\.connected\) \{([^]*?)\n {4}\}/.exec(app)?.[1] ?? '';

    it('relay: RelayConnecting with the name; the raw bound address is never the title', () => {
        expect(block).toContain('<RelayConnecting');
        expect(block).toMatch(/relayWorkstationOf\(remote\.bound\)/);
        expect(block).not.toMatch(/Connecting to \{remote\.bound/);
    });
});
