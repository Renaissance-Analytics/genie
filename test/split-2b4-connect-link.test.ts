import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as connectLink from '../src/core/connect-link.js';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { capabilityOf, REMOTE_METHODS, type CallContext, type RemoteMethod } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { hostOwnerOps, type HostOwnerSources } from '../src/main/host-owner-ops.js';

/*
 * CLIENT/HOST SPLIT STEP 2b-4, "OPEN A SHARE LINK…" (Tynn #898, story #896, task #1429). A pasted link is CLASSIFIED by
 * the host, against the Tynn account it is signed in to and the role Tynn gave this machine: never a host or a role a
 * window sends. That is a protocol call, `tynnNetwork.classifyLink`, beside `tynnNetwork.workstations`. OPENING what it
 * decided stays the window's own (the coordinator's ruling): the person's browser for an invite, a workstation's window
 * over the relay. So `genie:connect-link` is a window capability (os-shell), and main asks the host through its own
 * protocol client. Names and hosts are fixtures, never real ones.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const TYNN = 'https://tynn.example';
const LOCAL: CallContext = { connectionId: 'rc_tray', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'Genie’s tray' };
const METHOD = 'tynnNetwork.classifyLink' as RemoteMethod;

type Decision = { ok: false; note: string } | { ok: true; link: { kind: 'invite'; url: string } | { kind: 'workstation'; workstationId: string; name?: string } };
const core = connectLink as unknown as {
    decideConnectLink?: (pasted: string, tynnHost: string | null, role: 'pilot' | 'drone' | null) => Decision;
    connectLinkDecisionOf?: (raw: unknown) => Decision | null;
    actOnConnectLink?: (decision: Decision, deps: { openExternal(url: string): Promise<boolean>; openWorkstation(id: string, name?: string | null): void }) => Promise<{ ok: boolean; note: string }>;
};

/** The host API with genie-host's own owner operations over a fixture Tynn account and role. */
function hostWith(tynn: { signedIn: boolean; host: string; role: 'pilot' | 'drone' | null } | null) {
    const sources = {
        appInbox: { door: { dump: () => ({}), call: async () => null }, enabled: () => false, workspaceExists: () => false, restart: {} },
        deviceLink: { call: async () => null },
        tynn: {
            account: () => (tynn ? { request: async () => { throw new Error('not asked'); }, host: () => tynn.host, status: () => ({ signedIn: tynn.signedIn }) } : null),
            role: () => tynn?.role ?? null,
            readRole: async () => {},
            registered: () => null,
            stored: async () => null,
            v1Settings: () => null,
        },
    } as unknown as HostOwnerSources;
    const owner = hostOwnerOps(sources);
    return buildHostApi({
        features: {}, workspaceOps: {}, agentOps: {}, updates: null,
        localOwner: { ...owner, tynnNetwork: { ...owner.tynnNetwork, shares: { list: async () => [], mint: async () => ({ ok: false }), revoke: async () => ({ ok: false }) } } },
    } as unknown as HostApiDeps);
}

describe('tynnNetwork.classifyLink: the host decides what a pasted link is', () => {
    it('is a remote method for this machine’s own windows, beside tynnNetwork.workstations', () => {
        expect(REMOTE_METHODS as readonly string[]).toContain(METHOD);
        expect(capabilityOf(METHOD)).toBe(capabilityOf('tynnNetwork.workstations'));
    });

    it('an invite on the host’s own Tynn: the link to open in the browser', async () => {
        const api = hostWith({ signedIn: true, host: TYNN, role: 'pilot' });
        expect(await api.invoke(METHOD, [`${TYNN}/invites/accept/tok_1`], LOCAL)).toEqual({ ok: true, link: { kind: 'invite', url: `${TYNN}/invites/accept/tok_1` } });
    });

    it('a workstation link: the workstation to open, with its name', async () => {
        const api = hostWith({ signedIn: true, host: TYNN, role: null });
        expect(await api.invoke(METHOD, ['genie://workstation/open?id=ws_1&name=Box'], LOCAL)).toEqual({ ok: true, link: { kind: 'workstation', workstationId: 'ws_1', name: 'Box' } });
    });

    it('another Tynn’s link is refused in words, naming both', async () => {
        const api = hostWith({ signedIn: true, host: TYNN, role: 'pilot' });
        const out = await api.invoke(METHOD, ['https://elsewhere.example/invites/accept/tok_1'], LOCAL) as Decision;
        expect(out.ok).toBe(false);
        expect((out as { note: string }).note).toMatch(/elsewhere\.example[\s\S]*tynn\.example/);
    });

    it('the HOST’s role decides: a machine Tynn made a drone opens nothing, whatever the window thinks', async () => {
        const api = hostWith({ signedIn: true, host: TYNN, role: 'drone' });
        const out = await api.invoke(METHOD, [`${TYNN}/invites/accept/tok_1`], LOCAL) as Decision;
        expect(out.ok).toBe(false);
    });

    it('signed out of Tynn, or no Tynn account: it says to sign in, and opens nothing', async () => {
        for (const api of [hostWith({ signedIn: false, host: TYNN, role: null }), hostWith(null)]) {
            const out = await api.invoke(METHOD, [`${TYNN}/invites/accept/tok_1`], LOCAL) as Decision;
            expect(out).toMatchObject({ ok: false, note: expect.stringMatching(/Sign in to Tynn/) });
        }
    });
});

describe('the decision, and acting on it (core/connect-link.ts)', () => {
    it('decide and act compose to what dispatchConnectLink always did', async () => {
        expect(typeof core.decideConnectLink).toBe('function');
        expect(typeof core.actOnConnectLink).toBe('function');
        const deps = { openExternal: vi.fn(async () => true), openWorkstation: vi.fn() };
        const decided = core.decideConnectLink!(`${TYNN}/invites/accept/tok_1`, TYNN, 'pilot');
        const out = await core.actOnConnectLink!(decided, deps);
        expect(deps.openExternal).toHaveBeenCalledWith(`${TYNN}/invites/accept/tok_1`);
        expect(out).toEqual(await connectLink.dispatchConnectLink(`${TYNN}/invites/accept/tok_1`, TYNN, 'pilot', { openExternal: async () => true, openWorkstation: () => {} }));
    });

    it('the window reads the host’s answer strictly: only an http(s) invite or a valid workstation id is acted on', () => {
        const of = core.connectLinkDecisionOf!;
        expect(of({ ok: true, link: { kind: 'invite', url: `${TYNN}/invites/accept/tok_1` } })).toEqual({ ok: true, link: { kind: 'invite', url: `${TYNN}/invites/accept/tok_1` } });
        expect(of({ ok: true, link: { kind: 'workstation', workstationId: 'ws_1' } })).toEqual({ ok: true, link: { kind: 'workstation', workstationId: 'ws_1' } });
        expect(of({ ok: false, note: 'Sign in to Tynn first.' })).toEqual({ ok: false, note: 'Sign in to Tynn first.' });
        for (const bad of [null, 'x', { ok: true }, { ok: true, link: { kind: 'invite', url: 'file:///etc/passwd' } }, { ok: true, link: { kind: 'invite', url: 'javascript:alert(1)' } },
            { ok: true, link: { kind: 'workstation', workstationId: '../x' } }, { ok: true, link: { kind: 'other' } }, { ok: false }]) {
            expect(of(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('a refusal opens nothing and passes the host’s words on', async () => {
        const deps = { openExternal: vi.fn(async () => true), openWorkstation: vi.fn() };
        expect(await core.actOnConnectLink!({ ok: false, note: 'Sign in to Tynn first.' }, deps)).toEqual({ ok: false, note: 'Sign in to Tynn first.' });
        expect(deps.openExternal).not.toHaveBeenCalled();
        expect(deps.openWorkstation).not.toHaveBeenCalled();
    });
});

describe('main asks the host and opens what it decided (source guards)', () => {
    const main = code(src('src/main/main.ts'));
    const handler = (() => { const at = main.indexOf("ipcMain.handle('genie:connect-link'"); return at < 0 ? '' : main.slice(at, at + 900); })();

    it('genie:connect-link asks tynnNetwork.classifyLink over main’s own client, then acts on the answer', () => {
        expect(handler).toMatch(/ownProtocol\.call\('tynnNetwork\.classifyLink', \[/);
        expect(handler).toMatch(/connectLinkDecisionOf\(/);
        expect(handler).toMatch(/actOnConnectLink\(/);
    });

    it('it reads no Tynn host and no role of its own', () => {
        expect(handler.length).toBeGreaterThan(0);
        expect(handler).not.toMatch(/tynnAccount|workstationRoleNow|dispatchConnectLink/);
    });

    it('the channel is a window capability now, and has left the frozen still-to-move list', () => {
        expect(IPC_INVENTORY.find(([c]) => c === 'genie:connect-link')?.[1]).toBe('window:os-shell');
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'genie:connect-link': '2b'/);
    });
});
