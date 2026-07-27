/**
 * Hand-rolled 5-field cron parser + evaluator for Host-layer scheduled tasks.
 *
 *     ┌───── minute        0-59
 *     │ ┌─── hour          0-23
 *     │ │ ┌─ day-of-month  1-31
 *     │ │ │ ┌ month        1-12
 *     │ │ │ │ ┌ day-of-week 0-7 (0 and 7 are both Sunday)
 *     * * * * *
 *
 * Each field supports `*`, a literal value, a range `a-b`, a step `* / n` or
 * `a-b/n` / `a/n`, and comma-separated lists of any of those.
 *
 * DELIBERATELY dependency-free: the scheduler runs in the Host main process,
 * where every extra package is another thing to keep patched and another thing
 * that can break an update. The whole surface is ~200 lines and fully unit
 * tested (`__tests__/cron.test.ts`), which is cheaper than a dependency.
 *
 * TIMEZONE: everything is the HOST's local time. A user who schedules "09:00"
 * means 09:00 where the Host runs, so every date is built with the local
 * `new Date(y, m, d, h, mi)` constructor — never a UTC conversion. Across a DST
 * jump the platform normalizes a non-existent local time forward, which is the
 * behaviour a wall-clock schedule should have.
 */

/** A parsed expression: the expanded, sorted set of matching values per field. */
export interface CronFields {
    minutes: number[];
    hours: number[];
    daysOfMonth: number[];
    months: number[];
    /** 0-6, Sunday first. A literal `7` normalizes onto `0`. */
    daysOfWeek: number[];
    /** True when day-of-month does NOT cover every day — see {@link dayMatches}. */
    domRestricted: boolean;
    /** True when day-of-week does NOT cover every day — see {@link dayMatches}. */
    dowRestricted: boolean;
}

interface FieldSpec {
    min: number;
    max: number;
    /** Day-of-week only: fold a literal 7 onto 0 (both mean Sunday). */
    wrapSeven?: boolean;
}

const MINUTE: FieldSpec = { min: 0, max: 59 };
const HOUR: FieldSpec = { min: 0, max: 23 };
const DOM: FieldSpec = { min: 1, max: 31 };
const MONTH: FieldSpec = { min: 1, max: 12 };
const DOW: FieldSpec = { min: 0, max: 7, wrapSeven: true };

/**
 * How far forward {@link nextFireAfter} will look before giving up. Five years
 * of days comfortably covers the sparsest legitimate schedule (Feb 29 — at most
 * 8 years apart in theory, 4 in every year this software will run) while still
 * terminating fast on an impossible one like `0 0 30 2 *`.
 */
const MAX_LOOKAHEAD_DAYS = 366 * 5;

/** Expand one comma-separated field into its sorted value set, or null if bad. */
function parseField(raw: string, spec: FieldSpec): number[] | null {
    const text = raw.trim();
    if (!text) return null;
    const out = new Set<number>();
    for (const part of text.split(',')) {
        const values = parsePart(part.trim(), spec);
        if (!values) return null;
        for (const v of values) out.add(v);
    }
    if (out.size === 0) return null;
    return [...out].sort((a, b) => a - b);
}

/** One list element: `*`, `a`, `a-b`, or any of those with a `/step` suffix. */
function parsePart(part: string, spec: FieldSpec): number[] | null {
    if (!part) return null;

    let body = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
        body = part.slice(0, slash);
        const stepText = part.slice(slash + 1);
        if (!/^\d+$/.test(stepText)) return null;
        step = Number(stepText);
        if (step < 1) return null;
    }

    let lo: number;
    let hi: number;
    if (body === '*') {
        lo = spec.min;
        hi = spec.max;
    } else if (/^\d+$/.test(body)) {
        lo = Number(body);
        // A bare value with a step reads as "from here to the end of the field"
        // (`5/10` = 5,15,25,…) — the common cron extension. Without a step it is
        // the single value.
        hi = slash === -1 ? lo : spec.max;
    } else {
        const m = /^(\d+)-(\d+)$/.exec(body);
        if (!m) return null;
        lo = Number(m[1]);
        hi = Number(m[2]);
        if (lo > hi) return null;
    }
    if (lo < spec.min || hi > spec.max) return null;

    const out: number[] = [];
    for (let v = lo; v <= hi; v += step) {
        out.push(spec.wrapSeven && v === 7 ? 0 : v);
    }
    return out;
}

/**
 * Parse a 5-field expression into its expanded value sets. Returns null — never
 * throws — for anything malformed, so every caller has exactly one failure mode
 * to handle.
 */
export function parseCron(expr: string): CronFields | null {
    if (typeof expr !== 'string') return null;
    const parts = expr.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 5) return null;

    const minutes = parseField(parts[0], MINUTE);
    const hours = parseField(parts[1], HOUR);
    const daysOfMonth = parseField(parts[2], DOM);
    const months = parseField(parts[3], MONTH);
    const daysOfWeekRaw = parseField(parts[4], DOW);
    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) return null;
    // 7 folded onto 0 can duplicate an explicit 0 (`0,7`), so de-dupe.
    const daysOfWeek = [...new Set(daysOfWeekRaw)].sort((a, b) => a - b);

    return {
        minutes,
        hours,
        daysOfMonth,
        months,
        daysOfWeek,
        // "Restricted" = the field does not cover EVERY day. Computed from the
        // expanded set rather than the literal `*` so `*/1` and `0-6` read as
        // unrestricted too.
        domRestricted: daysOfMonth.length < DOM.max - DOM.min + 1,
        dowRestricted: daysOfWeek.length < 7,
    };
}

/** Whether an expression is a well-formed 5-field cron. */
export function isValidCron(expr: string): boolean {
    return parseCron(expr) !== null;
}

/**
 * Does this calendar day match the date fields?
 *
 * Standard (Vixie) cron semantics: when BOTH day-of-month and day-of-week are
 * restricted the day matches if EITHER hits (a union — `0 0 1 * 1` means "the
 * 1st, and also every Monday"). When one of them is unrestricted its set covers
 * every day anyway, so the plain AND is correct.
 */
function dayMatches(f: CronFields, d: Date): boolean {
    if (!f.months.includes(d.getMonth() + 1)) return false;
    const domHit = f.daysOfMonth.includes(d.getDate());
    const dowHit = f.daysOfWeek.includes(d.getDay());
    if (f.domRestricted && f.dowRestricted) return domHit || dowHit;
    return domHit && dowHit;
}

/**
 * The next instant the expression fires, STRICTLY after `from` (never `from`
 * itself — that's what makes re-arming after a fire terminate). Seconds and
 * milliseconds are always zero. Returns null for an invalid expression or one
 * that can never occur (`0 0 30 2 *`).
 *
 * Walks day-by-day rather than minute-by-minute, so even a once-a-year schedule
 * resolves in a few hundred cheap iterations.
 */
export function nextFireAfter(expr: string, from: Date): Date | null {
    const f = parseCron(expr);
    if (!f) return null;

    // Round UP to the next whole minute: a fire is minute-granular, and starting
    // at `from`'s own minute would re-fire the occurrence we just ran.
    const start = new Date(from.getTime());
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let earliestHour = start.getHours();
    let earliestMinute = start.getMinutes();

    for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
        if (dayMatches(f, day)) {
            for (const h of f.hours) {
                if (h < earliestHour) continue;
                for (const m of f.minutes) {
                    if (h === earliestHour && m < earliestMinute) continue;
                    return new Date(
                        day.getFullYear(),
                        day.getMonth(),
                        day.getDate(),
                        h,
                        m,
                        0,
                        0,
                    );
                }
            }
        }
        // Nothing left today — start tomorrow at 00:00. Constructing from
        // (date + 1) lets the platform roll month/year boundaries for us.
        day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        earliestHour = 0;
        earliestMinute = 0;
    }
    return null;
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * A human-readable rendering of the common schedule shapes, for the Processes
 * panel. Anything exotic (or invalid) falls back to the raw expression — an
 * honest "here is exactly what you typed" beats a wrong paraphrase.
 */
export function describeCron(expr: string): string {
    if (!isValidCron(expr)) return expr;
    const [mi, hr, dom, mon, dow] = expr.trim().split(/\s+/);
    const anyDate = dom === '*' && mon === '*' && dow === '*';
    const lit = (s: string) => /^\d+$/.test(s);
    const at = (h: string, m: string) => `${pad2(Number(h))}:${pad2(Number(m))}`;

    if (mi === '*' && hr === '*' && anyDate) return 'Every minute';
    const everyN = /^\*\/(\d+)$/.exec(mi);
    if (everyN && hr === '*' && anyDate) return `Every ${everyN[1]} minutes`;
    if (lit(mi) && hr === '*' && anyDate) {
        return Number(mi) === 0 ? 'Hourly, on the hour' : `Hourly at :${pad2(Number(mi))}`;
    }
    if (lit(mi) && lit(hr)) {
        if (anyDate) return `Daily at ${at(hr, mi)}`;
        if (dom === '*' && mon === '*' && lit(dow)) {
            const day = DOW_NAMES[Number(dow) % 7];
            return `Weekly on ${day} at ${at(hr, mi)}`;
        }
        if (lit(dom) && mon === '*' && dow === '*') {
            return `Monthly on day ${Number(dom)} at ${at(hr, mi)}`;
        }
    }
    return expr;
}
