import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

/**
 * CLIENT/HOST SPLIT STEP 2d-4b2 (Tynn #898, story #910, task #1424): ONE HOST SERVES EVERY CLIENT. Since 2d-4b1 this
 * machine's window is served by genie-host's RemoteHost, through its tunnel. main's own RemoteHost (compose.ts), the
 * buildHostApi wiring behind it (main.ts) and the typing relay that carried a window's events to genie-host
 * (forwardEvents → engine.remoteAccess 'event' → newestWindow/windowEvent → hostRemoteApi's onEvent port) serve nobody;
 * they are deleted. A client is a dumb terminal: it serves no remote connection (the owner's ruling), so compose keeps
 * no remote-serving section of its own, host-less or not. Names are fixtures, never real ones.
 */

const TOKEN = 'e'.repeat(64);
const strip = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const source = async (path: string) => strip(await readFile(path, 'utf8'));

/** A host that welcomes on another engine protocol: what an older (or newer) genie-host says to this window. */
function hostOnProtocol(protocol: number) {
    const [hostSide, windowSide] = memoryPair();
    const heard: string[] = [];
    let closed = false;
    hostSide.onMessage((text) => {
        heard.push(text);
        if (heard.length === 1) hostSide.send(JSON.stringify({ kind: 'welcome', connectionId: 'e1', host: 'box', isOwner: true, workspaceId: null, protocol, build: 'other', pid: 77 }));
    });
    hostSide.onClose(() => { closed = true; });
    return { windowSide: windowSide as ClientTransport, heard, closed: () => closed };
}

describe('a window and a host on different engine protocols part cleanly (2d-4b coordinator check)', () => {
    for (const [name, protocol] of [['an older host', ENGINE_PROTOCOL - 1], ['a newer host', ENGINE_PROTOCOL + 1]] as const) {
        it(`${name}'s welcome is refused: connect settles ok:false, the link closes, and nothing is tunnelled`, async () => {
            const host = hostOnProtocol(protocol);
            const client = new SessionEngineClient();
            const settled = await Promise.race([
                client.connect(host.windowSide, TOKEN),
                new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000)),
            ]);
            expect(settled).toEqual({ ok: false, reason: `the host speaks protocol ${protocol}, this window ${ENGINE_PROTOCOL}` });
            await new Promise((r) => setTimeout(r, 20));
            expect(host.closed()).toBe(true);
            expect(client.connected).toBe(false);
            // No tunnel op before an accepted welcome: the window's door has nothing to carry over this link.
            expect(client.protocolSend('open', 't1', { window: 'main', label: 'this Genie window' })).toBe(false);
            expect(host.heard).toHaveLength(1);
            expect(JSON.parse(host.heard[0]!)).toMatchObject({ kind: 'hello', auth: { kind: 'token' } });
        });
    }

    it('POSITIVE CONTROL: a host on this protocol is accepted on the same fixture', async () => {
        const host = hostOnProtocol(ENGINE_PROTOCOL);
        const client = new SessionEngineClient();
        const connecting = client.connect(host.windowSide, TOKEN);
        await new Promise((r) => setTimeout(r, 20));
        // The welcome was taken: the link stays open, waiting for the host's dump (engine.ready), and is not refused.
        expect(host.closed()).toBe(false);
        expect(client.connected).toBe(true);
        host.windowSide.close();
        await expect(connecting).resolves.toMatchObject({ ok: false });
    });
});

describe('main serves no protocol of its own', () => {
    it('main builds no host API, feeds no RemoteHost and forwards no events', async () => {
        const main = await source('src/main/main.ts');
        expect(main).not.toMatch(/buildHostApi/);
        expect(main).not.toMatch(/remoteApiNow/);
        expect(main).not.toMatch(/forwardEvents\(/);
        expect(main).not.toMatch(/remoteTransport:/);
        expect(main).not.toMatch(/remoteApi:/);
        expect(main).not.toMatch(/localFeatureInvalidations/);
        expect(main).not.toMatch(/const remoteHub = transportHub\(/);
        // What stays: the door tunnels to genie-host, and the window's own facts are said down it.
        expect(main).toMatch(/tunnelDoor\(localDoor, tunnelLinkOf\(/);
        expect(main).toMatch(/remoteAccess: linkedRemote/);
    });

    it('compose keeps no RemoteHost and no remote-serving section, host-less or not: the remote view is genie-host’s', async () => {
        const compose = await source('src/main/compose.ts');
        expect(compose).not.toMatch(/new RemoteHost\(/);
        expect(compose).not.toMatch(/import \{ RemoteHost/);
        expect(compose).not.toMatch(/readonly remoteApi\?:/);
        expect(compose).not.toMatch(/readonly remoteTransport\?:/);
        expect(compose).not.toMatch(/openDevices/);
        expect(compose).toMatch(/readonly remoteAccess: RemoteAccessReplica \| RemoteAccessView;/);
        expect(compose).toMatch(/remote: input\.remoteAccess,/);
        expect(compose).toMatch(/pairing: input\.remoteAccess\.pairing,/);
    });
});

describe('the typing relay is gone: genie-host publishes what a Pilot types itself (Tynn #730)', () => {
    it('no window forwards events, and genie-host takes none from a window', async () => {
        expect(await source('src/main/remote-access-replica.ts')).not.toMatch(/forwardEvents|wantedListeners|'event'/);
        const access = await source('src/main/remote-access-host.ts');
        expect(access).not.toMatch(/newestWindow|windowEvent|case 'event':|ports\.onEvent/);
        expect(access).not.toMatch(/readonly onEvent\?: \(listener: \(channel: string, payload: unknown\) => void\) => \(\) => void;/);
        const host = await source('src/main/genie-host.ts');
        expect(host).not.toMatch(/remoteWindowEvents|newestWindow:|windowEvent:/);
    });
});
