import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { tynnProjectIdOf } from '../src/core/issue-watch.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { TynnWatchEvent } from '../src/core/local-tynn-watch.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { wireHostMailWake } from '../src/main/host-mail-wake.js';
import { HOST_LOCAL_OWNER, hostTynnWatch } from '../src/main/host-local-watches.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { InboxStore } from '../src/main/inbox-store.js';
import type { SocketLike } from '../src/main/issue-watch-client.js';
import { IssueWatchService, TynnBoardHub, type HostTynn } from '../src/main/issue-watch-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { Store } from '../src/main/store.js';

/**
 * P5c: ISSUEWATCH AND THE LIVE BOARD IN GENIE-HOST. They were built in the window's main: with no window nobody listened to
 * Tynn, a GitHub change waited for the next window, and no agent was told. The host holds the Tynn account (P3.4), the
 * agents and the inbox wake (P3.2), so it listens: IssueWatch's notices reach the linked workspace's agents through the
 * host's ONE wake, the sounds are tool signals an open window plays, and the board is followed per view, one socket for
 * every board. Since Tynn #934 task #1474 none of it rides the engine link: genie-host's own tools (checkIssues, imDone's
 * count line) read its IssueWatch directly, its feature machine holds the panel, and the board's views are its own owner's
 * (the Tynn tab's `tynn.watch`; who may watch and a closing connection's release are pinned in p4-family12-tynn.test.ts).
 *
 * Tynn here is a fake: its routes answer as tynn.ai's do, and its sockets are recorded so a test pushes a frame on them.
 */

const TOKEN = 'p5c-token';
const PROJECT = 'proj_1';
const USER_CHANNEL = 'private-App.Models.User.42';
const BOARD_CHANNEL = `private-project-board.${PROJECT}`;
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const item = (key: string, kind = 'issue') => ({ kind, key, number: 7, title: 'Make it faster', url: `https://github.com/acme/app/${kind}/7`, createdAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z', owner: 'acme', repo: 'app' });
const entry = (items: unknown[]) => ({ workspaceId: PROJECT, projectId: PROJECT, counts: {}, items, feedbackItems: [], tracking: {} });

type FakeSocket = SocketLike & { url: string; sent: string[]; closed: boolean; emit(frame: unknown): void };

/** A fake Tynn the host is signed in to: its routes, and every socket dialled to it. */
function fakeTynn(opts: { authStatus?: number } = {}) {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const sockets: FakeSocket[] = [];
    const reconcile = { workspaces: [entry([item('acme/app:issue:1')])] };
    const account: HostTynn = {
        userId: () => '42',
        request: async (path, init) => {
            requests.push({ method: init.method, path, body: init.body ?? null });
            const status = path === '/api/v1/user/broadcasting-auth' ? (opts.authStatus ?? 200) : 200;
            const json = path === '/api/v1/broadcasting-config' ? { key: 'pk_test', cluster: 'us2' }
                : path.endsWith('/broadcasting-auth') ? { auth: 'pk_test:sig' }
                : path === '/api/v1/user/issue-watch/refresh' ? { refreshed: true, reason: 'refreshed', workspace: entry([item('acme/app:issue:1')]) }
                : path.endsWith('/repositories') ? { entitled: true, repositories: [{ owner: 'acme', repo: 'app', enabled: true }] }
                : reconcile;
            return { ok: status < 300, status, json: async () => json };
        },
    };
    const socket = (url: string): FakeSocket => {
        const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
        const s: FakeSocket = {
            url, sent: [], closed: false,
            send: (data) => { s.sent.push(data); },
            close: () => { if (s.closed) return; s.closed = true; for (const l of listeners.close ?? []) l({}); },
            addEventListener: (type, l) => { (listeners[type] ??= []).push(l); },
            emit: (frame) => { for (const l of listeners.message ?? []) l({ data: JSON.stringify(frame) }); },
        };
        sockets.push(s);
        return s;
    };
    const established = (s: FakeSocket) => s.emit({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '123.456' }) });
    /** IssueWatch's socket up and subscribed to the person's channel. */
    const live = async (s: FakeSocket) => {
        established(s);
        await settle();
        s.emit({ event: 'pusher_internal:subscription_succeeded', channel: USER_CHANNEL, data: '{}' });
        await settle();
    };
    /** Tynn pushes a project's entry: a new pull request beside the issue the baseline had. */
    const pushNewPr = (s: FakeSocket) => s.emit({ event: 'issuewatch.delta', channel: USER_CHANNEL, data: JSON.stringify(entry([item('acme/app:issue:1'), item('acme/app:pr:2', 'pr')])) });
    return { account, requests, sockets, socket, established, live, pushNewPr };
}

const schedule = () => () => {};

interface Fake { prompts: string[]; events: DriverEvents }
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        const fake: Fake = { prompts: [], events: options.events };
        fakes.set(record.id, fake);
        return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(typeof content === 'string' ? content : JSON.stringify(content)); }, kill: () => {}, cliSessionId: null };
    };
    return factory;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); fakes.clear(); });

/** A workspace linked to the Tynn project (its project.json), or one that is not. */
async function workspaceDir(linked: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'p5c-ws-'));
    await writeFile(join(dir, 'project.json'), JSON.stringify(linked ? { name: 'Acme', tynn: { projectId: PROJECT } } : { name: 'Loose' }));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
const projectOfDir = (dir: string | undefined): string | null => {
    if (dir === undefined) return null;
    try { return tynnProjectIdOf(readFileSync(join(dir, 'project.json'), 'utf8')); } catch { return null; }
};

/**
 * genie-host's parts, as genie-host.ts builds them, with NO window: the registry, the inbox, the sessions, the mail wake
 * with IssueWatch's queue as its second source, and the IssueWatch service on the host's Tynn account.
 */
async function hostRig(options: { authStatus?: number; safeMode?: () => boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'p5c-host-'));
    const acme = await workspaceDir(true);
    const loose = await workspaceDir(false);
    const store = new Store(dir);
    const make = (name: string, workspaceId: string, setting: AgentRecord['issueWatch']): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId, provider: 'claude', name }), ...(setting ? { issueWatch: setting } : {}) });
    const pusher = make('pusher', 'acme', { delivery: 'push', kinds: ['pr.new'] });
    const waiter = make('waiter', 'acme', { delivery: 'next-turn', kinds: ['pr.new'] });
    const outsider = make('outsider', 'loose', { delivery: 'push', kinds: ['pr.new'] });
    await store.writeWorkspaces([{ id: 'acme', path: acme }, { id: 'loose', path: loose }]);
    await store.writeAgents([pusher, waiter, outsider]);
    const registry = new HostRegistry(store);
    await registry.refresh();
    const inbox = await InboxStore.open(dir);
    const settings = await SettingsStore.open(dir);
    const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    const tynn = fakeTynn(options.authStatus === undefined ? {} : { authStatus: options.authStatus });
    const projectFor = (workspaceId: string) => projectOfDir(registry.workspace(workspaceId)?.path);
    const issueWatch = new IssueWatchService({
        tynn: () => tynn.account,
        socket: tynn.socket,
        schedule,
        projectFor,
        delivery: {
            agents: () => registry.listAgents(),
            defaultAgentOf: (workspaceId) => registry.defaultAgentOf(workspaceId),
            workspaceFor: (projectId) => {
                const w = registry.listWorkspaces().find((x) => projectOfDir(x.path) === projectId);
                return w ? { id: w.id, name: w.id === 'acme' ? 'Acme' : w.id } : null;
            },
        },
    });
    const log: string[] = [];
    const off = wireHostMailWake({ inbox, host, registry, settings, osaDir: dir, log: (l) => log.push(l), issueWatch: issueWatch.delivery, ...(options.safeMode ? { safeMode: options.safeMode } : {}) });
    cleanups.push(async () => { issueWatch.stop(); off(); host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
    return { host, registry, tynn, issueWatch, pusher, waiter, outsider, log, projectFor };
}

const notice = /IssueWatch — GitHub changed in Acme:[\s\S]*acme\/app/;

describe('with no window, a GitHub change reaches the linked workspace’s agents through the host’s one wake', () => {
    it('a stopped `push` agent is started for it and told (CONTROL: not running before the delta)', async () => {
        const r = await hostRig();
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        expect(r.host.probe(r.pusher.id as AgentId)).toBeNull();
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        expect(r.host.probe(r.pusher.id as AgentId)?.running).toBe(true);
        expect(fakes.get(r.pusher.id)?.prompts.join('\n') ?? '').toMatch(notice);
    });

    it('SAFE MODE (Tynn #386): the same delta wakes nobody — the `push` agent stays stopped (the CONTROL is the test above)', async () => {
        const r = await hostRig({ safeMode: () => true });
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        expect(r.host.probe(r.pusher.id as AgentId)).toBeNull();
        expect(r.log.join('\n')).toMatch(/safe mode/i);
    });

    it('a `next-turn` agent is NOT woken by it, and is told when it next runs', async () => {
        const r = await hostRig();
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        // CONTROL in the same run: the `push` agent beside it WAS woken by the same delta.
        expect(r.host.probe(r.pusher.id as AgentId)?.running).toBe(true);
        expect(r.host.probe(r.waiter.id as AgentId)).toBeNull();
        expect(r.host.start(r.waiter, process.cwd())).toEqual({ ok: true });
        await settle(40);
        expect(fakes.get(r.waiter.id)?.prompts.join('\n') ?? '').toMatch(notice);
    });

    it('an agent of a workspace NOT linked to the project hears nothing', async () => {
        const r = await hostRig();
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        expect(r.host.probe(r.pusher.id as AgentId)?.running).toBe(true);
        expect(r.host.probe(r.outsider.id as AgentId)).toBeNull();
    });

    it('the account changing (signed in or out, another Tynn) starts it over: the old socket closed, a new one dialled', async () => {
        const r = await hostRig();
        r.issueWatch.start();
        await settle();
        expect(r.tynn.sockets).toHaveLength(1);
        r.issueWatch.restart();
        await settle();
        expect(r.tynn.sockets[0]!.closed).toBe(true);
        expect(r.tynn.sockets).toHaveLength(2);
        expect(r.tynn.sockets[1]!.closed).toBe(false);
    });

    it('Tynn’s 404 when asked to sign the channel is read as signed out, the sign-in kept, and it tries again', async () => {
        const r = await hostRig({ authStatus: 404 });
        r.issueWatch.start();
        await settle();
        r.tynn.established(r.tynn.sockets[0]!);
        await settle();
        expect(r.issueWatch.dump()).toMatchObject({ state: 'reconnecting', reason: expect.stringMatching(/answered 404[\s\S]*sign-in is kept/) });
    });
});

/** A window linked over the real engine protocol, hearing genie-host's tool signals as main does (its IssueWatch sounds). */
async function windowOn(server: SessionEngineServer) {
    const { readIssueWatchSound } = await import('../src/core/issue-watch-signal.js');
    const [h, raw] = memoryPair();
    server.accept(h, { local: true });
    const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
    const sounds: string[] = [];
    const signals: unknown[] = [];
    const client = new SessionEngineClient({ onToolSignal: (signal) => { signals.push(signal); const sound = readIssueWatchSound(signal); if (sound) sounds.push(sound); } });
    expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
    return { client, sounds, signals, close: () => t.close() };
}

/** genie-host's IssueWatch as its tools and its windows get it (Tynn #934 task #1474): the tools' port, and the sound signal. */
async function serverRig() {
    const r = await hostRig();
    const { hostIssueWatchTools, sayIssueWatchSounds } = await import('../src/main/issue-watch-tools.js');
    const server = new SessionEngineServer({ token: TOKEN, build: 't' });
    server.attach(new SessionHost({ userData: await mkdtemp(join(tmpdir(), 'p5c-sh-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const rechecks: number[] = [];
    const tools = hostIssueWatchTools({ issueWatch: r.issueWatch, projectFor: r.projectFor, recheckSignIn: () => { rechecks.push(1); } });
    sayIssueWatchSounds(r.issueWatch, (signal) => { server.callback({ name: 'toolSignal', signal }); });
    return { ...r, server, tools, rechecks };
}

describe('genie-host’s tools read its IssueWatch directly, and ask it by call (Tynn #934 task #1474)', () => {
    it('the summary for a workspace is the host’s own state, with what Tynn pushed; a workspace linked to no project is said so', async () => {
        const r = await serverRig();
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        expect(r.issueWatch.dump().projects[PROJECT]?.recent.map((e) => e.kind)).toEqual(['pr.new']);
        const acme = r.tools.forWorkspace('acme');
        expect(acme).toMatchObject({ state: 'live', linked: true });
        expect(acme.entry).toEqual(r.issueWatch.dump().projects[PROJECT]?.entry);
        expect(acme.entry?.items.map((i) => i.kind).sort()).toEqual(['issue', 'pr']);
        expect(acme.deliveredAt).toBe(r.issueWatch.dump().projects[PROJECT]?.deliveredAt);
        expect(r.tools.forWorkspace('loose')).toEqual({ state: 'live', linked: false });
    });

    it('a change is read at once: before Tynn pushed, the list is the reconciled one; after, the pushed one', async () => {
        const r = await serverRig();
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        await settle(40);
        const before = r.tools.forWorkspace('acme').entry?.items.map((i) => i.kind) ?? [];
        expect(before).not.toContain('pr');
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        expect(r.tools.forWorkspace('acme').entry?.items.map((i) => i.kind)).toContain('pr');
    });

    it('Refresh is a call the host makes to Tynn; an unlinked workspace is refused in words and Tynn is not asked for it', async () => {
        const r = await serverRig();
        r.issueWatch.start();
        await settle();
        await expect(r.tools.refresh!('acme')).resolves.toMatchObject({ ok: true, refreshed: true });
        const refreshes = () => r.tynn.requests.filter((q) => q.path === '/api/v1/user/issue-watch/refresh');
        expect(refreshes()).toEqual([{ method: 'POST', path: '/api/v1/user/issue-watch/refresh', body: { project_id: PROJECT } }]);
        await expect(r.tools.refresh!('loose')).resolves.toEqual({ ok: false, reason: 'this workspace is not linked to a Tynn project' });
        expect(refreshes()).toHaveLength(1);
    });

    it('the repo switches are the feature machine’s call on the same service, read again into the host’s state', async () => {
        const r = await serverRig();
        r.issueWatch.start();
        await settle();
        await expect(r.issueWatch.call('setRepo', ['acme', 'acme', 'app', { enabled: false }])).resolves.toMatchObject({ ok: true });
        expect(r.tynn.requests).toContainEqual({ method: 'POST', path: `/api/v1/user/issue-watch/${PROJECT}/repositories/acme/app`, body: { enabled: false } });
        await settle();
        expect(r.issueWatch.dump().projects[PROJECT]?.watched).toMatchObject({ state: 'ok', repos: [{ slug: 'acme/app' }] });
        await expect(r.issueWatch.call('setRepo', ['loose', 'acme', 'app', { enabled: false }])).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/not running for this workspace/) });
    });

    it('asking Tynn again about the sign-in is the host’s own account’s, when a tool finds it signed out', async () => {
        const r = await serverRig();
        r.tools.recheckSignIn!();
        expect(r.rechecks).toHaveLength(1);
    });

    it('sounds: an open window is told to play one per kind, as a tool signal; one that links later is told nothing (nothing queued)', async () => {
        const r = await serverRig();
        r.issueWatch.start();
        await settle();
        const open = await windowOn(r.server);
        await r.tynn.live(r.tynn.sockets[0]!);
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        expect(open.sounds).toEqual(['ghpr']);
        expect(open.signals).toEqual([{ kind: 'issuewatch', sound: 'ghpr' }]);
        const later = await windowOn(r.server);
        await settle();
        expect(later.sounds).toEqual([]);
        expect(later.signals).toEqual([]);
        // CONTROL: the change itself is in the host's state; only the sound was not kept.
        expect(r.issueWatch.dump().projects[PROJECT]?.recent.map((e) => e.kind)).toEqual(['pr.new']);
    });

    it('with no window open the host plays nothing and keeps no sound for later', async () => {
        const r = await serverRig();
        r.issueWatch.start();
        await settle();
        await r.tynn.live(r.tynn.sockets[0]!);
        r.tynn.pushNewPr(r.tynn.sockets[0]!);
        await settle(40);
        const first = await windowOn(r.server);
        await settle();
        expect(first.sounds).toEqual([]);
        expect(r.issueWatch.dump().projects[PROJECT]?.recent).toHaveLength(1);
    });
});

/** The board hub as genie-host wires it: its own owner's events to its watch port (host-local-watches.ts), no other's anywhere. */
async function boardRig() {
    const r = await hostRig();
    const boardTynn = fakeTynn();
    const idleTynn = fakeTynn();
    let watches: ReturnType<typeof hostTynnWatch> | null = null;
    const board = new TynnBoardHub({ tynn: () => boardTynn.account, socket: boardTynn.socket, schedule, projectFor: r.projectFor, send: (owner, event) => { if (owner === HOST_LOCAL_OWNER) watches?.deliver('board', event); } });
    const idle = () => new TynnBoardHub({ tynn: () => idleTynn.account, socket: idleTynn.socket, schedule, projectFor: r.projectFor, send: () => {} });
    watches = hostTynnWatch({ hubs: { board, issues: idle(), features: idle() } });
    const heard: TynnWatchEvent[] = [];
    watches.port.subscribe((event) => heard.push(event));
    return { ...r, board, boardTynn, idleTynn, port: watches.port, heard };
}

describe('the live board in the host, followed per view under genie-host’s own owner', () => {
    const boardLive = async (r: Awaited<ReturnType<typeof boardRig>>, s: FakeSocket) => {
        r.boardTynn.established(s);
        await settle();
        s.emit({ event: 'pusher_internal:subscription_succeeded', channel: BOARD_CHANNEL, data: '{}' });
        await settle();
    };

    it('two views of one board share ONE socket; the first unwatch keeps it, the last closes it', async () => {
        const r = await boardRig();
        expect(await r.port.watch('board', 'view-1', 'acme')).toBe(true);
        expect(await r.port.watch('board', 'view-2', 'acme')).toBe(true);
        await settle();
        expect(r.boardTynn.sockets).toHaveLength(1);
        r.port.unwatch('board', 'view-1');
        await settle();
        expect(r.boardTynn.sockets[0]!.closed).toBe(false);
        r.port.unwatch('board', 'view-2');
        await settle();
        expect(r.boardTynn.sockets[0]!.closed).toBe(true);
        expect(r.boardTynn.sockets).toHaveLength(1);
        // The board's watch dialled nothing for the Issues queue or the Features page.
        expect(r.idleTynn.sockets).toEqual([]);
    });

    it('rings and states reach the watch port by kind and workspace', async () => {
        const r = await boardRig();
        expect(await r.port.watch('board', 'view-1', 'acme')).toBe(true);
        await settle();
        await boardLive(r, r.boardTynn.sockets[0]!);
        r.boardTynn.sockets[0]!.emit({ event: 'task.updated', channel: BOARD_CHANNEL, data: JSON.stringify({ id: 'task_9' }) });
        await settle();
        expect(r.heard).toContainEqual({ kind: 'board', workspaceId: 'acme', signal: { state: 'live' } });
        expect(r.heard.some((e) => e.kind === 'board' && 'ring' in (e.signal as object) && (e.signal as { ring: { catchUp: boolean } }).ring.catchUp === false)).toBe(true);
        expect(r.heard.every((e) => e.kind === 'board' && e.workspaceId === 'acme')).toBe(true);
    });

    it('a view under any other owner is told nowhere: no engine link carries a board event. CONTROL: genie-host’s own view beside it is told', async () => {
        const r = await boardRig();
        expect(r.board.watch('a-window-link', 'view-w', 'acme')).toBe(true);
        await settle();
        await boardLive(r, r.boardTynn.sockets[0]!);
        expect(r.heard).toEqual([]);
        expect(await r.port.watch('board', 'view-1', 'acme')).toBe(true);
        await settle();
        expect(r.heard.length).toBeGreaterThan(0);
    });

    it('a workspace not linked to a Tynn project is not followed, and dials nothing', async () => {
        const r = await boardRig();
        expect(await r.port.watch('board', 'view-1', 'loose')).toBe(false);
        await settle();
        expect(r.boardTynn.sockets).toEqual([]);
    });
});

/** A source file's code with its comment lines removed (by line, so a pinned line is never a comment). */
function code(file: string): string {
    return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
}

/** A source file's imports: static (import/export … from, side-effect imports) and dynamic (`import('…')`). */
function importsOf(file: string): { readonly static: string[]; readonly dynamic: string[] } {
    const text = code(file);
    const stat = [...text.matchAll(/(?:^|\n)\s*(?:import\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?|export\s+(?!type\s)(?:\*|\{)[^'";]*?\sfrom\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    const dyn = [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
    return { static: stat, dynamic: dyn };
}

/** Every source file reachable from `entry` (dynamic imports followed only when asked). */
function graph(entry: string, followDynamic: boolean): Set<string> {
    const files = new Set<string>();
    const visit = (file: string): void => {
        const at = resolve(file);
        if (files.has(at)) return;
        files.add(at);
        const found = importsOf(at);
        for (const spec of [...found.static, ...(followDynamic ? found.dynamic : [])]) {
            if (!spec.startsWith('.')) continue;
            const base = resolve(dirname(at), spec).replace(/\.js$/, '');
            const hit = ['.ts', '.tsx'].map((x) => base + x).find((p) => existsSync(p));
            if (hit) visit(hit);
        }
    };
    visit(entry);
    return files;
}

/* THE WINDOW KEEPS NO ISSUEWATCH, BOARD OR PUSHER SOCKET (Tynn #585: no exception left). */
describe('the guard: main builds no IssueWatchClient, IssueWatchDelivery, TynnBoardLive or dialTynnSocket', () => {
    const socketModules = ['issue-watch-client.ts', 'issue-watch-delivery.ts', 'tynn-board-live.ts', 'tynn-socket.ts', 'pusher-link.ts'].map((f) => resolve('src/main', f));

    it('genie-host’s graph reaches every one of them (the control)', () => {
        const host = graph('src/main/genie-host.ts', false);
        for (const m of socketModules) expect(host.has(m), m).toBe(true);
    });

    it('main’s static graph reaches none of them', () => {
        const main = graph('src/main/main.ts', false);
        for (const m of socketModules) expect(main.has(m), m).toBe(false);
    });

    it('main names none of them, and builds no IssueWatch push', () => {
        const main = code('src/main/main.ts');
        for (const name of ['IssueWatchClient', 'IssueWatchDelivery', 'TynnBoardLive', 'dialTynnSocket', 'wireIssueWatchPush', 'issueWatchDelivery']) expect(main, name).not.toContain(name);
    });

    it('genie-host builds the service and the board hub, dials through dialTynnSocket with its account’s host, and gives the queue to its one wake', () => {
        const host = code('src/main/genie-host.ts');
        expect(host.match(/dialTynnSocket\(url, hostTynn\?\.host\(\) \?\? TYNN_HOST\)/g)).toHaveLength(1);
        expect(host).toMatch(/new IssueWatchService\(\{/);
        expect(host).toMatch(/new TynnBoardHub\(\{/);
        expect(host).toMatch(/wireHostMailWake\(\{[^\n]*issueWatch: issueWatch\.delivery/);
        expect(host).toMatch(/account\.onChange\(\(\) => \{ issueWatch\.restart\(\); \}\)/);
        // No second push in the host: IssueWatch's goes through the mail wake's own module.
        expect(host).not.toMatch(/wireInboxPush|wireIssueWatchPush/);
        expect(code('src/main/host-mail-wake.ts')).toMatch(/wireIssueWatchPush\(\{/);
    });
});
