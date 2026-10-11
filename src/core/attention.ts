import { createHash } from 'node:crypto';

/**
 * THE ATTENTION PROTOCOL — the pure half (§6.3).
 *
 * The rules a tool handler applies before anything is stored: how full a list may be, what is
 * a question and therefore not a list item, what a well-formed `ForceTheQuestion` looks like,
 * and how a repeated question is recognised so it is rejoined rather than asked twice.
 */

export interface ListItem {
    readonly id: string;
    readonly text: string;
    /** The agent that added it. On the user list this is shown as "who asked". */
    readonly askedBy: string;
    readonly createdAt: string;
    readonly done: boolean;
}

export type ListKind = 'agent' | 'user';

/**
 * Both lists REFUSE when full rather than dropping the oldest. A list that silently drops is a
 * list nobody can trust to still hold what they put in it.
 */
export const LIST_LIMITS = { agent: 10, user: 5 } as const satisfies Record<ListKind, number>;

export type AddResult =
    | { kind: 'added'; items: readonly ListItem[] }
    | { kind: 'full'; limit: number; items: readonly ListItem[] }
    | { kind: 'question'; reason: string };

const INTERROGATIVE = /^(should|shall|can|could|would|will|may|might|do|does|did|is|are|was|were|which|what|when|where|who|whom|why|how)\b/i;

/**
 * A question is never a list item. Anything that needs ANSWERING goes to `ForceTheQuestion`;
 * a list holds things that need DOING. A trailing `?` or an interrogative opening is the test —
 * imperatives ("Decide on …", "Rotate …") pass.
 */
export function looksLikeQuestion(text: string): boolean {
    const t = text.trim();
    return t.endsWith('?') || INTERROGATIVE.test(t);
}

export function addToList(list: ListKind, items: readonly ListItem[], item: ListItem): AddResult {
    if (looksLikeQuestion(item.text)) {
        return { kind: 'question', reason: 'a question is never a list item — ask it with ForceTheQuestion' };
    }
    const limit = LIST_LIMITS[list];
    const open = items.filter((i) => !i.done).length;
    if (open >= limit) return { kind: 'full', limit, items };
    return { kind: 'added', items: [...items, item] };
}

export interface QuestionOption {
    readonly label: string;
    readonly description?: string;
}

export interface Question {
    /** ≤ 12 characters; shown as a chip. */
    readonly header: string;
    /** Markdown. */
    readonly question: string;
    /** 2–4. */
    readonly options: readonly QuestionOption[];
    readonly multiSelect?: boolean;
}

export const QUESTION_LIMITS = { questions: [1, 4], options: [2, 4], header: 12 } as const;

/** The reason a `ForceTheQuestion` payload is refused, or `null` when it is well-formed. */
export function validateQuestions(questions: readonly Question[]): string | null {
    const [qMin, qMax] = QUESTION_LIMITS.questions;
    if (questions.length < qMin || questions.length > qMax) {
        return `ForceTheQuestion carries ${qMin}–${qMax} questions; got ${questions.length}`;
    }
    const [oMin, oMax] = QUESTION_LIMITS.options;
    for (const q of questions) {
        if (q.header.length > QUESTION_LIMITS.header) {
            return `header ${JSON.stringify(q.header)} is over ${QUESTION_LIMITS.header} characters`;
        }
        if (q.options.length < oMin || q.options.length > oMax) {
            return `${q.header}: each question has ${oMin}–${oMax} options; got ${q.options.length}`;
        }
    }
    return null;
}

/**
 * The identity of a DECISION: who is asking, and what they are asking, option labels included,
 * option descriptions excluded. Two asks with the same key are the same open question and the
 * second is rejoined to the first. Descriptions are left out because an agent re-asking after a
 * restart often rewrites them; the decision has not changed.
 */
export function questionKey(agentId: string, questions: readonly Question[]): string {
    const shape = questions.map((q) => ({
        header: q.header,
        question: q.question,
        options: q.options.map((o) => o.label),
        multiSelect: q.multiSelect === true,
    }));
    return createHash('sha256').update(JSON.stringify([agentId, shape])).digest('hex');
}
