import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
    addToList,
    questionKey,
    validateQuestions,
    type ListItem,
    type ListKind,
    type Question,
} from '../core/attention.js';
import { questionTitle } from '../core/deck-sources.js';
import type { AgentId } from '../core/identity.js';
import { HUMAN, type Participant } from '../core/inbox.js';
import type { InboxStore } from './inbox-store.js';
import { runtimeDir } from './paths.js';
import { readJson, reportFlush, writeJsonAtomic } from './store.js';

/**
 * THE ATTENTION PROTOCOL — the durable half (§6.3).
 *
 * What the Genie MCP tool handlers call for `imDone`, `ForceTheQuestion` and `lists`. One
 * atomically-written file under the runtime directory; the handoff note is the one thing
 * written elsewhere — into the WORKSPACE at `.ai/handoff/<agent>.md` (gitignored), because
 * that is where the next run of the agent is launched from and handed it.
 *
 * ## Agents never write the handoff file themselves
 *
 * The name and shape are Genie's to derive. `imDone` writes it, REPLACING the previous note —
 * a handoff is "where things stand", and appending turns it into a log nobody reads. The
 * response says whether it landed and, if not, why: no name to file under, no workspace to
 * write into, a failed write. A dropped handoff reported as saved is how the next run starts
 * from nothing while believing it has context.
 *
 * ## A question survives a restart and is never duplicated
 *
 * `ask` keys the decision (`questionKey`) and rejoins a repeat to the pending question instead
 * of filing a second one. A rejoin is still an ASK: the agent is waiting on it now. It is written down (`reaskedAt`, and
 * `asks` counted up) and announced like any change, so a question the person had put off comes back to the question
 * window (main/question-window.ts) — unless Do Not Disturb is on — and its liveness is judged from this ask, not the
 * first one. Same id, same content, same revision: the person's half-written answer to it is kept. The answer is not returned by the tool — it is mailed to the asker
 * through the inbox FROM the human, so the agent's ordinary `receive` picks it up and the human
 * is on record as having decided.
 *
 * ## Nothing waits forever
 *
 * A question leaves in one of four ways, and every one is said to whoever is waiting on it:
 *
 * - **answered** by the person — the answer is mailed to the agent;
 * - **dismissed** by the person, without an answer (one, or "all older than 1 day") — the agent is mailed
 *   "<header>: dismissed by the person, without an answer", so it stops waiting and decides on its own — with any note
 *   the person left on a question ("Note on <header>: …"); "Dismiss all stale" sends exactly the ones the person saw;
 * - **withdrawn** by the agent that asked (ForceTheQuestion `action: 'cancel'`) — nothing is mailed: the agent knows;
 * - **updated** by the agent that asked (`action: 'update'`) — not a leaving: same id, same place in the queue, new
 *   content, and a new `revision` so a half-filled form for the old content is dropped.
 *
 * Only the asking agent, in its own workspace, may withdraw or update its question. Before this, nothing removed a
 * question but an answer, and the Deck kept eight from the day before that the person had never been shown (the owner,
 * 2026-10-15: "some look really old").
 *
 * ## A Done on the person's list is told to the agent that put it there
 *
 * `lists.done` is the one place every Done goes through — the Deck's Done (feature IPC `list-done`) and the `lists` MCP
 * tool alike — and it takes WHO marked it. When the person marks done an item an agent asked for, the asker is mailed
 * from the human, the way an answer reaches it. Before, it only flipped `done` and the asker never heard (B23).
 */

export interface HandoffSaved {
    readonly saved: true;
    readonly path: string;
}
export interface HandoffNotSaved {
    readonly saved: false;
    readonly reason: string;
}

export interface ImDoneInput {
    readonly agentId: AgentId;
    readonly agentName: string | null;
    readonly workspacePath: string | null;
    readonly workspaceId?: string;
    readonly handoff?: string;
}

export interface ImDoneResult {
    readonly ok: true;
    readonly handoff: HandoffSaved | HandoffNotSaved;
    /** The agent's own open checklist — it rides every imDone. */
    readonly checklist: readonly ListItem[];
}

export interface Finished {
    readonly id: string;
    readonly agentId: AgentId;
    readonly agentName: string | null;
    readonly handoff: string | null;
    readonly at: string;
    readonly seen: boolean;
}

export interface AskInput {
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly workspaceId: string;
    readonly questions: readonly Question[];
    readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export interface AskResult {
    readonly ok: true;
    readonly questionId: string;
    readonly userActive: boolean;
    /** True when an identical open question already existed and this call joined it. */
    readonly rejoined: boolean;
    /** DND (§6.3): the person's configured reply, said at once; `null` when DND is off. */
    readonly dndReply: string | null;
}

export interface PendingQuestion {
    readonly id: string;
    readonly key: string;
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly workspaceId: string;
    readonly questions: readonly Question[];
    readonly priority: 'low' | 'normal' | 'high' | 'urgent';
    readonly askedAt: string;
    /** How many times its agent updated it; absent (a question never updated, or filed before updates existed) = 0. */
    readonly revision?: number;
    /** How many times its agent asked it AGAIN (a rejoined repeat); absent = never. */
    readonly asks?: number;
    /** When it was last asked again (ISO); absent = never. Its agent's liveness is judged from this ask. */
    readonly reaskedAt?: string;
}

/** The asking agent, as the MCP caller resolves it: a question is withdrawn or updated only by the agent that asked it. */
export interface QuestionOwner {
    readonly agentId: AgentId;
    readonly workspaceId: string;
}

export interface UpdateInput extends QuestionOwner {
    readonly questionId: string;
    readonly questions: readonly Question[];
    readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
}

/** How a question left (genie#1204): what a waiting flow branches on. */
export type QuestionLeft = { readonly kind: 'answered'; readonly answer: Answer } | { readonly kind: 'dismissed'; readonly notes: readonly string[] } | { readonly kind: 'withdrawn' };

export interface Answer {
    /** One array of chosen labels per question, in order. */
    readonly selections: readonly (readonly string[])[];
    /**
     * One note per question, in order ('' where none). The form offers a note under every question (Genie 1's FTQ did;
     * the owner asked for it back, 2026-10-14), and a note alone answers its question. Optional for callers that only
     * ever had the overall note; missing means no question carries one.
     */
    readonly notes?: readonly string[];
    /** The overall note. Always present; may be empty. The form no longer shows one — a caller other than it may still send it. */
    readonly note: string;
}

interface ListRecord {
    readonly list: ListKind;
    readonly workspaceId: string;
    readonly item: ListItem;
}

interface AttentionFile {
    lists: ListRecord[];
    questions: PendingQuestion[];
    finished: Finished[];
}

export type ListAddResult =
    | { kind: 'added'; item: ListItem }
    | { kind: 'full'; limit: number }
    | { kind: 'question'; reason: string };

export class AttentionStore {
    readonly #file: string;
    readonly #inbox: InboxStore;
    readonly #now: () => string;
    #data: AttentionFile;

    readonly lists: {
        add(input: { list: ListKind; workspaceId: string; agentId: AgentId; text: string }): Promise<ListAddResult>;
        show(input: { list: ListKind; workspaceId: string; agentId: AgentId }): ListItem[];
        /**
         * Marks an item done. `by` is who did it — the person (`HUMAN`) or the calling agent — and is required, so no
         * path can mark an item done without saying who: when the PERSON marks done an item an agent asked for, that
         * agent is mailed (see `#mailListDone`). False when no such item is in that workspace.
         */
        done(input: { workspaceId: string; id: string; by: Participant }): Promise<boolean>;
        clear(input: { list: ListKind; workspaceId: string; agentId: AgentId }): Promise<number>;
    };

    private constructor(file: string, inbox: InboxStore, data: AttentionFile, now: () => string) {
        this.#file = file;
        this.#inbox = inbox;
        this.#data = data;
        this.#now = now;
        this.lists = {
            add: (input) => this.#addToList(input),
            show: (input) => this.#scoped(input).map((r) => r.item),
            done: async ({ workspaceId, id, by }) => {
                const record = this.#data.lists.find((r) => r.workspaceId === workspaceId && r.item.id === id);
                if (!record) return false;
                // Already done: still true, nothing written, nobody mailed again.
                if (record.item.done) return true;
                this.#data.lists = this.#data.lists.map((r) => (r === record ? { ...r, item: { ...r.item, done: true } } : r));
                await this.#flush();
                // The item is done whatever happens to the mail: it is written before anyone is told.
                if (by === HUMAN && record.item.askedBy !== HUMAN) await this.#mailListDone(record.item);
                return true;
            },
            clear: async (input) => {
                const gone = this.#scoped(input);
                this.#data.lists = this.#data.lists.filter((r) => !gone.includes(r));
                await this.#flush();
                return gone.length;
            },
        };
    }

    static async open(userData: string, inbox: InboxStore, now: () => string = () => new Date().toISOString()): Promise<AttentionStore> {
        const file = join(runtimeDir(userData), 'attention.json');
        const data = await readJson<AttentionFile>(file, { lists: [], questions: [], finished: [] });
        return new AttentionStore(file, inbox, data, now);
    }

    async imDone(input: ImDoneInput): Promise<ImDoneResult> {
        const handoff = await this.#saveHandoff(input);
        this.#data.finished.push({
            id: `fin_${randomUUID()}`,
            agentId: input.agentId,
            agentName: input.agentName,
            handoff: input.handoff ?? null,
            at: this.#now(),
            seen: false,
        });
        await this.#flush();

        const checklist = this.#data.lists
            .filter((r) => r.list === 'agent' && r.item.askedBy === input.agentId && !r.item.done)
            .filter((r) => input.workspaceId === undefined || r.workspaceId === input.workspaceId)
            .map((r) => r.item);
        return { ok: true, handoff, checklist };
    }

    /** Every user-list item in every workspace, with its workspace — the Deck's user-list source. */
    allUserItems(): Array<{ workspaceId: string; item: ListItem }> {
        return this.#data.lists.filter((r) => r.list === 'user').map((r) => ({ workspaceId: r.workspaceId, item: r.item }));
    }

    /** Every finish, oldest first — the Deck's "Since you looked" band reads the unseen ones. */
    finished(): readonly Finished[] {
        return this.#data.finished;
    }

    /**
     * An agent's LAST handoff, read or not — the workspace dashboard's "Last finished" (q_09d1f4a0): its first line, and
     * when. A finish without a handoff is skipped; none at all = `null`.
     */
    lastHandoff(agentId: AgentId): { text: string; at: number } | null {
        for (let i = this.#data.finished.length - 1; i >= 0; i -= 1) {
            const f = this.#data.finished[i]!;
            if (f.agentId !== agentId || f.handoff === null) continue;
            const text = f.handoff.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
            const at = Date.parse(f.at);
            if (text === undefined || Number.isNaN(at)) continue;
            return { text: text.slice(0, 200), at };
        }
        return null;
    }

    markSeen(id: string): void {
        this.#data.finished = this.#data.finished.map((f) => (f.id === id ? { ...f, seen: true } : f));
        reportFlush(this.#flush(), 'the attention store');
    }

    async ask(input: AskInput, context: { userActive: boolean; dnd?: { on: boolean; reply: string } | undefined }): Promise<AskResult> {
        const dndReply = context.dnd?.on ? context.dnd.reply : null;
        const refusal = validateQuestions(input.questions);
        if (refusal !== null) throw new Error(refusal);

        const key = questionKey(input.agentId, input.questions);
        const existing = this.#data.questions.find((q) => q.key === key);
        if (existing) {
            // Asked again: the same question, and the agent waiting on it NOW. Recorded and announced (the flush fires the
            // change), so a question the person put off comes back to the window; content and revision untouched, so the
            // draft for it stays good. Before, a rejoin wrote nothing and fired nothing: put off once, never seen again.
            const again: PendingQuestion = { ...existing, asks: (existing.asks ?? 0) + 1, reaskedAt: this.#now() };
            this.#data.questions = this.#data.questions.map((q) => (q.id === existing.id ? again : q));
            await this.#flush();
            return { ok: true, questionId: existing.id, userActive: context.userActive, rejoined: true, dndReply };
        }

        const pending: PendingQuestion = {
            id: `q_${randomUUID()}`,
            key,
            agentId: input.agentId,
            agentName: input.agentName,
            workspaceId: input.workspaceId,
            questions: input.questions,
            priority: input.priority ?? 'normal',
            askedAt: this.#now(),
        };
        this.#data.questions.push(pending);
        await this.#flush();
        return { ok: true, questionId: pending.id, userActive: context.userActive, rejoined: false, dndReply };
    }

    pending(): readonly PendingQuestion[] {
        return this.#data.questions;
    }

    /**
     * The human's answer. Removes the question and mails the asker FROM the human, so the
     * agent's ordinary `receive` carries the decision and the record shows who made it.
     */
    async answer(questionId: string, answer: Answer): Promise<void> {
        const q = this.#data.questions.find((x) => x.id === questionId);
        if (!q) throw new Error(`no pending question ${questionId}`);
        this.#data.questions = this.#data.questions.filter((x) => x.id !== questionId);
        await this.#flush();
        this.#left(questionId, { kind: 'answered', answer });

        // Each question, what was chosen, and — right under it — that question's own note. "(no option chosen)" says a
        // note answered it instead; the overall Note line is only there when an overall note was given.
        const lines = q.questions.map((question, i) => {
            const chosen = answer.selections[i] ?? [];
            const own = (answer.notes?.[i] ?? '').trim();
            const picked = chosen.length > 0 ? chosen.join(', ') : own ? '(no option chosen)' : '(no option chosen, no note)';
            return `- **${question.header}** — ${question.question}\n  → ${picked}${own ? `\n  Note: ${own}` : ''}`;
        });
        const overall = answer.note.trim();
        const text = [
            `Answer to your question ${questionId}:`,
            ...lines,
            ...(overall ? [`\nNote: ${overall}`] : []),
        ].join('\n');
        await this.#inbox.send({ from: HUMAN, to: q.agentId, text });
    }

    /**
     * The person DISMISSES a question without answering it. It leaves the Deck and the question window, and the asker is
     * mailed — from the human, like an answer — that it was dismissed, so it stops waiting. Once: a second dismiss of the
     * same id finds nothing and throws, mailing nobody.
     *
     * `notes` — one per question, as the form holds them — travel with the dismissal (the owner, 2026-10-15: "I NEED THE
     * ABILITY TO ADD NOTES TO ANY AND ALL QUESTIONS"): a person putting a question aside can still say why, or what to do.
     */
    async dismiss(questionId: string, notes: readonly string[] = []): Promise<void> {
        const q = this.#data.questions.find((x) => x.id === questionId);
        if (!q) throw new Error(`no pending question ${questionId}`);
        this.#data.questions = this.#data.questions.filter((x) => x.id !== questionId);
        await this.#flush();
        this.#left(questionId, { kind: 'dismissed', notes });
        await this.#mailDismissed(q, notes);
    }

    /**
     * "Dismiss all stale": exactly these questions leave — the ones the person SAW marked stale — each asker mailed once.
     * An id no longer pending is skipped, never a reason to stop. One write for all of them. Returns how many left.
     */
    async dismissMany(questionIds: readonly string[]): Promise<number> {
        const gone = this.#data.questions.filter((q) => questionIds.includes(q.id));
        if (gone.length === 0) return 0;
        this.#data.questions = this.#data.questions.filter((q) => !gone.includes(q));
        await this.#flush();
        for (const q of gone) this.#left(q.id, { kind: 'dismissed', notes: [] });
        for (const q of gone) await this.#mailDismissed(q);
        return gone.length;
    }

    /**
     * "Dismiss all older than 1 day": every question asked more than `ms` ago leaves, each asker mailed once. Returns
     * how many. One write for all of them, so the Deck and the window move once.
     */
    async dismissOlderThan(ms: number): Promise<number> {
        const cutoff = Date.parse(this.#now()) - ms;
        const old = this.#data.questions.filter((q) => Date.parse(q.askedAt) < cutoff);
        if (old.length === 0) return 0;
        this.#data.questions = this.#data.questions.filter((q) => !old.includes(q));
        await this.#flush();
        for (const q of old) this.#left(q.id, { kind: 'dismissed', notes: [] });
        for (const q of old) await this.#mailDismissed(q);
        return old.length;
    }

    /**
     * The ASKING agent withdraws its question (ForceTheQuestion `action: 'cancel'`): it leaves the Deck and the window and
     * the person is not asked any more. Nothing is mailed — the agent that withdrew it knows. Another agent's question,
     * or one from another workspace, is refused with no change (and is not distinguished from a missing one).
     */
    async withdraw(owner: QuestionOwner, questionId: string): Promise<{ ok: true; questionId: string; withdrawn: true }> {
        this.#owned(owner, questionId);
        this.#data.questions = this.#data.questions.filter((x) => x.id !== questionId);
        await this.#flush();
        this.#left(questionId, { kind: 'withdrawn' });
        return { ok: true, questionId, withdrawn: true };
    }

    /**
     * The ASKING agent replaces its question's content (and, if given, its priority). Same id, same `askedAt` — so it
     * keeps its place in the queue — and `revision` + 1, so a form holding a draft for the old content starts clean.
     * Validated like an ask; an update identical to another of the agent's pending questions is refused.
     */
    async update(input: UpdateInput): Promise<{ ok: true; questionId: string; revision: number }> {
        const q = this.#owned(input, input.questionId);
        const refusal = validateQuestions(input.questions);
        if (refusal !== null) throw new Error(refusal);
        const key = questionKey(input.agentId, input.questions);
        const twin = this.#data.questions.find((x) => x.key === key && x.id !== q.id);
        if (twin) throw new Error(`that is the same as your pending question ${twin.id}; cancel one of them instead`);
        const revision = (q.revision ?? 0) + 1;
        const next: PendingQuestion = { ...q, key, questions: input.questions, priority: input.priority ?? q.priority, revision };
        this.#data.questions = this.#data.questions.map((x) => (x.id === q.id ? next : x));
        await this.#flush();
        return { ok: true, questionId: q.id, revision };
    }

    #owned(owner: QuestionOwner, questionId: string): PendingQuestion {
        const q = this.#data.questions.find((x) => x.id === questionId);
        // One refusal for "missing" and "not yours": an agent learns nothing about another agent's questions from it.
        if (!q || q.agentId !== owner.agentId || q.workspaceId !== owner.workspaceId) {
            throw new Error(`no pending question ${questionId} asked by you in this workspace`);
        }
        return q;
    }

    async #mailDismissed(q: PendingQuestion, notes: readonly string[] = []): Promise<void> {
        // Each note the person left, under the header of the question it is about; blank ones say nothing.
        const noted = q.questions.flatMap((question, i) => {
            const own = (notes[i] ?? '').trim();
            return own ? [`Note on ${question.header}: ${own}`] : [];
        });
        await this.#inbox.send({
            from: HUMAN,
            to: q.agentId,
            text: [
                `${questionTitle(q.questions)}: dismissed by the person, without an answer.`,
                `(Your question ${q.id}. Nothing was chosen; decide without it, or ask again if it still matters.)`,
                ...noted,
            ].join('\n'),
        });
    }

    /**
     * The person marked done something an agent put on their list. The asker is told the way an answer reaches it —
     * mail FROM the human (`answer` above) — so its ordinary `receive` carries it and main's `inbox.onSend` wiring
     * reminds it if it is idle. Mail to an agent this Genie no longer knows is kept like any other and wakes nobody.
     * Only the person's Done is mailed: an agent marking its own item knows, and the same item done twice is mailed once.
     */
    async #mailListDone(item: ListItem): Promise<void> {
        await this.#inbox.send({
            from: HUMAN,
            to: item.askedBy as AgentId,
            text: [`The person marked done the item you put on their list: ${item.text}`, `(Your list item ${item.id}.)`].join('\n'),
        });
    }

    async #saveHandoff(input: ImDoneInput): Promise<HandoffSaved | HandoffNotSaved> {
        if (input.handoff === undefined) return { saved: false, reason: 'no handoff was passed' };
        if (!input.agentName) return { saved: false, reason: 'no agent name to file the handoff under' };
        if (!input.workspacePath) return { saved: false, reason: 'no workspace to write the handoff into' };

        const dir = join(input.workspacePath, '.ai', 'handoff');
        const path = join(dir, `${input.agentName}.md`);
        try {
            await mkdir(dir, { recursive: true });
            const tmp = `${path}.${randomUUID()}.tmp`;
            await writeFile(tmp, `${input.handoff.trimEnd()}\n`, 'utf8');
            await rename(tmp, path);
            return { saved: true, path };
        } catch (error) {
            return { saved: false, reason: `writing ${path} failed: ${(error as Error).message}` };
        }
    }

    #scoped(input: { list: ListKind; workspaceId: string; agentId: AgentId }): ListRecord[] {
        return this.#data.lists.filter(
            (r) =>
                r.list === input.list &&
                r.workspaceId === input.workspaceId &&
                (input.list === 'user' || r.item.askedBy === input.agentId),
        );
    }

    async #addToList(input: { list: ListKind; workspaceId: string; agentId: AgentId; text: string }): Promise<ListAddResult> {
        const item: ListItem = { id: `li_${randomUUID()}`, text: input.text, askedBy: input.agentId, createdAt: this.#now(), done: false };
        const current = this.#scoped(input).map((r) => r.item);
        const result = addToList(input.list, current, item);
        if (result.kind === 'full') return { kind: 'full', limit: result.limit };
        if (result.kind === 'question') return { kind: 'question', reason: result.reason };
        this.#data.lists.push({ list: input.list, workspaceId: input.workspaceId, item });
        await this.#flush();
        return { kind: 'added', item };
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.#file, this.#data);
        // Every change lands here, so here is where it is announced: the Deck reads questions, the person's list and
        // finished agents from this store, and a Deck that is not told shows nothing (the owner, 2026-10-14: "I have not
        // seen FTQ modals pop up at all").
        for (const listener of this.#changeListeners) listener();
    }

    readonly #changeListeners = new Set<() => void>();
    readonly #leaveListeners = new Set<(questionId: string, outcome: QuestionLeft) => void>();

    /**
     * A question LEFT — answered, dismissed or withdrawn — with how (genie#1204): what a flow waiting on its own
     * ForceTheQuestion step listens for, to go on down the answer's port. Told after the change is written.
     */
    onLeave(listener: (questionId: string, outcome: QuestionLeft) => void): () => void {
        this.#leaveListeners.add(listener);
        return () => this.#leaveListeners.delete(listener);
    }

    #left(questionId: string, outcome: QuestionLeft): void {
        // Kept a while too: a waiter that looks just after the question left (answered in the same moment it was asked)
        // still learns how, rather than finding it gone and guessing.
        this.#recentlyLeft.set(questionId, outcome);
        if (this.#recentlyLeft.size > 200) this.#recentlyLeft.delete(this.#recentlyLeft.keys().next().value as string);
        for (const l of this.#leaveListeners) l(questionId, outcome);
    }

    readonly #recentlyLeft = new Map<string, QuestionLeft>();

    /** How a question that recently left, left (genie#1204); undefined for one still pending or long gone. */
    leftOutcome(questionId: string): QuestionLeft | undefined {
        return this.#recentlyLeft.get(questionId);
    }

    /** Something the Deck shows changed: a question asked or answered, a list item, a finished agent. */
    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => this.#changeListeners.delete(listener);
    }
}
