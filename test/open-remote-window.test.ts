import { describe, expect, it } from 'vitest';
import { openRemoteHost } from '../src/renderer/remote-session.js';

/**
 * OPEN A HOST IN ITS OWN WINDOW — IN THE REAL APP (the two-VM proof, 2026-10-20). Connect's Open (and Open on a Tynn
 * workstation) asked `bridge?.remoteWindows` of the App's `bridge` PROP — which only tests inject; the running app reads
 * `window.genie` — so in the real app Open never made a window: it connected in place. The window that opens is the
 * one this Genie can open (the injected bridge, else the window's own); only with neither does this window connect.
 */
describe('openRemoteHost', () => {
    it('the real app (no injected bridge): opens through window.genie — its own window', () => {
        const opened: string[] = [];
        const connected: string[] = [];
        openRemoteHost('relay:ws_1', undefined, { remoteWindows: { open: async (u: string) => { opened.push(u); } } }, (u) => connected.push(u));
        expect(opened).toEqual(['relay:ws_1']);
        expect(connected).toEqual([]);
    });

    it('an injected bridge wins (tests, the live check)', () => {
        const opened: string[] = [];
        openRemoteHost('wss://h/genie', { remoteWindows: { open: async (u: string) => { opened.push(`injected ${u}`); } } }, { remoteWindows: { open: async () => { opened.push('window'); } } }, () => {});
        expect(opened).toEqual(['injected wss://h/genie']);
    });

    it('no way to open a window (a phone, a browser): this window connects (CONTROL)', () => {
        const connected: string[] = [];
        openRemoteHost('wss://h/genie', undefined, undefined, (u) => connected.push(u));
        expect(connected).toEqual(['wss://h/genie']);
    });
});
