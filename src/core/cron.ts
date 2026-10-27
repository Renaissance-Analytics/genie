/**
 * CRON — the standard five fields (minute hour day-of-month month day-of-week), evaluated on a WALL CLOCK.
 *
 * This is what a Flow's `schedule_trigger` carries (`cron` + `timezone`). Supported: `*`, numbers,
 * lists (`8,20`), ranges (`1-5`), steps (`*\/5`, `1-30/10`), Sunday as 0 or 7. Not supported, and
 * therefore REFUSED rather than approximated: names (`MON`, `JAN`), `L`/`W`/`#`, seconds.
 *
 * ## Which clock
 *
 * No timezone = THIS MACHINE'S LOCAL TIME, as Genie 1 evaluated every schedule: a person who writes
 * "09:00" means nine o'clock where they are, every day, summer and winter. Genie 2 used to evaluate
 * everything in UTC, so a 09:00 job ran at 10:00 or 11:00 local depending on the season — a schedule
 * evaluated in the wrong zone fires at the wrong hour every day and looks fine from across the room.
 * An IANA name (`Europe/Amsterdam`, `UTC`) evaluates in that zone; a name the platform does not know
 * is refused (`null`), never quietly read as UTC.
 *
 * ## Daylight saving — Genie 1's rule, which is the platform's own
 *
 * The match is on the WALL clock, each wall-clock minute at most once:
 * - a time that does not exist (the spring-forward gap, 02:30 when 02:00 jumps to 03:00) runs at the
 *   same distance past the jump — 03:30 — as `new Date(y, m, d, 2, 30)` normalises it;
 * - a time that happens twice (the autumn fall-back, 01:30 twice) runs at its FIRST occurrence only.
 * So a daily job runs once a day across both changes, and an every-30-minutes job does not run the
 * repeated hour a second time.
 */

interface Field {
    readonly values: ReadonlySet<number>;
}

interface Parsed {
    readonly minute: Field;
    readonly hour: Field;
    readonly dayOfMonth: Field;
    readonly month: Field;
    readonly dayOfWeek: Field;
    readonly domWild: boolean;
    readonly dowWild: boolean;
}

function parseField(text: string, min: number, max: number): Field | null {
    const values = new Set<number>();
    for (const part of text.split(',')) {
        const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (!m) return null;
        const [, range, stepText] = m;
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!(step >= 1)) return null;
        let lo: number;
        let hi: number;
        if (range === '*') {
            lo = min;
            hi = max;
        } else {
            const [a, b] = range!.split('-').map(Number);
            lo = a!;
            hi = b ?? a!;
            if (stepText !== undefined && b === undefined) hi = max;
        }
        if (lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) values.add(v);
    }
    return { values };
}

export function parseCron(expr: string): Parsed | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const minute = parseField(parts[0]!, 0, 59);
    const hour = parseField(parts[1]!, 0, 23);
    const dayOfMonth = parseField(parts[2]!, 1, 31);
    const month = parseField(parts[3]!, 1, 12);
    const dow = parseField(parts[4]!, 0, 7);
    if (!minute || !hour || !dayOfMonth || !month || !dow) return null;
    // Sunday is 0 or 7.
    const dowValues = new Set([...dow.values].map((v) => (v === 7 ? 0 : v)));
    return {
        minute,
        hour,
        dayOfMonth,
        month,
        dayOfWeek: { values: dowValues },
        domWild: parts[2] === '*',
        dowWild: parts[4] === '*',
    };
}

/**
 * A clock the evaluator walks. `wall` maps an instant to its wall-clock reading, encoded as the ms of
 * that reading read AS IF it were UTC (so the UTC getters give its fields); `instant` maps a wall-clock
 * reading back to the instant it names, with the gap and repeat rules above.
 */
interface Zone {
    wall(instant: number): number;
    instant(wall: number): number;
}

const UTC_ZONE: Zone = { wall: (t) => t, instant: (w) => w };

/** The machine's local time, through the platform's own local Date — Genie 1's evaluator, exactly. */
const LOCAL_ZONE: Zone = {
    wall(t) {
        const d = new Date(t);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
    },
    instant(w) {
        const d = new Date(w);
        // The local constructor IS the rule: a gap moves forward by the jump, a repeat takes the first.
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()).getTime();
    },
};

const DAY_MS = 86_400_000;
const named = new Map<string, Zone | null>();

/** An IANA zone through Intl, with the SAME gap/repeat rule as the local constructor. */
function namedZone(name: string): Zone | null {
    if (named.has(name)) return named.get(name)!;
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone: name,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });
    } catch {
        named.set(name, null);
        return null;
    }
    /** Wall-clock minus instant, in ms, at `t` (whole seconds: no zone offset has a fraction of one). */
    const offset = (t: number): number => {
        const whole = Math.floor(t / 1000) * 1000;
        const parts: Record<string, number> = {};
        for (const p of format.formatToParts(new Date(whole))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
        // Some engines still print midnight as 24 under h23; it is 0.
        const hour = parts.hour === 24 ? 0 : parts.hour!;
        return Date.UTC(parts.year!, parts.month! - 1, parts.day!, hour, parts.minute!, parts.second!) - whole;
    };
    const zone: Zone = {
        wall: (t) => t + offset(t),
        instant(w) {
            // The offsets a day either side bracket at most one change (no zone changes twice in two days).
            const before = offset(w - DAY_MS);
            const after = offset(w + DAY_MS);
            const early = w - before;
            const late = w - after;
            const earlyOk = offset(early) === before;
            const lateOk = offset(late) === after;
            if (earlyOk && lateOk) return Math.min(early, late); // the repeated hour: its first occurrence
            if (earlyOk) return early;
            if (lateOk) return late;
            return w - before; // the gap: the same distance past the jump, as the local constructor does
        },
    };
    named.set(name, zone);
    return zone;
}

function zoneOf(timezone: string | undefined): Zone | null {
    if (timezone === undefined || timezone.trim() === '') return LOCAL_ZONE;
    if (timezone === 'UTC' || timezone === 'Etc/UTC') return UTC_ZONE;
    return namedZone(timezone);
}

/** Why a schedule's timezone cannot be honoured, or `null` when it can (none = this machine's local time). */
export function timeZoneProblem(timezone: string | undefined): string | null {
    if (zoneOf(timezone) !== null) return null;
    return `timezone ${timezone} is not one Genie knows — use an IANA name like Europe/Amsterdam, or leave it empty for this machine's local time`;
}

const SEARCH_LIMIT_YEARS = 5;
/** More than any daylight-saving jump there is (most are 1 h; a few zones have used 2 h). */
const GAP_LOOKBACK_MS = 3 * 60 * 60 * 1000;

/**
 * The first instant strictly after `fromMs` whose wall-clock reading matches, on the zone's wall clock
 * (none = this machine's local time) — or `null` for an invalid expression, an unknown timezone, or a
 * rule that cannot fire within five years.
 */
export function nextCronAfter(expr: string, fromMs: number, timezone: string | undefined): number | null {
    const zone = zoneOf(timezone);
    if (!zone) return null;
    const p = parseCron(expr);
    if (!p) return null;

    // Walk the WALL clock with the UTC getters (the encoding above), from the minute after the reading of `from` LESS
    // `GAP_LOOKBACK_MS`. A time in the spring gap (02:30 when 02:00 jumps to 03:00) runs at its normalised instant, 03:30 —
    // which the wall reads only AFTER 02:30 has gone by. Walking from `from`'s own reading (03:10, say) passed 02:30
    // already, so a plan made between the jump and 03:30 (a launch, an edit, any re-plan) lost that day's run to the next.
    // Starting earlier changes nothing else: every match at or before `from` is skipped below, and wall order is instant
    // order (the repeated autumn hour maps to its first occurrence only).
    const t = new Date(zone.wall(fromMs - GAP_LOOKBACK_MS));
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    const limit = t.getTime() + SEARCH_LIMIT_YEARS * 366 * DAY_MS;

    while (t.getTime() <= limit) {
        if (!p.month.values.has(t.getUTCMonth() + 1)) {
            t.setUTCMonth(t.getUTCMonth() + 1, 1);
            t.setUTCHours(0, 0, 0, 0);
            continue;
        }
        // Standard cron: when both day fields are restricted, EITHER matching counts.
        const domOk = p.dayOfMonth.values.has(t.getUTCDate());
        const dowOk = p.dayOfWeek.values.has(t.getUTCDay());
        const dayOk = p.domWild && p.dowWild ? true : p.domWild ? dowOk : p.dowWild ? domOk : domOk || dowOk;
        if (!dayOk) {
            t.setUTCDate(t.getUTCDate() + 1);
            t.setUTCHours(0, 0, 0, 0);
            continue;
        }
        if (!p.hour.values.has(t.getUTCHours())) {
            t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
            continue;
        }
        if (!p.minute.values.has(t.getUTCMinutes())) {
            t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
            continue;
        }
        const at = zone.instant(t.getTime());
        // A reading `from` already passed — the second pass through a repeated hour, whose matches were
        // taken at their first occurrence — is not a run: keep walking.
        if (at > fromMs) return at;
        t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    }
    return null;
}
