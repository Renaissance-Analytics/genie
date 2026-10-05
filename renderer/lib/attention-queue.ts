import { PRIORITY_RANK, type QuestionPriority } from '../../main/ask/question-priority';
import type { ListItemSpec, PendingQuestionSpec } from './genie';

/**
 * ONE queue for "what needs me", normalised out of the surfaces that each own a
 * piece of it.
 *
 * ## Why
 *
 * Today a human has to notice a glow on a rail and then guess which of twelve
 * flyouts explains it. Being asked a question and being asked to do something are
 * ONE human intention — somebody wants something from you — served by two separate
 * surfaces with their own buttons, their own badges and their own empty states. The
 * Deck's claim is that you can clear your morning without opening either, and this
 * is the projection that makes that possible.
 *
 * ## Sources
 *
 * Two today, both already pushed to the renderer, so this needs no new host
 * protocol:
 *
 * - **pending questions** (`PendingQuestionSpec`) — ForceTheQuestion, including
 *   DEFERRED ones, which are precisely the ones the modal is not showing;
 * - **UserList items** (`ListItemSpec`) — written by an agent, worked by a person,
 *   and resolving one NUDGES the agent that asked.
 *
 * Two more belong here and are deliberately absent rather than wired to the wrong
 * thing. An **unread handoff** needs `readHandoff` exposed over IPC — it has no
 * production caller at all today. A **message to the human** has no renderer source
 * yet: `AgentInboxIncomingNotice` is about a notice delivered to an AGENT's
 * terminal, which is a different fact, and reading it as human-addressed mail would
 * put somebody else's inbox on your board. The union grows when the sources are
 * real.
 *
 * ## Pure, and renderer-side for now
 *
 * The headless-host contract puts WORK/CONTENT on the host, so this projection
 * eventually belongs there and gets pushed. It starts here because both sources
 * already arrive here, which is what makes the Deck shippable without a protocol
 * change. Moving it later is a lift, not a rewrite — that is why it takes plain
 * data and returns plain data.
 */

/** What kind of ask this is. Grows as the remaining sources become real. */
export type AttentionKind = 'question' | 'list-item';

export interface AttentionItem {
    /** Unique ACROSS kinds. A question and a list item may share an id — they come
     *  from different tables — so an unprefixed key would make one of them vanish
     *  from a React list, silently. */
    key: string;
    kind: AttentionKind;
    /** The collapsed one-liner. */
    title: string;
    /** Markdown body for the expanded row; null when the kind has none. */
    body: string | null;
    /** The agent involved, or null when nothing names one. For a list item this is
     *  the agent that gets nudged on resolve, so it is not decoration. */
    agentName: string | null;
    workspaceLabel: string | null;
    /** The host it was forwarded from; null means local. */
    remoteHost: string | null;
    /** ms epoch, or **null when the host did not say** — render nothing, never a
     *  guessed age. */
    createdAt: number | null;
    priority: QuestionPriority;
    /** Is an agent STOPPED behind this? The key that reorders a morning. */
    blocking: boolean;
    /** Why a question is not on the modal, when it is not. */
    deferralReason: PendingQuestionSpec['deferralReason'] | null;
}

export interface AttentionSources {
    questions: readonly PendingQuestionSpec[];
    listItems: readonly ListItemSpec[];
}

/** The title for a question: its first header, falling back to the body, falling
 *  back to a plain label. A row with an empty title is a row nobody can act on. */
function questionTitle(q: PendingQuestionSpec): string {
    const first = q.questions[0];
    if (!first) return 'A question is waiting';
    return first.header.trim() || first.question.trim() || 'A question is waiting';
}

function fromQuestion(q: PendingQuestionSpec): AttentionItem {
    return {
        key: `question:${q.id}`,
        kind: 'question',
        title: questionTitle(q),
        body: q.questions[0]?.question ?? null,
        agentName: null,
        workspaceLabel: q.workspaceLabel ?? null,
        remoteHost: q.remoteHost ?? null,
        createdAt: q.createdAt ?? null,
        priority: q.priority ?? 'normal',
        // An agent is parked on this answer and will not move until it arrives.
        blocking: true,
        deferralReason: q.deferralReason ?? null,
    };
}

function fromListItem(i: ListItemSpec): AttentionItem {
    return {
        key: `list:${i.id}`,
        kind: 'list-item',
        title: i.text,
        body: null,
        agentName: i.agentName ?? null,
        workspaceLabel: null,
        remoteHost: null,
        // The list carries no timestamp today. Null, not now — see the rule above.
        createdAt: null,
        priority: 'normal',
        // Deliberately false, straight from the service's own words: ForceTheQuestion
        // "parks the agent on an answer, a UserList lets it carry on while a human
        // does something". Nothing is stopped behind this one.
        blocking: false,
        deferralReason: null,
    };
}

/**
 * Everything waiting on a human, ranked.
 *
 * Order: **blocking first**, then priority, then oldest. A blocked agent is burning
 * nothing but it has STOPPED, and that is the only state where the human is the
 * bottleneck — so it outranks a non-blocking item however urgent that item claims
 * to be.
 *
 * It reuses `PRIORITY_RANK` but deliberately NOT `insertByPriority`, whose documented
 * invariant is that index 0 is never displaced because it is "the question currently
 * shown/being answered" and yanking it mid-answer is the defect it exists to
 * prevent. A status board has no such head, so borrowing that helper would pin
 * whichever row happened to arrive first and call it protection.
 */
export function attentionItems(src: AttentionSources): AttentionItem[] {
    const items = [...src.questions.map(fromQuestion), ...src.listItems.map(fromListItem)];

    return items.sort((a, b) => {
        if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;

        const rank = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (rank !== 0) return rank;

        // Oldest first — but an UNKNOWN age must not jump the queue. Treating absent
        // as 0 would make a question forwarded by an older host the oldest thing on
        // the board, promoting it on the strength of a missing field.
        if (a.createdAt === null && b.createdAt === null) return 0;
        if (a.createdAt === null) return 1;
        if (b.createdAt === null) return -1;
        return a.createdAt - b.createdAt;
    });
}
