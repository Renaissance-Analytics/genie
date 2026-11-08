import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addressOf, type AddressContext } from '../src/core/address.js';
import { parseRoute } from '../src/core/route.js';
import * as takeOverRoute from '../src/core/take-over-route.js';

/*
 * A TAKE OVER WINDOW FOR ANOTHER MACHINE KNOWS IT IS ONE, WHATEVER FORM ITS HASH IS IN (Tynn #529 part A; the Azure pair
 * run, 2026-11-08). On a real Pilot the Take Over window opened and showed the drone's Dashboard, "nobody is driving",
 * never attached: the window's hash is written machine-qualified (`#genie://<pilot>/takeover/<id>`, core/address.ts),
 * and App.tsx told a Take Over window by `hash.startsWith('#genie://takeover/')` — so it connected as a plain remote window,
 * without its ticket. One module now makes the opener's route and reads it back, in both forms.
 */
const { takeOverRouteOf, takeOverTerminalOf } = takeOverRoute as unknown as {
    takeOverRouteOf(terminalId: string): string;
    takeOverTerminalOf(hash: string): string | null;
};

const ctx: AddressContext = { workstation: 'pilot', workspaces: [{ id: 'ws_1', name: 'tynn.ai', path: '/w/tynn' }], agents: [] };

describe('one parser for the Take Over window\'s hash', () => {
    it('the opener\'s own route round-trips, as main writes it and in the machine-qualified form the window rewrites it to', () => {
        for (const id of ['term_7', 'pty-4f2a', 'a b/c']) {
            const route = takeOverRouteOf(id);
            // The route is the app's own: it parses as a Take Over window on that terminal.
            expect(parseRoute(route)).toMatchObject({ surface: 'takeover' });
            expect(takeOverTerminalOf(`#${route}`)).toBe(id);
            // The address the window shows (and its hash, once rewritten): still a Take Over window, the same terminal.
            const shown = addressOf(route, ctx);
            expect(shown).toMatch(/^genie:\/\/pilot\/takeover\//);
            expect(takeOverTerminalOf(`#${shown}`)).toBe(id);
            // With a query (a provider's login window) too.
            expect(takeOverTerminalOf(`#${shown}?login=claude`)).toBe(id);
        }
    });

    it('CONTROL: other windows are not Take Over windows — the Dashboard, a workspace, an agent named like the page', () => {
        for (const hash of ['', '#', '#genie://dashboard', '#genie://pilot/dashboard', '#genie://pilot/tynn-ai', '#genie://pilot/tynn-ai/takeover', '#genie://pilot/takeover', '#genie://takeover/', '#genie://a/b/takeover/x']) {
            expect(takeOverTerminalOf(hash), hash).toBeNull();
        }
    });

    it('the opener (main) and the detector (App) both use it; the old prefix test is gone', () => {
        const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
        const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
        const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
        expect(main).toMatch(/const route = takeOverRouteOf\(terminalId\);/);
        expect(app).toMatch(/takeOverTerminalOf\(window\.location\.hash\) !== null/);
        expect(app).not.toContain("startsWith('#genie://takeover/')");
    });
});
