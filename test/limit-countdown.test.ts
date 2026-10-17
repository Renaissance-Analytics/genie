import { describe, expect, it } from 'vitest';
import { headerActions, limitCountdown, statePill } from '../src/core/agent-view.js';
import type { LiveSession } from '../src/core/roster.js';

/**
 * ONE COUNTDOWN (Tynn #794, story #287). The owner, 2026-10-17: Genie must "show a timer to the user and then auto start
 * back up a little bit after the timer". The agent's pill says it is paused for its provider's limit, until when, and
 * counts down to it; a limit with no reset says it needs the person, with no timer; and Resume now is offered.
 */
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const live = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'idle', startedAt: NOW - 60_000, pendingApproval: null, failure: null,
    mcpServers: [], contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, links: null, plan: null,
    ...over,
} as LiveSession);
const hhmm = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

describe('the pill while the login is held', () => {
    it('paused: "Paused · rate limit · resumes HH:MM" with the time LEFT counting down', () => {
        const resumeAtMs = NOW + 38 * 60_000 + 12_000;
        const pill = statePill(live({ limit: { state: 'paused', window: 'five_hour', resetsAtMs: resumeAtMs - 120_000, resumeAtMs, message: null } }), () => NOW, { turns: 4 });
        expect(pill).toEqual({ word: `Paused · rate limit · resumes ${hhmm(resumeAtMs)}`, elapsed: '38:12', tone: 'warn' });
    });

    it('over an hour: h:mm:ss', () => {
        expect(limitCountdown(NOW + 2 * 3_600_000 + 5 * 60_000 + 7_000, NOW)).toBe('2:05:07');
        expect(limitCountdown(NOW - 5_000, NOW)).toBe('0:00');
    });

    it('retrying on the backoff (no reset known): says it is a try, and when', () => {
        const next = NOW + 15 * 60_000;
        expect(statePill(live({ limit: { state: 'retrying', nextTryAtMs: next, attempt: 1, message: 'weekly limit' } }), () => NOW, { turns: 4 }))
            .toEqual({ word: `Paused · rate limit · next try ${hhmm(next)}`, elapsed: '15:00', tone: 'warn' });
    });

    it('needs the person: no timer — never an invented one', () => {
        expect(statePill(live({ limit: { state: 'needs-person', message: 'out of usage credits' } }), () => NOW, { turns: 4 }))
            .toEqual({ word: 'Paused · rate limit · needs you: out of usage credits', elapsed: null, tone: 'warn' });
    });

    it('a parked question still wins (the person is the bottleneck either way); open is the ordinary pill (CONTROL)', () => {
        const parked = statePill(live({ pendingApproval: { question: 'Run it?' } as never, parkedAt: NOW, limit: { state: 'paused', window: 'w', resetsAtMs: NOW, resumeAtMs: NOW + 1000, message: null } }), () => NOW, { turns: 4 });
        expect(parked.word).toContain('waiting on you');
        expect(statePill(live({ limit: { state: 'open' } }), () => NOW, { turns: 4 }).word).toBe('Idle');
    });
});

describe('Resume now', () => {
    it('is offered while held, and not when open (CONTROL)', () => {
        expect(headerActions(live({ limit: { state: 'paused', window: 'w', resetsAtMs: NOW, resumeAtMs: NOW + 1000, message: null } }), 'declared').resumeLimit).toBe(true);
        expect(headerActions(live({ limit: { state: 'needs-person', message: null } }), 'declared').resumeLimit).toBe(true);
        expect(headerActions(live({ limit: { state: 'open' } }), 'declared').resumeLimit).toBe(false);
        expect(headerActions(live({}), 'declared').resumeLimit).toBe(false);
    });
});
