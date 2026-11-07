import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeReverb, type FakeReverb } from '../scripts/perf-lag/fake-reverb.mjs';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { issueWatchPanelView, issueWatchWhyNot, parseIssueWatchEntry, type IssueWatchSummary, type IwEvent } from '../src/core/issue-watch.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { IssueWatchClient, RECONNECT_MAX_MS, RECONNECT_MS, type IssueWatchClientPorts, type IssueWatchState, type SocketLike } from '../src/main/issue-watch-client.js';
import { genieTools, type Caller } from '../src/main/mcp-tools.js';
import { CONNECT_DEADLINE_MS, SUBSCRIBE_DEADLINE_MS } from '../src/main/pusher-link.js';
import { TynnBoardLive } from '../src/main/tynn-board-live.js';
import { dialTynnSocket } from '../src/main/tynn-socket.js';

/**
 * PRODUCTION'S REVERB ANSWERS ONLY `Origin: https://tynn.ai` (genie#1478). Anything else gets `pusher:error` 4009 `Origin
 * not allowed`, and then the socket stays open and silent until the server closes it about 300 s later. Genie sent no
 * Origin, dropped the error frame, had no deadline, and read nothing unless the socket came up: IssueWatch never connected
 * to production, and test VMs could not see it, because tynn.gen's WebSocket service allows every Origin.
 *
 * So the top half is the real thing on a real socket against scripts/perf-lag/fake-reverb.mjs, which holds production's rule.
 */
const PRODUCTION = 'https://tynn.ai';
const PROJECT = 'proj_1';
const CHANNEL = 'private-App.Models.User.42';
const item = (key: string, kind = 'issue') => ({ kind, key, number: 1, title: 't', url: 'u', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z', owner: 'acme', repo: 'app' });
const entry = (items: unknown[]) => ({ workspaceId: PROJECT, projectId: PROJECT, counts: {}, items, feedbackItems: [], tracking: {} });

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
/** Waits for a state to come true, on the wire's own time; a timeout answers what it was instead. */
async function until(read: () => boolean, ms = 2_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!read() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return read();
}

let servers: FakeReverb[] = [];
let clients: Array<{ stop(): void }> = [];
afterEach(async () => {
    for (const c of clients) c.stop();
    clients = [];
    for (const s of servers) await s.close();
    servers = [];
});
async function reverb(allowedOrigins: readonly string[] = [PRODUCTION], subscribe?: 'answer' | 'subscription-error' | 'pusher-error' | 'silent'): Promise<FakeReverb> {
    const s = await startFakeReverb({ allowedOrigins, ...(subscribe === undefined ? {} : { subscribe }) });
    servers.push(s);
    return s;
}

/** A signed-in Tynn over nothing, and a client on it. */
function harness(opts: { config: unknown; socket: IssueWatchClientPorts['socket']; signedIn?: boolean; pull?: (n: number) => Promise<unknown> | unknown; authStatus?: number; authHangs?: boolean }) {
    const requests: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const states: IssueWatchState[] = [];
    const entries: string[] = [];
    const heard: IwEvent[] = [];
    let pulls = 0;
    let reconcile: unknown = { workspaces: [entry([item('a:issue:1')])] };
    const client = new IssueWatchClient({
        tynn: () => (opts.signedIn === false ? null : {
            userId: '42',
            request: async (path) => {
                requests.push(path);
                let json: unknown = reconcile;
                if (path === '/api/v1/broadcasting-config') json = opts.config;
                else if (path === '/api/v1/user/broadcasting-auth') {
                    if (opts.authHangs === true) await new Promise(() => {});
                    json = { auth: 'rk:sig' };
                    if (opts.authStatus !== undefined) return { ok: opts.authStatus < 300, status: opts.authStatus, json: async () => json };
                } else if (opts.pull) json = await opts.pull(pulls++);
                return { ok: true, status: 200, json: async () => json };
            },
        }),
        socket: opts.socket,
        schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
        onEvents: (_projectId, events) => { heard.push(...events); },
        onState: (state) => { states.push(state); },
        onEntry: (e) => { entries.push(e.projectId); },
    });
    clients.push(client);
    return { client, requests, timers, states, entries, heard, setReconcile: (r: unknown) => { reconcile = r; } };
}

type FakeSocket = SocketLike & { url: string; sent: string[]; closed: boolean; emit(frame: unknown): void; drop(event?: { message?: string }): void; fail(event: { message?: string }): void };
/** A socket that does only what it is told: its `close()` fires nothing unless `closeAnswers` is set. */
function fakeSockets(closeAnswers = false) {
    const sockets: FakeSocket[] = [];
    const socket = (url: string): SocketLike => {
        const listeners: Record<string, Array<(e: { data?: unknown; message?: unknown }) => void>> = {};
        const s: FakeSocket = {
            url, sent: [], closed: false,
            send: (data) => { s.sent.push(data); },
            close: () => { s.closed = true; if (closeAnswers) for (const l of listeners.close ?? []) l({}); },
            addEventListener: (type, l) => { (listeners[type] ??= []).push(l); },
            emit: (frame) => { for (const l of listeners.message ?? []) l({ data: JSON.stringify(frame) }); },
            drop: (event = {}) => { for (const l of listeners.close ?? []) l(event); },
            fail: (event) => { for (const l of listeners.error ?? []) l(event); },
        };
        sockets.push(s);
        return s;
    };
    return { sockets, socket };
}
const CONFIG = { broadcaster: 'reverb', key: 'rk', host: 'ws.example.test', port: 443, scheme: 'https' };
const REFUSAL = { event: 'pusher:error', data: JSON.stringify({ code: 4009, message: 'Origin not allowed' }) };
const liveTimers = (h: { timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> }) => h.timers.filter((t) => !t.cancelled);

describe('the fake holds production’s rule (CONTROL: this is what the tests below are measured against)', () => {
    /** The first thing said, and whether anything else followed within a moment. */
    const dial = (url: string, init?: { headers: Record<string, string> }) => new Promise<{ frames: string[]; closed: boolean }>((done) => {
        const frames: string[] = [];
        let closed = false;
        const ws = init ? new (WebSocket as unknown as new (u: string, i: unknown) => WebSocket)(url, init) : new WebSocket(url);
        ws.addEventListener('message', (e) => { frames.push(String(e.data)); });
        ws.addEventListener('close', () => { closed = true; });
        setTimeout(() => { done({ frames, closed }); }, 300);
    });

    it('no Origin, or a wrong one: 4009 Origin not allowed, and then silent and open', async () => {
        const server = await reverb();
        const none = await dial(server.url());
        const wrong = await dial(server.url(), { headers: { Origin: 'https://example.com' } });
        expect(server.connections.map((c) => c.origin)).toEqual([null, 'https://example.com']);
        for (const r of [none, wrong]) {
            expect(r.frames).toEqual([JSON.stringify(REFUSAL)]);
            expect(r.closed).toBe(false);
        }
    });

    it('its own Origin: connection_established', async () => {
        const server = await reverb();
        const r = await dial(server.url(), { headers: { Origin: PRODUCTION } });
        expect(r.frames.map((f) => (JSON.parse(f) as { event: string }).event)).toEqual(['pusher:connection_established']);
    });
});

describe('Genie’s socket against that rule (real socket, real wire)', () => {
    it('IssueWatch reaches live, and the Origin on the wire is the Tynn host’s', async () => {
        const server = await reverb();
        const h = harness({ config: server.config(), socket: (url) => dialTynnSocket(url, PRODUCTION) });
        h.client.start();
        await until(() => h.client.state().kind === 'live');
        expect(h.client.state()).toEqual({ kind: 'live' });
        expect(server.connections.map((c) => c.origin)).toEqual([PRODUCTION]);
        expect(server.connections[0]?.received.map((f) => JSON.parse(f) as unknown)).toEqual([{ event: 'pusher:subscribe', data: { auth: 'rk:sig', channel: CHANNEL } }]);
    });

    it('the live board reaches live on the same rule', async () => {
        const server = await reverb();
        const states: string[] = [];
        const live = new TynnBoardLive({
            tynn: () => ({ request: async (path) => ({ ok: true, status: 200, json: async () => (path === '/api/v1/broadcasting-config' ? server.config() : { auth: 'rk:sig' }) }) }),
            socket: (url) => dialTynnSocket(url, PRODUCTION),
            schedule: () => () => {},
            onRing: () => {},
            onState: (_projectId, state) => { states.push(state); },
        });
        const stop = live.watch('01JPROJECT');
        await until(() => states.at(-1) === 'live');
        stop();
        expect(states.at(-1)).toBe('live');
        expect(server.connections.map((c) => c.origin)).toEqual([PRODUCTION]);
    });

    it('the Origin is the configured host’s, not a constant: a dev Genie says its own, and production refuses it', async () => {
        const dev = await reverb(['https://tynn.gen']);
        const onDev = harness({ config: dev.config(), socket: (url) => dialTynnSocket(url, 'https://tynn.gen/') });
        onDev.client.start();
        await until(() => onDev.client.state().kind === 'live');
        expect(onDev.client.state()).toEqual({ kind: 'live' });
        expect(dev.connections.map((c) => c.origin)).toEqual(['https://tynn.gen']);

        const production = await reverb();
        const offProduction = harness({ config: production.config(), socket: (url) => dialTynnSocket(url, 'https://tynn.gen') });
        offProduction.client.start();
        await until(() => offProduction.client.state().kind === 'reconnecting');
        expect(offProduction.client.state()).toMatchObject({ kind: 'reconnecting', reason: expect.stringContaining('Origin not allowed') });
    });

    it('a socket production refuses is not left waiting: it is closed, says why, and tries again', async () => {
        const server = await reverb();
        // No Origin, the way Genie used to dial.
        const h = harness({ config: server.config(), socket: (url) => new WebSocket(url) as unknown as SocketLike });
        h.client.start();
        await until(() => h.client.state().kind !== 'connecting');
        expect(h.client.state()).toMatchObject({ kind: 'reconnecting', reason: expect.stringMatching(/Origin not allowed.*4009/) });
        expect(await until(() => server.connections[0]?.closeAsked === true)).toBe(true);
        expect(liveTimers(h).map((t) => t.ms)).toEqual([RECONNECT_MS]);
    });

    it('the Tynn sockets dial through dialTynnSocket (COUNTED), with the account’s host: genie-host’s, and the window’s only on the emergency no-host path (P5c)', async () => {
        const host = await readFile(resolve('src/main/genie-host.ts'), 'utf8');
        expect(host.match(/dialTynnSocket\(url, hostTynn\?\.host\(\) \?\? TYNN_HOST\)/g)).toHaveLength(1);
        // IssueWatch, the board, and the Issues queue: each uses the same origin-confined dialer.
        expect(host.match(/socket: tynnSocket,/g)).toHaveLength(3);
        const issuesHub = host.match(/const tynnIssues = new TynnBoardHub\(\{([\s\S]*?)\n    \}\);/)?.[1];
        expect(issuesHub).toContain('socket: tynnSocket,');
        expect(issuesHub).toContain('feed: TYNN_ISSUES_FEED,');
        const emergency = await readFile(resolve('src/main/issue-watch-emergency.ts'), 'utf8');
        expect(emergency.match(/dialTynnSocket\(url, p\.account\(\)\?\.host\(\) \?\? TYNN_HOST\)/g)).toHaveLength(1);
        const main = await readFile(resolve('src/main/main.ts'), 'utf8');
        expect(main).not.toMatch(/dialTynnSocket/);
        for (const file of [host, emergency, main]) expect(file).not.toMatch(/new WebSocket\(url\) as unknown as SocketLike/);
    });
});

describe('Electron’s own WebSocket', () => {
    /*
     * main's WebSocket is the undici inside Electron, not node_modules/undici and not the Node running this suite, and it
     * takes the header through a non-standard constructor argument. A runtime that dropped it would say nothing. So the
     * probe the VM runs by hand runs here too, under the binary, and an Electron upgrade that loses it fails here.
     */
    it('puts the Origin on the wire (scripts/perf-lag/reverb-origin-probe.mjs --local, under ELECTRON_RUN_AS_NODE)', async () => {
        const electron = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron');
        const out = await new Promise<{ code: number | null; stdout: string }>((done, fail) => {
            const p = spawn(electron, ['scripts/perf-lag/reverb-origin-probe.mjs', '--local'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
            let stdout = '';
            p.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
            p.on('error', fail);
            p.on('exit', (code) => { done({ code, stdout }); });
        });
        const result = JSON.parse(out.stdout.trim().split('\n').at(-1)!) as { pass: boolean; runtime: { electron: string | null }; checks: Array<{ name: string; pass: boolean }> };
        // Said in the failure: which check, and what the wire held.
        expect(out.stdout, out.stdout).toContain(`wire: ${PRODUCTION}`);
        expect(result.runtime.electron).toMatch(/^\d+\./);
        expect(result.checks.filter((c) => !c.pass)).toEqual([]);
        expect(result.checks).toHaveLength(3);
        expect(out.code).toBe(0);
    }, 60_000);
});

describe('pusher:error is a failure with its reason', () => {
    it('the socket is closed and it tries again, without waiting for a close that may never come', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(REFUSAL);
        await settle();
        expect(f.sockets[0]!.closed).toBe(true);
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringMatching(/Origin not allowed.*4009/) });
        expect(liveTimers(h)).toHaveLength(1);
        // A close that does arrive, late, is the same failure: it schedules nothing more.
        f.sockets[0]!.drop();
        expect(liveTimers(h)).toHaveLength(1);
    });

    it('a failure that keeps happening backs off, capped; live starts the pause over (COUNTED)', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        const pauses: number[] = [];
        for (let i = 0; i < 8; i += 1) {
            f.sockets[i]!.emit(REFUSAL);
            await settle();
            const retry = liveTimers(h).at(-1)!;
            pauses.push(retry.ms);
            retry.cancelled = true;
            retry.fn();
            await settle();
        }
        expect(pauses).toEqual([RECONNECT_MS, 10_000, 20_000, 40_000, 80_000, 160_000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);

        const last = f.sockets.at(-1)!;
        last.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
        await settle();
        last.emit({ event: 'pusher_internal:subscription_succeeded', channel: CHANNEL, data: '{}' });
        await settle();
        expect(h.client.state()).toEqual({ kind: 'live' });
        last.drop();
        expect(h.client.state()).toEqual({ kind: 'reconnecting' });
        expect(liveTimers(h).at(-1)!.ms).toBe(RECONNECT_MS);
    });

    it('the reason stays said while it dials again, so an agent asking in between still hears it', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(REFUSAL);
        await settle();
        liveTimers(h).at(-1)!.fn();
        await settle();
        expect(h.client.state()).toEqual({ kind: 'connecting', reason: expect.stringContaining('Origin not allowed') });
    });

    it('a server’s words are capped before they reach an agent', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        f.sockets[0]!.emit({ event: 'pusher:error', data: { code: 4009, message: 'x'.repeat(5_000) } });
        await settle();
        const state = h.client.state() as { reason: string };
        expect(state.reason.length).toBeLessThan(400);
    });
});

describe('a deadline for connection_established', () => {
    it('a socket that says nothing fails at the deadline, with a reason, not after the server’s 300 s', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        const deadline = liveTimers(h).find((t) => t.ms === CONNECT_DEADLINE_MS);
        expect(deadline).toBeDefined();
        expect(CONNECT_DEADLINE_MS).toBeLessThan(60_000);
        deadline!.fn();
        await settle();
        expect(f.sockets[0]!.closed).toBe(true);
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringContaining('15 s') });
        expect(liveTimers(h).filter((t) => t.ms === RECONNECT_MS)).toHaveLength(1);
    });

    it('CONTROL: connection_established, a refusal, a drop and a stop each end the deadline', async () => {
        for (const end of [
            (s: FakeSocket) => { s.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) }); },
            (s: FakeSocket) => { s.emit(REFUSAL); },
            (s: FakeSocket) => { s.drop(); },
        ]) {
            const f = fakeSockets();
            const h = harness({ config: CONFIG, socket: f.socket });
            h.client.start();
            await settle();
            expect(liveTimers(h).map((t) => t.ms)).toEqual([CONNECT_DEADLINE_MS]);
            end(f.sockets[0]!);
            await settle();
            expect(liveTimers(h).filter((t) => t.ms === CONNECT_DEADLINE_MS)).toEqual([]);
        }
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        h.client.stop();
        expect(liveTimers(h)).toEqual([]);
    });

    it('a socket that closes before it connected says so, with the runtime’s own words', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        f.sockets[0]!.fail({ message: 'Received network error or non-101 status code.' });
        f.sockets[0]!.drop();
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringContaining('non-101') });
    });

    it('a socket that cannot even be built is a failure with its reason too, not an unhandled rejection', async () => {
        const h = harness({ config: CONFIG, socket: () => { throw new Error('Invalid URL'); } });
        h.client.start();
        await settle();
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringContaining('Invalid URL') });
        expect(liveTimers(h).map((t) => t.ms)).toEqual([RECONNECT_MS]);
    });
});

describe('the reconcile does not wait for the socket', () => {
    const pullsOf = (h: { requests: string[] }) => h.requests.filter((p) => p === '/api/v1/user/issue-watch').length;

    it('at start: the list arrives with the socket still silent', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        expect(h.client.state().kind).toBe('connecting');
        expect(pullsOf(h)).toBe(1);
        expect(h.entries).toEqual([PROJECT]);
        // A boot's first list is the baseline, on whichever road it came.
        expect(h.heard).toEqual([]);
    });

    it('on each failed connect: what changed during the outage is heard, with no socket ever up', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        h.setReconcile({ workspaces: [entry([item('a:issue:1'), item('a:pr:7', 'pr')])] });
        f.sockets[0]!.emit(REFUSAL);
        await settle();
        expect(pullsOf(h)).toBe(2);
        expect(h.heard.map((e) => [e.kind, e.item?.key])).toEqual([['pr.new', 'a:pr:7']]);
    });

    it('when the push config itself fails, the list is still asked for', async () => {
        const h = harness({ config: { broadcaster: 'log' }, socket: () => { throw new Error('not dialled'); } });
        h.client.start();
        await settle();
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: 'Tynn has no push configured' });
        expect(pullsOf(h)).toBe(2);
        expect(h.entries).toEqual([PROJECT, PROJECT]);
    });

    it('CONTROL: signed out, nothing is asked', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket, signedIn: false });
        h.client.start();
        await settle();
        expect(h.requests).toEqual([]);
        expect(h.client.state()).toEqual({ kind: 'signed-out' });
    });

    it('two pulls never overlap: an older answer landing last would read as things closing and reopening (COUNTED)', async () => {
        const f = fakeSockets();
        const releases: Array<(v: unknown) => void> = [];
        let inFlight = 0;
        let most = 0;
        const h = harness({
            config: CONFIG,
            socket: f.socket,
            pull: () => new Promise((r) => {
                inFlight += 1;
                most = Math.max(most, inFlight);
                releases.push((v) => { inFlight -= 1; r(v); });
            }),
        });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(REFUSAL);
        await settle();
        expect(releases).toHaveLength(1);
        releases[0]!({ workspaces: [entry([item('a:issue:1')])] });
        await settle();
        // The pull asked for meanwhile runs after, so it reads what is true now.
        expect(releases).toHaveLength(2);
        releases[1]!({ workspaces: [entry([item('a:issue:1')])] });
        await settle();
        expect(most).toBe(1);
        expect(h.heard).toEqual([]);
    });

    it('a pull still out when it stops is dropped, and the one asked for after it never goes: signing out does not bring the list back', async () => {
        const f = fakeSockets();
        let release: (v: unknown) => void = () => {};
        const h = harness({ config: CONFIG, socket: f.socket, pull: () => new Promise((r) => { release = r; }) });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(REFUSAL);
        await settle();
        h.client.stop();
        release({ workspaces: [entry([item('a:issue:1')])] });
        await settle();
        expect(h.entries).toEqual([]);
        expect(pullsOf(h)).toBe(1);
    });

    it('a restart while the push config is out dials once: the older dial goes no further (COUNTED)', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        h.client.stop();
        h.client.start();
        await settle();
        expect(f.sockets).toHaveLength(1);
        expect(liveTimers(h).map((t) => t.ms)).toEqual([CONNECT_DEADLINE_MS]);
        // Connected, the one connect deadline it has is gone: nothing can come along later and close a healthy socket.
        f.sockets[0]!.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) });
        await settle();
        expect(liveTimers(h).filter((t) => t.ms === CONNECT_DEADLINE_MS)).toEqual([]);
    });
});

describe('IssueWatch: a subscribe refused or unanswered is a failure with its reason', () => {
    const ESTABLISHED = { event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) };
    const SUBSCRIBED = { event: 'pusher_internal:subscription_succeeded', channel: CHANNEL, data: '{}' };

    it('real wire: pusher:subscription_error closes it, says why, backs off, and the reason reaches issueWatchWhyNot', async () => {
        const server = await reverb([PRODUCTION], 'subscription-error');
        const h = harness({ config: server.config(), socket: (url) => dialTynnSocket(url, PRODUCTION) });
        h.client.start();
        await until(() => h.client.state().kind === 'reconnecting');
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringMatching(/refused the channel.*The signature is not valid.*401/) });
        expect(await until(() => server.connections[0]?.closeAsked === true)).toBe(true);
        expect(liveTimers(h).map((t) => t.ms)).toEqual([RECONNECT_MS]);
        const state = h.client.state() as { kind: 'reconnecting'; reason: string };
        expect(issueWatchWhyNot({ state: state.kind, linked: true, reason: state.reason })).toContain('The signature is not valid');
    });

    it('real wire: a connection-level refusal after the subscribe is the same failure', async () => {
        const server = await reverb([PRODUCTION], 'pusher-error');
        const h = harness({ config: server.config(), socket: (url) => dialTynnSocket(url, PRODUCTION) });
        h.client.start();
        await until(() => h.client.state().kind === 'reconnecting');
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringMatching(/Connection is unauthorized.*4009/) });
    });

    it('real wire: a subscribe nobody answers fails at its deadline, not never', async () => {
        const server = await reverb([PRODUCTION], 'silent');
        const h = harness({ config: server.config(), socket: (url) => dialTynnSocket(url, PRODUCTION) });
        h.client.start();
        await until(() => server.connections[0]?.received.length === 1);
        expect(h.client.state().kind).toBe('connecting');
        const deadline = liveTimers(h).find((t) => t.ms === SUBSCRIBE_DEADLINE_MS);
        expect(deadline).toBeDefined();
        deadline!.fn();
        expect(h.client.state()).toEqual({ kind: 'reconnecting', reason: expect.stringContaining('30 s') });
        expect(liveTimers(h).map((t) => t.ms)).toEqual([RECONNECT_MS]);
    });

    it('a signature that never comes back is covered by the same deadline', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket, authHangs: true });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(ESTABLISHED);
        await settle();
        liveTimers(h).find((t) => t.ms === SUBSCRIBE_DEADLINE_MS)!.fn();
        expect(f.sockets[0]!.closed).toBe(true);
        expect(h.client.state()).toMatchObject({ kind: 'reconnecting' });
    });

    it('the signature’s 404 is Tynn’s word for signed out: it says so, keeps the credential, closes and tries again', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket, authStatus: 404 });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(ESTABLISHED);
        await settle();
        expect(f.sockets[0]!.closed).toBe(true);
        const state = h.client.state() as { kind: string; reason: string };
        // Still trying: a passing 404 heals itself (main/tynn-account.ts decides the sign-in, on /me).
        expect(state.kind).toBe('reconnecting');
        expect(state.reason).toMatch(/not signed in to Tynn/);
        expect(state.reason).toMatch(/404/);
        expect(state.reason).toMatch(/sign-in is kept/);
        expect(liveTimers(h).map((t) => t.ms)).toEqual([RECONNECT_MS]);
    });

    it('CONTROL: subscribed ends the deadline; a refusal on another channel is not this one’s', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        f.sockets[0]!.emit(ESTABLISHED);
        await settle();
        expect(liveTimers(h).map((t) => t.ms)).toEqual([SUBSCRIBE_DEADLINE_MS]);
        f.sockets[0]!.emit({ event: 'pusher:subscription_error', channel: 'private-someone-else', data: '{}' });
        await settle();
        expect(f.sockets[0]!.closed).toBe(false);
        f.sockets[0]!.emit(SUBSCRIBED);
        await settle();
        expect(h.client.state()).toEqual({ kind: 'live' });
        expect(liveTimers(h)).toEqual([]);
    });

    it('a refused subscribe backs off like a refused connect, and live starts it over', async () => {
        const f = fakeSockets();
        const h = harness({ config: CONFIG, socket: f.socket });
        h.client.start();
        await settle();
        const pauses: number[] = [];
        for (let i = 0; i < 3; i += 1) {
            f.sockets[i]!.emit(ESTABLISHED);
            await settle();
            f.sockets[i]!.emit({ event: 'pusher:subscription_error', channel: CHANNEL, data: JSON.stringify({ error: 'nope', status: 403 }) });
            await settle();
            const retry = liveTimers(h).at(-1)!;
            pauses.push(retry.ms);
            retry.cancelled = true;
            retry.fn();
            await settle();
        }
        expect(pauses).toEqual([RECONNECT_MS, 10_000, 20_000]);
        f.sockets[3]!.emit(ESTABLISHED);
        await settle();
        f.sockets[3]!.emit(SUBSCRIBED);
        await settle();
        f.sockets[3]!.drop();
        expect(liveTimers(h).at(-1)!.ms).toBe(RECONNECT_MS);
    });
});

describe('the live board does not hang either', () => {
    const P1 = '01JPROJECTONE';
    const P2 = '01JPROJECTTWO';
    const channel = (p: string) => `private-project-board.${p}`;
    const ESTABLISHED = { event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2' }) };
    const SUBSCRIBED = (p: string) => ({ event: 'pusher_internal:subscription_succeeded', channel: channel(p), data: '{}' });

    function board(opts: { socket: IssueWatchClientPorts['socket']; config?: unknown; authHangs?: boolean }) {
        const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
        const states = new Map<string, string>();
        const failures: string[] = [];
        const live = new TynnBoardLive({
            tynn: () => ({
                request: async (path) => {
                    if (path !== '/api/v1/broadcasting-config' && opts.authHangs === true) await new Promise(() => {});
                    return { ok: true, status: 200, json: async () => (path === '/api/v1/broadcasting-config' ? opts.config ?? CONFIG : { auth: 'rk:sig' }) };
                },
            }),
            socket: opts.socket,
            schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
            onRing: () => {},
            onState: (projectId, state) => { states.set(projectId, state); },
            onFailure: (reason) => { failures.push(reason); },
        });
        return { live, timers, states, failures };
    }

    it('pusher:error closes it, is logged with its reason, and retries with a growing pause, without waiting for a close', async () => {
        const f = fakeSockets();
        const b = board({ socket: f.socket });
        const stop = b.live.watch(P1);
        await settle();
        f.sockets[0]!.emit(REFUSAL);
        await settle();
        expect(f.sockets[0]!.closed).toBe(true);
        expect(b.states.get(P1)).toBe('reconnecting');
        expect(b.failures).toEqual([expect.stringMatching(/Origin not allowed.*4009/)]);
        const first = liveTimers(b);
        expect(first.map((t) => t.ms)).toEqual([1_000]);
        // A close that does arrive, late, is the same failure.
        f.sockets[0]!.drop();
        expect(liveTimers(b)).toHaveLength(1);
        first[0]!.cancelled = true;
        first[0]!.fn();
        await settle();
        f.sockets[1]!.emit(REFUSAL);
        await settle();
        expect(liveTimers(b).at(-1)!.ms).toBe(2_000);
        stop();
    });

    it('a socket that says nothing fails at the connect deadline and retries', async () => {
        const f = fakeSockets();
        const b = board({ socket: f.socket });
        const stop = b.live.watch(P1);
        await settle();
        liveTimers(b).find((t) => t.ms === CONNECT_DEADLINE_MS)!.fn();
        expect(f.sockets[0]!.closed).toBe(true);
        expect(b.states.get(P1)).toBe('reconnecting');
        expect(b.failures).toEqual([expect.stringContaining('15 s')]);
        expect(liveTimers(b).map((t) => t.ms)).toEqual([1_000]);
        stop();
    });

    it('a subscribe nobody answers, or a signature that never comes back, fails at the subscribe deadline and retries', async () => {
        for (const authHangs of [false, true]) {
            const f = fakeSockets();
            const b = board({ socket: f.socket, authHangs });
            const stop = b.live.watch(P1);
            await settle();
            f.sockets[0]!.emit(ESTABLISHED);
            await settle();
            liveTimers(b).find((t) => t.ms === SUBSCRIBE_DEADLINE_MS)!.fn();
            expect(f.sockets[0]!.closed).toBe(true);
            expect(b.states.get(P1)).toBe('reconnecting');
            expect(liveTimers(b).map((t) => t.ms)).toEqual([1_000]);
            stop();
        }
    });

    it('a board refused its channel is off and not retried; its deadline is gone, and the other board’s socket stays up', async () => {
        const f = fakeSockets();
        const b = board({ socket: f.socket });
        b.live.watch(P1);
        const stop = b.live.watch(P2);
        await settle();
        f.sockets[0]!.emit(ESTABLISHED);
        await settle();
        f.sockets[0]!.emit(SUBSCRIBED(P2));
        f.sockets[0]!.emit({ event: 'pusher:subscription_error', channel: channel(P1), data: JSON.stringify({ error: 'nope', status: 403 }) });
        await settle();
        expect(b.states.get(P1)).toBe('off');
        expect(b.states.get(P2)).toBe('live');
        expect(b.failures).toEqual([expect.stringContaining('nope')]);
        expect(f.sockets[0]!.closed).toBe(false);
        expect(liveTimers(b)).toEqual([]);
        stop();
    });

    it('closing a board whose subscribe is out takes its deadline with it: it cannot close the socket under the other board', async () => {
        const f = fakeSockets();
        const b = board({ socket: f.socket });
        const stop1 = b.live.watch(P1);
        const stop2 = b.live.watch(P2);
        await settle();
        f.sockets[0]!.emit(ESTABLISHED);
        await settle();
        f.sockets[0]!.emit(SUBSCRIBED(P2));
        await settle();
        expect(liveTimers(b).map((t) => t.ms)).toEqual([SUBSCRIBE_DEADLINE_MS]);
        stop1();
        expect(liveTimers(b)).toEqual([]);
        expect(f.sockets[0]!.closed).toBe(false);
        stop2();
    });

    it('one board that never answers keeps growing the pause: another going live does not reset it (COUNTED)', async () => {
        const f = fakeSockets();
        const b = board({ socket: f.socket });
        b.live.watch(P1);
        const stop = b.live.watch(P2);
        await settle();
        const pauses: number[] = [];
        for (let i = 0; i < 3; i += 1) {
            f.sockets[i]!.emit(ESTABLISHED);
            await settle();
            f.sockets[i]!.emit(SUBSCRIBED(P2));
            await settle();
            liveTimers(b).find((t) => t.ms === SUBSCRIBE_DEADLINE_MS)!.fn();
            const retry = liveTimers(b).at(-1)!;
            pauses.push(retry.ms);
            retry.cancelled = true;
            retry.fn();
            await settle();
        }
        expect(pauses).toEqual([1_000, 2_000, 4_000]);
        // Every board answered: the pause starts over.
        f.sockets[3]!.emit(ESTABLISHED);
        await settle();
        f.sockets[3]!.emit(SUBSCRIBED(P1));
        f.sockets[3]!.emit(SUBSCRIBED(P2));
        await settle();
        f.sockets[3]!.drop();
        expect(liveTimers(b).at(-1)!.ms).toBe(1_000);
        stop();
    });

    it('a socket that cannot be built retries with its reason, not an unhandled rejection', async () => {
        const b = board({ socket: () => { throw new Error('Invalid URL'); } });
        const stop = b.live.watch(P1);
        await settle();
        expect(b.states.get(P1)).toBe('reconnecting');
        expect(b.failures).toEqual([expect.stringContaining('Invalid URL')]);
        expect(liveTimers(b).map((t) => t.ms)).toEqual([1_000]);
        stop();
    });

    it('real wire: a Reverb that refuses the socket does not leave the board connecting', async () => {
        const server = await reverb();
        const b = board({ socket: (url) => new WebSocket(url) as unknown as SocketLike, config: server.config() });
        const stop = b.live.watch(P1);
        await until(() => b.states.get(P1) === 'reconnecting');
        expect(b.states.get(P1)).toBe('reconnecting');
        expect(await until(() => server.connections[0]?.closeAsked === true)).toBe(true);
        stop();
    });

    it('real wire: a subscribe nobody answers does not leave the board connecting', async () => {
        const server = await reverb([PRODUCTION], 'silent');
        const b = board({ socket: (url) => dialTynnSocket(url, PRODUCTION), config: server.config() });
        const stop = b.live.watch(P1);
        await until(() => server.connections[0]?.received.length === 1);
        liveTimers(b).find((t) => t.ms === SUBSCRIBE_DEADLINE_MS)!.fn();
        expect(b.states.get(P1)).toBe('reconnecting');
        stop();
    });
});

describe('the reason reaches whoever asks', () => {
    const REASON = 'Tynn’s socket server refused the connection: Origin not allowed (4009)';
    const ENTRY = parseIssueWatchEntry(entry([item('a:issue:1')]))!;

    it('issueWatchWhyNot says it instead of "not connected yet"; CONTROL: no reason, the old words', () => {
        expect(issueWatchWhyNot({ state: 'reconnecting', linked: true, reason: REASON })).toBe(`IssueWatch is not connected to Tynn: ${REASON}`);
        expect(issueWatchWhyNot({ state: 'connecting', linked: true })).toBe('IssueWatch is not connected to Tynn yet');
    });

    it('the panel says it, whether or not it has a list to show', () => {
        expect(issueWatchPanelView({ state: 'reconnecting', linked: true, reason: REASON }, []).line).toEqual({ tone: 'warn', text: `IssueWatch is not connected to Tynn: ${REASON}` });
        expect(issueWatchPanelView({ state: 'reconnecting', linked: true, reason: REASON, entry: ENTRY }, []).line).toEqual({ tone: 'warn', text: `Not connected to Tynn (${REASON}) — showing what it last sent` });
        expect(issueWatchPanelView({ state: 'reconnecting', linked: true, entry: ENTRY }, []).line).toEqual({ tone: 'warn', text: 'Reconnecting to Tynn — showing what it last sent' });
    });

    describe('the tools', () => {
        let dirs: string[] = [];
        afterEach(async () => {
            for (const dir of dirs) await rm(dir, { recursive: true, force: true });
            dirs = [];
        });
        const call = async (summary: IssueWatchSummary, name: string) => {
            const dir = await mkdtemp(join(tmpdir(), 'genie2-iw-origin-'));
            dirs.push(dir);
            const inbox = await InboxStore.open(dir);
            const attention = await AttentionStore.open(dir, inbox);
            const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
            const caller: Caller = { agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
            const tools = genieTools({
                inbox, attention, roster: () => [atlas], resolveCaller: () => caller,
                workspaceSetting: () => ({ scope: 'self' }), userActive: () => true, glow: () => true, thumbsUp: () => {},
                issueWatch: { forWorkspace: () => summary },
            });
            return JSON.parse((await tools.find((x) => x.definition.name === name)!.handler({ terminalId: 't', handoff: 'done' }, { server: 'genie', tool: name, headers: {} })).text) as Record<string, unknown>;
        };

        it('with no list, checkIssues and imDone say the reason', async () => {
            const down: IssueWatchSummary = { state: 'reconnecting', linked: true, reason: REASON };
            expect((await call(down, 'checkIssues')).reason).toBe(`IssueWatch is not connected to Tynn: ${REASON}`);
            expect((await call(down, 'imDone')).issueWatch).toBe(`not connected to Tynn: ${REASON}`);
        });

        it('a push outage no longer blanks them: the reconciled list and counts are there, and checkIssues says it is not live', async () => {
            const up: IssueWatchSummary = { state: 'reconnecting', linked: true, reason: REASON, entry: ENTRY };
            expect((await call(up, 'imDone')).issueWatch).toBe('issues:1, PR:0, sec:0');
            const checked = await call(up, 'checkIssues');
            expect(checked.ok).toBe(true);
            expect(checked.counts).toEqual({ issues: 1, prs: 0, security: 0, feedback: 0 });
            expect(checked.notLive).toBe(REASON);
        });

        it('notLive is there whenever it is not live, reason or none, so its absence means live', async () => {
            expect((await call({ state: 'connecting', linked: true, entry: ENTRY }, 'checkIssues')).notLive).toBe('IssueWatch is connecting');
            expect((await call({ state: 'reconnecting', linked: true, entry: ENTRY }, 'checkIssues')).notLive).toBe('IssueWatch is reconnecting');
        });

        it('CONTROL: live, checkIssues has no notLive', async () => {
            expect(await call({ state: 'live', linked: true, entry: ENTRY }, 'checkIssues')).not.toHaveProperty('notLive');
        });
    });
});
