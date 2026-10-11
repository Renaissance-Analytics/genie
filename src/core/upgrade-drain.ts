/**
 * DRAIN BEFORE UPGRADING (§7.5) and RESTORE AFTER (§7.6) — pure.
 *
 * Before an update applies, every live agent is asked to stop, write a handoff and acknowledge. The
 * roster is the truth of that wait: who was asked, who answered, who has gone QUIET — amber after
 * `DRAIN_QUIET_MS`, so a silent agent is not mistaken for a slow one — and nothing waits past
 * `DRAIN_LIMIT_MS`. The report names who never answered. Cancel is the caller's: this module never
 * installs anything. After an upgrade, starts are spaced `RESTORE_GAP_MS` apart, in order.
 */

export const DRAIN_QUIET_MS = 20_000;
export const DRAIN_LIMIT_MS = 120_000;
export const RESTORE_GAP_MS = 3_000;

export type DrainState = 'asked' | 'answered' | 'quiet';

export interface DrainEntry {
    readonly agentId: string;
    readonly name: string;
    readonly state: DrainState;
    readonly askedAt: number;
    readonly answeredAt: number | null;
}

export interface DrainRoster {
    readonly startedAt: number;
    readonly entries: readonly DrainEntry[];
}

export function startDrain(agents: ReadonlyArray<{ id: string; name: string }>, now: number): DrainRoster {
    return { startedAt: now, entries: agents.map((a) => ({ agentId: a.id, name: a.name, state: 'asked', askedAt: now, answeredAt: null })) };
}

export function drainAnswered(roster: DrainRoster, agentId: string, now: number): DrainRoster {
    if (!roster.entries.some((e) => e.agentId === agentId && e.state !== 'answered')) return roster;
    return { ...roster, entries: roster.entries.map((e) => (e.agentId === agentId && e.state !== 'answered' ? { ...e, state: 'answered', answeredAt: now } : e)) };
}

/** Time passes: an asked agent past the quiet threshold turns quiet. Answered agents never do. */
export function drainTick(roster: DrainRoster, now: number): DrainRoster {
    return { ...roster, entries: roster.entries.map((e) => (e.state === 'asked' && now - e.askedAt >= DRAIN_QUIET_MS ? { ...e, state: 'quiet' } : e)) };
}

/** Everyone answered, or the limit passed. Never before either. */
export function drainComplete(roster: DrainRoster, now: number): boolean {
    return roster.entries.every((e) => e.state === 'answered') || now - roster.startedAt >= DRAIN_LIMIT_MS;
}

export function drainReport(roster: DrainRoster): string {
    const total = roster.entries.length;
    if (total === 0) return 'no agents were running';
    const answered = roster.entries.filter((e) => e.state === 'answered');
    const silent = roster.entries.filter((e) => e.state !== 'answered').map((e) => e.name);
    const head = `${answered.length} of ${total} agent${total === 1 ? '' : 's'} wrote a handoff`;
    if (silent.length === 0) return head;
    return `${head}; ${silent.join(', ')} never answered and ${silent.length === 1 ? 'was' : 'were'} stopped without one`;
}

/** Starts spaced at least three seconds apart, in the order given, the first at once. */
export function restoreSchedule(agentIds: readonly string[], gapMs: number = RESTORE_GAP_MS): Array<{ agentId: string; at: number }> {
    return agentIds.map((agentId, i) => ({ agentId, at: i * gapMs }));
}
