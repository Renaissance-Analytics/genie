import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_HOST_SUMMARY, hostSummaryOf, keychainBecameReady, readHostSummary, type HostSummary } from '../src/core/host-summary.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, capabilityOf, inMemoryPair, parseMessage, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { hostLegacyAdopt, readAdoptRequest } from '../src/main/host-legacy-adopt.js';
import type { KeychainRead, KeychainResult, SecretName } from '../src/main/keychain.js';
import { fileMigrationBook, hostVault, type MigrationSource, type OldRead } from '../src/main/keychain-migration.js';
import { legacyUnsealer } from '../src/main/legacy-unsealer.js';
import { OWN_CLIENT_LABEL, ownProtocolClient, type OwnCallAnswer } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { ProtocolTunnels } from '../src/main/protocol-tunnels.js';
import { tunnelDoor, type TunnelLink } from '../src/main/window-tunnel.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-3b (Tynn #959; part of #913; the coordinator's ruling). Electron's safeStorage exists only in
 * main, so main keeps ONE thing about an older Genie's secrets: a one-shot unsealer (legacy-unsealer.ts). It opens each old
 * copy and Genie 1's record of this machine, hands them to genie-host on the local-only `keychain.adoptLegacy`, deletes
 * exactly the old copies genie-host names, and says so. genie-host runs the crash-safe move on ITS keychain and the same
 * book (host-legacy-adopt.ts; keychain-migration.ts split into the host's verify, the window's delete and the host's
 * finish), then reloads its accounts, registers with Genie 1's record and brings its agents back to Tynn, by itself. The
 * keyring card, the Tynn and GitHub accounts and the registration leave main: no `client.tynn(`, `client.github(`,
 * `client.keyring(` or `client.relayHost(` is left there.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Every use main.ts makes of its engine client, as test/split-2e-window-guard.test.ts reads it. */
const engineUses = (text: string): string[] => [...new Set([...code(text).matchAll(/(?<![\w$-])client\??\.(\w+)(\s*\(\s*'([^']*)')?/g)].map((m) => (m[1] === 'call' ? `call:${m[3] ?? '?'}` : m[1]!)))].sort();

const ADOPT = 'keychain.adoptLegacy' as RemoteMethod;
const RECHECK = 'tynn.recheck' as RemoteMethod;
/** Distinctive, so a line that carried one would be found. */
const SECRET = 'gho_SECRET-7f3a9c-never-printed';
const PEM = '-----BEGIN PRIVATE KEY-----PEM-SECRET-4b1e-never-printed-----END PRIVATE KEY-----';
const AGENT = 'tynn/agent/01ARZ3NDEKTSV4RRFFQ69G5FAV' as SecretName;

function fakeKeychain() {
    const held = new Map<string, string>();
    const state = { available: true, mangle: (value: string) => value, writes: 0 };
    const keychain = {
        get: async (name: SecretName): Promise<KeychainRead> => (!state.available ? { kind: 'unavailable', reason: 'no secret service' } : held.has(name) ? { kind: 'value', value: held.get(name)! } : { kind: 'missing' }),
        set: async (name: SecretName, value: string): Promise<KeychainResult> => {
            if (!state.available) return { ok: false, reason: 'no secret service' };
            state.writes += 1;
            held.set(name, state.mangle(value));
            return { ok: true };
        },
    };
    return { held, state, vault: hostVault(keychain) };
}

describe('keychain.adoptLegacy and tynn.recheck: local-only methods genie-host answers', () => {
    it('are in the protocol table, `local`, and genie-host’s own', () => {
        for (const method of [ADOPT, RECHECK]) {
            expect(REMOTE_METHODS as readonly string[]).toContain(method);
            expect(capabilityOf(method)).toBe('local');
            expect(HOST_ALONE_METHODS.has(method), method).toBe(true);
        }
    });

    async function host(api: HostApi, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g3b-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const remote = new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { remote, done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
    }
    function api(ports: Pick<HostApiDeps, 'legacySecrets' | 'tynnRecheck'>) {
        const inner = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, ...ports } as unknown as HostApiDeps);
        // Only the two methods reach the host API; whatever else a connection asks answers nothing.
        const invoke = vi.fn((m: RemoteMethod, a: unknown[], ctx?: Parameters<HostApi['invoke']>[2]) => (m === ADOPT || m === RECHECK ? inner.invoke(m, a, ctx) : Promise.resolve(null)));
        return { invoke, api: { invoke, onEvent: () => () => {}, workspaceOfAgent: () => null } as unknown as HostApi };
    }

    it('main’s own client may call both: the request reaches the adopter whole, and the recheck runs', async () => {
        const adopt = vi.fn(async (request: unknown) => ({ outcomes: [], remove: [], echo: (request as { phase?: unknown }).phase }));
        const recheck = vi.fn(async () => {});
        const own = ownProtocolClient();
        const a = api({ legacySecrets: { adopt }, tynnRecheck: recheck });
        const h = await host(a.api, own.door);
        try {
            expect(await own.call(ADOPT, [{ phase: 'removed', names: ['github/access'] }])).toEqual({ ok: true, value: { outcomes: [], remove: [], echo: 'removed' } });
            expect(adopt).toHaveBeenCalledWith({ phase: 'removed', names: ['github/access'] });
            expect(await own.call(RECHECK, [])).toEqual({ ok: true, value: null });
            expect(recheck).toHaveBeenCalledTimes(1);
        } finally { await h.done(); }
    });

    it('another machine (a relay owner, a share-link guest) is refused before the host is asked; a page in this machine’s window is refused by the host', async () => {
        const adopt = vi.fn(async () => ({ outcomes: [], remove: [] }));
        const recheck = vi.fn(async () => {});
        const a = api({ legacySecrets: { adopt }, tynnRecheck: recheck });
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        const h = await host(a.api, { onConnection: (l) => { accept = l; return () => {}; } });
        const connect = async (preAuth: Record<string, unknown>) => {
            const pair = inMemoryPair();
            const frames: WireMessage[] = [];
            pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
            accept({ ...pair.server, preAuth: preAuth as never });
            pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: preAuth.kind }, label: String(preAuth.label) }));
            await settle();
            const call = async (id: number, method: RemoteMethod, args: unknown[]) => {
                pair.client.send(JSON.stringify({ kind: 'call', id, method, args }));
                await settle();
                return frames.find((m) => m.kind === 'result' && m.id === id) as Extract<WireMessage, { kind: 'result' }> | undefined;
            };
            return { frames, call };
        };
        try {
            for (const preAuth of [
                { kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false },
                { kind: 'relay', label: 'wren', isOwner: false, workspaceId: 'ws_a', readonly: false },
            ]) {
                const far = await connect(preAuth);
                expect(far.frames.some((m) => m.kind === 'welcome'), String(preAuth.label)).toBe(true);
                await far.call(1, 'baton.take' as RemoteMethod, []);
                expect(await far.call(2, ADOPT, [{ phase: 'adopt', secrets: [{ name: 'github/access', read: { kind: 'value', value: SECRET } }], genie1Identity: null }])).toMatchObject({ ok: false, reason: expect.stringMatching(/own Genie window/) });
                expect(await far.call(3, RECHECK, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/own Genie window/) });
            }
            expect(a.invoke.mock.calls.map(([m]) => m)).not.toContain(ADOPT);
            expect(a.invoke.mock.calls.map(([m]) => m)).not.toContain(RECHECK);
            // This machine's own window, but a page: it never hands secrets over.
            const page = await connect({ kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' });
            const refused = await page.call(4, ADOPT, [{ phase: 'adopt', secrets: [{ name: 'tynn/pairing', read: { kind: 'value', value: SECRET } }], genie1Identity: null }]);
            expect(refused).toMatchObject({ ok: true, value: { ok: false, reason: expect.stringMatching(/never by a window/) } });
            expect(adopt).not.toHaveBeenCalled();
            expect(JSON.stringify(refused)).not.toContain(SECRET);
        } finally { await h.done(); }
    });

    it('CONTROL: a host with no adopter or no Tynn account says so in words', async () => {
        const a = api({});
        expect(await a.api.invoke(ADOPT, [{ phase: 'removed', names: [] }])).toEqual({ ok: false, reason: 'this host keeps nothing an older Genie sealed' });
        expect(await a.api.invoke(RECHECK, [])).toEqual({ ok: false, reason: 'this host has no Tynn account to ask' });
    });
});

describe('genie-host’s two phases: the crash-safe move on its own keychain and book', () => {
    let dir: string;
    let bookFile: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-2g3b-book-')); bookFile = join(dir, 'keychain-migration.json'); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const bookNow = async () => JSON.parse(await readFile(bookFile, 'utf8')).secrets as Record<string, string>;
    const adopter = (file = bookFile, k = fakeKeychain(), moved = vi.fn(), lines: string[] = []) => ({ k, moved, lines, adopt: hostLegacyAdopt({ vault: k.vault, book: fileMigrationBook(file), log: (l) => lines.push(l), moved }) });
    const adopt = (secrets: unknown[], genie1Identity: unknown = null) => ({ phase: 'adopt', secrets, genie1Identity });

    it('moved: written, read back and booked `verified`; the window may delete it; `done` only once it says it did', async () => {
        const a = adopter();
        expect(await a.adopt.adopt(adopt([{ name: 'github/access', read: { kind: 'value', value: SECRET } }]))).toEqual({ outcomes: [{ name: 'github/access', status: 'verified' }], remove: ['github/access'] });
        expect(a.k.held.get('github/access')).toBe(SECRET);
        expect(await bookNow()).toEqual({ 'github/access': 'verified' });
        expect(await a.adopt.adopt({ phase: 'removed', names: ['github/access'] })).toEqual({ outcomes: [{ name: 'github/access', status: 'moved' }], remove: [] });
        expect(await bookNow()).toEqual({ 'github/access': 'done' });
    });

    it('already done: not written again, nothing to delete', async () => {
        const a = adopter();
        await fileMigrationBook(bookFile).write('github/access', 'done');
        expect(await a.adopt.adopt(adopt([{ name: 'github/access', read: { kind: 'value', value: SECRET } }]))).toEqual({ outcomes: [{ name: 'github/access', status: 'already' }], remove: [] });
        expect(a.k.state.writes).toBe(0);
    });

    it('none, and no row: nothing to move, and nothing booked (the security review of #2120)', async () => {
        const a = adopter();
        expect(await a.adopt.adopt(adopt([{ name: 'tynn/pairing', read: { kind: 'none' } }]))).toEqual({ outcomes: [{ name: 'tynn/pairing', status: 'nothing' }], remove: [] });
        await expect(readFile(bookFile, 'utf8')).rejects.toThrow();
    });

    it('none, with a confirmed row: the old copy went after it was confirmed, so the row is finished', async () => {
        const a = adopter();
        await fileMigrationBook(bookFile).write('tynn/pairing', 'verified');
        expect(await a.adopt.adopt(adopt([{ name: 'tynn/pairing', read: { kind: 'none' } }]))).toEqual({ outcomes: [{ name: 'tynn/pairing', status: 'moved' }], remove: [] });
        expect(await bookNow()).toEqual({ 'tynn/pairing': 'done' });
    });

    it('unreadable: kept; a confirmed row the file covers is not finished by its silence', async () => {
        const a = adopter();
        await fileMigrationBook(bookFile).write(AGENT, 'verified');
        expect(await a.adopt.adopt(adopt([{ name: 'agents.json', read: { kind: 'unreadable', covers: 'tynn/agent/' } }]))).toEqual({ outcomes: [{ name: 'agents.json', status: 'old-copy-unreadable' }], remove: [] });
        expect(await bookNow()).toEqual({ [AGENT]: 'verified' });
    });

    it('the read-back differs, or the keychain does not answer: kept, nothing to delete, no row', async () => {
        const differs = adopter();
        differs.k.state.mangle = () => 'something-else';
        expect(await differs.adopt.adopt(adopt([{ name: 'github/refresh', read: { kind: 'value', value: SECRET } }]))).toEqual({ outcomes: [{ name: 'github/refresh', status: 'read-back-differs' }], remove: [] });
        const none = adopter();
        none.k.state.available = false;
        expect(await none.adopt.adopt(adopt([{ name: 'github/refresh', read: { kind: 'value', value: SECRET } }]))).toEqual({ outcomes: [{ name: 'github/refresh', status: 'keychain-unavailable' }], remove: [] });
        await expect(readFile(bookFile, 'utf8')).rejects.toThrow();
    });

    it('a crash between the phases: the next launch finds `verified`, never writes it again, and lets the old copy go; one already gone is finished', async () => {
        const first = adopter();
        await first.adopt.adopt(adopt([{ name: 'github/access', read: { kind: 'value', value: SECRET } }, { name: 'github/refresh', read: { kind: 'value', value: `${SECRET}-r` } }]));
        // The window died before it deleted anything. The next launch, a new host over the same book and keychain:
        const next = hostLegacyAdopt({ vault: first.k.vault, book: fileMigrationBook(bookFile), log: () => {}, moved: () => {} });
        const writes = first.k.state.writes;
        // github/access's seal is still there; github/refresh's went just before the crash.
        expect(await next.adopt(adopt([{ name: 'github/access', read: { kind: 'value', value: SECRET } }]))).toEqual({
            outcomes: [{ name: 'github/access', status: 'verified' }, { name: 'github/refresh', status: 'moved' }], remove: ['github/access'],
        });
        expect(first.k.state.writes).toBe(writes);
        expect(await bookNow()).toEqual({ 'github/access': 'verified', 'github/refresh': 'done' });
    });

    it('a removal named for a row the book never confirmed is not finished', async () => {
        const a = adopter();
        expect(await a.adopt.adopt({ phase: 'removed', names: ['tynn/pairing'] })).toEqual({ outcomes: [{ name: 'tynn/pairing', status: 'not-confirmed' }], remove: [] });
        await expect(readFile(bookFile, 'utf8')).rejects.toThrow();
    });

    it('only what a seal held is ever written: a device’s, an inbox’s or a made-up name is refused whole, and the keychain is untouched', async () => {
        for (const name of ['device/wss://example.test', 'mail/inbox/ws', 'deploy/x', 'pod/host-key', 'tynn/agent/not-a-key', 'whatever']) {
            const a = adopter();
            const answer = await a.adopt.adopt(adopt([{ name, read: { kind: 'value', value: SECRET } }]));
            expect(answer, name).toMatchObject({ ok: false });
            expect(a.k.state.writes, name).toBe(0);
        }
        expect(readAdoptRequest(null)).toMatchObject({ ok: false });
        expect(readAdoptRequest({ phase: 'adopt', secrets: [{ name: 'github/access', read: { kind: 'value', value: 7 } }], genie1Identity: null })).toMatchObject({ ok: false });
        expect(readAdoptRequest({ phase: 'adopt', secrets: [], genie1Identity: { workstationId: '', privateKeyPem: null } })).toMatchObject({ ok: false });
        expect(readAdoptRequest({ phase: 'removed', names: ['device/x'] })).toMatchObject({ ok: false });
    });

    it('it recovers by itself: something moved, or Genie 1’s record came; nothing of either, nothing to do', async () => {
        // A book each, so one case's rows say nothing in the next.
        const moved = adopter(join(dir, 'moved.json'));
        await moved.adopt.adopt(adopt([{ name: 'tynn/pairing', read: { kind: 'value', value: SECRET } }]));
        expect(moved.moved).toHaveBeenCalledWith({ secretsMoved: true, genie1Identity: null });
        const identity = adopter(join(dir, 'identity.json'));
        await identity.adopt.adopt(adopt([], { workstationId: 'ws_genie1', privateKeyPem: PEM }));
        expect(identity.moved).toHaveBeenCalledWith({ secretsMoved: false, genie1Identity: { workstationId: 'ws_genie1', privateKeyPem: PEM } });
        const quiet = adopter(join(dir, 'quiet.json'));
        await quiet.adopt.adopt(adopt([{ name: 'tynn/pairing', read: { kind: 'none' } }]));
        expect(quiet.moved).not.toHaveBeenCalled();
    });
});

describe('main’s one-shot unsealer', () => {
    function source(name: string, read: OldRead, extra: { covers?: string; removeFails?: boolean } = {}) {
        const removed = { count: 0 };
        const s: MigrationSource = {
            name: name as SecretName,
            ...(extra.covers !== undefined ? { covers: extra.covers } : {}),
            old: { read: async () => read, remove: async () => { if (extra.removeFails) throw new Error(`held open: ${SECRET}`); removed.count += 1; } },
        };
        return { s, removed };
    }
    function unsealer(sources: MigrationSource[], answers: Array<(args: unknown[]) => OwnCallAnswer | Promise<OwnCallAnswer>>) {
        const calls: unknown[][] = [];
        const lines: string[] = [];
        const u = legacyUnsealer({
            sources: async () => sources,
            genie1Identity: async () => ({ workstationId: 'ws_genie1', privateKeyPem: PEM }),
            call: async (_method, args) => { calls.push(args); const next = answers.shift(); return next ? next(args) : { ok: false, reason: 'no answer scripted' }; },
            log: (line) => lines.push(line),
        });
        return { u, calls, lines };
    }

    it('hands every old copy over as read (a value, none, an unreadable file with what it covers) with Genie 1’s record', async () => {
        const t = unsealer([source('github/access', { kind: 'value', value: SECRET }).s, source('tynn/pairing', { kind: 'none' }).s, source('agents.json', { kind: 'unreadable' }, { covers: 'tynn/agent/' }).s], [() => ({ ok: true, value: { outcomes: [], remove: [] } })]);
        await t.u.run();
        expect(t.calls).toEqual([[{ phase: 'adopt', secrets: [
            { name: 'github/access', read: { kind: 'value', value: SECRET } },
            { name: 'tynn/pairing', read: { kind: 'none' } },
            { name: 'agents.json', read: { kind: 'unreadable', covers: 'tynn/agent/' } },
        ], genie1Identity: { workstationId: 'ws_genie1', privateKeyPem: PEM } }]]);
    });

    it('deletes exactly what genie-host named, then says so; nothing it did not name, nothing not verified', async () => {
        const a = source('github/access', { kind: 'value', value: SECRET });
        const b = source('github/refresh', { kind: 'value', value: SECRET });
        const c = source('tynn/pairing', { kind: 'value', value: SECRET });
        const t = unsealer([a.s, b.s, c.s], [
            () => ({ ok: true, value: { outcomes: [{ name: 'github/access', status: 'verified' }, { name: 'github/refresh', status: 'verified' }, { name: 'tynn/pairing', status: 'keychain-unavailable' }], remove: ['github/access', 'tynn/pairing'] } }),
            () => ({ ok: true, value: { outcomes: [{ name: 'github/access', status: 'moved' }], remove: [] } }),
        ]);
        await t.u.run();
        expect([a.removed.count, b.removed.count, c.removed.count]).toEqual([1, 0, 0]);
        expect(t.calls[1]).toEqual([{ phase: 'removed', names: ['github/access'] }]);
        expect(t.lines).toEqual(['[keychain] tynn/pairing stays where it was: keychain-unavailable']);
    });

    it('genie-host refusing, or an answer that does not read, deletes nothing and asks no second phase', async () => {
        for (const answer of [{ ok: false, reason: 'Genie is still starting; try again in a moment' }, { ok: true, value: { ok: false, reason: 'this host keeps nothing an older Genie sealed' } }, { ok: true, value: { outcomes: 'x', remove: ['github/access'] } }] as OwnCallAnswer[]) {
            const a = source('github/access', { kind: 'value', value: SECRET });
            const t = unsealer([a.s], [() => answer]);
            await t.u.run();
            expect(a.removed.count).toBe(0);
            expect(t.calls).toHaveLength(1);
            expect(t.lines.join('\n')).toMatch(/nothing was deleted/);
        }
    });

    it('an old copy that will not go stays, by name; genie-host is told only of what went', async () => {
        const a = source('github/access', { kind: 'value', value: SECRET }, { removeFails: true });
        const t = unsealer([a.s], [() => ({ ok: true, value: { outcomes: [{ name: 'github/access', status: 'verified' }], remove: ['github/access'] } })]);
        await t.u.run();
        expect(t.calls).toHaveLength(1);
        expect(t.lines).toEqual(['[keychain] github/access stays where it was: old-copy-left']);
    });

    it('runs again when genie-host’s keychain turns ready, and only then', async () => {
        const answers = Array.from({ length: 4 }, () => () => ({ ok: true, value: { outcomes: [], remove: [] } }) as OwnCallAnswer);
        const t = unsealer([], answers);
        const ready: HostSummary = { ...EMPTY_HOST_SUMMARY, keychainReady: true };
        t.u.summary(EMPTY_HOST_SUMMARY, ready); await settle();
        t.u.summary(ready, ready); await settle();
        t.u.summary(ready, EMPTY_HOST_SUMMARY); await settle();
        expect(t.calls).toHaveLength(1);
        t.u.summary(EMPTY_HOST_SUMMARY, ready); await settle();
        expect(t.calls).toHaveLength(2);
    });

    it('never more than one pass at a time: asked during one, it runs once more after it', async () => {
        let release: () => void = () => {};
        let inFlight = 0;
        let most = 0;
        const t = unsealer([], [
            () => new Promise<OwnCallAnswer>((r) => { inFlight += 1; most = Math.max(most, inFlight); release = () => { inFlight -= 1; r({ ok: true, value: { outcomes: [], remove: [] } }); }; }),
            () => { inFlight += 1; most = Math.max(most, inFlight); inFlight -= 1; return { ok: true, value: { outcomes: [], remove: [] } }; },
        ]);
        const first = t.u.run();
        await settle();
        void t.u.run(); void t.u.run();
        await settle();
        expect(t.calls).toHaveLength(1);
        release();
        await first; await settle();
        expect(t.calls).toHaveLength(2);
        expect(most).toBe(1);
    });

    it('end to end with genie-host’s adopter: in its keychain byte for byte, the old copy gone, the book done; a lost second phase is finished by the next run', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-2g3b-e2e-'));
        try {
            const bookFile = join(dir, 'keychain-migration.json');
            const k = fakeKeychain();
            const host = hostLegacyAdopt({ vault: k.vault, book: fileMigrationBook(bookFile), log: () => {}, moved: () => {} });
            let seal: string | null = SECRET;
            const old: MigrationSource = { name: 'github/access', old: { read: async () => (seal === null ? { kind: 'none' } : { kind: 'value', value: seal }), remove: async () => { seal = null; } } };
            let loseSecondPhase = true;
            const u = legacyUnsealer({
                sources: async () => [old],
                genie1Identity: async () => null,
                call: async (_m, args) => {
                    const request = args[0] as { phase: string };
                    if (request.phase === 'removed' && loseSecondPhase) return { ok: false, reason: 'Genie is still starting; try again in a moment' };
                    return { ok: true, value: await host.adopt(request) };
                },
                log: () => {},
            });
            await u.run();
            expect([k.held.get('github/access'), seal]).toEqual([SECRET, null]);
            expect(JSON.parse(await readFile(bookFile, 'utf8')).secrets).toEqual({ 'github/access': 'verified' });
            loseSecondPhase = false;
            await u.run();
            expect(JSON.parse(await readFile(bookFile, 'utf8')).secrets).toEqual({ 'github/access': 'done' });
            expect(k.held.get('github/access')).toBe(SECRET);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});

/*
 * THE SECURITY REVIEW OF #2120 (the coordinator, before merge). genie-host now signs in and registers by itself, so its
 * keychain may hold a NEWER value than an old seal: with no row in the book, a seal is compared, never written over it.
 * The hand-over is gated on main's own client by an explicit tunnel kind, not by the label any door may say. A `removed`
 * finishes only what this host answered `verified` itself.
 */
describe('the security review of #2120: a newer value is never overwritten, and only main’s own client hands over', () => {
    let dir: string;
    let bookFile: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-2g3b-review-')); bookFile = join(dir, 'keychain-migration.json'); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const adopt = (secrets: unknown[]) => ({ phase: 'adopt', secrets, genie1Identity: null });
    const adopterOver = (k = fakeKeychain(), file = bookFile) => ({ k, adopt: hostLegacyAdopt({ vault: k.vault, book: fileMigrationBook(file), log: () => {}, moved: () => {} }) });

    it('no row, and the keychain already holds a DIFFERENT value: `keychain-differs`, nothing written, nothing to delete, no row', async () => {
        const a = adopterOver();
        a.k.held.set('github/access', 'gho_NEWER-signed-in-by-genie-host');
        expect(await a.adopt.adopt(adopt([{ name: 'github/access', read: { kind: 'value', value: SECRET } }]))).toEqual({ outcomes: [{ name: 'github/access', status: 'keychain-differs' }], remove: [] });
        expect(a.k.held.get('github/access')).toBe('gho_NEWER-signed-in-by-genie-host');
        expect(a.k.state.writes).toBe(0);
        await expect(readFile(bookFile, 'utf8')).rejects.toThrow();
    });

    it('no row, and the keychain holds the SAME value: confirmed without a write, and the old copy may go', async () => {
        const a = adopterOver();
        a.k.held.set('tynn/pairing', SECRET);
        expect(await a.adopt.adopt(adopt([{ name: 'tynn/pairing', read: { kind: 'value', value: SECRET } }]))).toEqual({ outcomes: [{ name: 'tynn/pairing', status: 'verified' }], remove: ['tynn/pairing'] });
        expect(a.k.state.writes).toBe(0);
    });

    it('CONTROL: no row and nothing in the keychain: stored, read back, the old copy may go', async () => {
        const a = adopterOver();
        expect(await a.adopt.adopt(adopt([{ name: 'workstation/key', read: { kind: 'value', value: PEM } }]))).toEqual({ outcomes: [{ name: 'workstation/key', status: 'verified' }], remove: ['workstation/key'] });
        expect(a.k.held.get('workstation/key')).toBe(PEM);
    });

    it('end to end: the unsealer keeps the seal whose value the keychain overrode', async () => {
        const k = fakeKeychain();
        k.held.set('github/access', 'gho_NEWER');
        const a = adopterOver(k);
        const removed: string[] = [];
        const sources: MigrationSource[] = [{ name: 'github/access' as SecretName, old: { read: async (): Promise<OldRead> => ({ kind: 'value', value: SECRET }), remove: async () => { removed.push('github/access'); } } }];
        const unsealer = legacyUnsealer({
            sources: async () => sources,
            genie1Identity: async () => null,
            call: async (_method, args): Promise<OwnCallAnswer> => ({ ok: true, value: await a.adopt.adopt(args[0]) }),
            log: () => {},
        });
        await unsealer.run();
        expect(removed).toEqual([]);
        expect(k.held.get('github/access')).toBe('gho_NEWER');
    });

    it('`removed` finishes only what THIS host answered `verified`: a row an earlier host confirmed is not finished by it', async () => {
        const first = adopterOver();
        await first.adopt.adopt(adopt([{ name: 'github/access', read: { kind: 'value', value: SECRET } }]));
        // A new genie-host over the same book, told of a removal it never answered:
        const next = adopterOver(first.k);
        expect(await next.adopt.adopt({ phase: 'removed', names: ['github/access'] })).toEqual({ outcomes: [{ name: 'github/access', status: 'not-confirmed' }], remove: [] });
        expect(JSON.parse(await readFile(bookFile, 'utf8')).secrets).toEqual({ 'github/access': 'verified' });
        // CONTROL: the host that answered it finishes it.
        expect(await first.adopt.adopt({ phase: 'removed', names: ['github/access'] })).toEqual({ outcomes: [{ name: 'github/access', status: 'moved' }], remove: [] });
        expect(JSON.parse(await readFile(bookFile, 'utf8')).secrets).toEqual({ 'github/access': 'done' });
    });

    function fakeLink() {
        const sent: Array<{ op: string; tunnel: string; payload: unknown }> = [];
        const link: TunnelLink = { live: () => true, send: (op, tunnel, payload) => { sent.push({ op, tunnel, payload }); return true; }, onFrame: () => () => {}, onDown: () => () => {} };
        return { sent, link };
    }
    function inMemoryDoor() {
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        const transport: ServerTransport = { onConnection: (l) => { accept = l; return () => {}; } };
        return { transport, open: (preAuth: Record<string, unknown>) => { const pair = inMemoryPair(); accept({ ...pair.server, preAuth: preAuth as never }); return pair; } };
    }

    it('the tunnel: only a door main opened as its own opens `own`; a page’s door claiming it, labelled Genie’s tray, does not', () => {
        const page = fakeLink();
        const pageDoor = inMemoryDoor();
        tunnelDoor(pageDoor.transport, page.link);
        pageDoor.open({ kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main', own: true });
        expect(page.sent.map((s) => s.op)).toEqual(['open']);
        expect((page.sent[0]!.payload as { kind?: unknown }).kind).toBeUndefined();
        const mine = fakeLink();
        const ownDoor = inMemoryDoor();
        tunnelDoor(ownDoor.transport, mine.link, { own: true });
        ownDoor.open({ kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main' });
        expect((mine.sent[0]!.payload as { kind?: unknown }).kind).toBe('own');
    });

    it('genie-host: a tunnel opened `own` is admitted as main’s own client; one only LABELLED Genie’s tray is not', () => {
        const tunnels = new ProtocolTunnels();
        const seen: Array<{ own?: unknown }> = [];
        tunnels.onConnection((c) => { seen.push((c.preAuth ?? {}) as { own?: unknown }); });
        tunnels.receive('engine-1', 'open', 't1', { window: 'main', label: OWN_CLIENT_LABEL }, () => {});
        tunnels.receive('engine-1', 'open', 't2', { window: 'main', label: OWN_CLIENT_LABEL, kind: 'own' }, () => {});
        tunnels.receive('engine-1', 'open', 't3', { window: 'main', label: 'this Genie window', own: true }, () => {});
        expect(seen.map((p) => p.own === true)).toEqual([false, true, false]);
    });

    it('the host API: Genie’s tray as a label is refused, and the adopter is never asked; main’s own client is let through', async () => {
        const adoptFn = vi.fn(async () => ({ outcomes: [], remove: [] }));
        const inner = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, legacySecrets: { adopt: adoptFn } } as unknown as HostApiDeps);
        const base = { connectionId: 'c1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: OWN_CLIENT_LABEL } as const;
        const request = { phase: 'adopt', secrets: [{ name: 'tynn/pairing', read: { kind: 'value', value: SECRET } }], genie1Identity: null };
        expect(await inner.invoke(ADOPT, [request], base)).toMatchObject({ ok: false, reason: expect.stringMatching(/never by a window/) });
        expect(adoptFn).not.toHaveBeenCalled();
        expect(await inner.invoke(ADOPT, [request], { ...base, own: true })).toEqual({ outcomes: [], remove: [] });
        expect(adoptFn).toHaveBeenCalledTimes(1);
    });

    it('wired: main tunnels its own client’s door as `own`, and its window’s door not', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/tunnelDoor\(ownProtocol\.door, tunnelLinkOf\(agentEngineLink\.client\), \{ own: true \}\)/);
        expect(main.match(/own: true/g) ?? []).toHaveLength(1);
    });
});

describe('no value is said anywhere: a log line, an outcome, an error, a refusal', () => {
    it('a distinctive secret and Genie 1’s key are in none of them, on either side', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-2g3b-quiet-'));
        const said: string[] = [];
        const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { said.push(args.map(String).join(' ')); }));
        try {
            const k = fakeKeychain();
            const host = hostLegacyAdopt({ vault: k.vault, book: fileMigrationBook(join(dir, 'keychain-migration.json'), { log: (l) => said.push(l) }), log: (l) => said.push(l), moved: (m) => said.push(JSON.stringify({ secretsMoved: m.secretsMoved })) });
            const answers: unknown[] = [];
            const keep = async (request: unknown) => { const a = await host.adopt(request); answers.push(a); return a; };
            // Every way it can go: moved, differs, unavailable, a refused name, a malformed read, a delete that fails.
            await keep({ phase: 'adopt', secrets: [{ name: 'github/access', read: { kind: 'value', value: SECRET } }], genie1Identity: { workstationId: 'ws_1', privateKeyPem: PEM } });
            k.state.mangle = () => `${SECRET}-mangled`;
            await keep({ phase: 'adopt', secrets: [{ name: 'github/refresh', read: { kind: 'value', value: SECRET } }], genie1Identity: null });
            k.state.available = false;
            await keep({ phase: 'adopt', secrets: [{ name: 'tynn/pairing', read: { kind: 'value', value: SECRET } }], genie1Identity: null });
            await keep({ phase: 'adopt', secrets: [{ name: `device/${SECRET}`, read: { kind: 'value', value: SECRET } }], genie1Identity: null });
            await keep({ phase: 'adopt', secrets: [{ name: 'github/access', read: { kind: 'value', value: SECRET } }], genie1Identity: { workstationId: 7, privateKeyPem: PEM } });
            await keep({ phase: 'removed', names: [SECRET] });
            k.state.available = true;
            const u = legacyUnsealer({
                sources: async () => [{ name: 'github/access', old: { read: async () => ({ kind: 'value', value: SECRET }), remove: async () => { throw new Error(`EBUSY ${SECRET}`); } } }, { name: 'tynn/pairing', old: { read: async () => { throw new Error(`cannot unseal ${SECRET}`); }, remove: async () => {} } }],
                genie1Identity: async () => ({ workstationId: 'ws_1', privateKeyPem: PEM }),
                call: async (_m, args) => ({ ok: true, value: await keep(args[0]) }),
                log: (l) => said.push(l),
            });
            await u.run();
            const refusing = legacyUnsealer({ sources: async () => { throw new Error(`agents.json: ${SECRET}`); }, genie1Identity: async () => null, call: async () => ({ ok: false, reason: 'x' }), log: (l) => said.push(l) });
            await refusing.run();
            expect(said.length).toBeGreaterThan(0);
            expect(answers.length).toBeGreaterThan(0);
            const everything = [...said, ...answers.map((a) => JSON.stringify(a))].join('\n');
            expect(everything).not.toContain(SECRET);
            expect(everything).not.toContain(PEM);
            expect(everything).not.toContain('PEM-SECRET');
            // CONTROL: the gauge finds a secret where one is (the host's keychain holds it).
            expect([...k.held.values()].join('\n')).toContain(SECRET);
        } finally {
            for (const spy of spies) spy.mockRestore();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('the summary says whether genie-host’s keychain can keep secrets, and GitHub’s block', () => {
    it('said from the host’s own reading; read from the wire fail closed', () => {
        expect(hostSummaryOf([], [], [], { workstationRole: 'pilot', tynnAccountKey: null, keychainReady: true, githubBlocked: true })).toMatchObject({ keychainReady: true, githubBlocked: true });
        expect(hostSummaryOf([], [], [])).toMatchObject({ keychainReady: false, githubBlocked: false });
        expect(EMPTY_HOST_SUMMARY).toMatchObject({ keychainReady: false, githubBlocked: false });
        const base = { terminals: [], armedFlows: [], scheduledTasks: [] };
        expect(readHostSummary({ ...base, keychainReady: true, githubBlocked: true })).toMatchObject({ keychainReady: true, githubBlocked: true });
        expect(readHostSummary({ ...base, keychainReady: 'yes', githubBlocked: 1 })).toMatchObject({ keychainReady: false, githubBlocked: false });
        expect(readHostSummary(base)).toMatchObject({ keychainReady: false, githubBlocked: false });
    });

    it('turning ready is the only flip that counts', () => {
        const ready = { ...EMPTY_HOST_SUMMARY, keychainReady: true };
        expect(keychainBecameReady(EMPTY_HOST_SUMMARY, ready)).toBe(true);
        expect(keychainBecameReady(ready, ready)).toBe(false);
        expect(keychainBecameReady(ready, EMPTY_HOST_SUMMARY)).toBe(false);
        expect(keychainBecameReady(EMPTY_HOST_SUMMARY, EMPTY_HOST_SUMMARY)).toBe(false);
    });
});

describe('wired: genie-host adopts and recovers by itself; main only unseals', () => {
    const host = code(src('src/main/genie-host.ts'));
    const main = code(src('src/main/main.ts'));

    it('genie-host composes the adopter over its own keychain and the one book, and after a move reloads, registers and recovers itself', () => {
        expect(host).toMatch(/const legacyAdopt = hostLegacyAdopt\(\{\s*vault: hostVault\(keychain\),\s*book: fileMigrationBook\(join\(home, 'keychain-migration\.json'\)/);
        expect(host).toMatch(/if \(secretsMoved\) void githubOpening\.then\(\(account\) => account\.reload\(\)\)/);
        expect(host).toMatch(/account\.reload\(\)[\s\S]{0,120}relayHostService\.register\(genie1Identity\)[\s\S]{0,120}tynnRecovery\?\.recover\(\{ secretsMoved: true \}\)/);
        expect(host).toMatch(/legacySecrets: legacyAdopt,/);
        expect(host).toMatch(/tynnRecheck: async \(\) => \{ const account = await tynnOpening\.catch\(\(\) => null\); if \(account && !account\.status\(\)\.signedIn\) await account\.recheck\(\); \}/);
    });

    it('genie-host’s summary reads its keychain and its GitHub account, and is poked on their changes', () => {
        expect(host).toMatch(/keychainReady: keychainNow\?\.state\(\) === 'ready', githubBlocked: \(githubAccountNow\?\.view\(\)\.signal \?\? null\) !== null \}\)/);
        expect(host).toMatch(/opened\.keychain\.onAnswerChange\(pokeSummary\); opened\.keyring\?\.onChange\(pokeSummary\);/);
        expect(host).toMatch(/githubOpening\.then\(\(account\) => \{ account\.onChange\(pokeSummary\); pokeSummary\(\); \}/);
        // Every client's Deck strip reads GitHub's block from here too.
        expect(host).toMatch(/githubBlocked: \(githubAccountNow\?\.view\(\)\.signal \?\? null\) !== null,\s*osAgentWorking:/);
    });

    it('main unseals once at boot and when the keychain turns ready, over its own protocol client; the unsealer moves to the launcher in step 6', () => {
        expect(main).toMatch(/const unsealer: LegacyUnsealer = legacyUnsealer\(\{/);
        expect(main).toMatch(/call: \(method, args\) => ownProtocol\.call\(method, args\)/);
        expect(main).toMatch(/tynnAgentIdentities\(\{ file: join\(genieRoot\(\), 'agent-credentials', 'agents\.json'\), secrets: NO_KEYCHAIN_HERE \}\)\.legacyKeys\(cipher\)/);
        expect(main).toMatch(/settleStaleLegacyPairing\([\s\S]*?tynnPairingSource\([\s\S]*?githubSealedSources\([\s\S]*?workstationSealedSources\(/);
        expect(main).toMatch(/genie1Identity: async \(\) => readGenie1Identity\(readV1Settings\(v1DatabaseFile\(\)\), osCipher\(safeStorage, process\.platform\)\)/);
        expect(main).toMatch(/unsealer\.summary\(before, summary\);/);
        expect(main).toMatch(/void unsealer\.run\(\);/);
        expect(src('src/main/legacy-unsealer.ts')).toMatch(/moves to the launcher in split step 6/);
    });

    it('compose no longer runs the move nor holds an account: main passes it none of it', () => {
        const compose = code(src('src/main/compose.ts'));
        for (const gone of [/moveAgentKeys/, /moveSecretsAgain/, /migrateSecrets/, /legacySecrets/, /onSecretsMoved/, /secretsLog/, /tynnCipher/, /\btynnVault\b/]) expect(compose).not.toMatch(gone);
        // CONTROL: the word boundary still finds the input where it is (compose's agents.json path is tynnVaultFile, not it).
        expect('readonly tynnVault?: HostVault;').toMatch(/\btynnVault\b/);
        const call = /const composed: WindowServices = await composeWith\(\{[\s\S]*?\n {4}\}\);/.exec(main)?.[0] ?? '';
        expect(call.length).toBeGreaterThan(0);
        for (const gone of [/\btynn: \(\) =>/, /tynnCipher:/, /tynnVault:/, /tynnSecrets:/, /legacySecrets:/, /onSecretsMoved:/, /secretsLog:/]) expect(call).not.toMatch(gone);
    });

    it('main holds no Tynn or GitHub account, keyring card or relay registration: their engine uses leave the list', () => {
        const uses = engineUses(src('src/main/main.ts'));
        for (const gone of ['tynn', 'github', 'keyring', 'relayHost']) {
            expect(uses, gone).not.toContain(gone);
            expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u), gone).not.toContain(gone);
        }
        expect(main).not.toMatch(/\btynnAccount\b|\bgithubAccount\b|\blinkedRelayHost\b|takeResumeSignIn|recoverTynnAgents/);
    });

    it('a genie:// sign-in goes to genie-host’s account as Settings’ code box does; the share link stays a relay window', () => {
        const open = /function openGenieUrl\(url: string\): void \{[\s\S]*?\n\}/.exec(main)?.[0] ?? '';
        expect(open).toMatch(/if \(workstation\) \{ openRemoteWindow\(`relay:\$\{workstation\.id\}`, workstation\.name\); return; \}/);
        expect(open).toMatch(/ownProtocol\.call\('features\.act', \[\{ kind: 'integrations\.tynnCode', code \}\]\)/);
        expect(src('src/main/feature-machine.ts')).toMatch(/case 'integrations\.tynnCode': \{\s*const r = await tynnAccountOf\(ports\)\.signIn\(action\.code\);/);
    });

    it('a wake and IssueWatch’s signed-out ask genie-host’s account again; GitHub’s block is the host’s, on its own Deck strip', () => {
        expect(main).toMatch(/powerMonitor\.on\('resume', \(\) => \{ void handProxyAnswers\?\.\(\); if \(ownProtocolTunnelled\) void ownProtocol\.call\('tynn\.recheck', \[\]\); \}\);/);
        expect(main).toMatch(/recheckSignIn: \(\) => \{ void ownProtocol\.call\('tynn\.recheck', \[\]\); \} \}/);
        // The window registry's signal strip went in Tynn #998 (2g-4b1): nothing read it. The summary still carries the block.
        expect(main).not.toMatch(/registry\.setSignals\(/);
        expect(src('src/core/host-summary.ts')).toMatch(/githubBlocked/);
    });

    it('no token goes over the engine link either way: since Tynn #961 (2g-3c) it has no keychain door at all', () => {
        const server = code(src('src/main/session-engine-server.ts'));
        expect(server).not.toMatch(/secretCompare|movableName|secretStore|secretRead|#keychain\(/);
        expect(src('src/core/engine-protocol.ts')).not.toMatch(/'engine\.secret[A-Za-z]*'/);
        // CONTROL: the same scan finds a route the server still has.
        expect(server).toMatch(/case 'engine\.proxyRemember':/);
    });
});
