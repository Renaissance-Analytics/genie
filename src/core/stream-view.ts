import { headroomLine } from './headroom.js';
import { computeDiff } from '@particle-academy/fancy-file-commons';
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
 * THE CHIPS ROW'S OTHER FILTERS (the board's `Usage · Approvals · Errors`): FACETS over the rows, not tracks in the
 * drawer. A usage report is a row of its own kind; an error is a tool call the agent reported `failed` or a notice at
 * level `error` — so one row can sit in a lane AND a facet, and selecting either shows it.
 *
 * Approvals: the session mints a ledger row for every DECISION on a permission request (allowed, denied, answered,
 * cancelled by a stop), so the chip counts decisions the ledger actually holds — the parked request itself is state,
 * shown by the card, until it is answered.
 */
export type Facet = 'usage' | 'approvals' | 'errors';
export const FACETS: readonly Facet[] = ['usage', 'approvals', 'errors'];
/** What one chip selects. The selection in the route (`?lane=`) is a set of these; `null` is not filtering. */
export type StreamFilter = Lane | Facet;
export const FILTERS: readonly StreamFilter[] = [...LANES, ...FACETS];

export function facetsOf(event: StreamEvent): readonly Facet[] {
    switch (event.kind) {
        case 'usage': return ['usage'];
        case 'tool': return event.status === 'failed' ? ['errors'] : [];
        case 'notice': return event.level === 'error' ? ['errors'] : [];
        case 'approval': return ['approvals'];
        default: return [];
    }
}

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
    /** Rendered as the chat renders an agent's reply — Markdown and moic's markup (genie#1263). Absent = plain text. */
    prose?: boolean | undefined;
    /** A thought's WHOLE text, drawn when the row is expanded (the owner: click the thinking line to see the reasoning). */
    full?: string | undefined;
    meta: string | null;
    /** `warn` = a tool still running (the board's amber `running`). */
    metaTone: 'default' | 'bad' | 'warn';
    /**
     * The board's `kind` column, 40px mono: the tool's name (`Bash`, `Edit`), or the row's own kind (`think`,
     * `usage`, `plan`, `compacted`). `null` for a message, and for a tool that reported no name (its note says so).
     */
    kind: string | null;
    /**
     * WHO spoke, on a message row: `you` (blue), the agent BY NAME (violet), a peer as `wren → atlas`. A field, not a
     * guess from a role — rendering `role` alone once labelled a sibling agent's message `user`, the owner's word.
     */
    who: { label: string; tone: 'you' | 'agent' | 'peer' } | null;
    /** An edit's line counts as two cells (`+42` green, `−8` red) — ONLY from a real diff; a zero side is absent. */
    plus: number | null;
    minus: number | null;
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
    /** The agent's name, so its message rows are labelled with it rather than "agent". */
    agentName?: string | undefined;
    /**
     * For a compaction divider: the highest turn that had STARTED before it (the board's `turns 1–11 summarised`).
     * Derived from the ledger's turn markers by the caller, not reported — a compaction summarises the whole context
     * up to then. Absent or 0 = no turn marker before it, and the divider says nothing about turns.
     */
    summarisedTurns?: number | undefined;
}

/**
 * Line counts from an edit's own `old_string` / `new_string` (one pair, or an `edits[]` list) — a REAL diff of what
 * the agent sent, not an estimate. `null` when the call carried no before-and-after (a `Write` reports only what it
 * wrote; `rawInput === null` reported nothing). Counted by line with a plain LCS, which is what a diff is.
 */
export function editLineCounts(rawInput: unknown): { plus: number; minus: number; newFile: boolean } | null {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    const input = rawInput as Record<string, unknown>;
    const pairs: { before: string; after: string }[] = [];
    const take = (o: Record<string, unknown>) => {
        const before = typeof o['old_string'] === 'string' ? (o['old_string'] as string) : null;
        const after = typeof o['new_string'] === 'string' ? (o['new_string'] as string) : null;
        if (before !== null || after !== null) pairs.push({ before: before ?? '', after: after ?? '' });
    };
    // Braced on purpose: without them the `else` bound to the INNER `if` inside the loop, so a plain `old_string` /
    // `new_string` pair — what Claude's Edit sends — was never taken, and every such edit counted nothing. The
    // Stream's tests fed counts through the `diffs` map and never noticed; the index column did.
    if (Array.isArray(input['edits'])) {
        for (const e of input['edits']) {
            if (typeof e === 'object' && e !== null) take(e as Record<string, unknown>);
        }
    } else {
        take(input);
    }
    if (pairs.length === 0) return null;
    // The kit's diff engine (`fancy-file-commons`), never a hand-rolled one: a line on the `after` side only was added,
    // on the `before` side only removed; `both` is unchanged.
    let plus = 0;
    let minus = 0;
    for (const p of pairs) {
        const diff = computeDiff(p.before === '' ? [] : p.before.split('\n'), p.after === '' ? [] : p.after.split('\n'));
        for (const hunk of diff.hunks) {
            for (const line of hunk.lines) {
                if (line.side === 'after') plus += 1;
                else if (line.side === 'before') minus += 1;
            }
        }
    }
    return { plus, minus, newFile: pairs.every((p) => p.before === '') };
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

    // A title that only repeats the tool's name (`Grep Grep`) is said once — and then says nothing about the call
    // (Claude's titles ARE the name), so the call's own argument stands in: `Bash  php artisan test`, an edit's path.
    const titleIsName = event.title === null || event.title === event.name;
    const argument = titleIsName ? argumentSummary(event.rawInput) : null;
    const label = (isEdit ? argument : null) ?? event.title ?? event.name ?? '(tool call)';
    const main = isEdit ? label : [event.name, titleIsName ? argument : event.title].filter(Boolean).join('  ') || label;

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
        metaTone: event.status === 'failed' ? 'bad' : event.status === 'in_progress' || event.status === 'pending' ? 'warn' : 'default',
        // The board's kind column: the tool's name. A nameless tool gets no kind — its note already says so.
        kind: event.name,
        who: null,
        // Two cells, from a REAL diff only; a zero side is absent rather than `+0`.
        plus: context.diff && context.diff.plus > 0 ? context.diff.plus : null,
        minus: context.diff && context.diff.minus > 0 ? context.diff.minus : null,
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

        // The line counts are the row's `plus` / `minus` cells (the board draws them as two coloured cells), so the
        // meta says only what happened to the file.
        return diff.newFile ? 'new file' : 'applied';
    }

    // Never defaulted to `pending`: "the agent has not said" and "the agent said pending" are
    // different claims, and only one of them is in the data.
    if (event.status === null) return null;

    // `running` (the board, in amber) for a call still in flight — never the protocol's raw `in_progress` / `pending`.
    const word = event.status === 'failed' ? 'err' : event.status === 'completed' ? 'ok' : 'running';
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
        kind: 'plan', who: null, plus: null, minus: null,
    };
}

/**
 * The one argument that says what a tool call did, from its `rawInput`: the command, the path, the pattern, the URL, the
 * query or the task's description — the first present, in that order, on one line. `null` when none is there:
 * the row then says the name alone rather than guessing or printing `{}`.
 */
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'path'] as const;
function argumentSummary(rawInput: unknown): string | null {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return null;
    const input = rawInput as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
        const value = input[key];
        if (typeof value === 'string' && value.trim() !== '') return value.replace(/\s+/g, ' ').trim();
    }
    return null;
}

export function ledgerRow(row: TimedEvent, context: RowContext = {}): LedgerRow {
    const base = {
        id: row.id, at: row.at, mono: false, italic: false, clamp: true, expandable: false,
        meta: null as string | null, metaTone: 'default' as const, tinted: false,
        inspectable: false, note: null as string | null,
        kind: null as string | null, who: null as LedgerRow['who'], plus: null as number | null, minus: null as number | null,
    };

    switch (row.event.kind) {
        case 'message': {
            // Messages are the only thing that is ever expanded. Everything else is one line.
            const agent = context.agentName ?? 'agent';
            const who: LedgerRow['who'] =
                row.event.speaker === 'you' ? { label: 'you', tone: 'you' }
                : row.event.speaker === 'peer' ? { label: `${row.event.peerName ?? 'peer'} → ${agent}`, tone: 'peer' }
                : { label: agent, tone: 'agent' };
            return {
                ...base, icon: 'message-square', tone: 'default', main: row.event.text,
                clamp: false, expandable: true, lane: 'messages', who,
                // An agent's or a peer's words are PROSE, drawn with the chat's markup (genie#1263); yours stay as typed.
                prose: row.event.speaker !== 'you',
            };
        }

        case 'think':
            return {
                ...base,
                icon: 'brain',
                tone: 'violet',
                kind: 'think',
                // Claude's API redacts reasoning by default: the thought arrives with no text. Said, not drawn blank.
                main: row.event.text.trim() === '' ? 'Reasoning not sent by the provider' : oneLine(row.event.text),
                italic: true,
                // The owner (using beta.19): a thought EXPANDS on click to its whole reasoning — over the spec's
                // "never expands". Nothing to expand when the provider sent no text.
                expandable: row.event.text.trim() !== '',
                ...(row.event.text.trim() !== '' ? { full: row.event.text } : {}),
                // The provider's own estimate when it gave one (`~`: an estimate); otherwise the derived Δ, or nothing.
                meta: typeof row.event.estimate === 'number' ? `~${thousands(row.event.estimate)} tok` : row.event.tokens === null ? null : `Δ+${thousands(row.event.tokens)} tok`,
                lane: 'thoughts',
            };

        case 'tool':
            return toolRow(row, row.event, context);

        case 'usage': {
            // No cost field AT ALL when the provider reports none — codex reports none. A
            // `$0.00` would claim the turn was free.
            const parts = [`context ${thousands(row.event.used)} / ${thousands(row.event.size)}`];
            // The turn's own input and output, when the provider sent its totals (codex); absent, never `+0`.
            if (typeof row.event.turnIn === 'number' && typeof row.event.turnOut === 'number') parts.unshift(`+${thousands(row.event.turnIn)} in · +${thousands(row.event.turnOut)} out`);
            // The TURN's cost, resolved from the running totals — never the running total under this name.
            if (typeof row.event.turnCost === 'number') parts.push(`$${row.event.turnCost.toFixed(2)} this turn`);
            return { ...base, icon: 'gauge', tone: 'muted', kind: 'usage', main: parts.join(' · '), mono: true, lane: null };
        }

        case 'plan':
            return { ...planRow(row, row.event.entries), kind: 'plan' };

        case 'divider': {
            const { before, after } = row.event;
            const sizes =
                before !== null && after !== null
                    ? `context compacted · ${thousands(before)} → ${thousands(after)}`
                    : 'context compacted';
            const n = context.summarisedTurns ?? 0;
            const main = n <= 0 ? sizes : n === 1 ? `${sizes} · turn 1 summarised` : `${sizes} · turns 1–${n} summarised`;
            return { ...base, icon: 'scissors', tone: 'amber', kind: 'compacted', main, lane: null };
        }

        case 'run':
            // Where a run of this agent began. A resumed one continues a conversation the provider holds in full —
            // including anything from before Genie recorded it, which is why the agent can remember more than is shown.
            return { ...base, icon: 'history', tone: 'muted', kind: 'run', main: row.event.resumed ? 'Run started · the agent resumed its conversation (it remembers all of it, including anything from before Genie recorded it)' : 'Run started · a new conversation', lane: null };

        case 'earlier':
            return { ...base, icon: 'history', tone: 'muted', kind: 'earlier', main: `${row.event.count.toLocaleString('en-US')} earlier recorded rows are not shown`, lane: null };

        case 'turn': {
            // The board's divider: `Turn 14 · started by you · 14:07:12` (the time is the row's own).
            const main = row.event.by === null ? `Turn ${row.event.n}` : `Turn ${row.event.n} · started by ${row.event.by}`;
            return { ...base, icon: 'play', tone: 'muted', kind: 'turn', main, lane: null };
        }

        case 'stopped':
            // The turn's end, when it was stopped: plainly `Stopped by you` — not a failure, not a finish.
            return { ...base, icon: 'square', tone: 'muted', kind: 'stopped', main: row.event.by === null ? 'Stopped' : `Stopped by ${row.event.by}`, lane: null };

        case 'finished':
            // The turn's end, when it finished (beta.33 item 10): `Turn 12 finished`.
            return { ...base, icon: 'check', tone: 'muted', kind: 'finished', main: `Turn ${row.event.n} finished`, lane: null };

        case 'prompt_delivery':
            return { ...base, icon: 'message-square', tone: 'muted', main: `Queued input ${row.event.status === 'sent' ? 'sent' : row.event.status === 'discarded' ? 'discarded' : 'kept as an unsent draft'}`, lane: null };

        case 'notice':
            // A rate-limit notice reads as its headroom line, never the provider's raw sentence with an ISO date.
            return { ...base, icon: 'info', tone: 'amber', main: row.event.headroom ? headroomLine(row.event.headroom) : row.event.message, lane: null };

        case 'approval': {
            // The decision, in one line: `allowed · php artisan migrate --force`. The tool, when the request named one.
            const e = row.event;
            const icon = e.outcome === 'allowed' ? 'check' : e.outcome === 'answered' ? 'check' : 'x';
            const tone: Tone = e.outcome === 'allowed' ? 'emerald' : e.outcome === 'denied' ? 'bad' : e.outcome === 'cancelled' ? 'muted' : 'default';
            const main = `${e.outcome}${e.tool ? ` · ${e.tool}` : ''} · ${e.question}`;
            return { ...base, icon, tone, main, mono: true, kind: 'approval', lane: null };
        }

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
export function visibleRows(rows: readonly TimedEvent[], lanes: readonly StreamFilter[] | null): readonly TimedEvent[] {
    if (lanes === null) return rows;

    return rows.filter((row) => {
        if (row.event.kind === 'divider') return true;
        // A turn marker is STRUCTURE, not content: a filtered view that lost its turns would read as one long turn.
        if (row.event.kind === 'turn') return true;
        const lane = laneOf(row.event);
        if (lane !== null && lanes.includes(lane)) return true;
        // A row is also shown for any FACET it carries: a failed call under Errors, a report under Usage.
        return facetsOf(row.event).some((facet) => lanes.includes(facet));
    });
}

/**
 * FIND IN STREAM (`/`): the rows that SAY the query — the ledger's main text, the speaker, the kind column —
 * case-insensitively. Structure rows (turn markers, the compaction divider) always stay, for the reason they survive a
 * lane filter. A blank query is no find at all and returns the rows untouched.
 */
export function findRows(rows: readonly TimedEvent[], query: string): readonly TimedEvent[] {
    const q = query.trim().toLowerCase();
    if (q === '') return rows;
    return rows.filter((row) => {
        if (row.event.kind === 'divider' || row.event.kind === 'turn') return true;
        const r = ledgerRow(row);
        return [r.main, r.who?.label ?? '', r.kind ?? ''].some((s) => s.toLowerCase().includes(q));
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
/**
 * What each turn cost, from the session's running totals: a usage report's cost minus the previous report's. The
 * first report in the thread is its own rise (nothing ran before it). A FALL — a `/clear`, or an older CLI that
 * restarted its totals on resume — says nothing about that turn, so it gets none; the next rise is measured from it.
 */
/**
 * THE STREAM'S ROWS: what the agent is DOING. Replies and your messages live in the chat (the owner, using beta.19);
 * prism-acp's debug notices (`thinking`, `session started`, `turn complete`) are not rows — and a debug notice's
 * thinking-token estimate is put on the thought before it, when that thought has none of its own.
 */
export function activityRows(rows: readonly TimedEvent[]): TimedEvent[] {
    const out: TimedEvent[] = [];
    for (const r of rows) {
        if (repeatsCompaction(out[out.length - 1]?.event, r.event)) continue;
        const e = r.event;
        if (e.kind === 'message') continue;
        if (e.kind === 'notice' && e.level === 'debug') {
            if (typeof e.estimate === 'number') {
                for (let i = out.length - 1; i >= 0; i--) {
                    const prev = out[i]!.event;
                    if (prev.kind === 'think') {
                        if (typeof prev.estimate !== 'number') out[i] = { ...out[i]!, event: { ...prev, estimate: e.estimate } };
                        break;
                    }
                }
            }
            continue;
        }
        out.push(r);
    }
    return joinToolCalls(out);
}

/**
 * A COMPACTION DIVIDER THAT ONLY REPEATS THE ONE BEFORE IT (genie#1249): the same compaction, with nothing between them
 * but what the views do not show as activity (debug notices; the chat's own rule adds nothing more). A Codex resume used
 * to re-record the thread's history, and every replayed compaction landed as a new divider: the owner's miapa showed a
 * column of "context compacted · turns 1–56 summarised" after each restart. The ledger keeps what was written; the
 * views show it once. A real compaction comes after work — a turn, a thought, a tool, a usage report — and stays.
 */
export function repeatsCompaction(previous: StreamEvent | undefined, event: StreamEvent): boolean {
    return event.kind === 'divider' && previous?.kind === 'divider'
        && previous.variant === event.variant && previous.before === event.before && previous.after === event.after;
}

/**
 * ONE ROW PER TOOL CALL. A call arrives as a `tool_call` and then its `tool_call_update`s — same toolCallId, usually no
 * name, title or kind. Each update is folded into the call's own row, where the call was: name, title, kind and input
 * from the first frame that said them, status from the latest. An update whose call never arrived keeps its own row.
 */
export function joinToolCalls(rows: readonly TimedEvent[]): TimedEvent[] {
    const out: TimedEvent[] = [];
    const at = new Map<string, number>();
    for (const r of rows) {
        const e = r.event;
        if (e.kind !== 'tool' || e.toolCallId === '') { out.push(r); continue; }
        const i = at.get(e.toolCallId);
        if (i === undefined) { at.set(e.toolCallId, out.length); out.push(r); continue; }
        const prev = out[i]!;
        const p = prev.event as typeof e;
        out[i] = { ...prev, event: { ...p, name: p.name ?? e.name, title: p.title ?? e.title, toolKind: p.toolKind ?? e.toolKind, rawInput: p.rawInput ?? e.rawInput, status: e.status } };
    }
    return out;
}

export function resolveTurnCosts(rows: readonly TimedEvent[]): readonly TimedEvent[] {
    // One rule for every running total — cost, input, output: the rise from the previous report that carried it.
    const previous: { cost: number | null; in: number | null; out: number | null } = { cost: null, in: null, out: null };
    const rise = (key: 'cost' | 'in' | 'out', now: number | null | undefined, round: number): number | null => {
        if (typeof now !== 'number') return null;
        const before = previous[key];
        previous[key] = now;
        const d = before === null ? now : now - before;
        return d >= 0 ? Math.round(d * round) / round : null;
    };
    return rows.map((r) => {
        if (r.event.kind !== 'usage') return r;
        return { ...r, event: { ...r.event, turnCost: rise('cost', r.event.cost, 1e6), turnIn: rise('in', r.event.inTokens, 1), turnOut: rise('out', r.event.outTokens, 1) } };
    });
}

/** The session's cost: the latest report's running total, or `null` when the provider reported none. */
export function sessionCostOf(rows: readonly TimedEvent[]): number | null {
    for (let i = rows.length - 1; i >= 0; i--) {
        const e = rows[i]!.event;
        if (e.kind === 'usage' && e.cost !== null) return e.cost;
    }
    return null;
}

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

/** An edit's line counts, counted once per edit input (an LCS each), not once per push. */
const editCounts = new WeakMap<object, ReturnType<typeof editLineCounts>>();
function editCountsOf(rawInput: unknown): ReturnType<typeof editLineCounts> {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    if (!editCounts.has(rawInput)) editCounts.set(rawInput, editLineCounts(rawInput));
    return editCounts.get(rawInput) ?? null;
}

/**
 * THE STREAM'S ROWS ACROSS PUSHES (genie#1340): a row the push did not change is the SAME object it was, so a memoised
 * row does not draw again. The host keeps a ledger row's object while it is unchanged and replaces it when it changes
 * (core/agent-push-wire.ts), and StreamPrep keeps its rows the same way; so a row is mapped again only when its object or
 * what its context says (duration, diff, agent name, summarised turns) changed. An edit's diff, when not given, is
 * counted from its own input once per edit.
 */
export class LedgerRowCache {
    readonly #kept = new WeakMap<TimedEvent, { durationMs: number | undefined; diff: RowContext['diff']; agentName: string | undefined; summarisedTurns: number | undefined; out: LedgerRow }>();

    row(row: TimedEvent, context: RowContext = {}): LedgerRow {
        const e = row.event;
        const diff = context.diff ?? (e.kind === 'tool' && e.toolKind === 'edit' ? editCountsOf(e.rawInput) ?? undefined : undefined);
        const kept = this.#kept.get(row);
        if (kept && kept.durationMs === context.durationMs && kept.agentName === context.agentName && kept.summarisedTurns === context.summarisedTurns && sameDiff(kept.diff, diff)) return kept.out;
        const out = ledgerRow(row, diff === undefined ? context : { ...context, diff });
        this.#kept.set(row, { durationMs: context.durationMs, diff, agentName: context.agentName, summarisedTurns: context.summarisedTurns, out });
        return out;
    }
}

function sameDiff(a: RowContext['diff'], b: RowContext['diff']): boolean {
    return a === b || (a !== undefined && b !== undefined && a.plus === b.plus && a.minus === b.minus && a.newFile === b.newFile);
}
