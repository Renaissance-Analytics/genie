import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import * as protocol from '../src/core/remote-protocol.js';
import { capabilityOf, inMemoryPair, parseMessage, type CallContext, type PreAuth, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { IPC_INVENTORY, WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { DESIGN_LOGIN } from '../src/core/design-login.js';
import { loginRoute } from '../src/main/login-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2b-2a, SIGN-INS ON THE ONE PROTOCOL (Tynn #898, story #896, task #1427). The coordinator's
 * ruling (2026-11-19), option A: an agent's provider login (`providerLogin`), the machine's design sign-in
 * (`logins.design`) and a switch of account (`accounts.switch`) are protocol calls answered by genie-host, for every
 * client and for the host's OWNER only. A share-link guest is refused.
 *
 * genie-host starts the PROVIDER'S OWN login in a terminal. Genie never reads, writes or relays a credential. This
 * machine's window that asked is asked to open that terminal's window (`terminal.window`, as for Take Over), and the
 * login is cancelled when that window closes. Another machine's window gets a companion ticket and the route, and
 * opens its own window there.
 *
 * Step 3 can add a step-up (2FA) check to these three without re-plumbing: they are named once (SIGN_IN_METHODS), and
 * RemoteHost checks them in one place.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const context = (connectionId: string, origin: CallContext['origin'] = 'local-window'): CallContext =>
    ({ connectionId, origin, profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'x' });
/** Dynamic: new in this step, so each case goes red on its own. */
const signInsModule = async () => { const file: string = '../src/main/host-sign-ins.js'; return import(file) as Promise<{ hostSignIns: (ports: unknown) => SignIns }>; };
type Answer = { ok: true; terminalId: string; route: string } | { ok: false; reason: string };
interface SignIns {
    providerLogin(agentId: string, context?: CallContext): Promise<Answer>;
    design(context?: CallContext): Promise<Answer>;
    switchAccount(provider: string, choose: unknown, context?: CallContext): Promise<Answer>;
    loginFor(provider: string, context?: CallContext): Promise<Answer>;
}

const METHODS = ['providerLogin', 'logins.design', 'accounts.switch'] as const;

describe('the three sign-in methods are named once, written by the owner (the step-3 hook)', () => {
    it('SIGN_IN_METHODS names them, and each is a write any client may make', () => {
        expect((protocol as unknown as { SIGN_IN_METHODS?: readonly string[] }).SIGN_IN_METHODS).toEqual([...METHODS, 'logins.provider', 'accounts.signIn']); // + the tray's (2b-2b, split-2b2b), one account's own (Tynn #1011)
        for (const method of METHODS) {
            expect(protocol.REMOTE_METHODS as readonly string[]).toContain(method);
            expect(capabilityOf(method as RemoteMethod), method).toBe('write');
        }
    });

    it('RemoteHost checks them in ONE place, where step 3 adds its step-up', () => {
        const host = code(src('src/main/remote-host.ts'));
        expect(host.match(/#signInRefusal\(/g)?.length).toBe(2); // the definition and its one call
        expect(host).toMatch(/SIGN_IN_METHODS[^;]*\.includes\(method\)/);
    });
});

describe('genie-host starts the provider\'s own login and opens it on the window that asked', () => {
    const fixture = (opened: boolean | 'never' = true) => {
        const asked: Array<{ route: string; connectionId: string | null }> = [];
        const cancelled: string[] = [];
        const started: Array<[string, string | undefined]> = [];
        let closeWindow: () => void = () => {};
        const ports = {
            login: (provider: string, accountId?: string) => { started.push([provider, accountId]); return provider === 'nobody' ? { ok: false as const, reason: 'no such login' } : { ok: true as const, terminalId: `term_${provider}` }; },
            switchLogin: (provider: string) => ({ ok: true as const, terminalId: `term_sw_${provider}`, instructions: ['pick it'] }),
            providerOf: (agentId: string) => (agentId === 'agent_a' ? 'claude' : null),
            cancel: (terminalId: string) => { cancelled.push(terminalId); },
            openWindow: (ctx: CallContext | undefined, route: string, closed: () => void) => {
                asked.push({ route, connectionId: ctx?.connectionId ?? null });
                closeWindow = closed;
                return opened === true;
            },
        };
        return { ports, asked, cancelled, started, close: () => closeWindow() };
    };

    it('an agent\'s login: its provider\'s active account, on the caller\'s window, cancelled when that window closes', async () => {
        const { hostSignIns } = await signInsModule();
        const f = fixture();
        const r = await hostSignIns(f.ports).providerLogin('agent_a', context('c1'));
        expect(r).toEqual({ ok: true, terminalId: 'term_claude', route: loginRoute('term_claude', 'claude') });
        expect(f.started).toEqual([['claude', undefined]]);
        expect(f.asked).toEqual([{ route: loginRoute('term_claude', 'claude'), connectionId: 'c1' }]);
        expect(f.cancelled).toEqual([]);
        f.close();
        await settled();
        expect(f.cancelled).toEqual(['term_claude']);
    });

    it('the design sign-in and a switch of account open on their own routes', async () => {
        const { hostSignIns } = await signInsModule();
        const f = fixture();
        const api = hostSignIns(f.ports);
        expect(await api.design(context('c1'))).toMatchObject({ ok: true, route: loginRoute(`term_${DESIGN_LOGIN}`, DESIGN_LOGIN) });
        expect(await api.switchAccount('codex', 'work@example.com', context('c1'))).toMatchObject({ ok: true, route: loginRoute('term_sw_codex', 'codex', true, 'work@example.com') });
        expect(f.asked.map((a) => a.route)).toEqual([loginRoute(`term_${DESIGN_LOGIN}`, DESIGN_LOGIN), loginRoute('term_sw_codex', 'codex', true, 'work@example.com')]);
    });

    it('another machine\'s caller (no window here): nothing opens here, and the route goes back for its own window', async () => {
        const { hostSignIns } = await signInsModule();
        const f = fixture(false);
        const r = await hostSignIns(f.ports).loginFor('claude', context('c9', 'relay'));
        expect(r).toEqual({ ok: true, terminalId: 'term_claude', route: loginRoute('term_claude', 'claude') });
        expect(f.cancelled).toEqual([]);
    });

    it('refusals come back in words: an unknown agent, a provider whose login cannot start, a switch\'s bad account name', async () => {
        const { hostSignIns } = await signInsModule();
        const f = fixture();
        const api = hostSignIns(f.ports);
        expect(await api.providerLogin('agent_zz', context('c1'))).toEqual({ ok: false, reason: 'No agent named.' });
        expect(await api.loginFor('nobody', context('c1'))).toEqual({ ok: false, reason: 'no such login' });
        expect(await api.switchAccount('', undefined, context('c1'))).toEqual({ ok: false, reason: 'No provider named.' });
        // The account to choose is words for the steps only: control characters are dropped, never put into a route.
        expect(await api.switchAccount('codex', 'a\u0000b', context('c1'))).toMatchObject({ ok: true, route: loginRoute('term_sw_codex', 'codex', true) });
        expect(f.asked.map((a) => a.route)).toEqual([loginRoute('term_sw_codex', 'codex', true)]);
    });
});

describe('RemoteHost serves the sign-ins to the owner, and refuses a guest', () => {
    let dir: string;
    let devices: DeviceStore;
    let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void;
    let invoke: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-2b2-'));
        devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'tok' });
        invoke = vi.fn(async (method: string) => (METHODS.includes(method as never) ? { ok: true, terminalId: 'term_l', route: loginRoute('term_l', 'claude') } : { ok: true }));
        const api: HostApi = { invoke: invoke as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    });
    afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

    async function connect(preAuth: PreAuth, auth: object) {
        const pair = inMemoryPair();
        const inbox: WireMessage[] = [];
        const waiters: Array<(m: WireMessage) => void> = [];
        pair.client.onMessage((t) => { const r = parseMessage(t); if (!r.ok) return; const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
        const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
        accept({ ...pair.server, preAuth });
        pair.client.send(JSON.stringify({ kind: 'hello', auth, label: 'x' }));
        let m = await next();
        while (m.kind !== 'welcome') m = await next();
        let id = 0;
        return { call: async (method: string, ...args: unknown[]) => { pair.client.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); let r = await next(); while (r.kind !== 'result') r = await next(); return r; } };
    }
    const argsOf = (method: string) => (method === 'providerLogin' ? ['agent_a'] : method === 'accounts.switch' ? ['claude'] : []);

    it.each(METHODS)('%s: this machine\'s window is answered with its context and no ticket', async (method) => {
        const w = await connect({ kind: 'local', window: 'main', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false }, { kind: 'local' });
        const r = await w.call(method, ...argsOf(method));
        expect(r).toMatchObject({ ok: true, value: { ok: true, terminalId: 'term_l' } });
        expect((r as { value: { ticket?: unknown } }).value.ticket).toBeUndefined();
        expect(invoke.mock.calls.find((c) => c[0] === method)![2]).toMatchObject({ origin: 'local-window' });
    });

    it.each(METHODS)('%s: another machine\'s OWNER gets a companion ticket for its own window', async (method) => {
        const w = await connect({ kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false }, { kind: 'relay' });
        await w.call('baton.take');
        expect(await w.call(method, ...argsOf(method))).toMatchObject({ ok: true, value: { ok: true, terminalId: 'term_l', route: loginRoute('term_l', 'claude'), ticket: expect.any(String) } });
    });

    it.each(METHODS)('%s: a share-link GUEST is refused, and the host is never asked', async (method) => {
        const g = await connect({ kind: 'relay', label: 'wren', isOwner: false, workspaceId: 'ws', readonly: false }, { kind: 'relay' });
        await g.call('baton.take');
        const r = await g.call(method, ...argsOf(method));
        expect(r).toMatchObject({ ok: false });
        expect((r as { reason: string }).reason).toMatch(/owner/);
        expect(invoke.mock.calls.map((c) => c[0])).not.toContain(method);
    });
});

describe('the sign-ins leave the window\'s IPC and its engine link (source guards)', () => {
    const CHANNELS = ['genie:design-sign-in', 'genie:design-login', 'genie:account-switch', 'genie:provider-login'];

    it('no IPC handler, preload member or inventory row for them', () => {
        const main = code(src('src/main/main.ts')), preload = code(src('src/main/preload.ts'));
        for (const channel of CHANNELS) {
            expect(main, channel).not.toContain(`'${channel}'`);
            expect(preload, channel).not.toContain(`'${channel}'`);
            expect(IPC_INVENTORY.map(([c]) => c), channel).not.toContain(channel);
        }
    });

    it('main switches no account and opens no login for a feature; switchAccount leaves the engine inventory', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).not.toMatch(/client\??\.switchAccount\(/);
        expect(main).not.toMatch(/\bswitchAccountWindow\b/);
        expect(main).not.toMatch(/login: async provider => signIn/);
        expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u)).not.toContain('switchAccount');
    });

    it('the local window\'s bridge signs in over the protocol', () => {
        const session = code(src('src/renderer/local-session.ts'));
        expect(session).toMatch(/providerLogin: \(id\) => answered\(\(b\) => b\.providerLogin\(id\)\)/);
        expect(session).toMatch(/designSignIn: \(\) => answered\(\(b\) => b\.designSignIn!\(\)\)/);
        expect(session).toMatch(/switchAccount: \(provider, choose\) => answered\(\(b\) => b\.switchAccount!\(provider, choose\)\)/);
    });

    it('a feature\'s login is started by genie-host for its caller (features-host signIn port)', () => {
        expect(code(src('src/main/features-host.ts'))).toMatch(/this\.ports\.signIn\?\.\(provider, context\)/);
        expect(code(src('src/main/genie-host.ts'))).toMatch(/signIn: \(provider, context\) => signIns\.loginFor\(provider, context\)/);
    });
});
