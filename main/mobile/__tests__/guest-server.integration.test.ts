import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { disconnectGuest, mobileEmit, onGuestDisconnected, startMobileServer, stopMobileServer, mobileServerState } from '../server';
import { _resetAuthForTest, currentPin, mintGuestSession } from '../auth';
import { _resetAuditForTest } from '../audit';
import { _resetBatonForTest } from '../baton';
import { _resetBridgeForTest } from '../terminal-bridge';
import type { MobileDataDeps } from '../api';
import type { HostAccessPolicy } from '../../host-core/access-policy';

/**
 * A GUEST over the real sockets (genie-cloud#33): `/ws/term`, `/ws/events` and the
 * `.gen` site proxy, driven through the actual http + ws stack on 127.0.0.1.
 *
 * The REST half has its own suite (guest-api.test.ts). These are the channels a
 * REST gate cannot see:
 *  - a terminal attach is judged on the TERMINAL's workspace, and a read-only
 *    guest's keystrokes and resizes never reach the pty;
 *  - a push is delivered to a guest socket only when it concerns their workspace,
 *    and a push type nobody classified is withheld;
 *  - a site is proxied only when the grant names it, and writing to it needs
 *    `interact` plus `control`.
 * The owner's own paired device is the positive control for each.
 */

const written: Array<{ id: string; data: string }> = [];
const resizes: Array<{ id: string; cols: number; rows: number }> = [];
let appDir = '';
let upstream: http.Server | null = null;
let upstreamPort = 0;
const upstreamHits: Array<{ method: string; url: string }> = [];

const SHARED = { id: 'ws-shared', project_name: 'Shared App', path: '/w/shared' };
const PRIVATE = { id: 'ws-private', project_name: 'Private Payroll', path: '/w/private' };

const deps = (): MobileDataDeps =>
    ({
        listWorkspaces: () => [SHARED, PRIVATE],
        listTerminalSpecs: () => [
            { id: 't-shared', workspace_id: SHARED.id, label: 'shell', type: 'terminal', cwd: '/tmp', live_cwd: null },
            { id: 't-private', workspace_id: PRIVATE.id, label: 'payroll', type: 'terminal', cwd: '/tmp', live_cwd: null },
        ],
        listAllProcesses: () => [
            { id: 'p-shared', kind: 'process', label: 'web', command: 'x', workspace: SHARED.project_name, workspaceId: SHARED.id, status: 'running', autostart: false },
            { id: 'p-private', kind: 'process', label: 'payroll', command: 'x', workspace: PRIVATE.project_name, workspaceId: PRIVATE.id, status: 'running', autostart: false },
        ],
        liveTerminalIds: () => ['t-shared', 't-private'],
        writeToTerminal: (id: string, data: string) => {
            written.push({ id, data });
            return true;
        },
        getScrollback: () => '',
        resize: (id: string, cols: number, rows: number) => {
            resizes.push({ id, cols, rows });
            return true;
        },
        listPendingQuestions: () => [],
    }) as unknown as MobileDataDeps;

const policy = (overrides: Partial<HostAccessPolicy> = {}): HostAccessPolicy => ({
    principalId: 'tynn-user-guest',
    principalType: 'tynn-user',
    transports: ['tynn'],
    capability: 'control',
    workspaceScopes: [`workspace:${SHARED.id}`],
    sitePermissions: { 'site-shared': 'interact', 'site-shared-browse': 'browse' },
    ...overrides,
});

async function start(): Promise<number> {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-guest-it-'));
    fs.writeFileSync(path.join(appDir, 'mobile.html'), '<!doctype html><html><head></head><body></body></html>');
    await startMobileServer({
        serverVersion: '0.0.0-test',
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-guest-ud-')),
        appDir,
        enabled: true,
        configuredPort: () => 0,
        data: deps(),
        confirmPair: async () => true,
        bindIpOverride: '127.0.0.1',
        siteProxy: {
            resolveSite: (siteId: string) =>
                ({
                    'site-shared': { workspaceId: SHARED.id },
                    'site-shared-browse': { workspaceId: SHARED.id },
                    'site-private': { workspaceId: PRIVATE.id },
                } as Record<string, { workspaceId: string }>)[siteId]
                    ? {
                          workspaceId: ({ 'site-private': PRIVATE.id } as Record<string, string>)[siteId] ?? SHARED.id,
                          hostname: `${siteId}.gen`,
                          scheme: 'http' as const,
                          port: upstreamPort,
                          loopback: '127.0.0.1' as const,
                      }
                    : null,
        },
    });
    const st = mobileServerState();
    if (!st.running || !st.port) throw new Error('server did not bind');
    return st.port;
}

function send(port: number, method: string, pathname: string, token?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const r = http.request(
            { host: '127.0.0.1', port, path: pathname, method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            },
        );
        r.on('error', reject);
        r.end();
    });
}

function openWs(url: string, frames?: any[]): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { origin: 'http://127.0.0.1' });
        if (frames) ws.on('message', (m) => frames.push(JSON.parse(String(m))));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
}

async function pairOwner(port: number): Promise<string> {
    const body = JSON.stringify({ pin: currentPin() });
    return new Promise((resolve, reject) => {
        const r = http.request(
            { host: '127.0.0.1', port, path: '/api/pair', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(JSON.parse(data).token));
            },
        );
        r.on('error', reject);
        r.end(body);
    });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBatonForTest();
    _resetBridgeForTest();
    written.length = 0;
    resizes.length = 0;
    upstreamHits.length = 0;
    upstream = http.createServer((req, res) => {
        upstreamHits.push({ method: req.method ?? '', url: req.url ?? '' });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('site ok');
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
});

afterEach(async () => {
    stopMobileServer();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

describe('guest terminals (/ws/term)', () => {
    it('refuses to attach a guest to a terminal in a workspace outside the grant', async () => {
        const port = await start();
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;

        await expect(openWs(`ws://127.0.0.1:${port}/ws/term?terminal=t-private&token=${guest}`)).rejects.toThrow();
    });

    it('lets a control guest drive a terminal in its workspace (positive control)', async () => {
        const port = await start();
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;

        const ws = await openWs(`ws://127.0.0.1:${port}/ws/term?terminal=t-shared&token=${guest}`);
        ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
        await tick();

        expect(written).toContainEqual({ id: 't-shared', data: 'ls\r' });
        ws.close();
    });

    it('lets a read-only guest watch, but never type into or resize the terminal', async () => {
        const port = await start();
        const viewer = mintGuestSession({ policy: policy({ capability: 'readonly' }), name: 'Vic' }).token;

        const ws = await openWs(`ws://127.0.0.1:${port}/ws/term?terminal=t-shared&client=desktop&token=${viewer}`);
        ws.send(JSON.stringify({ type: 'input', data: 'rm -rf /\r' }));
        ws.send(JSON.stringify({ type: 'resize', cols: 40, rows: 10 }));
        await tick();

        expect(written).toEqual([]);
        expect(resizes).toEqual([]);
        ws.close();
    });

    it('still attaches the owner\'s device anywhere (positive control)', async () => {
        const port = await start();
        const owner = await pairOwner(port);

        const ws = await openWs(`ws://127.0.0.1:${port}/ws/term?terminal=t-private&token=${owner}`);
        ws.close();
    });
});

describe('guest pushes (/ws/events)', () => {
    it('delivers a push about the shared workspace, and withholds the private one and unclassified types', async () => {
        const port = await start();
        const owner = await pairOwner(port);
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;
        const guestFrames: any[] = [];
        const ownerFrames: any[] = [];
        const g = await openWs(`ws://127.0.0.1:${port}/ws/events?token=${guest}`, guestFrames);
        const o = await openWs(`ws://127.0.0.1:${port}/ws/events?token=${owner}`, ownerFrames);
        await tick(20);

        mobileEmit('process:status', { id: 'p-shared', status: 'stopped' });
        mobileEmit('process:status', { id: 'p-private', status: 'stopped' });
        mobileEmit('workspace:pulse', { workspaceId: PRIVATE.id });
        mobileEmit('agentinbox:message', { from: 'payroll-agent', text: 'salary run done' });
        mobileEmit('issue-watch:update', { counts: { [SHARED.id]: 1, [PRIVATE.id]: 9 }, errors: {}, needsReauth: false });
        await tick();

        const guestEvents = guestFrames.filter((f) => f.type !== 'control:changed');
        expect(guestEvents.map((f) => [f.type, f.payload?.id ?? f.payload?.workspaceId ?? null])).toEqual([
            ['process:status', 'p-shared'],
            ['issue-watch:update', null],
        ]);
        expect(guestEvents[1].payload.counts).toEqual({ [SHARED.id]: 1 });
        expect(JSON.stringify(guestFrames)).not.toMatch(/p-private|ws-private|salary/);

        // The owner's device receives all of it.
        const ownerTypes = ownerFrames.map((f) => f.type);
        expect(ownerTypes.filter((t) => t === 'process:status')).toHaveLength(2);
        expect(ownerTypes).toContain('agentinbox:message');
        expect(ownerTypes).toContain('workspace:pulse');
        g.close();
        o.close();
    });
});

describe('disconnecting a guest', () => {
    const closed = (ws: WebSocket) =>
        new Promise<number>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) resolve(ws.readyState);
            else ws.once('close', () => resolve(WebSocket.CLOSED));
        });

    it('closes that guest\'s live sockets and refuses its token, leaving everyone else connected', async () => {
        const port = await start();
        const owner = await pairOwner(port);
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;
        const other = mintGuestSession({ policy: policy({ principalId: 'tynn-user-other' }), name: 'Alex' }).token;
        const events = await openWs(`ws://127.0.0.1:${port}/ws/events?token=${guest}`);
        const term = await openWs(`ws://127.0.0.1:${port}/ws/term?terminal=t-shared&token=${guest}`);
        const otherEvents = await openWs(`ws://127.0.0.1:${port}/ws/events?token=${other}`);
        const ownerEvents = await openWs(`ws://127.0.0.1:${port}/ws/events?token=${owner}`);
        await tick(20);

        expect(disconnectGuest('tynn-user-guest')).toBe(1);

        await expect(closed(events)).resolves.toBe(WebSocket.CLOSED);
        await expect(closed(term)).resolves.toBe(WebSocket.CLOSED);
        expect((await send(port, 'GET', '/api/state', guest)).status).toBe(401);
        await tick(20);
        expect(otherEvents.readyState).toBe(WebSocket.OPEN);
        expect(ownerEvents.readyState).toBe(WebSocket.OPEN);
        otherEvents.close();
        ownerEvents.close();
    });
});

// genie#681: the host's banner must tell a guest from the owner's own device, say
// what each guest reaches, and disconnect one of them without touching the rest.
describe('who is connected, as the host sees it', () => {
    it("says what each guest reaches, by workspace name, and marks the owner's device as no guest", async () => {
        const port = await start();
        const owner = await pairOwner(port);
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;
        const viewer = mintGuestSession({
            policy: policy({ principalId: 'tynn-user-viewer', capability: 'readonly', workspaceScopes: ['host:all'] }),
            name: 'Vic',
        }).token;
        const sockets = [
            await openWs(`ws://127.0.0.1:${port}/ws/events?token=${owner}`),
            await openWs(`ws://127.0.0.1:${port}/ws/events?token=${guest}`),
            await openWs(`ws://127.0.0.1:${port}/ws/events?token=${viewer}`),
        ];
        await tick(20);

        const peers = mobileServerState().peers;
        expect(peers.find((p) => p.name === 'Sam')?.access).toEqual({ capability: 'control', workspaces: ['Shared App'] });
        expect(peers.find((p) => p.name === 'Vic')?.access).toEqual({ capability: 'readonly', workspaces: 'all' });
        expect(peers.filter((p) => p.access === null)).toHaveLength(1);
        for (const ws of sockets) ws.close();
    });

    it("tells whoever carries a guest's connection that the host disconnected them", async () => {
        await start();
        mintGuestSession({ policy: policy(), name: 'Sam' });
        const heard: string[] = [];
        const stop = onGuestDisconnected((principalId) => heard.push(principalId));

        disconnectGuest('tynn-user-guest');
        stop();
        disconnectGuest('tynn-user-guest');

        expect(heard).toEqual(['tynn-user-guest']);
    });
});

describe('guest sites (/api/site)', () => {
    it('does not proxy a site in a workspace outside the grant', async () => {
        const port = await start();
        const guest = mintGuestSession({ policy: policy({ sitePermissions: { '*': 'interact' } }), name: 'Sam' }).token;

        const res = await send(port, 'GET', '/api/site/site-private/', guest);

        expect(res.status).toBe(404);
        expect(upstreamHits).toEqual([]);
    });

    it('does not proxy a site in the shared workspace the grant does not name', async () => {
        const port = await start();
        const guest = mintGuestSession({ policy: policy({ sitePermissions: {} }), name: 'Sam' }).token;

        const res = await send(port, 'GET', '/api/site/site-shared/', guest);

        expect(res.status).toBe(404);
        expect(upstreamHits).toEqual([]);
    });

    it('lets a browse permission read a site but not post to it', async () => {
        const port = await start();
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;

        expect((await send(port, 'GET', '/api/site/site-shared-browse/page', guest)).status).toBe(200);
        expect((await send(port, 'POST', '/api/site/site-shared-browse/form', guest)).status).toBe(404);
        expect(upstreamHits).toEqual([{ method: 'GET', url: '/page' }]);
    });

    it('lets interact + control post to a site, and read-only never', async () => {
        const port = await start();
        const guest = mintGuestSession({ policy: policy(), name: 'Sam' }).token;
        const viewer = mintGuestSession({ policy: policy({ principalId: 'viewer', capability: 'readonly' }), name: 'Vic' }).token;

        expect((await send(port, 'POST', '/api/site/site-shared/form', guest)).status).toBe(200);
        expect((await send(port, 'POST', '/api/site/site-shared/form', viewer)).status).toBe(404);
        expect(upstreamHits.filter((h) => h.method === 'POST')).toHaveLength(1);
    });
});
