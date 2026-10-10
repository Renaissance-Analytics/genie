import type { StreamEvent } from './stream-event.js';

/**
 * HOW THE STREAM IS READ — the ledger's presentation decisions, with no React in sight.
 *
 * **The Stream is a ledger, not a chat transcript.** One line per event: a time, an icon, a
 * main field, a meta field. This is the single biggest divergence in the build this replaces —
 * it rendered a chat feed, which is why the screen looked nothing like the approved design
 * even though most of the data was already there.
 *
 * ## Three numbers in here are DERIVED, and each says so
 *
 * The wire does not carry them, so each is computed from something measurable and labelled as
 * what it is:
 *
 *  - **a thought's tokens** — the *rise in reported usage* across the thought's span, rendered
 *    `Δ+842 tok`. Estimating from character count was considered and rejected: that is a
 *    confident number about somebody's spend, invented here.
 *  - **a tool's duration** — wall-clock between the call and its terminal update. Absent when
 *    either end has no timestamp, and absent for a call that never finished.
 *  - **an edit's line counts** — only ever from a real diff, passed in. Never `+0 −0`, which
 *    asserts an edit that changed nothing.
 */

export type Lane = 'messages' | 'thoughts' | 'tools' | 'edits';

/** The four the design names. Not an open set — a lane the stream cannot fill is not a lane. */
export const LANES: readonly Lane[] = ['messages', 'thoughts', 'tools', 'edits'];

/**
 * An event with its arrival time and its row id.
 *
 * `at: null` is a real case — a row replayed from a thread that stored no timestamp — and it
 * is why Lanes renders a sentence rather than four empty tracks when nothing is timed. Four
 * empty tracks read as "nothing happened"; the truth is "Genie has no times for these".
 */
export interface TimedEvent {
    id: string;
    event: StreamEvent;
    at: number | null;
}

export type Tone = 'default' | 'muted' | 'violet' | 'emerald' | 'sky' | 'amber' | 'bad';

export interface LedgerRow {
    id: string;
    at: number | null;
    icon: string;
    tone: Tone;
    main: string;
    /** Rendered in `--font-mono`: commands, paths, figures. */
    mono: boolean;
    italic: boolean;
    /** Drawn as a single line. */
    clamp: boolean;
    /**
     * Whether a click opens anything.
     *
     * Separate from `clamp` deliberately. A clamped row that still expands on click is the
     * same defect with an extra step, and a thought must never expand — not on click, not
     * while streaming.
     */
    expandable: boolean;
    meta: string | null;
    metaTone: 'default' | 'bad';
    /** An edit row is tinted, so a file change is findable by scanning rather than reading. */
    tinted: boolean;
    /** Selecting this row opens the diff inspector. Only ever an edit with real arguments. */
    inspectable: boolean;
    /**
     * A short inline statement about what is MISSING from this row's data.
     *
     * `(kind not reported)` and `(arguments not reported)`. Said once, inline, rather than
     * drawn as a dash or quietly defaulted — which is the difference between a row that is
     * honest about a gap and a row that invents a category the provider never claimed.
     */
    note: string | null;
    lane: Lane | null;
}

/** Context a row cannot know about itself. All optional; absence means "not measured". */
export interface RowContext {
    durationMs?: number | undefined;
    diff?: { plus: number; minus: number; newFile: boolean } | undefined;
}

/** `8400` → `8.4k`. Thousands only above 1000, because `0.8k` is less readable than `800`. */
function thousands(n: number): string {
    return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** One line. A thought that sets its own row height is the thing the design forbids hardest. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

const TOOL_ICONS: Record<string, string> = {
    read: 'file-text',
    edit: 'pencil',
    execute: 'wrench',
    search: 'search',
    fetch: 'globe',
    think: 'brain',
    other: 'wrench',
};

function toolRow(
    row: TimedEvent,
    event: Extract<StreamEvent, { kind: 'tool' }>,
    context: RowContext,
): LedgerRow {
    const isEdit = event.toolKind === 'edit';

    // `null` kind gets its own glyph AND its own note. `other` is a category the provider can
    // claim; `null` is one it did not, and the two must not share a rendering.
    const icon = event.toolKind === null ? 'circle-help' : (TOOL_ICONS[event.toolKind] ?? 'wrench');

    const label = event.title ?? event.name ?? '(tool call)';
    const main = isEdit ? label : [event.name, event.title].filter(Boolean).join('  ') || label;

    // `rawInput === null` means the agent did not send this call's arguments — never `{}`. An
    // inspector opened on nothing is a panel that appears and says nothing, which reads as a
    // broken diff rather than as missing data.
    const hasArguments = event.rawInput !== null && event.rawInput !== undefined;

    const note =
        event.toolKind === null ? '(kind not reported)'
        : isEdit && !hasArguments ? '(arguments not reported)'
        : null;

    return {
        id: row.id,
        at: row.at,
        icon,
        tone: isEdit ? 'emerald' : 'muted',
        main,
        mono: true,
        italic: false,
        clamp: true,
        expandable: false,
        meta: metaFor(event, context, isEdit),
        metaTone: event.status === 'failed' ? 'bad' : 'default',
        tinted: isEdit,
        inspectable: isEdit && hasArguments,
        note,
        lane: isEdit ? 'edits' : 'tools',
    };
}

function metaFor(
    event: Extract<StreamEvent, { kind: 'tool' }>,
    context: RowContext,
    isEdit: boolean,
): string | null {
    if (isEdit) {
        if (event.status === null) return null;
        if (event.status === 'failed') return 'failed';

        const diff = context.diff;
        if (!diff) return context.durationMs === undefined ? 'applied' : `applied · ${seconds(context.durationMs)}`;

        // Line counts ONLY from a real diff, and a zero side is omitted rather than printed.
        // `+0 −0` asserts an edit that changed nothing, which is a claim about the file.
        const parts = [diff.newFile ? 'new file' : 'applied'];
        const counts = [diff.plus > 0 ? `+${diff.plus}` : null, diff.minus > 0 ? `−${diff.minus}` : null]
            .filter(Boolean)
            .join(' ');
        if (counts) parts.push(counts);
        return parts.join(' · ');
    }

    // Never defaulted to `pending`: "the agent has not said" and "the agent said pending" are
    // different claims, and only one of them is in the data.
    if (event.status === null) return null;

    const word = event.status === 'failed' ? 'err' : event.status === 'completed' ? 'ok' : event.status;
    return context.durationMs === undefined ? word : `${word} · ${seconds(context.durationMs)}`;
}

function seconds(ms: number): string {
    return `${Math.round(ms / 100) / 10}s`;
}

/** `[completed, in_progress, pending]` → `2 of 3 · in progress: <the one in flight>`. */
function planRow(row: TimedEvent, entries: readonly unknown[]): LedgerRow {
    const steps = entries.flatMap((e) => {
        if (typeof e !== 'object' || e === null) return [];
        const r = e as Record<string, unknown>;
        if (typeof r['content'] !== 'string' || typeof r['status'] !== 'string') return [];
        return [{ content: r['content'], status: r['status'] }];
    });

    // A plan we could not read says only that a plan arrived. Reporting `0 of 0` would be a
    // claim about the agent's progress, made from a parse failure.
    const done = steps.filter((s) => s.status === 'completed').length;
    const doing = steps.find((s) => s.status === 'in_progress');
    const main =
        steps.length === 0 ? 'plan updated'
        : doing ? `${done} of ${steps.length} · in progress: ${doing.content}`
        : `${done} of ${steps.length}`;

    return {
        id: row.id, at: row.at, icon: 'list-checks', tone: 'sky', main,
        mono: false, italic: false, clamp: true, expandable: false,
        meta: null, metaTone: 'default', tinted: false, inspectable: false, note: null, lane: null,
    };
}

export function ledgerRow(row: TimedEvent, context: RowContext = {}): LedgerRow {
    const base = {
        id: row.id, at: row.at, mono: false, italic: false, clamp: true, expandable: false,
        meta: null as string | null, metaTone: 'default' as const, tinted: false,
        inspectable: false, note: null as string | null,
    };

    switch (row.event.kind) {
        case 'message':
            // Messages are the only thing that is ever expanded. Everything else is one line.
            return {
                ...base, icon: 'message-square', tone: 'default', main: row.event.text,
                clamp: false, expandable: true, lane: 'messages',
            };

        case 'think':
            return {
                ...base,
                icon: 'brain',
                tone: 'violet',
                main: oneLine(row.event.text),
                italic: true,
                // `expandable: false` is the design's strongest instruction, and it is about
                // reading rather than taste: content that grows and reflows as reasoning
                // arrives is the worst experience in agent UIs, and a thought is the one thing
                // that streams continuously.
                expandable: false,
                meta: row.event.tokens === null ? null : `Δ+${thousands(row.event.tokens)} tok`,
                lane: 'thoughts',
            };

        case 'tool':
            return toolRow(row, row.event, context);

        case 'usage': {
            // No cost field AT ALL when the provider reports none — codex reports none. A
            // `$0.00` would claim the turn was free.
            const parts = [`context ${thousands(row.event.used)} / ${thousands(row.event.size)}`];
            if (row.event.cost !== null) parts.push(`$${row.event.cost.toFixed(2)} this turn`);
            return { ...base, icon: 'gauge', tone: 'muted', main: parts.join(' · '), mono: true, lane: null };
        }

        case 'plan':
            return planRow(row, row.event.entries);

        case 'divider': {
            const { before, after } = row.event;
            const main =
                before !== null && after !== null
                    ? `context compacted · ${thousands(before)} → ${thousands(after)}`
                    : 'context compacted';
            return { ...base, icon: 'scissors', tone: 'amber', main, lane: null };
        }

        case 'notice':
            return { ...base, icon: 'info', tone: 'amber', main: row.event.message, lane: null };

        case 'unknown':
            // Retained rather than dropped, matching prism-acp's own policy. A protocol
            // addition silently discarded presents as an agent that went quiet, which is the
            // failure this product is least equipped to notice.
            return {
                ...base, icon: 'circle-help', tone: 'muted',
                main: `(unmapped: ${row.event.sessionUpdate})`, mono: true, lane: null,
            };
    }
}

export function laneOf(event: StreamEvent): Lane | null {
    switch (event.kind) {
        case 'message': return 'messages';
        case 'think': return 'thoughts';
        case 'tool': return event.toolKind === 'edit' ? 'edits' : 'tools';
        default: return null;
    }
}

/**
 * Filter the stream to a lane selection.
 *
 * `lanes === null` means **not filtering**, which is a different state from filtering to
 * nothing — and the difference is visible: an empty selection shows only the rows below that
 * cannot be filtered.
 *
 * **A compaction divider is never removed, in any selection.** *Silent amnesia is the top
 * cause of "why did it get stupid"*, and a reader who filtered to `edits` and so never saw
 * that eleven turns were summarised away has been misled by the filter.
 */
export function visibleRows(rows: readonly TimedEvent[], lanes: readonly Lane[] | null): readonly TimedEvent[] {
    if (lanes === null) return rows;

    return rows.filter((row) => {
        if (row.event.kind === 'divider') return true;
        const lane = laneOf(row.event);
        return lane !== null && lanes.includes(lane);
    });
}

/**
 * Put a token figure on each thought, from the rise in reported usage across its span.
 *
 * ACP carries no per-thought count. This is the only honest number available: the difference
 * between the usage reported before a thought and after it. Rendered `Δ+842 tok` so it reads
 * as the measured difference it is.
 *
 * Three cases it refuses to guess at:
 *
 *  - **no usage report on one side** — common at the start of a turn, and it must render
 *    nothing rather than borrow the next thought's number;
 *  - **several thoughts inside one span** — they cannot be told apart, so the delta is divided
 *    evenly. A stated average, where attributing the whole of it to one thought would be an
 *    invented attribution;
 *  - **a drop in usage** — which is what a compaction looks like. A naive difference would
 *    report a thought that gave tokens back.
 */
export function resolveThinkTokens(rows: readonly TimedEvent[]): readonly TimedEvent[] {
    const out = rows.map((r) => ({ ...r }));

    let lastUsageAt: number | null = null;
    let lastUsed = 0;
    let pending: number[] = [];

    const flush = (used: number): void => {
        if (lastUsageAt === null || pending.length === 0) {
            pending = [];
            return;
        }
        const delta = used - lastUsed;
        // A negative or zero delta tells us nothing about these thoughts.
        if (delta > 0) {
            const share = Math.round(delta / pending.length);
            for (const i of pending) {
                const row = out[i];
                if (row && row.event.kind === 'think') row.event = { ...row.event, tokens: share };
            }
        }
        pending = [];
    };

    out.forEach((row, i) => {
        if (row.event.kind === 'usage') {
            flush(row.event.used);
            lastUsageAt = i;
            lastUsed = row.event.used;
        } else if (row.event.kind === 'think') {
            pending.push(i);
        }
    });

    // Thoughts after the last usage report stay `null`: nothing has bracketed them yet.
    return out;
}

/**
 * Wall-clock duration per tool call, from the call to its terminal update.
 *
 * Absent for a call that never finished — an unfinished call is the signature of a turn that
 * did not complete, which is the design's error state, and a duration there would claim it
 * ended. Absent too when either end has no timestamp, rather than measuring from a time we
 * do not have.
 */
export function resolveToolDurations(rows: readonly TimedEvent[]): Map<string, number> {
    const started = new Map<string, number>();
    const durations = new Map<string, number>();

    for (const row of rows) {
        if (row.event.kind !== 'tool') continue;
        const id = row.event.toolCallId;
        const terminal = row.event.status === 'completed' || row.event.status === 'failed';

        if (!terminal) {
            if (!started.has(id) && row.at !== null) started.set(id, row.at);
            continue;
        }

        // A terminal update must NOT be able to register itself as its own start. The first
        // version of this loop set the start before checking, so a completion whose opening
        // call had no timestamp measured 0ms from itself — a tool that reported "ok · 0s",
        // which reads as instant rather than as unmeasured. The test caught it.
        if (row.at === null) continue;
        const from = started.get(id);
        if (from !== undefined) durations.set(id, row.at - from);
    }

    return durations;
}
