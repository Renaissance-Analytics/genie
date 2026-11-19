import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as inventory from '../src/core/ipc-inventory.js';
import { memoryPair } from '../src/core/line-transport.js';
import * as protocol from '../src/core/remote-protocol.js';
import { capabilityOf, inMemoryPair, transportHub, type CallContext, type RemoteMethod, type ServerConnection, type ServerTransport } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import type { HostApi } from '../src/main/remote-host.js';
import { ProtocolTunnels } from '../src/main/protocol-tunnels.js';
import { hostRemoteApi, RemoteAccessHost } from '../src/main/remote-access-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { tunnelDoor, tunnelLinkOf } from '../src/main/window-tunnel.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2b-2b, THE TRAY'S LOG IN (Tynn #898, story #896, task #1427). The coordinator's design
 * (2026-11-19): the tray is a client like any other. main gets a small protocol client of its own, whose connections are
 * carried over a SECOND tunnel door on main's engine link to genie-host's RemoteHost, admitted there as this machine's
 * own window ("Genie's tray"). It says hello, makes one call, and closes. The tray's Log in is `logins.provider` (a new
 * sign-in, owner-only like the others: SIGN_IN_METHODS) and its Claude Design login is `logins.design`. genie-host runs
 * the PROVIDER'S OWN login and asks main to open its window; closing that window cancels it there. Genie never touches a
 * credential. main's own sign-in (`signIn`, engine `login`) and its `cancelLogin` on a window's close are gone.
 *
 * The guard records the tray's door as a protocol door that rides the engine link, never as a listener.
 * Names are fixtures, never real ones.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };
const TOKEN = 'e'.repeat(64);
const TRAY = 'Genie’s tray';

/** Dynamic: new in this step, so each case goes red on its own. */
type CallAnswer = { ok: true; value: unknown } | { ok: false; reason: string };
interface OwnClient { readonly door: ServerTransport; call(method: RemoteMethod, args: unknown[]): Promise<CallAnswer> }
const ownModule = async () => { const file: string = '../src/main/own-protocol-client.js'; return import(file) as Promise<{ ownProtocolClient: (options?: { timeoutMs?: number }) => OwnClient; OWN_CLIENT_LABEL: string }>; };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe('logins.provider: the tray’s Log in, a sign-in like the others', () => {
    it('is a remote method, a write, one of SIGN_IN_METHODS (owner-only, the step-3 hook) and genie-host’s', () => {
        expect(protocol.REMOTE_METHODS as readonly string[]).toContain('logins.provider');
        expect(capabilityOf('logins.provider' as RemoteMethod)).toBe('write');
        expect(protocol.SIGN_IN_METHODS as readonly string[]).toEqual(['providerLogin', 'logins.design', 'accounts.switch', 'logins.provider']);
        expect(HOST_ALONE_METHODS.has('logins.provider' as RemoteMethod)).toBe(true);
    });

    it('the host API starts the provider’s own login for the caller (signIns.loginFor), never a credential', async () => {
        const asked: Array<[string, CallContext | undefined]> = [];
        const api = buildHostApi({
            features: {}, workspaceOps: {}, agentOps: {}, updates: null,
            signIns: {
                loginFor: async (provider: string, context?: CallContext) => { asked.push([provider, context]); return { ok: true, terminalId: 't1', route: `login/${provider}/t1` }; },
                providerLogin: async () => { throw new Error('not this one'); },
                design: async () => { throw new Error('not this one'); },
                switchAccount: async () => { throw new Error('not this one'); },
            },
        } as unknown as HostApiDeps);
        const ctx: CallContext = { connectionId: 'rc_tray', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: TRAY };
        expect(await api.invoke('logins.provider' as RemoteMethod, ['claude'], ctx)).toEqual({ ok: true, terminalId: 't1', route: 'login/claude/t1' });
        expect(asked).toEqual([['claude', ctx]]);
    });

    it('CONTROL: with no sign-ins port the host says it cannot, in words', async () => {
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await api.invoke('logins.provider' as RemoteMethod, ['claude'])).toEqual({ ok: false, reason: 'this host cannot start a sign-in' });
    });
});

/** genie-host's RemoteHost behind the tunnels, with main's engine link and the tray's door tunnelled over it. */
async function hostAndTray(signIns: Record<string, unknown>) {
    const home = await mkdtemp(join(tmpdir(), 'genie-2b2b-'));
    const tunnels = new ProtocolTunnels();
    const relay: Array<(c: ServerConnection) => void> = [];
    const hub = transportHub(tunnels);
    hub.add({ onConnection: (cb) => { relay.push(cb); return () => {}; } });
    const none = () => () => {};
    const alone: HostApi = buildHostApi({
        snapshot: () => ({ agents: [], workspaces: [], deckItems: [], signals: {} }),
        subscribeSnapshot: none, subscribeAgentRecords: none, find: () => null, detailFor: () => null, cwdFor: () => null,
        host: { subscribe: none }, terminals: { onData: none, onExit: none, list: () => [] },
        features: {}, updates: null, workspaceOps: {}, agentOps: {}, signIns,
    } as unknown as HostApiDeps);
    const access = await RemoteAccessHost.open({ home, hostName: 'box', api: hostRemoteApi({ hostName: 'box', own: {}, alone, workspaceOfAgent: () => null }), transport: hub, now: () => 1_000_000, confirm: { ...allowEveryPairing, requests: () => [], answer: () => ({ ok: true as const }), onChange: () => () => {} } });
    cleanups.push(async () => { await access.close(); await rm(home, { recursive: true, force: true }); });
    const server = new SessionEngineServer({ token: TOKEN, build: 't', protocol: tunnels });
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide, { local: true });
    const client = new SessionEngineClient({ onWindowOp: async () => 'closed' });
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    cleanups.push(() => windowSide.close());
    const { ownProtocolClient } = await ownModule();
    const own = ownProtocolClient({ timeoutMs: 2_000 });
    const tray = tunnelDoor(own.door, tunnelLinkOf(client));
    cleanups.push(() => tray.dispose());
    return { own, tunnels, relay, client };
}

const signInsSeen = () => {
    const asked: Array<[string, string, CallContext | undefined]> = [];
    const answer = (what: string, provider: string, context?: CallContext) => { asked.push([what, provider, context]); return { ok: true as const, terminalId: `t_${provider}`, route: `login/${provider}` }; };
    return {
        asked,
        signIns: {
            loginFor: async (provider: string, context?: CallContext) => answer('loginFor', provider, context),
            design: async (context?: CallContext) => answer('design', 'design', context),
            providerLogin: async () => { throw new Error('not this one'); },
            switchAccount: async () => { throw new Error('not this one'); },
        },
    };
};

describe('main’s own protocol client: hello, one call, close, over the tray’s tunnel door', () => {
    it('names itself Genie’s tray', async () => {
        expect((await ownModule()).OWN_CLIENT_LABEL).toBe(TRAY);
    });

    it('the tray’s Log in reaches genie-host’s RemoteHost as this machine’s own window, the owner, and is answered', async () => {
        const seen = signInsSeen();
        const h = await hostAndTray(seen.signIns);
        const answer = await h.own.call('logins.provider' as RemoteMethod, ['claude']);
        expect(answer).toEqual({ ok: true, value: { ok: true, terminalId: 't_claude', route: 'login/claude' } });
        expect(seen.asked.map(([what, provider]) => [what, provider])).toEqual([['loginFor', 'claude']]);
        expect(seen.asked[0]![2]).toMatchObject({ origin: 'local-window', isOwner: true, workspaceId: null, readonly: false, label: TRAY });
    });

    it('the tray’s Claude Design login is logins.design, the same way', async () => {
        const seen = signInsSeen();
        const h = await hostAndTray(seen.signIns);
        expect(await h.own.call('logins.design' as RemoteMethod, [])).toMatchObject({ ok: true, value: { ok: true } });
        expect(seen.asked.map(([what]) => what)).toEqual(['design']);
    });

    it('closes its connection once answered: the tunnel carries nothing after the call', async () => {
        const seen = signInsSeen();
        const h = await hostAndTray(seen.signIns);
        let opened = 0;
        let closed = 0;
        h.tunnels.onConnection((c) => { opened += 1; c.onClose(() => { closed += 1; }); });
        await h.own.call('logins.provider' as RemoteMethod, ['claude']);
        await settle();
        expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
    });

    it('a refused call comes back refused, in the host’s words', async () => {
        const h = await hostAndTray(signInsSeen().signIns);
        const answer = await h.own.call('no.such.method' as RemoteMethod, []);
        expect(answer.ok).toBe(false);
        expect((answer as { reason: string }).reason.length).toBeGreaterThan(0);
    });

    it('before the engine link is up the call is refused as still starting, never left waiting', async () => {
        const { ownProtocolClient } = await ownModule();
        const own = ownProtocolClient({ timeoutMs: 2_000 });
        const tray = tunnelDoor(own.door, tunnelLinkOf(new SessionEngineClient()));
        cleanups.push(() => tray.dispose());
        const answer = await own.call('logins.provider' as RemoteMethod, ['claude']);
        expect(answer).toMatchObject({ ok: false });
        expect((answer as { reason: string }).reason).toMatch(/starting/);
    });

    it('with no door listening at all (main not composed yet) the call is refused, never left waiting', async () => {
        const { ownProtocolClient } = await ownModule();
        // A timeout far past the test's own: only an answer at once passes.
        const answer = await ownProtocolClient({ timeoutMs: 600_000 }).call('logins.provider' as RemoteMethod, ['claude']);
        expect(answer).toMatchObject({ ok: false });
        expect((answer as { reason: string }).reason).toMatch(/starting/);
    }, 3_000);

    it('its door is not a listener: it has no address, and opens connections only when main calls', async () => {
        const { ownProtocolClient } = await ownModule();
        const own = ownProtocolClient();
        expect((own.door as { address?: unknown }).address).toBeUndefined();
        let heard = 0;
        own.door.onConnection(() => { heard += 1; });
        await settle();
        expect(heard).toBe(0);
    });

    it('the door’s connections are this machine’s main window’s, labelled Genie’s tray (what the tunnel says to the host)', async () => {
        const { ownProtocolClient } = await ownModule();
        const own = ownProtocolClient({ timeoutMs: 50 });
        const pre: unknown[] = [];
        own.door.onConnection((c) => { pre.push(c.preAuth); c.close(); });
        await own.call('logins.provider' as RemoteMethod, ['claude']);
        expect(pre).toEqual([{ kind: 'local', label: TRAY, isOwner: true, workspaceId: null, readonly: false, window: 'main' }]);
    });
});

describe('what the tray logs when a sign-in does not start', () => {
    it('a refused call, or an answer that says it could not start, is said in words; a started one is not', async () => {
        const { callRefusal } = (await ownModule()) as unknown as { callRefusal: (a: CallAnswer) => string | null };
        expect(callRefusal({ ok: false, reason: 'still starting' })).toBe('still starting');
        expect(callRefusal({ ok: true, value: { ok: false, reason: 'no such login' } })).toBe('no such login');
        expect(callRefusal({ ok: true, value: { ok: true, terminalId: 't1', route: 'login/claude/t1' } })).toBeNull();
        expect(callRefusal({ ok: true, value: null })).toBeNull();
    });
});

describe('a share-link guest is still refused logins.provider (owner-only)', () => {
    it('a guest of one workspace over the relay is refused, and the host starts nothing', async () => {
        const seen = signInsSeen();
        const h = await hostAndTray(seen.signIns);
        const pair = inMemoryPair();
        for (const cb of h.relay) cb({ ...pair.server, remoteAddress: 'relay:guest', preAuth: { label: 'guest', isOwner: false, workspaceId: 'ws_a', readonly: false } });
        const frames: Array<Record<string, unknown>> = [];
        pair.client.onMessage((t) => frames.push(JSON.parse(t) as Record<string, unknown>));
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'guest' }));
        await settle();
        expect(frames.some((f) => f.kind === 'welcome')).toBe(true);
        pair.client.send(JSON.stringify({ kind: 'call', id: 1, method: 'logins.provider', args: ['claude'] }));
        await settle();
        expect(frames.find((f) => f.kind === 'result' && f.id === 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/owner/) });
        expect(seen.asked).toEqual([]);
    });
});

describe('main’s tray uses its protocol client; main’s own sign-in is gone (source guards)', () => {
    const main = code(src('src/main/main.ts'));

    it('the tray’s Log in calls logins.provider, and its Claude Design login calls logins.design, over the own client', () => {
        expect(main).toMatch(/onProviderLogin:[\s\S]{0,200}\.call\('logins\.provider'/);
        expect(main).toMatch(/onDesignLogin:[\s\S]{0,200}\.call\('logins\.design'/);
    });

    it('main has no sign-in of its own: no signIn, no engine login, no cancelLogin when a window closes', () => {
        expect(main).not.toMatch(/\bsignIn\s*=/);
        expect(main).not.toMatch(/\bsignIn\?\.\(/);
        expect(main).not.toMatch(/client\??\.login\(/);
        expect(main).not.toMatch(/\.cancelLogin\(/);
    });

    it('main tunnels exactly two doors over its engine link: the window’s IPC door and its own client’s', () => {
        const doors = [...main.matchAll(/\btunnelDoor\(\s*([\w.]+)\s*,\s*tunnelLinkOf\(\s*agentEngineLink\.client\s*\)/g)].map((m) => m[1]);
        expect(doors.sort()).toEqual(['localDoor', 'ownProtocol.door']);
        expect(main).toMatch(/\bownProtocol\s*=\s*ownProtocolClient\(/);
    });
});

describe('the guard records the tray’s door as a protocol door on the link, not a listener', () => {
    const doors = (inventory as unknown as { WINDOW_PROTOCOL_DOORS?: readonly (readonly [string, string])[] }).WINDOW_PROTOCOL_DOORS;

    it('WINDOW_PROTOCOL_DOORS names both doors main tunnels, each a protocol door', () => {
        expect(doors).toEqual([['localDoor', 'protocol-door'], ['ownProtocol.door', 'protocol-door']]);
    });

    it('the engine rows login and cancelLogin have left both the inventory and the frozen list', () => {
        const rows = inventory.WINDOW_ENGINE_INVENTORY.map(([use]) => use);
        expect(rows).not.toContain('login');
        expect(rows).not.toContain('cancelLogin');
        const guard = src('test/split-2e-window-guard.test.ts');
        expect(guard).not.toMatch(/\blogin: '2b'/);
        expect(guard).not.toMatch(/\bcancelLogin: '2b'/);
    });

    it('the own client’s module starts nothing and serves nothing', () => {
        const own = code(src('src/main/own-protocol-client.ts'));
        for (const starter of [/\bcreateServer\(/, /\.listen\(/, /new RemoteHost\(/, /\btransportHub\(/, /new ProtocolTunnels\(/, /new WebSocketServer\(/]) expect(own).not.toMatch(starter);
    });
});
