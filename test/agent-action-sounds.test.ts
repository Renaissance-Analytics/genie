import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentActionOf, type AgentAction } from '../src/core/agent-actions.js';
import { ALERT_KINDS, alertSound } from '../src/core/alerts.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A SOUND FOR EVERY KIND OF ACTION AN AGENT TAKES (Tynn #766 row C; the owner, 2026-10-17: "Every kind of action an agent
 * can take needs to have a sound setting with a ability to choose what sound plays (or not)").
 *
 * What an agent DOES is what its session reports: the tool calls the provider categorised (an edit, a command, a read or
 * search, a fetch), its plan, a reply ending, being stopped, being started — and, for its whole login, a rate limit and
 * the resume after it. Each is its own sound row. The noisy ones default to None (the owner's answer, Genie 1's rule):
 * an upgrade does not start making noise nobody agreed to. A tool call sounds ONCE, however many updates it streams; a
 * tool the provider did not categorise is not guessed into one.
 */
const tool = (toolCallId: string, toolKind: string | null): StreamEvent => ({ kind: 'tool', toolCallId, name: null, title: null, status: null, toolKind: toolKind as never, rawInput: null });

describe('what an event is, as an action', () => {
    it('the provider’s tool categories: edit, execute (a command), read and search, fetch — each keyed by its call', () => {
        expect(agentActionOf(tool('t1', 'edit'))).toEqual({ kind: 'edits', key: 'tool:t1' });
        expect(agentActionOf(tool('t2', 'execute'))).toEqual({ kind: 'runs', key: 'tool:t2' });
        expect(agentActionOf(tool('t3', 'read'))).toEqual({ kind: 'reads', key: 'tool:t3' });
        expect(agentActionOf(tool('t4', 'search'))).toEqual({ kind: 'reads', key: 'tool:t4' });
        expect(agentActionOf(tool('t5', 'fetch'))).toEqual({ kind: 'fetches', key: 'tool:t5' });
    });

    it('not an action: a tool the provider did not categorise, "other", thinking; a message (a reply ENDS at the turn)', () => {
        expect(agentActionOf(tool('t6', null))).toBeNull();
        expect(agentActionOf(tool('t7', 'other'))).toBeNull();
        expect(agentActionOf(tool('t8', 'think'))).toBeNull();
        expect(agentActionOf({ kind: 'message', speaker: 'agent', peerName: null, text: 'hi' })).toBeNull();
    });

    it('its plan (once per turn: the same key until the turn ends) and being stopped', () => {
        expect(agentActionOf({ kind: 'plan', entries: [] })).toEqual({ kind: 'plans', key: 'plan' });
        expect(agentActionOf({ kind: 'stopped', n: 3, by: 'you' })).toEqual({ kind: 'stopped', key: 'stopped:3' });
    });
});

describe('the registry has a row for each', () => {
    it('every action is an alert kind with its own sound row; the noisy ones and every new kind default to None', () => {
        const kinds = ALERT_KINDS.map((k) => k.kind);
        for (const k of ['started', 'replied', 'stopped', 'limited', 'resumed', 'edits', 'runs', 'reads', 'fetches', 'plans'] as const) expect(kinds).toContain(k);
        for (const k of ['started', 'replied', 'stopped', 'limited', 'resumed', 'edits', 'runs', 'reads', 'fetches', 'plans'] as const) {
            expect(ALERT_KINDS.find((d) => d.kind === k)!.sound, k).toBe('off');
            expect(alertSound(k, { notification_sounds: true }), k).toBeNull();
        }
        // CONTROL: the five that were there keep their own sounds.
        expect(alertSound('question', { notification_sounds: true })).toEqual({ kind: 'wav', file: 'dingdongdoink.wav' });
        // Chosen, an action plays: an edit with Sparkle.
        expect(alertSound('edits', { notification_sounds: true, sound_edits: 'sparkle' })).toEqual({ kind: 'wav', file: 'sparkle.wav' });
    });

    it('each kind belongs to one group the Settings rows are shown under', () => {
        const by = (g: string) => ALERT_KINDS.filter((k) => k.group === g).map((k) => k.kind);
        expect(by('needs-you')).toEqual(['question', 'approval', 'broken', 'limited']);
        expect(by('turn')).toEqual(['started', 'replied', 'finished', 'thumbsup', 'stopped', 'resumed']);
        expect(by('work')).toEqual(['edits', 'runs', 'reads', 'fetches', 'plans']);
        expect(by('messages')).toEqual(['mail', 'agentmail']);
        expect(by('things')).toEqual(['exits', 'siteup', 'sitedown', 'serviceup', 'flowdone']);
        expect(by('github')).toEqual(['ghissue', 'ghpr', 'ghsecurity', 'ghci']);
        expect(ALERT_KINDS).toHaveLength(26);
    });
});

// ---- the host reports what its agents do -------------------------------------------------------------------------

const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 9, 17, 3, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};
let host: SessionHost;
let heard: Array<{ agent: string; kind: AgentAction['kind'] | 'limited' | 'resumed' | 'started' | 'replied' }> = [];
const names = new Map<string, string>();

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-action-sounds-'));
    now = Date.UTC(2026, 9, 17, 3, 0, 0);
    timers = [];
    heard = [];
    events.clear();
    names.clear();
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        onAction: (agentId, kind) => { heard.push({ agent: names.get(agentId) ?? agentId, kind }); },
        rateLimit: {
            gate: new RateLimitGate({ marginMs: 2 * MIN }),
            schedule: (ms, fn) => { const t = { at: now + ms, fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
        },
    });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (name: string): AgentRecord => { const r = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name }); names.set(r.id, name); return r; };
const update = (name: string, u: Record<string, unknown>) => events.get(name)!.onUpdate?.(u);

describe('the host reports each action once', () => {
    it('started; a tool call ONCE however many updates it streams; an uncategorised one not at all; COUNTED', () => {
        const a = record('atlas');
        host.start(a, dir);
        update('atlas', { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', title: 'Edit app.ts' });
        update('atlas', { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'edit', status: 'in_progress' });
        update('atlas', { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'edit', status: 'completed' });
        update('atlas', { sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'execute', title: 'npm test' });
        update('atlas', { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'mcp__genie__lists' });
        expect(heard).toEqual([
            { agent: 'atlas', kind: 'started' },
            { agent: 'atlas', kind: 'edits' },
            { agent: 'atlas', kind: 'runs' },
        ]);
    });

    it('its plan once per turn; a reply that ends is "replied" — a FAILED turn is not a reply', () => {
        const a = record('atlas');
        host.start(a, dir);
        heard = [];
        update('atlas', { sessionUpdate: 'plan_update', entries: [{ content: 'a' }] });
        update('atlas', { sessionUpdate: 'plan_update', entries: [{ content: 'a' }, { content: 'b' }] });
        events.get('atlas')!.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        update('atlas', { sessionUpdate: 'plan_update', entries: [{ content: 'c' }] });
        events.get('atlas')!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'boom' });
        expect(heard.map((h) => h.kind)).toEqual(['plans', 'replied', 'plans']);
    });

    it('a rate limit sounds ONCE for the login (not once per held agent), and the resume once', () => {
        const a = record('atlas');
        const b = record('wren');
        host.start(a, dir);
        host.start(b, dir);
        heard = [];
        const resetsAtMs = now + 60 * MIN;
        update('atlas', {
            sessionUpdate: 'notice', notice: { level: 'info', message: "You've hit your limit" },
            _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization: 1, resetsAtMs } }, raw: {} } },
        });
        events.get('atlas')!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
        expect(heard.filter((h) => h.kind === 'limited')).toHaveLength(1);
        host.resumeLimit('claude');
        expect(heard.filter((h) => h.kind === 'resumed')).toHaveLength(1);
    });
});
