import type { TerminalSpec } from './genie';

/**
 * DISPLAY helpers for scheduled tasks in the Processes panel.
 *
 * There is deliberately NO cron parsing in the renderer. The Host owns the
 * evaluator (main/terminal/cron.ts) and is the only thing that decides when a
 * task fires; it hands the client a formatted `description` alongside the armed
 * instant (`ScheduleInfo`). A second parser here could disagree with the one
 * that actually runs, and the UI would confidently show the wrong time — so
 * everything below is pure formatting over values the Host already computed.
 */

/** A run outcome, plus the "no run recorded" case. */
export type LastRunStatus = 'ok' | 'failed' | 'skipped';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * "1 min" / "5 hr" / "2 days" for a positive duration.
 *
 * ELAPSED time FLOORS and time-until ROUNDS, because the two read differently:
 * 90 seconds ago is "1 min ago" (a unit isn't complete until it is), while 90
 * seconds from now is better as "in 2 min" than a countdown that undersells.
 */
function coarse(ms: number, round: (n: number) => number): string {
    if (ms < HOUR) return `${Math.max(1, round(ms / MIN))} min`;
    if (ms < DAY) return `${round(ms / HOUR)} hr`;
    const d = round(ms / DAY);
    return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/**
 * When the task fires next. `nextAt` is null for anything the Host hasn't armed
 * — disabled, awaiting approval, or an expression that can never occur — and
 * saying so plainly beats an empty cell the user has to interpret.
 */
export function formatNextRun(nextAt: number | null, now: number = Date.now()): string {
    if (nextAt === null) return 'Not scheduled';
    const delta = nextAt - now;
    // At (or a hair past) the instant the timer is firing — the re-arm lands a
    // moment later, so show the transition rather than a negative countdown.
    if (delta <= 0) return 'due now';
    return `in ${coarse(delta, Math.round)}`;
}

/** Verb for a recorded outcome; a run in flight has cleared its status. */
function verb(status: LastRunStatus | undefined): string {
    if (status === 'failed') return 'Failed';
    if (status === 'skipped') return 'Skipped';
    return 'Ran';
}

/** "Ran 1 min ago" / "Failed 3 hr ago" / "Never run". */
export function formatLastRun(
    lastRunAt: number | undefined,
    status: LastRunStatus | undefined,
    now: number = Date.now(),
): string {
    if (!lastRunAt) return 'Never run';
    const ago = Math.max(0, now - lastRunAt);
    if (ago < MIN) return `${verb(status)} just now`;
    return `${verb(status)} ${coarse(ago, Math.floor)} ago`;
}

/** Dot-colour class suffix for the last outcome (`.sched-dot-ok`, …). */
export function lastRunTone(status: LastRunStatus | undefined): 'ok' | 'failed' | 'skipped' | 'none' {
    return status ?? 'none';
}

/** True when a spec is a scheduled task rather than a long-running service. */
export function isScheduledSpec(spec: Pick<TerminalSpec, 'type' | 'meta'> | undefined): boolean {
    if (!spec || spec.type !== 'process') return false;
    const expr = spec.meta?.schedule;
    return typeof expr === 'string' && expr.trim() !== '';
}

/**
 * The preset dropdown beside the raw expression field. Presets cover the shapes
 * people actually want; `custom` reveals the expression field for everything
 * else, and the leading empty value turns a scheduled task back into a plain
 * process. Deliberately a small list — a preset the user has to read twice is
 * worse than typing the expression.
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: 'No schedule (run as a service)' },
    { value: '*/5 * * * *', label: 'Every 5 minutes' },
    { value: '*/15 * * * *', label: 'Every 15 minutes' },
    { value: '0 * * * *', label: 'Hourly, on the hour' },
    { value: '0 9 * * *', label: 'Daily at 09:00' },
    { value: '0 3 * * *', label: 'Daily at 03:00' },
    { value: '0 9 * * 1-5', label: 'Weekdays at 09:00' },
    { value: '0 9 * * 1', label: 'Mondays at 09:00' },
    { value: '0 3 1 * *', label: 'Monthly, the 1st at 03:00' },
    { value: 'custom', label: 'Custom expression…' },
];
