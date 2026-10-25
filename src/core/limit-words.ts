import { clockAmPm, fullDateTime } from './clock-words.js';
import type { GateView } from './rate-limit-gate.js';

/**
 * ONE WORDING FOR A HELD LOGIN, wherever an agent is shown (Tynn #794): the Dashboard row, the chat's context line, the
 * Agent view. Until when it resumes; the next try on the no-reset backoff; or that it needs the person, in the
 * provider's own words when it gave any. `null` when the login is open or nothing was reported — never a guessed time.
 */
export function limitWords(limit: GateView | null | undefined): string | null {
    if (!limit) return null;
    switch (limit.state) {
        case 'paused':
            return `rate limit · resumes ${clockAmPm(limit.resumeAtMs)}`;
        case 'retrying':
            return `rate limit · next try ${clockAmPm(limit.nextTryAtMs)}`;
        case 'needs-person':
            return limit.message ? `rate limit · needs you: ${limit.message}` : 'rate limit · needs you';
        default:
            return null;
    }
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
