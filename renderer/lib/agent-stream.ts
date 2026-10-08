import type { AgentSession, Message, Thought, ToolCall } from '../../main/agentsession/model';

/**
 * THE STREAM — §5.2 of the owner's spec board, "total oversight".
 *
 * One ordered list of two row shapes, and that distinction is the design:
 *
 *  - **SPEECH** wraps and renders in full. It is what the human came to read.
 *  - **EVENT** is exactly ONE LINE, always — a thought, a tool call, an edit, a usage sample.
 *
 * ## Why the one-line rule lives HERE and not in the stylesheet
 *
 * The brief's fixed requirement is that a thought is one line and is never auto-expanded,
 * because content jumping as reasoning streams is the worst reading experience in agent UIs.
 * The usual implementation — "collapse long things" — does not actually work: the collapsed
 * thing still reflows as it grows.
 *
 * The board's fix is structural: an EVENT row *cannot* grow. So the flattening happens in this
 * projection, where it is a property with a test, rather than in CSS where `white-space:
 * nowrap` is one careless override away from being lost with nothing failing.
 *
 * ## And why a live thought withholds its text
 *
 * A settled thought reads; a streaming one would jump on every chunk. So the live row says
 * `Thinking…` and the text waits until it stops moving. That is not coyness — it is the only
 * version of "show me the reasoning" that does not move the rows above it.
 */

export type StreamRowType = 'event' | 'speech' | 'divider';

/** What an EVENT row is, which decides its icon and its colour. The board's vocabulary. */
export type EventKind = 'think' | 'tool' | 'edit' | 'plan' | 'usage';

export const EVENT_KIND_ICON = {
    think: 'brain',
    tool: 'wrench',
    edit: 'pencil',
    plan: 'list-checks',
    usage: 'gauge',
} as const satisfies Record<EventKind, string>;

/** How loudly a row reads. `null` is the common case — most rows are quiet. */
export type StreamLevel = 'bad' | 'attention' | 'pending' | null;

export interface StreamRow {
    id: string;
    type: StreamRowType;
    /** Set for an event; null for speech and dividers, which have no kind. */
    kind: EventKind | null;
    /** The row's text. ONE LINE for an event — guaranteed by construction. */
    main: string;
    /** The trailing detail: who spoke, how a call ended. Null when there is nothing honest. */
    meta: string | null;
    /** When it happened, for the time gutter. Null ⇒ unstamped. */
    at: number | null;
    /** Still in flight, so it sorts last and renders differently. */
    live: boolean;
    level: StreamLevel;
}

/**
 * Collapse to a single line.
 *
 * Every run of whitespace — newlines included — becomes one space. Not a `replace(/\n/g, ' ')`:
 * reasoning arrives with blank lines in it, and turning `\n\n` into two spaces leaves a visible
 * gap where a paragraph break used to be.
 */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** The tool kinds the board draws as an EDIT — tinted, and counted as a change. The rest are
 *  traffic. Taken from the agent's own `kind`, never from the tool's NAME: a provider may call
 *  its writer anything, and matching on prose is how the plan rail broke once already. */
const EDIT_KINDS = new Set(['edit', 'write', 'create', 'delete', 'move']);

function subjectOf(call: ToolCall): string | null {
    const input = call.rawInput;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    for (const key of ['file_path', 'filePath', 'path']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            const parts = value.split(/[\\/]/).filter(Boolean);
            return parts[parts.length - 1] ?? null;
        }
    }
    for (const key of ['command', 'pattern', 'query', 'url']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return oneLine(value);
    }
    return null;
}

function toolRow(call: ToolCall): StreamRow {
    const isEdit = call.kind !== null && EDIT_KINDS.has(call.kind);
    return {
        id: `tool:${call.id}`,
        type: 'event',
        kind: isEdit ? 'edit' : 'tool',
        // The SUBJECT when the agent reported arguments, else the tool's name — which is the
        // least Genie always knows. A blank row reads as a rendering fault rather than as a
        // tool whose arguments are opaque.
        main: oneLine(subjectOf(call) ?? call.name),
        meta: call.status === 'success' ? null : call.status === 'failure' ? 'failed' : 'running',
        at: call.at,
        live: false,
        level: call.status === 'failure' ? 'bad' : call.status === 'pending' ? 'pending' : null,
    };
}

function thoughtRow(thought: Thought, live: boolean): StreamRow {
    return {
        id: `thought:${thought.id}`,
        type: 'event',
        kind: 'think',
        // WITHHELD while it streams. The text is only legible once it stops moving.
        main: live ? 'Thinking…' : oneLine(thought.text),
        // No token count: not on the wire, and estimating it from the text would be an
        // estimate dressed as a measurement. See `Thought`.
        meta: null,
        at: thought.at,
        live,
        level: null,
    };
}

function speechRow(message: Message, live: boolean): StreamRow {
    return {
        id: `msg:${message.id}`,
        type: 'speech',
        kind: null,
        // NOT flattened. Speech is the one place a human reads prose, and destroying its
        // paragraphs to satisfy a rule about event rows would be the rule misapplied.
        main: message.content,
        /**
         * THE AUTHOR when another agent wrote it, `you` for the owner, and otherwise the ROLE.
         *
         * The role fallback is not decoration — `agent-view-render.test.ts` caught my first
         * version dropping it, and the reason it matters is in that file: before authors
         * existed, every row read role-only, so a sibling agent's request said "user" exactly
         * like the owner's and became indistinguishable from an instruction from the person in
         * charge. `error` and `tool` rows have nobody to name, and the role IS the answer.
         */
        meta: message.author ?? (message.role === 'user' ? 'you' : message.role),
        at: message.at ?? null,
        live,
        level: null,
    };
}

export function agentStream(session: AgentSession, input: { now: number }): StreamRow[] {
    const settled: StreamRow[] = [
        ...session.thoughts.map((t) => thoughtRow(t, false)),
        ...session.tools.map(toolRow),
        ...session.transcript.map((m) => speechRow(m, false)),
    ];

    /**
     * SORTED BY WHEN IT HAPPENED, with unstamped rows LAST.
     *
     * `at: null` means nobody stamped it — not 1970. Sorting a null to the front would put the
     * oldest possible position on a fact whose age is unknown, which in practice is the newest
     * thing that arrived. The original index breaks ties because `Infinity - Infinity` is NaN
     * and makes `sort` implementation-defined — the same trap `mergeTranscripts` records.
     */
    const keyed = settled.map((row, i) => ({ row, i }));
    keyed.sort((a, b) => {
        const av = a.row.at ?? Number.POSITIVE_INFINITY;
        const bv = b.row.at ?? Number.POSITIVE_INFINITY;
        if (av === bv) return a.i - b.i;
        return av < bv ? -1 : 1;
    });

    const rows = keyed.map((k) => k.row);

    // The live rows go last, unconditionally: they are still happening, so no timestamp
    // comparison can put them anywhere else honestly.
    if (session.live) rows.push(speechRow(session.live, true));
    if (session.liveThought) rows.push(thoughtRow(session.liveThought, true));

    /**
     * AND THE TAIL SAYS WHY IT STOPPED, when it stopped.
     *
     * §6.4: the turn visibly PARKS. A stopped agent has to be obvious in the stream rather
     * than inferable from the absence of new rows — which is indistinguishable from an agent
     * that is simply slow.
     */
    if (session.error) {
        rows.push({
            id: 'divider:error',
            type: 'divider',
            kind: null,
            main: oneLine(session.error),
            meta: null,
            at: null,
            live: false,
            level: 'bad',
        });
    } else if (session.turn.state === 'awaiting-input' || session.turn.state === 'awaiting-approval') {
        const seconds = Math.max(0, Math.round((input.now - session.turn.since) / 1000));
        rows.push({
            id: 'divider:parked',
            type: 'divider',
            kind: null,
            main: `turn parked · waiting on you ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
            meta: null,
            at: null,
            live: false,
            level: 'attention',
        });
    }

    return rows;
}
