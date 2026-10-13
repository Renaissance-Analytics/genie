import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { headerActions, statePill, tabsFor } from '../src/core/agent-view.js';

/**
 * THE AGENT VIEW PER THE BOARD (`Agent View.dc.html`, re-audited 2026-10-12). Where the board and the prose disagree the
 * board wins (§3) — except where §1 (no agent in a terminal) is at stake.
 *
 *  - The state pill speaks in turns: `Turn 14 · running 2m 35s`, `Turn 15 · parked · waiting on you`, `No turns yet`,
 *    `Broken · <reason>`; an observed agent: `Active · last output 40s ago` / `Quiet · last output 5m ago` / `Quiet · no
 *    output yet`. A clock only while a turn runs.
 *  - The header's actions depend on the state: `Stop` while a turn runs; `Restart` only when broken; `Open terminal`
 *    (the Take Over window) in the error state; `Take over` and `Chat` always.
 *  - An observed agent opens on Activity (the board), then Terminal, Files, Changes.
 */
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: 1_000_000 - 155_000, pendingApproval: null, failure: null,
    contextUsed: null, contextSize: null, plan: null, ...over,
} as LiveSession);
const now = () => 1_000_000;

describe('statePill — the board’s words', () => {
    it('a running turn: its number and a clock', () => {
        expect(statePill(session(), now, { turns: 14 })).toEqual({ word: 'Turn 14 · running', elapsed: '2:35', tone: 'ok' });
    });

    it('parked: the turn number and the wait; no clock without the stamp (the stamped case is in pill-stamps)', () => {
        const pill = statePill(session({ turnState: 'idle', pendingApproval: { question: 'Allow?', options: [] } as never }), now, { turns: 15 });
        expect(pill).toEqual({ word: 'Turn 15 · parked · waiting on you', elapsed: null, tone: 'warn' });
    });

    it('broken names the reason; idle after turns is idle; before any turn it is "No turns yet"; registered-never-started is "Not started"', () => {
        expect(statePill(session({ failure: { reason: 'ACP stream closed · exit 137', fixes: [] } }), now, { turns: 3 })).toEqual({ word: 'Broken · ACP stream closed · exit 137', elapsed: null, tone: 'bad' });
        expect(statePill(session({ running: false, turnState: 'idle' }), now, { turns: 3 })).toEqual({ word: 'Idle', elapsed: null, tone: 'muted' });
        expect(statePill(session({ running: true, turnState: 'idle' }), now, { turns: 0 })).toEqual({ word: 'No turns yet', elapsed: null, tone: 'muted' });
        expect(statePill(null, now, { turns: 0 })).toEqual({ word: 'Not started', elapsed: null, tone: 'muted' });
    });

    it('an observed agent reports what was measured: active with the last output’s age, quiet, or no output yet', () => {
        const probe = (lastOutputAt: number | null) => ({ terminalId: 't', startedAt: 0, lastOutputAt, bursts: [] });
        expect(statePill(null, now, { turns: 0, takeOver: probe(1_000_000 - 10_000) })).toEqual({ word: 'Active · last output 10s ago', elapsed: null, tone: 'ok' });
        expect(statePill(null, now, { turns: 0, takeOver: probe(1_000_000 - 300_000) })).toEqual({ word: 'Quiet · last output 5m ago', elapsed: null, tone: 'muted' });
        expect(statePill(null, now, { turns: 0, takeOver: probe(null) })).toEqual({ word: 'Quiet · no output yet', elapsed: null, tone: 'muted' });
    });

    it('CONTROL: the old vocabulary is gone — no pill ever reads "thinking" or "not started" for a session that exists', () => {
        const words = [session(), session({ running: false, turnState: 'idle' }), session({ failure: { reason: 'x', fixes: [] } })].map((s) => statePill(s, now, { turns: 2 }).word);
        expect(words.filter((w) => /thinking|not started/.test(w))).toEqual([]);
        expect(words).toHaveLength(3);
    });
});

describe('headerActions — the board’s action set by state', () => {
    it('Stop while a turn runs; Restart only when broken; Open terminal only when broken; Take over and Chat always', () => {
        expect(headerActions(session(), 'declared')).toEqual({ stop: true, restart: false, openTerminal: false, start: false, takeOver: true, chat: true });
        expect(headerActions(session({ failure: { reason: 'x', fixes: [] } }), 'declared')).toEqual({ stop: false, restart: true, openTerminal: true, start: false, takeOver: true, chat: true });
        // Not running and not broken: Start (the owner: there was no way to start the genie agent).
        expect(headerActions(session({ running: false, turnState: 'idle' }), 'declared')).toEqual({ stop: false, restart: false, openTerminal: false, start: true, takeOver: true, chat: true });
        expect(headerActions(null, 'declared')).toEqual({ stop: false, restart: false, openTerminal: false, start: true, takeOver: true, chat: true });
        // An observed agent is not managed: nothing to stop or restart; its window IS the terminal.
        expect(headerActions(null, 'observed')).toEqual({ stop: false, restart: false, openTerminal: false, start: false, takeOver: true, chat: true });
    });
});

describe('tabsFor — the board’s order', () => {
    it('an observed agent opens on Activity; a declared one keeps Stream | Files | Changes (§1: no Terminal for an agent that has no pty)', () => {
        expect(tabsFor('observed')).toEqual(['activity', 'terminal', 'files', 'changes']);
        expect(tabsFor('declared')).toEqual(['stream', 'files', 'changes']);
        expect(tabsFor('remote')).toEqual(['files', 'changes']);
    });
});
