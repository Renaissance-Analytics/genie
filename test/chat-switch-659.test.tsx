import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { chatThreadFrom, type MailLike } from '../src/core/chat-view.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore, RUN_FIELD } from '../src/core/thread-store.js';
import { agentDetailFor, type AgentDetailPorts } from '../src/main/agent-detail.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { PATCH_CHUNK_ROWS, SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { AgentDetailCache } from '../src/renderer/agent-detail.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { ChatMessages, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/*
 * TYNN #659 (the owner, 2026-11-12, two screenshots): "I notice it whenever I am switching agent chats. The inbox entries
 * are present already but the actual message history slowly builds."
 *
 * WHAT A SWITCH DOES, in code: the chat's rows are the agent detail's `rows` (the window's replica of genie-host's
 * `SessionHost.ledgerFor`) plus its `comms` (the AgentInbox, read in main, synchronously). The window's replica of a ledger
 * exists only while the window reads it: an agent not read for a minute is unwatched and its replica dropped
 * (`SessionEngineClient.sweepLedgers`), and an agent never read has none. So a switch to it:
 *
 *  1. `agentDetail` → `ledgerFor` answers NO rows (and starts watching) while `comms` already holds the mail; the window
 *     takes that detail as the agent's conversation — over the rows it had kept for that agent (renderer/agent-detail.ts)
 *     — and the chat is mail cards only;
 *  2. genie-host answers the watch with its ledger: empty while it reads the history from disk, then the whole ledger
 *     (up to 3,000 recorded rows) cut into frames of PATCH_CHUNK_ROWS, oldest first; the window applies them under a
 *     time budget and every frame is a push to the renderer — so the replies "slowly build", oldest first.
 *
 * The contract: rows the host has not finished sending are said as PENDING, never as "no rows"; a recently viewed agent
 * shows its kept rows (replies AND mail) until the host's are whole; an agent never viewed shows a loading state.
 */

/*
 * Read through these until the fix lands, so that, before it, this file compiles and fails on its ASSERTIONS (an absent
 * method reads `undefined`), not on a missing name.
 */
const pendingOf = (engine: object, id: string): boolean | undefined => (engine as { historyPending?: (id: string) => boolean }).historyPending?.(id);
const rowsPendingOf = (detail: object | null | undefined): boolean | undefined => (detail as { rowsPending?: boolean } | null | undefined)?.rowsPending;
function land<T extends { agent: { id: string } }>(cache: AgentDetailCache<T>, key: string, detail: T): Partial<T> {
    return (cache as unknown as { land?: (key: string, detail: T) => T }).land?.(key, detail) ?? {};
}

const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const fakeDriverFor: DriverFor = () => ((() => ({ start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } })) as unknown as SessionDriverFactory);

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-659-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

/** An agent with a long recorded conversation: `n` replies on the disk, none read yet. */
async function withHistory(n: number): Promise<AgentRecord> {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'beachhead' });
    const thread = openAgentThread(openDurableStore(sessionsDir(dir)), record.id);
    const events = [];
    for (let i = 0; i < n; i += 1) events.push({ kind: 'message', speaker: 'agent', peerName: null, text: `REPLY-${i}`, [RUN_FIELD]: 'run-old' });
    await thread.record(events as never);
    return record;
}

describe('genie-host says when an agent’s history is still being read', () => {
    it('pending while the recorded history is read (the ledger has no rows yet), not once it landed', async () => {
        const host = new SessionHost({ userData: dir, driverFor: fakeDriverFor, processTree: tree });
        const record = await withHistory(5);
        expect(host.ledgerFor(record.id)).toEqual([]);
        expect(pendingOf(host, record.id)).toBe(true);
        await vi.waitFor(() => expect(host.ledgerFor(record.id).length).toBe(5));
        expect(pendingOf(host, record.id)).toBe(false);
        await host.stopAll();
    });

    it('CONTROL: an agent with no recorded history is not pending once its (empty) read landed', async () => {
        const host = new SessionHost({ userData: dir, driverFor: fakeDriverFor, processTree: tree });
        const id = mintAgentId();
        host.ledgerFor(id);
        await vi.waitFor(() => expect(pendingOf(host, id)).toBe(false));
        expect(host.ledgerFor(id)).toEqual([]);
        await host.stopAll();
    });
});

describe('the window never takes a ledger it has not been sent in full as the agent’s rows', () => {
    const TOKEN = 'b'.repeat(64);
    let timers: Array<() => void> = [];
    const settle = async (): Promise<void> => {
        for (let i = 0; i < 8; i += 1) { const due = timers; timers = []; for (const fn of due) fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setImmediate(r)); }
    };

    async function rig(now?: () => number) {
        timers = [];
        const server = new SessionEngineServer({ token: TOKEN, build: 'test', schedule: (_ms, fn) => { timers.push(fn); return () => { timers = timers.filter((t) => t !== fn); }; } });
        const host = new SessionHost({ userData: dir, driverFor: fakeDriverFor, processTree: tree, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        let ledgerFrames = 0;
        const send = hostSide.send.bind(hostSide);
        hostSide.send = (text: string) => {
            const f = JSON.parse(text) as { channel?: string; payload?: { ledger?: { append: unknown[] } } };
            if (f.channel === 'engine.agent' && (f.payload?.ledger?.append.length ?? 0) > 0) ledgerFrames += 1;
            send(text);
        };
        server.accept(hostSide);
        const client = new SessionEngineClient({ ledgerIdleMs: 1_000, ...(now ? { now } : {}) });
        await client.connect(windowSide, TOKEN);
        return { host, client, frames: () => ledgerFrames };
    }

    it('a first read: pending (never "no rows") until the whole ledger is in, and no partial ledger is ever announced', async () => {
        const record = await withHistory(650);
        const { host, client, frames } = await rig();
        const seen: Array<{ length: number; pending: boolean | undefined }> = [];
        client.subscribe((id) => { if (id === record.id) seen.push({ length: client.ledgerFor(record.id).length, pending: pendingOf(client, record.id) }); });
        expect(client.ledgerFor(record.id)).toEqual([]);
        expect(pendingOf(client, record.id)).toBe(true);
        await vi.waitFor(async () => { await settle(); expect(client.ledgerFor(record.id).length).toBe(host.ledgerFor(record.id).length); }, { timeout: 5_000 });
        // POSITIVE CONTROL: the ledger really came in several frames — the case the claim is about.
        expect(frames()).toBeGreaterThanOrEqual(Math.ceil(650 / PATCH_CHUNK_ROWS));
        expect(pendingOf(client, record.id)).toBe(false);
        expect(client.ledgerFor(record.id)).toEqual(host.ledgerFor(record.id));
        // Every announcement that said "not pending" carried the whole ledger; none carried a part of it.
        const whole = host.ledgerFor(record.id).length;
        expect(seen.filter((s) => !s.pending).every((s) => s.length === whole)).toBe(true);
        expect(seen.filter((s) => s.length > 0 && s.length < whole)).toEqual([]);
        await host.stopAll();
    });

    it('switching back after the replica was swept: pending again until the host’s ledger is in again', async () => {
        const record = await withHistory(30);
        let t = 0;
        const { host, client } = await rig(() => t);
        client.ledgerFor(record.id);
        await vi.waitFor(async () => { await settle(); expect(client.ledgerFor(record.id).length).toBe(30); }, { timeout: 5_000 });
        expect(pendingOf(client, record.id)).toBe(false);
        // The person looked elsewhere for longer than the idle bound: the window drops its replica.
        t = 5_000;
        client.sweepLedgers();
        expect(client.ledgerFor(record.id)).toEqual([]);
        expect(pendingOf(client, record.id)).toBe(true);
        await vi.waitFor(async () => { await settle(); expect(client.ledgerFor(record.id).length).toBe(30); }, { timeout: 5_000 });
        expect(pendingOf(client, record.id)).toBe(false);
        await host.stopAll();
    });
});

describe('the detail says its rows are pending', () => {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'beachhead' });
    const ports = (pending: boolean | undefined): AgentDetailPorts => ({
        registry: { find: () => record, listAgents: () => [record], defaultAgentOf: () => null },
        engine: {
            probe: () => null, ledgerFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], rowsFor: () => [], refusals: new Map(),
            ...(pending === undefined ? {} : { historyPending: () => pending }),
        } as unknown as NonNullable<AgentDetailPorts['engine']>,
        cwdFor: () => dir,
    });
    it('while the engine is still sending the ledger', () => {
        expect(rowsPendingOf(agentDetailFor(ports(true), record.id as AgentId))).toBe(true);
    });
    it('CONTROL: not once it is in, nor from an engine that cannot say', () => {
        expect(rowsPendingOf(agentDetailFor(ports(false), record.id as AgentId))).toBeFalsy();
        expect(rowsPendingOf(agentDetailFor(ports(undefined), record.id as AgentId))).toBeFalsy();
    });
});

type D = { agent: { id: string }; rows: readonly string[]; comms?: readonly string[]; rowsPending?: boolean };
describe('what a switch shows while the host’s rows are pending (renderer/agent-detail.ts)', () => {
    it('a recently viewed agent: its KEPT rows, with what the new detail says besides; the kept rows stay kept', () => {
        const cache = new AgentDetailCache<D>();
        const kept: D = { agent: { id: 'a' }, rows: ['REPLY-1', 'REPLY-2'], comms: ['m1'] };
        cache.remember('a', kept);
        const shown = land(cache, 'a', { agent: { id: 'a' }, rows: [], comms: ['m1', 'm2'], rowsPending: true });
        expect(shown.rows).toEqual(['REPLY-1', 'REPLY-2']);
        expect(shown.comms).toEqual(['m1', 'm2']);
        expect(shown.rowsPending).toBeFalsy();
        expect(cache.show('a').detail?.rows).toEqual(['REPLY-1', 'REPLY-2']);
    });
    it('the whole detail, once in, is shown and kept', () => {
        const cache = new AgentDetailCache<D>();
        cache.remember('a', { agent: { id: 'a' }, rows: ['REPLY-1'] });
        const whole: D = { agent: { id: 'a' }, rows: ['REPLY-1', 'REPLY-2', 'REPLY-3'] };
        expect(land(cache, 'a', whole)).toBe(whole);
        expect(cache.show('a').detail).toBe(whole);
    });
    it('an agent never viewed: the pending detail as it is (the chat draws loading), and nothing kept for it', () => {
        const cache = new AgentDetailCache<D>();
        const pending: D = { agent: { id: 'b' }, rows: [], comms: ['m1'], rowsPending: true };
        expect(land(cache, 'b', pending).rowsPending).toBe(true);
        expect(cache.show('b').detail).toBeNull();
    });
    it('the hook lands every detail through the cache — the first answer and every push', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8').replace(/\r\n/g, '\n');
        const hook = app.slice(app.indexOf('function useAgentDetail('), app.indexOf('function useRemote('));
        expect(hook.length).toBeGreaterThan(200);
        expect(hook.match(/detailCache\.land\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
        expect(hook).not.toMatch(/detailCache\.remember\(/);
    });
});

const T = 1_700_000_000_000;
const rowOf = (id: string, name: string): AgentRow => ({
    id, name, provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const agents = [rowOf('a1', 'beachhead'), rowOf('a2', 'moic')];
const mail: MailLike = { id: 'm1', from: 'a2', to: 'a1', text: 'a note', sentAt: new Date(T + 1_000).toISOString(), readAt: null };
const chatDetail = (pending: boolean): AgentDetail => ({
    agent: { id: 'a1', name: 'beachhead', provider: 'claude', fidelity: 'declared', cwd: '/w' },
    session: null, turns: 0, cost: null, refusal: null, rows: [], comms: [mail], ...(pending ? { rowsPending: true } : {}),
});

describe('the chat of an agent whose rows are pending', () => {
    it('is not loaded and shows no mail rows alone', () => {
        const thread = chatThreadFrom(chatDetail(true), 'a1', agents, () => 0);
        expect(thread.loaded).toBe(false);
        expect(thread.messages).toEqual([]);
    });
    it('CONTROL: the same detail whole shows its mail', () => {
        const thread = chatThreadFrom(chatDetail(false), 'a1', agents, () => 0);
        expect(thread.loaded).toBe(true);
        expect(thread.messages.map((m) => m.who)).toEqual(['mail']);
    });

    const thread = (loaded: boolean | undefined): ChatThread => ({ agentId: 'a1', name: 'beachhead', fidelity: 'declared', unread: null, messages: [], ...(loaded === undefined ? {} : { loaded }) });
    const draw = (t: ChatThread, mailOnly = false) => renderToStaticMarkup(<ChatMessages messages={t.messages} thread={t} refs={{ files: false, agents: [], workspaces: [] }} mailOnly={mailOnly} />);
    it('draws a loading state — the desktop chat and the phone, which share these rows', () => {
        expect(draw(thread(false))).toContain('data-chat-loading');
    });
    it('CONTROL: none once loaded, none where it is not said, none for a mail-only (observed) chat', () => {
        expect(draw(thread(true))).not.toContain('data-chat-loading');
        expect(draw(thread(undefined))).not.toContain('data-chat-loading');
        expect(draw(thread(false), true)).not.toContain('data-chat-loading');
    });
});
