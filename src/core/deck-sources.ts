import type { ListItem } from './attention.js';
import { plainLabel, type DeckItem, type StaleReason } from './deck.js';
import { HUMAN, UNNAMED_AGENT } from './inbox.js';
import type { PendingQuestion } from '../main/attention-store.js';
import type { InboxMessage } from '../main/inbox-store.js';

/**
 * THE DECK'S FOUR SOURCES (§4.5), normalised into one item each so the band ranks them as a whole.
 *
 * Approvals arrive from the session layer already. The other three come from tonight's stores:
 *
 * - an AGENT QUESTION is BLOCKING — the agent has stopped until a person answers. A single
 *   question, even a single one with plain options, is a form: options plus a note per question.
 * - a USER-LIST item is a thing only a person can DO; it blocks nobody and is done inline.
 * - an UNREAD DM to the human is low priority, titled by sender and first line, marked read inline.
 *
 * A FINISHED AGENT'S HANDOFF IS NOT A SOURCE (Tynn #658). It is for agents: the agent's next run, or whoever picks up
 * the work, reads it (its handoff file and Genie's record of finished turns). It never waits for the person, who sees
 * the agent's state and its chat; it was an item with Open / Restart with this / mark read until the owner had
 * "hundreds of handoffs waiting for my attention" (2026-11-12): "I should not have to mark them as read."
 *
 * An agent the roster no longer knows is still shown, under its id — never dropped silently.
 *
 * A question's TITLE is its short `header` ("Engine", or "Engine + 2 more") as plain text — never the question itself.
 * The question is Markdown and long; as a title it was cut off mid-sentence with its `**` and backticks showing (the
 * owner, 2026-10-15: "I can't read this"). The question is read in the body, rendered (QuestionForm). Every item carries
 * its workspace's NAME when it is known — the rail's name, never the id.
 */

export interface DeckSourceInput {
    readonly questions: readonly PendingQuestion[];
    readonly userList: readonly { workspaceId: string; item: ListItem }[];
    readonly unreadDms: readonly InboxMessage[];
    /** Who the agent ids are, for names and workspaces. */
    readonly agents: Readonly<Record<string, { name: string; workspaceId: string }>>;
    /** Workspace id → its NAME as the rail says it (core/workspace-name.ts). An id not here gets no name — never the id. */
    readonly workspaceNames?: Readonly<Record<string, string>>;
    /** Workspace id → its colour (genie#1300), carried beside the name. An id not here gets none. */
    readonly workspaceColors?: Readonly<Record<string, string>>;
    /**
     * Is the asking agent still WAITING — its session as Genie runs it (or its Take Over terminal): `null` when it has
     * none, `undefined` when LIVENESS IS NOT KNOWN yet (the roster and the session host have not reported once). Only a
     * known answer is judged (`questionStale`); `undefined`, or no port at all, judges nothing — "we have not heard" is
     * never "the agent is gone".
     */
    readonly asker?: (agentId: string) => AskerState | null | undefined;
}

/** The asking agent's session now: is it running, and since when (epoch ms; `null` = no start recorded). */
export interface AskerState {
    readonly running: boolean;
    readonly startedAt: number | null;
}

/**
 * DOES ITS AGENT STILL WAIT FOR THIS QUESTION? (the owner, 2026-10-15: old items — "Keep, but mark stale"). It does not
 * when the agent is gone from the roster, when it has no running session (its session ended), or when the session
 * running now started AFTER the question was asked — an earlier run asked it, and the run now has never heard of it.
 * A session with no recorded start is not judged on that last count: "we have not heard" is not "it was earlier".
 */
export function questionStale(askedAt: number, known: boolean, session: AskerState | null): StaleReason | null {
    if (!known) return 'agent-gone';
    if (session === null || !session.running) return 'session-ended';
    if (session.startedAt !== null && Number.isFinite(askedAt) && askedAt < session.startedAt) return 'earlier-run';
    return null;
}

const option = (id: string, label: string) => ({ id, label, tone: 'neutral' as const });

/** The title of an agent's questions: the first one's header, as plain text, and how many more ride with it. */
export function questionTitle(questions: readonly { header: string; question: string }[]): string {
    const first = questions[0];
    if (!first) return 'A question';
    // A header is required (≤ 12 chars), but one that is only Markdown marks says nothing: the question's first words then.
    const firstLine = first.question.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    const head = plainLabel(first.header) || truncate(plainLabel(firstLine), 60) || 'A question';
    return questions.length === 1 ? head : `${head} + ${questions.length - 1} more`;
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * BUILT ONCE PER CHANGE (Tynn #663). Window main builds the Deck on every snapshot, up to 20 a second; at the owner's scale
 * (240 open questions) building every item every time was about 3 GB of garbage per 5 minutes, the largest single source
 * in the #662 soak. The stores never change a question, a list item or a message in place — they replace it (an update, a
 * re-ask, a done, a read are all new objects) — so an item is kept per SOURCE OBJECT, beside what else it was built from:
 * its workspace's name and colour, its agent's name, whether its agent still waits. When the object and those are the
 * same, the item is the same object as last time and nothing is built. Weakly held: a question answered, an item done, a
 * message read drops out with its source. Callers hand fresh records every time (deck-assembly.ts), so the four values an
 * item was built from are compared as VALUES, never the records' identity. A reused item allocates NOTHING: the values
 * are compared as arguments, never gathered into an array or a builder closure first — those alone, for 240 questions
 * 20 times a second, were still about 900 MB per 5 minutes in the soak.
 */
interface Kept { readonly a: unknown; readonly b: unknown; readonly c: unknown; readonly d: unknown; readonly item: DeckItem }
const built = new WeakMap<object, Kept>();

function keptItem(source: object, a: unknown, b: unknown, c: unknown, d: unknown): DeckItem | undefined {
    const kept = built.get(source);
    return kept !== undefined && kept.a === a && kept.b === b && kept.c === c && kept.d === d ? kept.item : undefined;
}

function keep(source: object, a: unknown, b: unknown, c: unknown, d: unknown, item: DeckItem): DeckItem {
    built.set(source, { a, b, c, d, item });
    return item;
}

export function deckItemsFrom(input: DeckSourceInput): DeckItem[] {
    const nameOfAgent = (agentId: string): string => input.agents[agentId]?.name ?? UNNAMED_AGENT;
    const workspaceOfAgent = (agentId: string): string | null => input.agents[agentId]?.workspaceId ?? null;
    const nameOf = (workspaceId: string | null) => (workspaceId === null ? undefined : input.workspaceNames?.[workspaceId]);
    const colorOf = (workspaceId: string | null) => (workspaceId === null ? undefined : input.workspaceColors?.[workspaceId]);
    const named = (workspaceId: string | null): { workspaceName?: string; workspaceColor?: string } => {
        const name = nameOf(workspaceId);
        const color = colorOf(workspaceId);
        return { ...(name === undefined ? {} : { workspaceName: name }), ...(color === undefined ? {} : { workspaceColor: color }) };
    };
    const items: DeckItem[] = [];

    for (const q of input.questions) {
        const live = input.asker?.(q.agentId);
        // Judged from the LATEST ask: an agent that asked again (a rejoin) is waiting now, even if its first ask came
        // from an earlier run. Its age on the Deck stays the first ask's — it has been waiting that long.
        const lastAsked = Date.parse(q.reaskedAt ?? q.askedAt);
        const stale = live === undefined ? null : questionStale(lastAsked, input.agents[q.agentId] !== undefined, live);
        const workspaceName = nameOf(q.workspaceId);
        const workspaceColor = colorOf(q.workspaceId);
        const kept = keptItem(q, workspaceName, workspaceColor, stale, undefined);
        if (kept) {
            items.push(kept);
            continue;
        }
        items.push(keep(q, workspaceName, workspaceColor, stale, undefined, {
            id: q.id,
            source: 'agent-question',
            agentId: q.agentId,
            agentName: q.agentName,
            workspaceId: q.workspaceId,
            ...named(q.workspaceId),
            title: questionTitle(q.questions),
            blocking: true,
            priority: q.priority,
            at: Date.parse(q.askedAt),
            // EVERY agent question is a form (the owner, 2026-10-14): ForceTheQuestion opens its window on top, and every
            // question carries its own note. A one-click inline answer had no note and never reached the window.
            answer: { kind: 'form', fields: q.questions.length, questions: q.questions },
            forwardedFrom: null,
            // Updated by its agent: a form keyed by this starts a clean draft (a draft for the old content is dropped).
            ...(q.revision ? { revision: q.revision } : {}),
            // Asked again: the window takes it as a new ask (a question put off comes back).
            ...(q.asks ? { asks: q.asks } : {}),
            // Its agent no longer waits: kept, and marked (the Deck greys it and offers Dismiss / Dismiss all stale).
            ...(stale ? { stale } : {}),
        }));
    }

    for (const { workspaceId, item } of input.userList) {
        if (item.done) continue;
        const agentName = nameOfAgent(item.askedBy);
        const workspaceName = nameOf(workspaceId);
        const workspaceColor = colorOf(workspaceId);
        const kept = keptItem(item, workspaceId, agentName, workspaceName, workspaceColor);
        if (kept) {
            items.push(kept);
            continue;
        }
        items.push(keep(item, workspaceId, agentName, workspaceName, workspaceColor, {
            id: item.id,
            source: 'user-list',
            agentId: item.askedBy,
            agentName,
            workspaceId,
            ...named(workspaceId),
            title: item.text,
            blocking: false,
            priority: 'normal',
            at: Date.parse(item.createdAt),
            answer: { kind: 'inline', options: [option('done', 'Done')] },
            forwardedFrom: null,
        }));
    }

    for (const m of input.unreadDms) {
        if (m.to !== HUMAN || m.from === HUMAN || m.readAt !== null) continue;
        const agentName = nameOfAgent(m.from);
        const workspaceId = workspaceOfAgent(m.from);
        const workspaceName = nameOf(workspaceId);
        const workspaceColor = colorOf(workspaceId);
        const kept = keptItem(m, agentName, workspaceId, workspaceName, workspaceColor);
        if (kept) {
            items.push(kept);
            continue;
        }
        const firstLine = m.text.split(/\r?\n/)[0] ?? '';
        items.push(keep(m, agentName, workspaceId, workspaceName, workspaceColor, {
            id: m.id,
            source: 'unread-dm',
            agentId: m.from,
            agentName,
            workspaceId,
            ...named(workspaceId),
            title: `${agentName}: ${firstLine}`,
            blocking: false,
            priority: 'low',
            at: Date.parse(m.sentAt),
            answer: { kind: 'inline', options: [option('read', 'Mark read')] },
            forwardedFrom: null,
        }));
    }

    return items;
}
