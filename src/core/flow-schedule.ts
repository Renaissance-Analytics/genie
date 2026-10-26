import { clockAmPm, fullDateTime } from './clock-words.js';
import { nextCronAfter, parseCron } from './cron.js';

/**
 * THE SCHEDULE, IN WORDS (genie#1204): presets a person picks instead of writing five cron fields, and when the flow
 * next runs (this machine's local time, as the scheduler reads it — core/cron.ts).
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
    { label: 'Every 15 minutes', cron: '*/15 * * * *' },
    { label: 'Every hour', cron: '0 * * * *' },
    { label: 'Every day at 03:00', cron: '0 3 * * *' },
    { label: 'Every day at 09:00', cron: '0 9 * * *' },
    { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
    { label: 'Every Monday at 09:00', cron: '0 9 * * 1' },
];

export function nextRunWords(cron: string, nowMs: number): string {
    const c = cron.trim();
    if (c === '') return 'No schedule: it runs only when you start it.';
    if (parseCron(c) === null) return 'Not a schedule Genie can read: five fields, e.g. 0 3 * * * (03:00 every day).';
    const next = nextCronAfter(c, nowMs, undefined);
    if (next === null) return 'Not a schedule Genie can read: five fields, e.g. 0 3 * * * (03:00 every day).';
    return `Next run: ${fullDateTime(next)} (${clockAmPm(next)})`;
}
