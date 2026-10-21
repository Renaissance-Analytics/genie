import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A WINDOW DRIVING ANOTHER WORKSTATION BROWSES THAT WORKSTATION'S SITES (browser rebuild step 4, the client half;
 * Genie 1's per-connKey browser). The transport is relay-site.ts (#1067): a door on this machine, a `site` stream over
 * the Tynn relay, the host's own front door.
 *
 * 1. WHICH BROWSER is decided by the window that asked — never by what the renderer says. A window driving another
 *    workstation never falls back to this machine's sites: while its connection is down it is refused in words (Genie 1
 *    had the bug the other way: a remote window that dropped opened the LOCAL browser).
 * 2. ONE DOOR PER WORKSTATION CONNECTION, closed with it; a reconnect gets a new one. The host's CA arrives with the
 *    host's answer to an open, over the authenticated session, and is what that connection's browser trusts.
 * 3. The Electron half (one window and one in-memory session per connection) is checked from source.
 */
const connection = () => import('../src/core/browser-connection.js') as Promise<Record<string, any>>;
const remoteBrowsers = () => import('../src/main/remote-browsers.js') as Promise<Record<string, any>>;

const code = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*\/\/.*$/, ''))
        .join('\n');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const T1 = { name: 't1' };
const T2 = { name: 't2' };

describe('which browser a window gets', () => {
    it('a window that is not driving another workstation browses this machine — even holding a relay channel', async () => {
        const { browserConnectionFor } = await connection();
        expect(browserConnectionFor({ remoteUrl: null, relays: [] })).toEqual({ kind: 'local' });
        expect(browserConnectionFor({ remoteUrl: null, relays: [{ workstationId: 'ws_a', transport: T1 }] })).toEqual({ kind: 'local' });
    });

    it('a relay window browses ITS workstation, over its own open channel', async () => {
        const { browserConnectionFor } = await connection();
        const r = browserConnectionFor({ remoteUrl: 'relay:ws_a', relays: [{ workstationId: 'ws_b', transport: T2 }, { workstationId: 'ws_a', transport: T1 }] });
        expect(r).toEqual({ kind: 'relay', workstationId: 'ws_a', transport: T1 });
    });

    it('a relay window whose connection is down is REFUSED in words — never this machine’s sites (counted over both shapes)', async () => {
        const { browserConnectionFor } = await connection();
        const down = [
            browserConnectionFor({ remoteUrl: 'relay:ws_a', relays: [] }),
            browserConnectionFor({ remoteUrl: 'relay:ws_a', relays: [{ workstationId: 'ws_b', transport: T2 }] }),
        ];
        expect(down.filter((r: { kind: string }) => r.kind === 'local')).toHaveLength(0);
        expect(down.filter((r: { kind: string }) => r.kind === 'refused')).toHaveLength(2);
        for (const r of down) expect(r.reason).toMatch(/not connected/i);
    });

    it('a window that reaches its host directly (ws/wss) is refused, pointing at the Tynn network — not given this machine', async () => {
        const { browserConnectionFor } = await connection();
        for (const url of ['ws://alphar.example.test:7421', 'wss://alphar.example.test:7421']) {
            const r = browserConnectionFor({ remoteUrl: url, relays: [] });
            expect(r.kind).toBe('refused');
            expect(r.reason).toMatch(/Tynn/);
        }
    });
});

/** A transport double: openSite answers as the host would, with its CA; onClose can be fired. */
function fakeTransport(ca: string | undefined) {
    const closes = new Set<() => void>();
    const opened: string[] = [];
    return {
        opened,
        openSite: async (host: string) => { opened.push(host); return { ok: true as const, ...(ca ? { ca } : {}), pipe: () => {} }; },
        onClose: (l: () => void) => { closes.add(l); return () => { closes.delete(l); }; },
        fireClose: () => { for (const l of [...closes]) l(); },
    };
}

function fakeDoors() {
    const made: Array<{ port: number; open: (h: string) => Promise<unknown>; closed: number }> = [];
    const door = async (input: { open: (h: string) => Promise<unknown> }) => {
        const d = { port: 40000 + made.length, open: input.open, closed: 0 };
        made.push(d);
        return { port: d.port, close: () => { d.closed++; } };
    };
    return { made, door };
}

describe('one door per workstation connection', () => {
    it('the first browse makes a door; browsing again on the same connection reuses it (counted)', async () => {
        const { RemoteBrowsers } = await remoteBrowsers();
        const doors = fakeDoors();
        const browsers = new RemoteBrowsers(doors.door);
        const t = fakeTransport('HOST-CA');
        const a = await browsers.connect('ws_a', t);
        const b = await browsers.connect('ws_a', t);
        expect(doors.made).toHaveLength(1);
        expect(a.port()).toBe(40000);
        expect(b.port()).toBe(40000);
    });

    it('the door opens streams on THIS connection, and learns the host’s CA from its answer (null before any open)', async () => {
        const { RemoteBrowsers } = await remoteBrowsers();
        const doors = fakeDoors();
        const browsers = new RemoteBrowsers(doors.door);
        const t = fakeTransport('HOST-CA');
        const via = await browsers.connect('ws_a', t);
        expect(via.ca()).toBeNull();
        await doors.made[0]!.open('app.gen');
        expect(t.opened).toEqual(['app.gen']);
        expect(via.ca()).toBe('HOST-CA');
    });

    it('the connection closing closes its door; the next browse after a reconnect gets a new door and port', async () => {
        const { RemoteBrowsers } = await remoteBrowsers();
        const doors = fakeDoors();
        const browsers = new RemoteBrowsers(doors.door);
        const first = fakeTransport('HOST-CA');
        await browsers.connect('ws_a', first);
        first.fireClose();
        expect(doors.made[0]!.closed).toBe(1);
        const second = fakeTransport('HOST-CA');
        const via = await browsers.connect('ws_a', second);
        expect(doors.made).toHaveLength(2);
        expect(via.port()).toBe(40001);
    });

    it('a different connection for the same workstation replaces the old one: its door closes', async () => {
        const { RemoteBrowsers } = await remoteBrowsers();
        const doors = fakeDoors();
        const browsers = new RemoteBrowsers(doors.door);
        await browsers.connect('ws_a', fakeTransport('HOST-CA'));
        await browsers.connect('ws_a', fakeTransport('HOST-CA'));
        expect(doors.made.map((d) => d.closed)).toEqual([1, 0]);
    });

    it('two workstations: two doors, each opening on its own connection', async () => {
        const { RemoteBrowsers } = await remoteBrowsers();
        const doors = fakeDoors();
        const browsers = new RemoteBrowsers(doors.door);
        const a = fakeTransport('CA-A');
        const b = fakeTransport('CA-B');
        await browsers.connect('ws_a', a);
        await browsers.connect('ws_b', b);
        await doors.made[1]!.open('shop.gen');
        expect([a.opened, b.opened]).toEqual([[], ['shop.gen']]);
    });
});

describe('the Electron half, from source', () => {
    const win = code('../src/main/genie-browser-electron.ts');
    const main = code('../src/main/main.ts');
    const app = code('../src/renderer/App.tsx');
    const preload = code('../src/main/preload.ts');

    it('another workstation’s pages get an IN-MEMORY session of their own per connection; this machine keeps its one', () => {
        expect(count(win, /session\.fromPartition\('persist:genie-browser-window'\)/g)).toBe(1);
        expect(count(win, /session\.fromPartition\(`genie-browser:\$\{/g)).toBe(1);
        expect(count(win, /fromPartition\(`persist:genie-browser:/g)).toBe(0);
    });

    it('that session trusts the HOST’s CA (looked up live), and is routed to that connection’s door (re-routed when it moves)', () => {
        expect(win).toMatch(/guardSession\(ses, \(\) => remotes\.get\(key\)\?\.ca\(\) \?\? null\)/);
        expect(win).toMatch(/if \(remote && live\.port !== remote\.port\(\)\) \{\s*live\.port = remote\.port\(\);\s*live\.routed = routeSession\(live\.ses, remote\.port\(\), log\);/);
        // CONTROL: this machine's session keeps Genie's own CA and front door.
        expect(win).toMatch(/guardSession\(ses, \(\) => options\.caPem\)/);
        expect(win).toMatch(/routeSession\(ses, options\.frontDoorPort, log\)/);
        // One place each rule is written: both sessions go through it.
        expect(count(win, /setCertificateVerifyProc\(/g)).toBe(1);
        expect(count(win, /guardSession\(ses,/g)).toBe(2);
    });

    it('main decides by the window that asked: the sender’s remote URL and its relay channels, never an argument', () => {
        const handler = /ipcMain\.handle\('genie:browser-window-open'[\s\S]*?\n {4}\}\);/.exec(main)?.[0] ?? '';
        expect(handler).toMatch(/browserConnectionFor\(\{/);
        expect(handler).toMatch(/webContents === event\.sender/);
        expect(handler).toMatch(/c\.sender === event\.sender/);
        expect(handler).toMatch(/remoteBrowsers\.connect\(/);
    });

    it('a relay channel records which workstation it reaches', () => {
        expect(main).toMatch(/relayChannels\.set\(channel, \{ transport: opened\.transport, sender, workstationId \}\)/);
    });

    it('the preload carries the host’s site names; the relay window’s bridge is given the browser (the direct one is not)', () => {
        expect(preload).toMatch(/ipcRenderer\.invoke\('genie:browser-window-open', address, hosts\)/);
        expect(count(app, /connectRemote\([^\n]*browse/g)).toBe(1);
        expect(app).toMatch(/connectRemote\(transport, \{ kind: 'relay'[^\n]*browse/);
    });
});
