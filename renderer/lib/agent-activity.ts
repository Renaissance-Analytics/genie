import type { AgentSession, Message, Thought, ToolCall } from '../../main/agentsession/model';
import { toolSubject } from './tool-subject';

/**
 * ACTIVITY — the surface for an agent Genie can only WATCH.
 *
 * The board: *"Activity lists terminal input and output, file writes and commits."* It is the
 * **Observed** shape's first tab (`agentViewTabs`), offered precisely because there are no
 * declared facts to show — every pty provider lands here.
 *
 * ## Why half of this module is about what it refuses to say
 *
 * Of the board's three named sources, Genie holds exactly one per agent.
 *
 * - **Terminal I/O** it does not. `project-floor.ts` measured this and wrote down the reason:
 *   *"Genie counts pty bytes per WORKSPACE (`agentPulse.note(workspaceId, bytes)`;
 *   `feedTerminalData` has the terminal id and does not pass it), so a byte-derived signal
 *   here would report a SIBLING agent's output as this agent thinking."* An earlier draft of
 *   that interface carried a `byteActive` flag and a caller wiring it to the only available
 *   source would have been wrong with nothing saying so.
 * - **Commits** it does not either. Nothing in `AgentSession` carries one, which is why
 *   `workspace-changes.ts` builds the Changes surface out of tool calls alone.
 * - **File writes** it does — but only when the agent reports its tool calls.
 *
 * What it holds instead is the traffic through its OWN channels: the AgentInbox thread and the
 * last `imDone` handoff, which the floor projector fills for all twenty-one providers.
 *
 * So the honest surface is a list of observed events **plus a statement of what could not be
 * observed**. The second half is not an apology, it is the load-bearing part: an Observed agent
 * with no mail yet has an empty list, and an empty list reads as *"this agent has done
 * nothing"* — which is the exact confident-blank this release exists to remove. A source that
 * is simply omitted is indistinguishable from a source with nothing in it.
 *
 * ## The null/zero rule, applied to a count
 *
 * `null` is "cannot see", `[]` is "none" — the model's own rule. On this panel that means a
 * number on screen is a MEASUREMENT and an absent number is an ADMISSION, and the two must
 * never be swapped: a confident `0` beside "Commits" is a claim nobody can support.
 */

/** What a row IS, which decides its icon and its tint. */
export type ActivityKind =
    /** Somebody addressed this agent — the owner, or a sibling through AgentInbox. */
    | 'heard'
    /** The agent's own voice: a reply, or its `imDone` handoff note. */
    | 'said'
    /** A piece of its reasoning. */
    | 'thought'
    /** A tool call that CHANGED a file. */
    | 'wrote'
    /** Any other tool call. Traffic, but traffic is what an observer has. */
    | 'ran';

export const ACTIVITY_KIND_ICON = {
    heard: 'inbox',
    said: 'message-square',
    thought: 'brain',
    wrote: 'pencil',
    ran: 'wrench',
} as const satisfies Record<ActivityKind, string>;

export interface ActivityRow {
    id: string;
    kind: ActivityKind;
    /** The row's text, ONE LINE always — see {@link oneLine}. */
    main: string;
    /** Who, or how a call ended. Null when there is nothing honest to add. */
    meta: string | null;
    /**
     * When Genie saw it, or **null when nobody stamped it**.
     *
     * Sanitised: a value that is not a finite, representable instant becomes null here rather
     * than reaching a render. See {@link stampOf}.
     */
    at: number | null;
    /**
     * The same instant as `at`, machine-readable for a `<time dateTime>`.
     *
     * Derived here and not in the component so the `Date` range check has a test. `new
     * Date(NaN).toISOString()` throws a RangeError, and a single bad sample off the wire would
     * take the whole tab down with it — the hazard `tool-subject.ts` was written for.
     */
    iso: string | null;
    /** Still in flight, so it sorts last and renders differently. */
    live: boolean;
    level: 'bad' | 'pending' | null;
    /**
     * The `ToolCall.id` behind this row, or null when there is nothing to open.
     *
     * Decided here rather than in the component because it is what makes a row a `<button>`
     * instead of an inert `<div>`, and "which rows are controls" is a rule, not a style.
     */
    inspect: string | null;
}

export type ActivitySourceId = 'mail' | 'files' | 'tools' | 'reasoning' | 'terminal' | 'commits';

export interface ActivitySource {
    id: ActivitySourceId;
    label: string;
    /** How many Genie observed, or **null when it cannot say**. Never rendered as `0`. */
    count: number | null;
    /**
     * Why there is no count — and never null when `count` is.
     *
     * "No gauge and no reason" is strictly worse than either, which is the case
     * `rateLimitUnavailable` exists in the session model to prevent.
     */
    unavailable: string | null;
}

export interface ActivityView {
    rows: ActivityRow[];
    sources: ActivitySource[];
}

/**
 * Collapse to a single line.
 *
 * Applied to SPEECH too, which is where this differs from `agent-stream.ts` on purpose. The
 * Stream leaves speech alone because *"speech is the one place a human reads prose"*. Activity
 * is not that place — it is a log, scanned down its left edge — and one three-line mail row in
 * the middle of it destroys the scan.
 *
 * Every run of whitespace becomes one space, newlines included. Not `replace(/\n/g, ' ')`:
 * turning `\n\n` into two spaces leaves a visible gap where a paragraph break used to be.
 */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** The kinds that CHANGE a file. Read from the agent's own `kind`, never from the tool's NAME:
 *  a provider may call its writer anything, and matching on prose is how the plan rail broke
 *  once already. The same set as `agent-stream.ts`, `workspace-changes.ts` and
 *  `dashboard-view.ts` — four copies now, and worth consolidating by whoever owns those. */
const WRITE_KINDS = new Set(['edit', 'write', 'create', 'delete', 'move']);

/**
 * `Date`'s own representable range, ±100 000 000 days from the epoch.
 *
 * Past it `toISOString()` throws a RangeError. Checked rather than caught so the refusal is a
 * stated rule with a test, not an exception swallowed somewhere.
 */
const MAX_TIME = 8.64e15;

/** An instant Genie can both sort and print, or nothing at all. */
function stampOf(at: number | null | undefined): { at: number | null; iso: string | null } {
    if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(at) > MAX_TIME) {
        return { at: null, iso: null };
    }
    return { at, iso: new Date(at).toISOString() };
}

function messageRow(m: Message, live: boolean): ActivityRow {
    return {
        id: `msg:${m.id}`,
        // The agent's own voice is the only one that is not somebody asking it for something.
        kind: m.role === 'agent' ? 'said' : 'heard',
        main: oneLine(m.content),
        /**
         * THE AUTHOR when another agent wrote it, `you` for the owner, otherwise the ROLE.
         *
         * The Stream's rule, kept rather than re-decided — and the role fallback is the part
         * that matters. Before `Message.author` existed every row read role-only, so a sibling
         * agent's request said `user` exactly like the owner's and became indistinguishable
         * from an instruction from the person in charge.
         */
        meta: m.author ?? (m.role === 'user' ? 'you' : m.role),
        ...stampOf(m.at ?? null),
        live,
        // An `error` message is the pty closing or the harness refusing — it reads as bad
        // because it IS bad, and its role is the only thing that says so.
        level: m.role === 'error' ? 'bad' : null,
        inspect: null,
    };
}

function thoughtRow(t: Thought, live: boolean): ActivityRow {
    return {
        id: `thought:${t.id}`,
        kind: 'thought',
        // WITHHELD while it streams, exactly as in the Stream: a settled thought reads, a
        // streaming one rewrites its own row on every chunk.
        main: live ? 'Thinking…' : oneLine(t.text),
        meta: null,
        ...stampOf(t.at),
        live,
        level: null,
        inspect: null,
    };
}

function toolRow(c: ToolCall): ActivityRow {
    const writes = c.kind !== null && WRITE_KINDS.has(c.kind);
    return {
        id: `tool:${c.id}`,
        kind: writes ? 'wrote' : 'ran',
        // The SUBJECT when the agent reported usable arguments, else the tool's name — the
        // least Genie always knows. `toolSubject` refuses far more than it accepts, and a
        // blank row reads as a rendering fault rather than as opaque arguments.
        main: oneLine(toolSubject(c) ?? c.name),
        meta: c.status === 'success' ? null : c.status === 'failure' ? 'failed' : 'running',
        ...stampOf(c.at),
        live: false,
        level: c.status === 'failure' ? 'bad' : c.status === 'pending' ? 'pending' : null,
        inspect: c.id,
    };
}

function sourcesFor(session: AgentSession, rows: ActivityRow[]): ActivitySource[] {
    const of = (kind: ActivityKind): number => rows.filter((r) => r.kind === kind).length;

    /**
     * WHETHER THIS AGENT'S TOOL CALLS REACH GENIE AT ALL — the discriminator, and note that it
     * is not "did it write something".
     *
     * Once any call has arrived, an agent that only read files has genuinely written nothing,
     * and `0` is then a fact worth stating. With no calls at all, a `0` beside "File writes"
     * would be `read-buffer.ts`'s confusion in a new place: *"0 bytes because we hold no
     * buffer for this terminal"* is not *"0 bytes because the terminal is quiet"*.
     */
    const toolsVisible = session.tools.length > 0;
    const reasoningVisible = session.thoughts.length > 0 || session.liveThought !== null;

    const blindToTools = 'No tool calls reach Genie for this agent';

    return [
        {
            id: 'mail',
            label: 'Messages',
            // Always a number, `0` included — this is the one channel Genie OWNS. The floor
            // projector fills `transcript` from the AgentInbox thread and the last handoff for
            // every provider, so an empty one really does mean nothing was exchanged.
            count: of('heard') + of('said'),
            unavailable: null,
        },
        {
            id: 'files',
            label: 'File writes',
            count: toolsVisible ? of('wrote') : null,
            unavailable: toolsVisible ? null : blindToTools,
        },
        {
            id: 'tools',
            label: 'Tool calls',
            count: toolsVisible ? of('ran') : null,
            unavailable: toolsVisible ? null : blindToTools,
        },
        {
            id: 'reasoning',
            label: 'Reasoning',
            count: reasoningVisible ? of('thought') : null,
            unavailable: reasoningVisible ? null : 'No reasoning reaches Genie for this agent',
        },
        {
            id: 'terminal',
            label: 'Terminal I/O',
            // NEVER a count, in any session. Not an oversight — the measurement does not exist
            // per agent, and the reason is in this module's own header.
            count: null,
            unavailable: 'Genie counts pty bytes per workspace, not per agent',
        },
        {
            id: 'commits',
            label: 'Commits',
            count: null,
            unavailable: 'No commit feed reaches the session model',
        },
    ];
}

export function agentActivity(session: AgentSession): ActivityView {
    const settled: ActivityRow[] = [
        ...session.transcript.map((m) => messageRow(m, false)),
        ...session.thoughts.map((t) => thoughtRow(t, false)),
        ...session.tools.map(toolRow),
    ];

    /**
     * ORDERED BY WHEN IT HAPPENED, with unstamped rows LAST.
     *
     * `at: null` means nobody stamped it — not 1970. Sorting a null to the front would put the
     * oldest possible position on a fact whose age is unknown, which in practice is the newest
     * thing that arrived. The original index breaks ties because `Infinity - Infinity` is NaN
     * and makes `sort` implementation-defined.
     */
    const keyed = settled.map((row, i) => ({ row, i }));
    keyed.sort((a, b) => {
        const av = a.row.at ?? Number.POSITIVE_INFINITY;
        const bv = b.row.at ?? Number.POSITIVE_INFINITY;
        if (av === bv) return a.i - b.i;
        return av < bv ? -1 : 1;
    });

    const rows = keyed.map((k) => k.row);

    // The live rows go last unconditionally: they are still happening, so no timestamp
    // comparison can place them anywhere else honestly — their own stamp is when they STARTED.
    if (session.live) rows.push(messageRow(session.live, true));
    if (session.liveThought) rows.push(thoughtRow(session.liveThought, true));

    return { rows, sources: sourcesFor(session, rows) };
}
