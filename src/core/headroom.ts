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
    /**
     * EVERY window the reading carried (genie#1268), the binding one included, in the provider's order: Claude's
     * `windows` (`five_hour`, `seven_day`, model windows such as `seven_day_opus`), codex's `primary` and `secondary`.
     */
    readonly windows: readonly LimitWindow[];
}

/**
 * One reported window. Neither provider reports an absolute limit — Claude a utilization fraction, codex a percent — so
 * this is the share USED as reported (it passes 100 in overage) and the share LEFT; never a count made up from them.
 */
export interface LimitWindow {
    /** `5h`, `7d`, `7d opus`. */
    readonly window: string;
    readonly usedPct: number;
    readonly leftPct: number;
    readonly resetsAtMs: number;
    readonly over: boolean;
}

export const RATE_LIMIT_META = 'particle.academy/rate_limit';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, twelve: 12, twenty_four: 24 };

/** `five_hour` → `5h`; a model window `seven_day_opus` → `7d opus`; anything else, its words. */
function claudeLabel(key: string): string {
    const m = /^([a-z_]+?|\d+)_(hour|day|week)s?(?:_([a-z0-9_]+))?$/.exec(key);
    if (!m) return key.replace(/_/g, ' ');
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORDS[m[1]!];
    if (n === undefined) return key.replace(/_/g, ' ');
    const label = `${n}${m[2] === 'hour' ? 'h' : m[2] === 'day' ? 'd' : 'w'}`;
    return m[3] ? `${label} ${m[3].replace(/_/g, ' ')}` : label;
}

function minutesLabel(mins: number): string {
    return mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}

function limitWindow(used: number, window: string, resetsAtMs: number, overage: boolean): LimitWindow {
    return { window, usedPct: Math.round(used), leftPct: Math.max(0, Math.round(100 - used)), resetsAtMs, over: overage || used > 100 };
}

function from(binding: LimitWindow, plan: string | null, windows: readonly LimitWindow[]): Headroom {
    return { plan, window: binding.window, leftPct: binding.leftPct, resetsAtMs: binding.resetsAtMs, over: binding.over, windows };
}

/** The headroom in a rate-limit `_meta` value, or `null` when it is neither shape. */
export function headroomFromMeta(value: unknown): Headroom | null {
    if (!isRecord(value)) return null;
    const windows = value['windows'];
    if (isRecord(windows)) {
        const type = typeof value['rateLimitType'] === 'string' ? (value['rateLimitType'] as string) : null;
        const key = type !== null && isRecord(windows[type]) ? type : Object.keys(windows).find((k) => isRecord(windows[k]));
        if (key === undefined) return null;
        const overage = value['isUsingOverage'] === true;
        const read = (k: string): LimitWindow | null => {
            const w = windows[k];
            if (!isRecord(w)) return null;
            const u = num(w['utilization']);
            const reset = num(w['resetsAtMs']) ?? (k === key ? num(value['resetsAtMs']) : null);
            // Overage is the binding window's state; another window is over only when its own figure says so.
            return u === null || reset === null ? null : limitWindow(u * 100, claudeLabel(k), reset, k === key && overage);
        };
        const binding = read(key);
        if (binding === null) return null;
        return from(binding, null, Object.keys(windows).map(read).filter((w): w is LimitWindow => w !== null));
    }
    const read = (w: unknown): LimitWindow | null => {
        if (!isRecord(w)) return null;
        const used = num(w['usedPercent']);
        const mins = num(w['windowDurationMins']);
        const reset = num(w['resetsAtMs']);
        return used === null || mins === null || reset === null ? null : limitWindow(used, minutesLabel(mins), reset, false);
    };
    const binding = read(isRecord(value['primary']) ? value['primary'] : value['secondary']);
    if (binding === null) return null;
    const all = [read(value['primary']), read(value['secondary'])].filter((w): w is LimitWindow => w !== null);
    return from(binding, typeof value['planType'] === 'string' ? (value['planType'] as string) : null, all);
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

/** `claude` → `Claude`. */
function providerWord(provider: string): string {
    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * One line of the hover on a provider's Dashboard pill (genie#1268): a reported window's share used, its share left, and
 * the reset as the full date with am/pm (#1191's wording).
 */
export function windowDetail(w: LimitWindow): string {
    return `${w.window} window: ${w.usedPct}% used · ${w.over ? 'over the limit' : `${w.leftPct}% left`} · resets ${fullDateTime(w.resetsAtMs)}`;
}

/** `7d` → `this week`; `5h` → `in the 5-hour window`; anything else → `in the 7d opus window`. */
function windowWords(window: string): string {
    if (window === '7d' || window === '1w') return 'this week';
    const hours = /^(\d+)h$/.exec(window);
    return hours ? `in the ${hours[1]}-hour window` : `in the ${window} window`;
}

/** The sidebar's dot (genie#1268). */
export interface RateLimitAlert {
    readonly level: 'warning' | 'danger';
    /** For a screen reader and the hover: each low window, e.g. `Claude: 8% left this week`. */
    readonly label: string;
}

/** "Once a rate limit hits 30%" — 30% LEFT — the dot shows; "turns red at 10%". */
export const LIMIT_WARNING_LEFT_PCT = 30;
export const LIMIT_DANGER_LEFT_PCT = 10;

/**
 * The dot across every provider's every reported window: the warning at 30% or less left, the danger at 10% or less or
 * spent; `null` once every window is above 30% left.
 */
export function rateLimitAlert(limits: Readonly<Record<string, Headroom>>): RateLimitAlert | null {
    let danger = false;
    const low: string[] = [];
    for (const provider of Object.keys(limits).sort()) {
        for (const w of limits[provider]!.windows) {
            if (!w.over && w.leftPct > LIMIT_WARNING_LEFT_PCT) continue;
            if (w.over || w.leftPct <= LIMIT_DANGER_LEFT_PCT) danger = true;
            low.push(`${providerWord(provider)}: ${w.over ? `over the limit ${windowWords(w.window)}` : `${w.leftPct}% left ${windowWords(w.window)}`}`);
        }
    }
    return low.length === 0 ? null : { level: danger ? 'danger' : 'warning', label: low.join('; ') };
}
