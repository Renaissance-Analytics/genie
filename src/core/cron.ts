/**
 * CRON — the standard five fields (minute hour day-of-month month day-of-week), evaluated in UTC.
 *
 * This is what a Flow's `schedule_trigger` carries (`cron` + `timezone`). Supported: `*`, numbers,
 * lists (`8,20`), ranges (`1-5`), steps (`*\/5`, `1-30/10`), Sunday as 0 or 7. Not supported, and
 * therefore REFUSED rather than approximated: names (`MON`, `JAN`), `L`/`W`/`#`, seconds, and any
 * timezone other than UTC — a schedule evaluated in the wrong zone fires at the wrong hour every
 * day and looks fine from across the room.
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

const SEARCH_LIMIT_YEARS = 5;

/**
 * The first time strictly after `fromMs` that matches, in UTC — or `null` for an invalid
 * expression, an unsupported timezone, or a rule that cannot fire within five years.
 */
export function nextCronAfter(expr: string, fromMs: number, timezone: string | undefined): number | null {
    if (timezone !== undefined && timezone !== 'UTC' && timezone !== 'Etc/UTC') return null;
    const p = parseCron(expr);
    if (!p) return null;

    const t = new Date(fromMs);
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    const limit = fromMs + SEARCH_LIMIT_YEARS * 366 * 86_400_000;

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
        return t.getTime();
    }
    return null;
}
