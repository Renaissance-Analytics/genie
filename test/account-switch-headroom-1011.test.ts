import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import { accountSwitchNote } from '../src/core/account-switch.js';
import type { Headroom } from '../src/core/headroom.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { PromptBlock } from '../src/core/prompt-content.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { SOURCE_NOTICE_NOW, sourceRateLimitNotice } from './fixtures/rate-limit-source.js';

/**
 * A SWITCH TELLS THE AGENTS THEIR NEW ROOM (Tynn #1011; the owner: "whenever we have an account switch make sure to post the
 * updated rate limit status so agents know it is reset. they keep getting stuck in holding patterns because they think the
 * rate limit is about to hit."). On every switch: the new account's reading is the one the agents' headroom signal carries
 * (published at once, and asked of the provider where it can answer), a stale "you have N% until you hit your rate limit"
 * from the OLD account is never delivered, each running agent's next turn opens with one line naming the account and its room,
 * and an agent held on the limit goes on.
 */
const HOUR = 3_600_000;
const NOW = SOURCE_NOTICE_NOW;
const fresh: Headroom = { plan: 'max', window: '5h', leftPct: 88, resetsAtMs: NOW + 3 * HOUR, over: false, windows: [
    { window: '5h', usedPct: 12, leftPct: 88, resetsAtMs: NOW + 3 * HOUR, over: false },
    { window: '7d', usedPct: 40, leftPct: 60, resetsAtMs: NOW + 90 * HOUR, over: false },
] };
const noTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const dirs: string[] = [];
const hosts: SessionHost[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
    for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
    for (const s of sessions.splice(0)) { try { s.stop('SIGTERM', { graceMs: 0 }); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('accountSwitchNote: one line naming the account and its room', () => {
    it('names the account, each window\'s use and the next reset, and says earlier warnings were the old account\'s', () => {
        const note = accountSwitchNote('Lab', fresh, NOW);
        expect(note).toMatch(/^Account switched to Lab: 5h 12% used, 7d 40% used, resets /);
        expect(note).toMatch(/earlier rate-limit warnings were about the previous account/i);
    });
    it('with no reading yet for that account it says so, never a guessed figure', () => {
        const note = accountSwitchNote('Lab', null, NOW);
        expect(note).toMatch(/^Account switched to Lab: its usage is not known yet/);
        expect(note).not.toMatch(/\d+% used/);
    });
    it('a window over its allowance, and one past its reset, are said as such', () => {
        const note = accountSwitchNote('Lab', { ...fresh, windows: [{ window: '5h', usedPct: 100, leftPct: 0, resetsAtMs: NOW + HOUR, over: true }, { window: '7d', usedPct: 99, leftPct: 1, resetsAtMs: NOW - 1, over: false }] }, NOW);
        expect(note).toMatch(/5h over the limit/);
        expect(note).toMatch(/7d reset/);
    });
});

async function rig() {
    const dir = await mkdtemp(join(tmpdir(), 'genie-1011-switch-room-')); dirs.push(dir);
    const wires: Array<string | readonly PromptBlock[]> = [];
    let events: DriverEvents = {}, running = false;
    const factory: SessionDriverFactory = (options) => { events = options.events; return {
        start: () => { running = true; }, prompt: (value) => { wires.push(value); }, kill: () => { running = false; },
        get running() { return running; }, get cliSessionId() { return null; },
    }; };
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noTree, clock: () => NOW });
    sessions.push(session); session.start(); await session.settled();
    return { session, wires, reading: (left: number) => events.onUpdate?.(sourceRateLimitNotice('claude', left, NOW + HOUR)), end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}

describe('AgentSession.accountSwitched: the next turn knows the new room, and nothing stale', () => {
    it('a pending "N% until you hit your rate limit" from the OLD account is never delivered; the switch line is, once', async () => {
        const r = await rig();
        r.session.prompt('first', 'you'); r.reading(5); r.end();
        r.session.accountSwitched(accountSwitchNote('Lab', fresh, NOW), fresh);
        r.session.prompt('carry on', 'you');
        const wire = String(r.wires[1]);
        expect(wire).not.toContain('until you hit your rate limit');
        expect(wire.indexOf('Account switched to Lab')).toBe(0);
        expect(wire).toContain('carry on');
        r.end(); r.session.prompt('and then', 'you');
        expect(String(r.wires[2])).toBe('and then');
    });

    it('a session held on the limit goes on', async () => {
        const r = await rig();
        r.session.hold();
        expect(r.session.held).toBe(true);
        r.session.accountSwitched(accountSwitchNote('Lab', fresh, NOW), fresh);
        expect(r.session.held).toBe(false);
    });
});

describe('SessionHost.accountSwitched: every running agent of the provider, and a fresh reading', () => {
    const account = (suffix: string, provider: 'claude' | 'codex' = 'claude'): AccountRecord => ({ id: `account_${suffix.repeat(32)}`, provider, label: suffix === '2' ? 'Lab' : 'Work', labelEdited: true,
        home: '/home/.claude', legacy: false, identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z' });
    const LAB = account('2');

    it('publishes the new account\'s reading at once, asks the provider for a live one, and tells every Claude agent (not Codex)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-1011-switch-host-')); dirs.push(dir);
        const prompts = new Map<string, unknown[]>();
        const reads: string[] = [];
        const driverFor: DriverFor = (agent) => () => {
            let running = false;
            const d: SessionDriver = {
                start: () => { running = true; }, prompt: (c) => { prompts.set(agent.id, [...(prompts.get(agent.id) ?? []), c]); },
                kill: () => { running = false; }, get running() { return running; }, get cliSessionId() { return null; },
                readRateLimits: async () => { reads.push(agent.id); },
            } as SessionDriver;
            return d;
        };
        const headroom = vi.fn();
        // The reading's clock and the host's are one (the windows reset at NOW + 3 h and NOW + 90 h).
        // The reading's clock and the host's are one (the windows reset at NOW + 3 h and NOW + 90 h).
        const host = new SessionHost({ userData: dir, driverFor, processTree: noTree, stopGraceMs: 0, onHeadroom: headroom, clock: () => NOW, clock: () => NOW, activeAccount: (p) => (p === 'claude' ? LAB : account('9', 'codex')) });
        hosts.push(host);
        const mk = (name: string, provider: 'claude' | 'codex'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider, name });
        const a = mk('one', 'claude'), b = mk('two', 'claude'), c = mk('three', 'codex');
        for (const r of [a, b, c]) expect(host.start(r, dir)).toEqual({ ok: true });

        host.accountSwitched('claude', { account: LAB, headroom: fresh });

        expect(headroom).toHaveBeenCalledWith('claude', fresh, expect.objectContaining({ accountId: LAB.id, fresh: true }));
        await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0));
        for (const r of [a, b, c]) host.prompt(r.id, 'go on', 'you');
        await vi.waitFor(() => expect(prompts.get(b.id)?.length).toBe(1));
        for (const r of [a, b]) expect(String(prompts.get(r.id)![0])).toMatch(/^Account switched to Lab: 5h 12% used/);
        expect(String(prompts.get(c.id)?.[0] ?? '')).not.toContain('Account switched');
    });
});
