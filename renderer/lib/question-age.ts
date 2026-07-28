/**
 * "When did this question come in?" — the relative age the PendingQuestions
 * inbox shows per request (genie #60).
 *
 * Pure + framework-free so it's unit-tested in the node vitest env (the renderer
 * has no jsdom harness), and deliberately coarse: the owner needs "is an agent
 * freshly blocked or has it been stuck all afternoon", not a precise duration.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format `createdAt` (ms epoch) as an age relative to `now`, or null when there
 * is nothing trustworthy to show — a question forwarded from a host on an older
 * build carries no stamp, and rendering that as "56 years ago" (epoch 0) would
 * be worse than rendering nothing. A stamp slightly in the FUTURE is normal
 * (host and client clocks differ) and reads as "just now" rather than negative.
 */
export function formatQuestionAge(createdAt: number | undefined, now: number): string | null {
    if (!createdAt || !Number.isFinite(createdAt)) return null;
    const ms = now - createdAt;
    if (ms < MINUTE) return 'just now';
    if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
    if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
    return `${Math.floor(ms / DAY)}d ago`;
}
