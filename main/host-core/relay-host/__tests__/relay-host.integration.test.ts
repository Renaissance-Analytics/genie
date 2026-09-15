import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MobileDataDeps } from '../../../mobile/api';
import { _resetAuditForTest } from '../../../mobile/audit';
import { _resetAuthForTest, listSessions } from '../../../mobile/auth';
import { _resetBatonForTest } from '../../../mobile/baton';
import { activeMobilePeers, mobileServerState, startMobileServer, stopMobileServer } from '../../../mobile/server';
import { _resetBridgeForTest } from '../../../mobile/terminal-bridge';
import { RelayMemberClient } from '../../../remote/relay-client';
import { PopKeypair } from '../../../remote/relay-pop';
import { startRelayHost, type RelayHostHandle, type RelayHostStatus } from '../service';
import type { TynnJwk } from '../grant';
import { jwkThumbprint } from '../pop';
import { startTestRelay, type TestRelay } from './helpers/test-relay';

/**
 * A DESKTOP Genie as a relay host (genie#680), end to end on 127.0.0.1: a relay
 * broker, this machine's real member-facing server, the relay host dialing out,
 * and Genie's real member client connecting in with a Tynn-signed grant — the
 * path a support engineer takes into a customer's desktop, minus only the network
 * between them and Tynn itself (stubbed at its HTTP contract).
 *
 * What it proves: the desktop registers on the relay with a relay ticket signed by
 * its own key; a guest shared ONE workspace connects without any shared network,
 * sees that workspace and only it, drives its terminal and not another's; a grant
 * for another machine, or an unbound control grant, is refused; revoking the grant
 * ends the live session; the guest appears on the host's roster by name; and the
 * owner's own grant connects as the owner.
 */

const WORKSTATION = 'ws-desktop';
const SHARED = { id: 'ws-shared', project_name: 'Shared App', path: '/w/shared' };
const PRIVATE = { id: 'ws-private', project_name: 'Private Payroll', path: '/w/private' };

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting');
        await tick(20);
    }
}

let relay: TestRelay;
let host: RelayHostHandle | null = null;
let tynn: { jwk: TynnJwk; privateKey: KeyObject };
let hostKey: { publicKey: KeyObject; privateKey: KeyObject };
let hostPublicKeyB64: string;
let introspectActive = true;
let ticketError: { status: number; body: unknown } | null = null;
const written: Array<{ id: string; data: string }> = [];
const statuses: RelayHostStatus[] = [];
const members: RelayMemberClient[] = [];
let appDir = '';
let upstream: http.Server | null = null;
let upstreamPort = 0;
const upstreamHits: string[] = [];

function deps(): MobileDataDeps {
    return {
        listWorkspaces: () => [SHARED, PRIVATE],
        listTerminalSpecs: () => [
            { id: 't-shared', workspace_id: SHARED.id, label: 'shell', type: 'terminal', cwd: '/tmp', live_cwd: null },
            { id: 't-private', workspace_id: PRIVATE.id, label: 'payroll', type: 'terminal', cwd: '/tmp', live_cwd: null },
        ],
        listAllProcesses: () => [],
        liveTerminalIds: () => ['t-shared', 't-private'],
        writeToTerminal: (id: string, data: string) => {
            written.push({ id, data });
            return true;
        },
        getScrollback: () => '',
        resize: () => true,
        listPendingQuestions: () => [],
        updateStatus: () => ({ state: 'idle', currentVersion: '0.0.0-test', latestVersion: null, readyToInstall: false }),
    } as unknown as MobileDataDeps;
}

function mintGrant(claims: Record<string, unknown>): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const input = `${b64u(JSON.stringify({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: tynn.jwk.kid }))}.${b64u(
        JSON.stringify({
            iss: 'https://tynn.test',
            sub: 'user-sam',
            aud: WORKSTATION,
            cap: 'control',
            scope: [`workspace:${SHARED.id}`],
            sites: {},
            jti: `grant-${Math.random()}`,
            iat: nowSec,
            nbf: nowSec,
            exp: nowSec + 900,
            name: 'Sam Support',
            src: 'share',
            ...claims,
        }),
    )}`;
    return `${input}.${b64u(sign(null, Buffer.from(input), tynn.privateKey))}`;
}

/** Tynn, at its HTTP contract: relay ticket, published keys, introspection. */
const fakeTynn: typeof fetch = async (input, init) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith(`/api/v1/workstations/${WORKSTATION}/relay-ticket`)) {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
        if (!auth.startsWith('Workstation ')) return json(401, { message: 'host authentication required' });
        if (ticketError) return json(ticketError.status, ticketError.body);
        return json(200, { ticket: 'relay.ticket.jws', relay_endpoint: relay.url, expires_at: new Date(Date.now() + 300_000).toISOString() });
    }
    if (url.endsWith('/api/v1/workstations/grants/public-keys')) return json(200, { keys: [tynn.jwk], heartbeat_interval: 60 });
    if (url.endsWith('/api/v1/workstations/grants/introspect')) return json(200, { active: introspectActive, revoked: !introspectActive });
    return json(404, {});
};

async function startServer(): Promise<number> {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relay-host-it-'));
    fs.writeFileSync(path.join(appDir, 'mobile.html'), '<!doctype html><html><head></head><body></body></html>');
    await startMobileServer({
        serverVersion: '0.0.0-test',
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relay-host-ud-')),
        appDir,
        enabled: true,
        configuredPort: () => 0,
        data: deps(),
        confirmPair: async () => true,
        bindIpOverride: '127.0.0.1',
        siteProxy: {
            resolveSite: (siteId: string) => {
                const workspaceId = ({ 'site-shared': SHARED.id, 'site-private': PRIVATE.id } as Record<string, string>)[siteId];
                return workspaceId && upstreamPort
                    ? { workspaceId, hostname: `${siteId}.gen`, scheme: 'http' as const, port: upstreamPort, loopback: '127.0.0.1' as const }
                    : null;
            },
        },
    });
    return mobileServerState().port!;
}

/** A `.gen` site this machine serves, as the site proxy's upstream. */
async function startUpstream(): Promise<void> {
    upstream = http.createServer((req, res) => {
        upstreamHits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('site ok');
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
}

/** GET a site over the member's relay `site` channel, as the Testing Browser does. */
function getSite(member: RelayMemberClient, siteId: string, workspaceId: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        let status = 0;
        let body = '';
        const stream = member.openSite(
            { workspaceId, siteId, method: 'GET', path: `/api/site/${siteId}/hello`, headers: {} },
            {
                onResponse: (s) => (status = s),
                onData: (chunk) => (body += chunk.toString('utf8')),
                onClose: () => resolve({ status, body }),
                onError: (message) => (status ? resolve({ status, body }) : reject(new Error(message))),
            },
        );
        stream.end();
    });
}

async function startHost(opts: { revalidateMs?: number } = {}): Promise<RelayHostHandle> {
    const port = await startServer();
    host = startRelayHost({
        workstationId: WORKSTATION,
        fingerprint: 'fp-desktop',
        sign: (data) => sign(null, data, hostKey.privateKey),
        authHeader: () => 'Workstation 1:sig',
        tynnApiBaseUrl: 'https://tynn.test',
        localBaseUrl: () => `http://127.0.0.1:${port}`,
        fetchImpl: fakeTynn,
        revalidateMs: opts.revalidateMs ?? 0,
        reconnect: { minMs: 0, maxMs: 0 },
        onStatus: (s) => statuses.push(s),
        log: () => {},
    });
    await until(() => host!.status().state === 'connected');
    return host;
}

async function connect(grant: string, pop?: PopKeypair): Promise<RelayMemberClient> {
    const member = new RelayMemberClient();
    members.push(member);
    await member.connect({ relayUrl: relay.url, workstationId: WORKSTATION, grant, popKeypair: pop, hostPublicKeyB64, timeoutMs: 3000 });
    return member;
}

function boundGrant(claims: Record<string, unknown> = {}): { grant: string; pop: PopKeypair } {
    const pop = PopKeypair.generate();
    return { grant: mintGrant({ cnf: { jkt: jwkThumbprint(pop.publicJwk) }, ...claims }), pop };
}

beforeEach(async () => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    _resetBridgeForTest();
    written.length = 0;
    statuses.length = 0;
    introspectActive = true;
    ticketError = null;
    relay = await startTestRelay();
    const tk = generateKeyPairSync('ed25519');
    tynn = { jwk: { kty: 'OKP', crv: 'Ed25519', kid: 'tynn-1', x: tk.publicKey.export({ format: 'jwk' }).x as string }, privateKey: tk.privateKey };
    hostKey = generateKeyPairSync('ed25519');
    hostPublicKeyB64 = (hostKey.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
});

afterEach(async () => {
    for (const m of members.splice(0)) m.close();
    host?.stop();
    host = null;
    stopMobileServer();
    await relay.close();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = null;
    upstreamPort = 0;
    upstreamHits.length = 0;
    if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

describe('a desktop Genie as a relay host', () => {
    it('registers on the relay with a relay ticket, signed with its own key', async () => {
        await startHost();

        expect(relay.hellos).toHaveLength(1);
        expect(relay.hellos[0]).toMatchObject({ type: 'host-hello', workstationId: WORKSTATION, fingerprint: 'fp-desktop', ticket: 'relay.ticket.jws' });
        expect(typeof relay.hellos[0].sig).toBe('string');
        expect(relay.hellos[0].mac).toBeUndefined();
    });

    it('lets a guest shared one workspace in without any shared network, and shows them that workspace only', async () => {
        await startHost();
        const { grant, pop } = boundGrant();
        const member = await connect(grant, pop);

        const reply = await member.rest({ method: 'GET', path: '/api/state' });

        expect(reply.status).toBe(200);
        const state = JSON.parse(reply.body ?? '') as { workspaces: Array<{ id: string }> };
        expect(state.workspaces.map((w) => w.id)).toEqual([SHARED.id]);
        expect(reply.body).not.toMatch(/ws-private|Private Payroll|t-private/);
    });

    it('lets the guest drive a terminal in that workspace, and not attach to another', async () => {
        await startHost();
        const { grant, pop } = boundGrant();
        const member = await connect(grant, pop);

        // Multiplexed, as Genie's remote window negotiates via /api/relay/features.
        const shared = member.openTerm('t-shared', () => {}, SHARED.id, true);
        await tick(150);
        shared.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
        // Tagged with the SHARED workspace, aimed at the private terminal: the tag decides nothing.
        const sneaky = member.openTerm('t-private', () => {}, SHARED.id, true);
        await tick(150);
        sneaky.send(JSON.stringify({ type: 'input', data: 'cat .env\r' }));
        await until(() => written.length > 0);
        await tick(150);

        expect(written).toEqual([{ id: 't-shared', data: 'ls\r' }]);
    });

    it('refuses a grant minted for another workstation', async () => {
        await startHost();
        const { grant, pop } = boundGrant({ aud: 'ws-somebody-else' });

        await expect(connect(grant, pop)).rejects.toThrow(/rejected the connection/);
        expect(listSessions().filter((s) => s.access)).toEqual([]);
    });

    it('refuses a control grant that is not bound to the member\'s key', async () => {
        await startHost();

        await expect(connect(mintGrant({}))).rejects.toThrow(/rejected the connection/);
    });

    it('refuses a member that cannot prove the key its grant is bound to', async () => {
        await startHost();
        const { grant } = boundGrant();

        await expect(connect(grant, PopKeypair.generate())).rejects.toThrow(/rejected the connection/);
    });

    it('ends the live session, and its local session, when the grant is revoked', async () => {
        await startHost({ revalidateMs: 100 });
        const { grant, pop } = boundGrant();
        const member = await connect(grant, pop);
        const events: string[] = [];
        member.openEvents((m) => events.push(m));
        await until(() => activeMobilePeers().some((p) => p.id === 'user-sam'));
        const [guestSession] = listSessions().filter((s) => s.access);
        expect(guestSession).toBeDefined();

        introspectActive = false;

        await until(() => listSessions().filter((s) => s.access).length === 0);
        // Its sockets are closed, not left streaming…
        await until(() => !activeMobilePeers().some((p) => p.id === 'user-sam'));
        // …and its local token no longer opens anything.
        const res = await fetch(`http://127.0.0.1:${mobileServerState().port}/api/state`, {
            headers: { authorization: `Bearer ${guestSession.token}` },
        });
        expect(res.status).toBe(401);
    });

    it('puts the guest on the host\'s roster by the name their grant carries', async () => {
        await startHost();
        const { grant, pop } = boundGrant();
        const member = await connect(grant, pop);

        member.openEvents(() => {});

        await until(() => activeMobilePeers().some((p) => p.name === 'Sam Support'));
        expect(activeMobilePeers().find((p) => p.name === 'Sam Support')?.id).toBe('user-sam');
    });

    it('connects the owner\'s own grant as the owner, with host management a guest is refused', async () => {
        await startHost();
        const owner = boundGrant({ src: 'owner', scope: ['host:all'], sites: { '*': 'interact' } });
        const guest = boundGrant({ sub: 'user-guest', scope: ['host:all'] });
        const ownerMember = await connect(owner.grant, owner.pop);
        const guestMember = await connect(guest.grant, guest.pop);

        // The updater's status is host management: the owner's, never a guest's —
        // even a guest shared every workspace.
        expect((await ownerMember.rest({ method: 'GET', path: '/api/update/status' })).status).toBe(200);
        expect((await guestMember.rest({ method: 'GET', path: '/api/update/status' })).status).toBe(403);
        expect(listSessions().filter((s) => s.access).map((s) => s.access?.principalId)).toEqual(['user-guest']);
    });

    // The acceptance path for `.gen` sites: a guest reaches a site their grant names,
    // over the relay's end-to-end encrypted site channel, and no other.
    it('lets a guest browse a site the grant names over the encrypted site channel, and not a site it does not', async () => {
        await startUpstream();
        await startHost();
        const { grant, pop } = boundGrant({ cap: 'readonly', sites: { 'site-shared': 'browse' } });
        const member = await connect(grant, pop);

        const shared = await getSite(member, 'site-shared', SHARED.id);
        const unnamed = await getSite(member, 'site-private', PRIVATE.id);

        expect(shared).toEqual({ status: 200, body: 'site ok' });
        expect(unnamed.status).not.toBe(200);
        expect(upstreamHits).toEqual(['/hello']);
    });

    it('never lets a member reach the pairing route or the phone app shell through the relay', async () => {
        await startHost();
        const { grant, pop } = boundGrant({ src: 'owner', scope: ['host:all'] });
        const member = await connect(grant, pop);

        expect((await member.rest({ method: 'POST', path: '/api/pair', body: '{"pin":"000000"}' })).status).toBe(403);
        expect((await member.rest({ method: 'GET', path: '/m/' })).status).toBe(403);
    });

    it('reports why it cannot be reached when Tynn has no relay for it', async () => {
        ticketError = { status: 409, body: { error: 'no_relay', message: 'No relay is configured for this workstation.' } };
        await startServer();
        host = startRelayHost({
            workstationId: WORKSTATION,
            fingerprint: 'fp',
            sign: (data) => sign(null, data, hostKey.privateKey),
            authHeader: () => 'Workstation 1:sig',
            tynnApiBaseUrl: 'https://tynn.test',
            localBaseUrl: () => `http://127.0.0.1:${mobileServerState().port}`,
            fetchImpl: fakeTynn,
            reconnect: { minMs: 0, maxMs: 0 },
            onStatus: (s) => statuses.push(s),
            log: () => {},
        });

        await until(() => host!.status().state === 'unavailable');
        expect(host.status()).toEqual({ state: 'unavailable', reason: 'no_relay', message: 'No relay is configured for this workstation.' });
        expect(relay.hellos).toEqual([]);
    });
});
