import { clockAmPm, fullDateTime, shortDateTime } from './clock-words.js';
import type { GateView } from './rate-limit-gate.js';

/**
 * ONE WORDING FOR A HELD LOGIN, wherever an agent is shown (Tynn #794): the Dashboard row, the chat's context line, the
 * Agent view. Until when it resumes; the next try on the no-reset backoff; or that it needs the person, in the
 * provider's own words when it gave any. `null` when the login is open or nothing was reported — never a guessed time.
 */
export function limitWords(limit: GateView | null | undefined, nowMs: number = Date.now()): string | null {
    if (!limit) return null;
    switch (limit.state) {
        case 'paused':
            return `rate limit · resumes ${when(limit.resumeAtMs, nowMs)}`;
        case 'retrying':
            return `rate limit · next try ${when(limit.nextTryAtMs, nowMs)}`;
        case 'needs-person':
            return limit.message ? `rate limit · needs you: ${limit.message}` : 'rate limit · needs you';
        default:
            return null;
    }
}

/**
 * WHEN, IN WORDS (Tynn #1089): the time alone today; with the day otherwise. A weekly limit's "resumes 7:15 PM" read as minutes
 * away, six days early.
 */
function when(at: number, nowMs: number): string {
    const a = new Date(at), n = new Date(nowMs);
    const today = a.getFullYear() === n.getFullYear() && a.getMonth() === n.getMonth() && a.getDate() === n.getDate();
    return today ? clockAmPm(at) : shortDateTime(at);
}

/**
 * The HOVER for that wording: the full date and time it resumes, or the next try (the owner, 2026-10-25). `null` when
 * there is no time to show — needing the person, open, nothing reported.
 */
export function limitTitle(limit: GateView | null | undefined): string | null {
    if (!limit) return null;
    if (limit.state === 'paused') return `Resumes ${fullDateTime(limit.resumeAtMs)}`;
    if (limit.state === 'retrying') return `Next try ${fullDateTime(limit.nextTryAtMs)}`;
    return null;
}
