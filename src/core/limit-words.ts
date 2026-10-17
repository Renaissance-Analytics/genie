import type { GateView } from './rate-limit-gate.js';

/** `14:31`, in the viewer's locale. */
function hhmm(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * ONE WORDING FOR A HELD LOGIN, wherever an agent is shown (Tynn #794): the Dashboard row, the chat's context line, the
 * Agent view. Until when it resumes; the next try on the no-reset backoff; or that it needs the person, in the
 * provider's own words when it gave any. `null` when the login is open or nothing was reported — never a guessed time.
 */
export function limitWords(limit: GateView | null | undefined): string | null {
    if (!limit) return null;
    switch (limit.state) {
        case 'paused':
            return `rate limit · resumes ${hhmm(limit.resumeAtMs)}`;
        case 'retrying':
            return `rate limit · next try ${hhmm(limit.nextTryAtMs)}`;
        case 'needs-person':
            return limit.message ? `rate limit · needs you: ${limit.message}` : 'rate limit · needs you';
        default:
            return null;
    }
}
