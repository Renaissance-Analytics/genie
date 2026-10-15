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
import type { AgentId } from '../core/identity.js';
import { HUMAN } from '../core/inbox.js';
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
 * of filing a second one. The answer is not returned by the tool — it is mailed to the asker
 * through the inbox FROM the human, so the agent's ordinary `receive` picks it up and the human
 * is on record as having decided.
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
}

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
        done(input: { workspaceId: string; id: string }): Promise<boolean>;
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
            done: async ({ workspaceId, id }) => {
                let hit = false;
                this.#data.lists = this.#data.lists.map((r) => {
                    if (r.workspaceId !== workspaceId || r.item.id !== id) return r;
                    hit = true;
                    return { ...r, item: { ...r.item, done: true } };
                });
                if (hit) await this.#flush();
                return hit;
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
        if (existing) return { ok: true, questionId: existing.id, userActive: context.userActive, rejoined: true, dndReply };

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

    /** Something the Deck shows changed: a question asked or answered, a list item, a finished agent. */
    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => this.#changeListeners.delete(listener);
    }
}
