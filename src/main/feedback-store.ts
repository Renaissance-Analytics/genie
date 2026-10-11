import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * FEEDBACK (§6.3 `submitFeedback`) — what an agent or the person says about Genie itself, kept durably
 * on this machine. Tynn is the eventual destination and is not wired yet, so an item stays
 * `sent: false` until something marks it; the store says what it holds, never that it was delivered.
 */

export type FeedbackKind = 'bug' | 'idea' | 'praise';
const KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'praise'];

export interface FeedbackItem {
    readonly id: string;
    readonly workspaceId: string;
    readonly agentName: string | null;
    readonly kind: FeedbackKind;
    readonly text: string;
    readonly at: string;
    readonly sent: boolean;
}

interface FeedbackFile {
    items: FeedbackItem[];
}

export class FeedbackStore {
    readonly #file: string;
    readonly #now: () => number;
    #data: FeedbackFile;
    #pending: Promise<void> = Promise.resolve();

    private constructor(file: string, now: () => number, data: FeedbackFile) {
        this.#file = file;
        this.#now = now;
        this.#data = data;
    }

    static async open(userData: string, now: () => number = Date.now): Promise<FeedbackStore> {
        const file = join(runtimeDir(userData), 'feedback.json');
        return new FeedbackStore(file, now, await readJson<FeedbackFile>(file, { items: [] }));
    }

    add(input: { workspaceId: string; agentName: string | null; kind: FeedbackKind; text: string }): FeedbackItem {
        if (input.text.trim().length === 0) throw new Error('feedback needs some text');
        if (!KINDS.includes(input.kind)) throw new Error(`feedback kind must be one of ${KINDS.join(', ')}`);
        const item: FeedbackItem = { id: `fb_${randomUUID()}`, workspaceId: input.workspaceId, agentName: input.agentName, kind: input.kind, text: input.text.trim(), at: new Date(this.#now()).toISOString(), sent: false };
        this.#data.items.unshift(item);
        void this.#flush();
        return item;
    }

    list(): readonly FeedbackItem[] {
        return this.#data.items;
    }

    unsent(): readonly FeedbackItem[] {
        return this.#data.items.filter((i) => !i.sent);
    }

    markSent(id: string): boolean {
        if (!this.#data.items.some((i) => i.id === id)) return false;
        this.#data.items = this.#data.items.map((i) => (i.id === id ? { ...i, sent: true } : i));
        void this.#flush();
        return true;
    }

    flushed(): Promise<void> {
        return this.#pending;
    }

    #flush(): Promise<void> {
        const snapshot: FeedbackFile = { items: [...this.#data.items] };
        this.#pending = this.#pending.then(() => writeJsonAtomic(this.#file, snapshot));
        return this.#pending;
    }
}
