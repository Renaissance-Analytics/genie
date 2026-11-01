import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headerActions, statePill } from '../src/core/agent-view.js';
import { chatContext, chatMessages } from '../src/core/chat-view.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { agentPrompter, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * START ON FIRST MESSAGE (the owner, 2026-11-01, q_04ce323c): "opening an agent must NOT start it". Opening shows it —
 * its history, its settings, a Start — and a live session is reattached as it is. The session starts when something
 * sends it work: the person's first message, mail that wakes it, a flow's prompt, Start. While it comes up the person
 * SEES it coming up (`Starting`), and their first message reads as waiting for the start, then sent.
 */

// Comments stripped first, so a sentence about the wiring cannot stand in for the wiring.
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const handler = (channel: string): string => {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    expect(at, `${channel} is handled in main.ts`).toBeGreaterThan(-1);
    const next = main.indexOf('ipcMain.handle(', at + 10);
    return main.slice(at, next === -1 ? undefined : next);
};

describe('main: opening shows, a message starts', () => {
    it('`genie:open-agent` starts nothing — no host.start, no restart', () => {
        const open = handler('genie:open-agent');
        expect(open).not.toMatch(/\.start\(/);
        expect(open).not.toMatch(/restartAgent\(/);
        // CONTROL: the same reader finds a start where there is one (Doctor's own handler).
        expect(main).toMatch(/host\.start\(record, cwdFor\(record\)\)/);
    });

    it('`genie:prompt` (the composer) starts the agent on demand before it delivers', () => {
        const prompt = handler('genie:prompt');
        expect(prompt).toMatch(/startOnDemand\(record\)/);
        expect(prompt.indexOf('startOnDemand(')).toBeLessThan(prompt.indexOf('promptWith('));
        // …and that is the shared rule (main/start-on-demand.ts), not a start of its own.
        expect(main).toMatch(/const startOnDemand = \(record: AgentRecord\): Promise<StartForWork> => startForWork\(/);
    });

    it('a flow’s prompt can start the agent too (the sessions port flows are given has `start`)', () => {
        const at = main.indexOf('agentSessions: {');
        expect(at).toBeGreaterThan(-1);
        expect(main.slice(at, at + 800)).toMatch(/start:\s*(?:async\s*)?\(id\)\s*=>/);
    });
});

describe('a remote window (host API): the same rules', () => {
    const record = { id: 'agent_a', workspaceId: 'pa', provider: 'claude', name: 'pa-ops' } as unknown as AgentRecord;
    function api(over: { startForWork?: HostApiDeps['startForWork'] } = {}) {
        const calls: string[] = [];
        const deps = {
            find: (id: string) => (id === 'agent_a' ? record : null),
            cwdFor: () => '/w/pa',
            host: {
                start: (r: AgentRecord) => { calls.push(`start:${r.id}`); return { ok: true }; },
                prompt: (id: string, text: string) => { calls.push(`prompt:${id}:${text}`); return true; },
            },
            ...(over.startForWork ? { startForWork: over.startForWork } : {}),
        } as unknown as HostApiDeps;
        return { api: buildHostApi(deps), calls };
    }

    it('openAgent starts nothing; an unknown agent is still refused', async () => {
        const { api: a, calls } = api();
        expect(await a.invoke('openAgent', ['agent_a'])).toEqual({ ok: true });
        expect(await a.invoke('openAgent', ['nope'])).toEqual({ ok: false, reason: 'unknown agent' });
        expect(calls).toEqual([]);
    });

    it('a start that answers LATER (genie-host) is awaited: refused there, nothing is delivered and the reason is said', async () => {
        const later = api({ startForWork: () => new Promise((r) => setTimeout(() => r({ ok: false, reason: 'claude is not installed' }), 5)) });
        expect(await later.api.invoke('prompt', ['agent_a', 'hi'])).toEqual({ ok: false, reason: 'claude is not installed' });
        expect(later.calls).toEqual([]);
    });

    it('prompt starts the agent on demand first, then delivers; a refused start delivers nothing and says why', async () => {
        const order: string[] = [];
        const { api: a, calls } = api({ startForWork: (r) => { order.push(`start-for-work:${r.id}`); return { ok: true, started: true }; } });
        expect(await a.invoke('prompt', ['agent_a', 'hi'])).toEqual({ ok: true });
        expect([...order, ...calls]).toEqual(['start-for-work:agent_a', 'prompt:agent_a:hi']);

        const refused = api({ startForWork: () => ({ ok: false, reason: 'Particle Academy Operations is hibernated' }) });
        expect(await refused.api.invoke('prompt', ['agent_a', 'hi'])).toEqual({ ok: false, reason: 'Particle Academy Operations is hibernated' });
        expect(refused.calls).toEqual([]);
    });
});

describe('a flow prompting an agent that is not running', () => {
    it('starts it (when the sessions port can) and delivers — no longer "not running; nowhere to go"', async () => {
        let state: { running: boolean; turnState: string; pendingApproval: unknown } | null = null;
        const rows: Array<{ event: unknown }> = [];
        const listeners = new Set<(id: string) => void>();
        const calls: string[] = [];
        const sessions: AgentSessionsPort = {
            session: () => state,
            rows: () => rows,
            start: (id) => { calls.push(`start:${id}`); state = { running: true, turnState: 'idle', pendingApproval: null }; return true; },
            prompt: (id, text) => {
                calls.push(`prompt:${id}:${text}`);
                state = { running: true, turnState: 'working', pendingApproval: null };
                setTimeout(() => { rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: 'done' } }); state = { running: true, turnState: 'idle', pendingApproval: null }; for (const l of listeners) l(id); }, 0);
                return true;
            },
            subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        };
        const prompt = agentPrompter({ sessions, resolve: () => ({ kind: 'one', id: 'agent_atlas' as never }), agent: () => ({ name: 'atlas', workspaceId: 'pa' }), asleep: () => false, by: 'flow "nightly"' });
        expect(await prompt('claude:atlas', 'post the standup')).toBe('done');
        expect(calls).toEqual(['start:agent_atlas', 'prompt:agent_atlas:post the standup']);
    });

    it('a sessions port whose start answers LATER (the agent engine in genie-host): the flow waits for it, then delivers', async () => {
        let state: { running: boolean; turnState: string; pendingApproval: unknown } | null = null;
        const rows: Array<{ event: unknown }> = [];
        const listeners = new Set<(id: string) => void>();
        const calls: string[] = [];
        const sessions: AgentSessionsPort = {
            session: () => state,
            rows: () => rows,
            // The replica learns of the session only when the host's answer comes back.
            start: (id) => new Promise<boolean>((r) => setTimeout(() => { calls.push(`start:${id}`); state = { running: true, turnState: 'idle', pendingApproval: null }; r(true); }, 5)),
            prompt: (id, text) => {
                calls.push(`prompt:${id}:${text}`);
                state = { running: true, turnState: 'working', pendingApproval: null };
                setTimeout(() => { rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: 'done' } }); state = { running: true, turnState: 'idle', pendingApproval: null }; for (const l of listeners) l(id); }, 0);
                return true;
            },
            subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        };
        const prompt = agentPrompter({ sessions, resolve: () => ({ kind: 'one', id: 'agent_atlas' as never }), agent: () => ({ name: 'atlas', workspaceId: 'pa' }), asleep: () => false, by: 'flow "nightly"' });
        expect(await prompt('claude:atlas', 'post the standup')).toBe('done');
        expect(calls).toEqual(['start:agent_atlas', 'prompt:agent_atlas:post the standup']);
    });

    it('a port that cannot start keeps the old answer (the control): not running, nowhere to go', async () => {
        const sessions: AgentSessionsPort = { session: () => null, rows: () => [], prompt: () => false, subscribe: () => () => {} };
        const prompt = agentPrompter({ sessions, resolve: () => ({ kind: 'one', id: 'agent_atlas' as never }), agent: () => ({ name: 'atlas', workspaceId: 'pa' }), asleep: () => false, by: 'flow "nightly"' });
        await expect(prompt('claude:atlas', 'x')).rejects.toThrow(/not running/);
    });
});

describe('starting is SEEN: Starting, then the first message sent', () => {
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    const ready = new Map<string, () => Promise<void>>();
    // Shaped like Genie's real start (deferred-driver.ts): the MCP preparation and the handshake are a `ready`.
    const driverFor: DriverFor = (record) => {
        const factory: SessionDriverFactory = () => {
            let resolve: () => void = () => {};
            const gate = new Promise<void>((r) => { resolve = r; });
            ready.set(record.id, async () => { resolve(); await gate; await Promise.resolve(); });
            return { start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null, ready: gate };
        };
        return factory;
    };
    let dir: string;
    let host: SessionHost;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-start-on-message-')); ready.clear(); host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree }); });
    afterEach(async () => { host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    const now = () => 1_760_000_000_000;
    const record = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'pa', provider: 'claude', name: 'pa-ops' });
    const detail = (r: AgentRecord) => ({ agent: { id: r.id, name: r.name, provider: r.provider, fidelity: 'declared' as const }, session: host.probe(r.id), rows: host.rowsFor(r.id) });

    it('never started: Not started, with Start', () => {
        const r = record();
        expect(statePill(host.probe(r.id), now).word).toBe('Not started');
        expect(headerActions(host.probe(r.id), 'declared')).toMatchObject({ start: true, stop: false });
    });

    it('coming up: the header and the chat say Starting; no Start pressed twice, no turn Stop', async () => {
        const r = record();
        host.start(r, dir);
        const probe = host.probe(r.id);
        expect(probe?.starting).toBe(true);
        expect(statePill(probe, now, { turns: 0 }).word).toBe('Starting');
        expect(chatContext(detail(r)).text).toBe('Starting');
        expect(headerActions(probe, 'declared')).toMatchObject({ start: false, stop: false });

        // CONTROL: once it is up, the same readers say so.
        await ready.get(r.id)!();
        expect(host.probe(r.id)?.starting).toBe(false);
        expect(statePill(host.probe(r.id), now, { turns: 0 }).word).toBe('No turns yet');
    });

    it('the first message, sent while it starts: shown as waiting for the start, then sent', async () => {
        const r = record();
        host.start(r, dir);
        expect(host.prompt(r.id, 'hello', 'you')).toBe(true);
        const waiting = chatMessages(detail(r)).find((m) => m.text === 'hello');
        expect(waiting).toMatchObject({ queued: true, queuedForStart: true });

        await ready.get(r.id)!();
        await host.settled();
        const sent = chatMessages(detail(r)).find((m) => m.text === 'hello');
        expect(sent?.queued ?? false).toBe(false);
        expect(sent?.queuedForStart).toBeUndefined();
        expect(sent?.delivered).toBe(true);
    });
});
