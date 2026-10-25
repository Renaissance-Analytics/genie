import { clockAmPm, fullDateTime } from './clock-words.js';
import type { StreamEvent } from './stream-event.js';
import type { TimedEvent } from './stream-view.js';

/**
 * PROVIDER HEADROOM (the board's rail: `Claude Max · 38% of 5h window · resets 16:00`). prism-acp attaches the
 * provider's rate-limit detail to a `notice` under `_meta["particle.academy/rate_limit"]`, in the provider's own
 * shape: Claude's `windows` (keyed `five_hour`, `seven_day`; `utilization` a fraction that can pass 1 in overage)
 * with the binding `rateLimitType`; codex's `primary` / `secondary` (`usedPercent`, `windowDurationMins`) and
 * `planType`. Read here into one shape: the binding window, the share LEFT, when it resets, and whether the window
 * is already spent past its allowance — said as such, never clamped into a number the provider did not send.
 */
export interface Headroom {
    /** The plan, when the provider named it (codex's `planType`); `null` otherwise — never guessed. */
    readonly plan: string | null;
    /** `5h`, `7d` — the binding window. */
    readonly window: string;
    readonly leftPct: number;
    readonly resetsAtMs: number;
    readonly over: boolean;
}

export const RATE_LIMIT_META = 'particle.academy/rate_limit';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, twelve: 12, twenty_four: 24 };

function claudeLabel(key: string): string {
    const m = /^([a-z_]+?|\d+)_(hour|day|week)s?$/.exec(key);
    if (!m) return key.replace(/_/g, ' ');
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORDS[m[1]!];
    return n === undefined ? key.replace(/_/g, ' ') : `${n}${m[2] === 'hour' ? 'h' : m[2] === 'day' ? 'd' : 'w'}`;
}

function minutesLabel(mins: number): string {
    return mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}

function from(used: number, window: string, resetsAtMs: number, plan: string | null, overage: boolean): Headroom {
    return { plan, window, leftPct: Math.max(0, Math.round(100 - used)), resetsAtMs, over: overage || used > 100 };
}

/** The headroom in a rate-limit `_meta` value, or `null` when it is neither shape. */
export function headroomFromMeta(value: unknown): Headroom | null {
    if (!isRecord(value)) return null;
    const windows = value['windows'];
    if (isRecord(windows)) {
        const type = typeof value['rateLimitType'] === 'string' ? (value['rateLimitType'] as string) : null;
        const key = type !== null && isRecord(windows[type]) ? type : Object.keys(windows).find((k) => isRecord(windows[k]));
        if (key === undefined) return null;
        const w = windows[key] as Record<string, unknown>;
        const u = num(w['utilization']);
        const reset = num(w['resetsAtMs']) ?? num(value['resetsAtMs']);
        if (u === null || reset === null) return null;
        return from(u * 100, claudeLabel(key), reset, null, value['isUsingOverage'] === true);
    }
    const primary = isRecord(value['primary']) ? value['primary'] : isRecord(value['secondary']) ? value['secondary'] : null;
    if (primary === null) return null;
    const used = num(primary['usedPercent']);
    const mins = num(primary['windowDurationMins']);
    const reset = num(primary['resetsAtMs']);
    if (used === null || mins === null || reset === null) return null;
    return from(used, minutesLabel(mins), reset, typeof value['planType'] === 'string' ? (value['planType'] as string) : null, false);
}

/** The latest reading in the ledger, or `null` — no reading, no row. */
export function headroomOf(rows: readonly TimedEvent[]): Headroom | null {
    for (let i = rows.length - 1; i >= 0; i--) {
        const e: StreamEvent = rows[i]!.event;
        if (e.kind === 'notice' && e.headroom) return e.headroom;
    }
    return null;
}


/** `pro · 60% of 5h window left · resets 6:30 PM`; spent past the allowance: `over the 5h window · resets 4:00 PM`. */
export function headroomLine(h: Headroom): string {
    const share = h.over ? `over the ${h.window} window` : `${h.leftPct}% of ${h.window} window left`;
    return `${h.plan ? `${h.plan} · ` : ''}${share} · resets ${clockAmPm(h.resetsAtMs)}`;
}

/** The hover on that line: the full date and time the window resets. */
export function headroomTitle(h: Headroom): string {
    return `Resets ${fullDateTime(h.resetsAtMs)}`;
}
