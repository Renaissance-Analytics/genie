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
import { CONNECT_DEADLINE_MS, IssueWatchClient, RECONNECT_MAX_MS, RECONNECT_MS, type IssueWatchClientPorts, type IssueWatchState, type SocketLike } from '../src/main/issue-watch-client.js';
import { genieTools, type Caller } from '../src/main/mcp-tools.js';
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
async function reverb(allowedOrigins: readonly string[] = [PRODUCTION]): Promise<FakeReverb> {
    const s = await startFakeReverb({ allowedOrigins });
    servers.push(s);
    return s;
}

/** A signed-in Tynn over nothing, and a client on it. */
function harness(opts: { config: unknown; socket: IssueWatchClientPorts['socket']; signedIn?: boolean; pull?: (n: number) => Promise<unknown> | unknown }) {
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
                else if (path === '/api/v1/user/broadcasting-auth') json = { auth: 'rk:sig' };
                else if (opts.pull) json = await opts.pull(pulls++);
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

    it('both of main’s Tynn sockets dial through dialTynnSocket (COUNTED), with the account’s host', async () => {
        const main = await readFile(resolve('src/main/main.ts'), 'utf8');
        expect(main.match(/socket: \(url\) => dialTynnSocket\(url, tynnAccount\?\.host\(\) \?\? TYNN_HOST\)/g)).toHaveLength(2);
        expect(main).not.toMatch(/new WebSocket\(url\) as unknown as SocketLike/);
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
        expect(h.entries.length).toBeGreaterThan(0);
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

    it('a pull still out when it stops is dropped: signing out does not bring the list back', async () => {
        const f = fakeSockets();
        let release: (v: unknown) => void = () => {};
        const h = harness({ config: CONFIG, socket: f.socket, pull: () => new Promise((r) => { release = r; }) });
        h.client.start();
        await settle();
        h.client.stop();
        release({ workspaces: [entry([item('a:issue:1')])] });
        await settle();
        expect(h.entries).toEqual([]);
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
        let dir = '';
        afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
        const call = async (summary: IssueWatchSummary, name: string) => {
            dir = await mkdtemp(join(tmpdir(), 'genie2-iw-origin-'));
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

        it('CONTROL: live, checkIssues has no notLive', async () => {
            expect(await call({ state: 'live', linked: true, entry: ENTRY }, 'checkIssues')).not.toHaveProperty('notLive');
        });
    });
});
