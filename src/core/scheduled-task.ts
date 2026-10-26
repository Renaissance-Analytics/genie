import { parseCron } from './cron.js';

/**
 * A SCHEDULED TASK — a background process with a schedule (genie#1204; the owner, 2026-10-26: "a scheduled command is a
 * BG Process in a workspace, just with a schedule"). Genie 1's model, kept: a `terminal_specs` process row whose meta
 * carried `schedule` (five-field cron, this machine's local time) and `schedule_kind` — `command` runs the process,
 * `agent-nudge` hands `nudge_prompt` to an agent (main/terminal/process-scheduler.ts at v0.7.0-beta.342). The words the
 * person sees are Genie 1's (renderer/lib/schedule-view.ts, lib/process-manager.ts `processCard`, main/terminal/cron.ts
 * `describeCron`). Pure: the renderer's Processes tab reads it too.
 */

export type ScheduleKind = 'command' | 'agent-nudge';
export type LastRunStatus = 'ok' | 'failed' | 'skipped';

/** What a kept process carries when it is a scheduled task. */
export interface ProcessSchedule {
    readonly cron: string;
    readonly kind: ScheduleKind;
    /** agent-nudge: the text each fire hands the agent. */
    readonly prompt?: string;
    /** agent-nudge: the agent, by its inbox address. */
    readonly agent?: string;
    readonly lastRunAt?: number;
    readonly lastRunStatus?: LastRunStatus;
}

/** Why this schedule could never run, or null. Checked before anything is kept (and before an agent's request is put to the person). */
export function scheduleProblem(schedule: { cron: string; kind?: string; prompt?: string | undefined; agent?: string | undefined }, command: string): string | null {
    const cron = schedule.cron.trim();
    if (parseCron(cron) === null) return `"${cron}" is not a schedule Genie can evaluate: five fields, minute hour day-of-month month day-of-week — e.g. "0 3 * * *"`;
    const kind = schedule.kind ?? 'command';
    if (kind === 'agent-nudge') {
        if (!schedule.prompt?.trim()) return 'an agent-nudge task needs `prompt` — the text delivered to the agent on each fire';
        if (!schedule.agent?.trim()) return 'an agent-nudge task needs `agent` — who to nudge (an inbox address)';
        return null;
    }
    if (kind !== 'command') return `"${kind}" is not a kind of scheduled task Genie runs (command or agent-nudge)`;
    if (!command.trim()) return 'a scheduled task needs a command to run';
    return null;
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A cron in words — Genie 1's `describeCron` (main/terminal/cron.ts:232-256): what it says, or the expression itself. */
export function describeSchedule(expr: string): string {
    if (parseCron(expr.trim()) === null) return expr;
    const [mi = '', hr = '', dom = '', mon = '', dow = ''] = expr.trim().split(/\s+/);
    const anyDate = dom === '*' && mon === '*' && dow === '*';
    const lit = (s: string) => /^\d+$/.test(s);
    const at = (h: string, m: string) => `${pad2(Number(h))}:${pad2(Number(m))}`;
    if (mi === '*' && hr === '*' && anyDate) return 'Every minute';
    const everyN = /^\*\/(\d+)$/.exec(mi);
    if (everyN && hr === '*' && anyDate) return `Every ${everyN[1]} minutes`;
    if (lit(mi) && hr === '*' && anyDate) return Number(mi) === 0 ? 'Hourly, on the hour' : `Hourly at :${pad2(Number(mi))}`;
    if (lit(mi) && lit(hr)) {
        if (anyDate) return `Daily at ${at(hr, mi)}`;
        if (dom === '*' && mon === '*' && lit(dow)) return `Weekly on ${DOW_NAMES[Number(dow) % 7]} at ${at(hr, mi)}`;
        if (lit(dom) && mon === '*' && dow === '*') return `Monthly on day ${Number(dom)} at ${at(hr, mi)}`;
    }
    return expr;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Elapsed time FLOORS, time-until ROUNDS (Genie 1's schedule-view.ts `coarse`). */
function coarse(ms: number, round: (n: number) => number): string {
    if (ms < HOUR) return `${Math.max(1, round(ms / MIN))} min`;
    if (ms < DAY) return `${round(ms / HOUR)} hr`;
    const d = round(ms / DAY);
    return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** "in 5 hr" / "due now" / "Not scheduled" (paused, asleep, or a date that never comes). */
export function formatNextRun(nextAt: number | null, now: number): string {
    if (nextAt === null) return 'Not scheduled';
    const delta = nextAt - now;
    if (delta <= 0) return 'due now';
    return `in ${coarse(delta, Math.round)}`;
}

/** "Ran 1 min ago" / "Failed 3 hr ago" / "Skipped just now" / "Never run". */
export function formatLastRun(lastRunAt: number | undefined, status: LastRunStatus | undefined, now: number): string {
    if (!lastRunAt) return 'Never run';
    const verb = status === 'failed' ? 'Failed' : status === 'skipped' ? 'Skipped' : 'Ran';
    const ago = Math.max(0, now - lastRunAt);
    if (ago < MIN) return `${verb} just now`;
    return `${verb} ${coarse(ago, Math.floor)} ago`;
}

/** Genie 1's preset list for a process's schedule (renderer/lib/schedule-view.ts `SCHEDULE_PRESETS`): '' = a service, 'custom' = type it. */
export const PROCESS_SCHEDULE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
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
