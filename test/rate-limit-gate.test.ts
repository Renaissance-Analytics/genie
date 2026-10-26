import { describe, expect, it } from 'vitest';
import { RateLimitGate, limitReadingsFromMeta } from '../src/core/rate-limit-gate.js';

/**
 * RATE LIMITS PAUSE, THEY DO NOT BREAK (Tynn story #287, task #792; the owner, 2026-10-17: "When it hits you cannot
 * process anything else and everything dies"). One gate per provider LOGIN — every Claude agent on the person's Claude
 * account shares one limit — fed the provider's own structured readings:
 *  - Claude's SDKRateLimitEvent (code.claude.com/docs/en/agent-sdk/typescript): status 'allowed' | 'allowed_warning' |
 *    'rejected', resetsAt, errorCode 'credits_required' (cannot continue until credits are bought); prism-acp carries it
 *    as { status, rateLimitType, resetsAtMs, windows, raw }.
 *  - codex's account/rateLimits: primary / secondary { usedPercent, windowDurationMins, resetsAtMs }.
 * A reset time is NEVER invented: no reset → retried on a stated backoff; credits → the person.
 */

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const MIN = 60_000;
const claude = { provider: 'claude', account: 'default' };
const codex = { provider: 'codex', account: 'default' };

const claudeMeta = (over: Record<string, unknown>) => ({
    status: 'allowed',
    rateLimitType: 'five_hour',
    resetsAtMs: T0 + 90 * MIN,
    windows: { five_hour: { utilization: 0.4, resetsAtMs: T0 + 90 * MIN } },
    raw: {},
    ...over,
});

describe('readings from the provider’s own rate-limit detail', () => {
    it('Claude: rejected → the binding window, rejected, with its reset; allowed and allowed_warning → allowed', () => {
        expect(limitReadingsFromMeta(claudeMeta({ status: 'rejected' }))).toEqual([{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 90 * MIN }]);
        expect(limitReadingsFromMeta(claudeMeta({}))).toEqual([{ window: 'five_hour', status: 'allowed', resetsAtMs: T0 + 90 * MIN }]);
        expect(limitReadingsFromMeta(claudeMeta({ status: 'allowed_warning' }))[0]!.status).toBe('allowed');
    });

    it('Claude: credits_required is the person’s, never a timer — even with a reset in the frame', () => {
        expect(limitReadingsFromMeta(claudeMeta({ status: 'rejected', raw: { errorCode: 'credits_required' } }))).toEqual([
            { window: 'five_hour', status: 'needs-person', resetsAtMs: null },
        ]);
    });

    it('Claude: an unknown status is NOT allowed (prism-acp: test status !== allowed, never a breach spelling)', () => {
        expect(limitReadingsFromMeta(claudeMeta({ status: 'blocked_somehow' }))[0]!.status).toBe('rejected');
    });

    it('codex: a window at 100% or more is rejected until its reset; under 100 is allowed — each window on its own', () => {
        const r = limitReadingsFromMeta({
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAtMs: T0 + 30 * MIN },
            secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAtMs: T0 + 3 * 1440 * MIN },
        });
        expect(r).toEqual([
            { window: 'primary', status: 'rejected', resetsAtMs: T0 + 30 * MIN },
            { window: 'secondary', status: 'allowed', resetsAtMs: T0 + 3 * 1440 * MIN },
        ]);
    });

    it('neither shape → no readings (nothing is guessed from a shape it does not know)', () => {
        expect(limitReadingsFromMeta({ hello: 1 })).toEqual([]);
        expect(limitReadingsFromMeta(null)).toEqual([]);
    });
});

describe('the gate', () => {
    it('a rejected window pauses the login until its reset PLUS the margin; other logins stay open', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        const v = gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 90 * MIN }], T0, 'You have hit your limit');
        expect(v).toEqual({ state: 'paused', window: 'five_hour', resetsAtMs: T0 + 90 * MIN, resumeAtMs: T0 + 92 * MIN, message: 'You have hit your limit' });
        expect(gate.view(codex, T0)).toEqual({ state: 'open' });
    });

    it('resumes ONCE: due() names the login when its time comes, and never again', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 10 * MIN }], T0, null);
        expect(gate.due(T0 + 11 * MIN)).toEqual([]); // CONTROL: inside the margin, still paused
        expect(gate.due(T0 + 12 * MIN)).toEqual([claude]);
        expect(gate.due(T0 + 13 * MIN)).toEqual([]);
        expect(gate.view(claude, T0 + 13 * MIN)).toEqual({ state: 'open' });
    });

    it('two windows rejected: the LATER reset holds; an allowed reading for one window does not lift the other', () => {
        const gate = new RateLimitGate({ marginMs: 0 });
        gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 60 * MIN }], T0, null);
        gate.report(claude, [{ window: 'seven_day', status: 'rejected', resetsAtMs: T0 + 3000 * MIN }], T0, null);
        expect(gate.view(claude, T0)).toMatchObject({ state: 'paused', window: 'seven_day', resumeAtMs: T0 + 3000 * MIN });
        gate.report(claude, [{ window: 'five_hour', status: 'allowed', resetsAtMs: T0 + 300 * MIN }], T0 + MIN, null);
        expect(gate.view(claude, T0 + MIN)).toMatchObject({ state: 'paused', window: 'seven_day' });
        expect(gate.due(T0 + 61 * MIN)).toEqual([]);
    });

    it('an allowed reading for the paused window lifts the pause early, and due() names it once', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 90 * MIN }], T0, null);
        gate.report(claude, [{ window: 'five_hour', status: 'allowed', resetsAtMs: T0 + 390 * MIN }], T0 + 5 * MIN, null);
        expect(gate.view(claude, T0 + 5 * MIN)).toEqual({ state: 'open' });
        expect(gate.due(T0 + 5 * MIN)).toEqual([claude]);
        expect(gate.due(T0 + 6 * MIN)).toEqual([]);
    });

    it('a breach with NO reset time is retried on a stated backoff, never a guessed reset', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN, retryBackoffMs: [15 * MIN, 30 * MIN] });
        expect(gate.breach(claude, T0, 'You have hit your weekly limit')).toEqual({ state: 'retrying', nextTryAtMs: T0 + 15 * MIN, attempt: 1, message: 'You have hit your weekly limit' });
        expect(gate.due(T0 + 15 * MIN)).toEqual([claude]); // the try
        // the try hit the limit again: the next step of the backoff, and the last step repeats
        expect(gate.breach(claude, T0 + 15 * MIN, 'again')).toMatchObject({ state: 'retrying', nextTryAtMs: T0 + 45 * MIN, attempt: 2 });
        expect(gate.due(T0 + 45 * MIN)).toEqual([claude]);
        expect(gate.breach(claude, T0 + 45 * MIN, 'again')).toMatchObject({ state: 'retrying', nextTryAtMs: T0 + 75 * MIN, attempt: 3 });
    });

    it('a try that goes through (ok) clears the backoff; the next breach starts again at its first step', () => {
        const gate = new RateLimitGate({ marginMs: 0, retryBackoffMs: [15 * MIN, 30 * MIN] });
        gate.breach(claude, T0, 'limit');
        expect(gate.due(T0 + 15 * MIN)).toEqual([claude]);
        // The try is in flight: nothing is held, so it is open — a past "next try" said as retrying re-armed a 0 ms wake
        // forever (genie#1195). The step is still counted until the try says how it went.
        expect(gate.view(claude, T0 + 15 * MIN)).toEqual({ state: 'open' });
        gate.ok(claude);
        expect(gate.view(claude, T0 + 16 * MIN)).toEqual({ state: 'open' });
        expect(gate.breach(claude, T0 + 20 * MIN, 'limit')).toMatchObject({ attempt: 1, nextTryAtMs: T0 + 35 * MIN });
    });

    it('an ALLOWED reading on every window ends a no-reset backoff: the held login is due at once, the next breach is step 1', () => {
        const gate = new RateLimitGate({ marginMs: 0, retryBackoffMs: [15 * MIN, 30 * MIN] });
        gate.breach(codex, T0, 'limit');
        gate.report(codex, [{ window: 'primary', status: 'allowed', resetsAtMs: T0 + 300 * MIN }, { window: 'secondary', status: 'allowed', resetsAtMs: T0 + 9000 * MIN }], T0 + MIN, null);
        expect(gate.view(codex, T0 + MIN)).toEqual({ state: 'open' });
        expect(gate.due(T0 + MIN)).toEqual([codex]);
        expect(gate.due(T0 + 2 * MIN)).toEqual([]);
        expect(gate.breach(codex, T0 + 3 * MIN, 'limit')).toMatchObject({ attempt: 1, nextTryAtMs: T0 + 18 * MIN });
    });

    it('CONTROL: a reading with one window still rejected (no reset) keeps the backoff counting', () => {
        const gate = new RateLimitGate({ marginMs: 0, retryBackoffMs: [15 * MIN, 30 * MIN] });
        gate.breach(codex, T0, 'limit');
        gate.report(codex, [{ window: 'primary', status: 'allowed', resetsAtMs: T0 + 300 * MIN }, { window: 'secondary', status: 'rejected', resetsAtMs: null }], T0 + MIN, null);
        expect(gate.view(codex, T0 + MIN)).toMatchObject({ state: 'retrying', attempt: 2 });
    });

    it('a reset in the past and due() agree: nothing is due before the margin has run from now', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 - 10 * MIN }], T0, null);
        expect(gate.due(T0 + MIN)).toEqual([]);
        expect(gate.due(T0 + 2 * MIN)).toEqual([claude]);
    });

    it('a breach while a structured pause is known keeps the KNOWN reset (no backoff over it)', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 90 * MIN }], T0, null);
        expect(gate.breach(claude, T0 + MIN, 'You have hit your limit')).toMatchObject({ state: 'paused', resumeAtMs: T0 + 92 * MIN });
    });

    it('needs-person: no timer, never due, until the person resumes', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        expect(gate.report(claude, [{ window: 'five_hour', status: 'needs-person', resetsAtMs: null }], T0, 'out of usage credits')).toEqual({ state: 'needs-person', message: 'out of usage credits' });
        expect(gate.due(T0 + 100_000 * MIN)).toEqual([]);
        gate.resumeNow(claude);
        expect(gate.view(claude, T0)).toEqual({ state: 'open' });
    });

    it('resumeNow opens a paused login at once (the person’s "Resume now")', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 90 * MIN }], T0, null);
        gate.resumeNow(claude);
        expect(gate.view(claude, T0)).toEqual({ state: 'open' });
        expect(gate.due(T0 + 100 * MIN)).toEqual([]); // already open: nothing to resume later
    });

    it('a reset already in the past still waits the margin (the provider needs a moment to refresh)', () => {
        const gate = new RateLimitGate({ marginMs: 2 * MIN });
        expect(gate.report(claude, [{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 - MIN }], T0, null)).toMatchObject({ state: 'paused', resumeAtMs: T0 + 2 * MIN });
    });

    it('the default margin is 2 minutes', () => {
        const gate = new RateLimitGate();
        expect(gate.report(claude, [{ window: 'w', status: 'rejected', resetsAtMs: T0 }], T0, null)).toMatchObject({ resumeAtMs: T0 + 2 * MIN });
    });
});
