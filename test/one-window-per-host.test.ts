import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerSecondInstance, hostAsked } from '../src/core/quit-flag.js';

/*
 * ONE WINDOW PER HOST, IN ONE CLIENT PROCESS (Tynn #1058 L4). The client is one process (its single-instance lock). The
 * launcher's `launcher.openWindow {host}` starts the client with `--host <address>`, or `--open-window` with no host
 * (native/launcher/src/control.rs). When a client already runs, that start is a second launch: the running client focuses
 * that host's window or opens it, and the second process exits.
 */
const act = () => {
    const seen: string[] = [];
    return { seen, act: { quit: () => seen.push('quit'), reveal: () => seen.push('reveal'), defer: (run: () => void) => run(), open: (url: string) => seen.push(`url ${url}`), openHost: (address: string) => seen.push(`host ${address}`) } };
};

describe('the host a launch asks for', () => {
    it('--host <address> names a host; anything that is not a host address names none', () => {
        expect(hostAsked(['genie-client', '--host', 'wss://studio.example:7443'])).toBe('wss://studio.example:7443');
        expect(hostAsked(['genie-client', '--host', 'relay:ws_01'])).toBe('relay:ws_01');
        expect(hostAsked(['genie-client', '--host', 'file:///x'])).toBeNull();
        expect(hostAsked(['genie-client', '--host'])).toBeNull();
        expect(hostAsked(['genie-client', '--open-window'])).toBeNull();
    });
});

describe('a second launch', () => {
    it('with --host: that host\'s window, focused or opened; the main window is not raised in its place', () => {
        const r = act();
        expect(answerSecondInstance(['genie-client', '--host', 'wss://studio.example:7443'], null, r.act)).toBe('open-host');
        expect(r.seen).toEqual(['host wss://studio.example:7443']);
    });

    it('with --open-window, or plain: the main window, as before', () => {
        const r = act();
        expect(answerSecondInstance(['genie-client', '--open-window'], null, r.act)).toBe('reveal');
        expect(answerSecondInstance(['genie-client'], null, r.act)).toBe('reveal');
        expect(r.seen).toEqual(['reveal', 'reveal']);
    });

    it('a --host that is not a host address is a plain launch, never an open of something else', () => {
        const r = act();
        expect(answerSecondInstance(['genie-client', '--host', 'javascript:alert(1)'], null, r.act)).toBe('reveal');
        expect(r.seen).toEqual(['reveal']);
    });
});

describe('main.ts is wired to it', () => {
    it('the second launch opens a host\'s window through openRemoteWindow (one per host, keyed by its address), and so does a first launch with --host', () => {
        const main = readFileSync(join('src', 'main', 'main.ts'), 'utf8');
        const second = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf("app.on('second-instance'") + 400);
        expect(second).toMatch(/openHost: \(address\) => \{?\s*openRemoteWindow\(address/);
        expect(main).toMatch(/hostAsked\(process\.argv\)/);
    });
});
