import type { DeckItem } from '../core/deck.js';
import { isWindowQuestion } from '../core/question-queue.js';

/**
 * THE CONNECTED MACHINE'S QUESTIONS, FOR THIS MACHINE'S QUESTION WINDOW (Tynn #726 part 1; the owner's live trial,
 * 2026-11-16: connected to a client's machine, no ForceTheQuestion question reached his window).
 *
 * The question window is native, in each machine's own main process (question-window.ts), and read only this machine's
 * Deck. A drone's agent asked; the window opened on the drone's screen, and the Pilot's never knew. A window driving
 * another machine already HAS that machine's Deck (its snapshot, over the remote link); it reports the live questions
 * here, by its webContents id. They join the one window and its queue under ids of their own (two machines can hold the
 * same id), with the machine named beside the workspace. An answer or a Dismiss goes back to THAT window, which sends it
 * through the host's own `features.act` — the action the host's Deck takes, with the host's own item — and its answer,
 * or its refusal in its own words, is the question window's. Nothing is answered here, and nothing is left hanging.
 */

export type RemoteQuestionAction =
    | { kind: 'deck.answerForm'; selections: string[][]; notes: string[] }
    | { kind: 'deck.dismiss'; notes: string[] };

/** What the window driving the host is asked to send, as the host's FeatureAction. */
export type RemoteDeckAction =
    | { kind: 'deck.answerForm'; item: DeckItem; selections: string[][]; notes: string[]; note: string }
    | { kind: 'deck.dismiss'; item: DeckItem; notes: string[] };

export interface RemoteQuestionRequest {
    readonly id: string;
    readonly action: RemoteDeckAction;
}

type Outcome = { ok: true } | { ok: false; reason: string };

export interface RemoteQuestionsPorts {
    /** To the window `sender` (a webContents id): send it this request. `false` = that window is not there. */
    readonly send: (sender: number, request: RemoteQuestionRequest) => boolean;
    /** How long an answer may take to come back before it is refused. Default one minute. */
    readonly timeoutMs?: number;
}

interface Reported {
    readonly host: string;
    readonly key: string;
    /** Shown id → the host's own item. */
    readonly originals: ReadonlyMap<string, DeckItem>;
    readonly shown: readonly DeckItem[];
}

interface Pending {
    readonly sender: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly host: string;
}

const PREFIX = 'remote:';
const DEFAULT_TIMEOUT_MS = 60_000;

/** A question as it can be shown: an object with an id and a form, nothing else assumed of what a window sent. */
function showable(value: unknown): value is DeckItem {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as { id?: unknown; answer?: unknown };
    if (typeof v.id !== 'string' || typeof v.answer !== 'object' || v.answer === null) return false;
    return isWindowQuestion(value as DeckItem);
}

export class RemoteQuestions {
    readonly #ports: RemoteQuestionsPorts;
    readonly #byWindow = new Map<number, Reported>();
    readonly #pending = new Map<string, Pending>();
    #next = 0;

    constructor(ports: RemoteQuestionsPorts) {
        this.#ports = ports;
    }

    /** The window `sender` drives `host`, whose Deck is `items`. `true` = what the question window reads changed. */
    report(sender: number, host: string, items: readonly unknown[]): boolean {
        const live = items.filter(showable);
        const was = this.#byWindow.get(sender);
        if (live.length === 0 || host === '') {
            if (!was) return false;
            this.#byWindow.delete(sender);
            return true;
        }
        const key = JSON.stringify([host, live]);
        if (was?.key === key) return false;
        const originals = new Map<string, DeckItem>();
        const shown: DeckItem[] = [];
        for (const item of live) {
            const id = `${PREFIX}${sender}:${item.id}`;
            originals.set(id, item);
            shown.push({ ...item, id, workspaceName: item.workspaceName ? `${item.workspaceName} · ${host}` : host });
        }
        this.#byWindow.set(sender, { host, key, originals, shown });
        return true;
    }

    /** The window `sender` closed: its questions go, and an answer still on its way is refused with the reason. */
    drop(sender: number): boolean {
        const was = this.#byWindow.get(sender);
        this.#byWindow.delete(sender);
        for (const [id, p] of this.#pending) {
            if (p.sender !== sender) continue;
            clearTimeout(p.timer);
            this.#pending.delete(id);
            p.reject(new Error(`the window connected to ${p.host} closed before the answer was sent`));
        }
        return was !== undefined;
    }

    /** Every connected machine's live questions, as the question window shows them. */
    items(): DeckItem[] {
        return [...this.#byWindow.values()].flatMap((r) => r.shown);
    }

    /** Is this (shown) id another machine's question? */
    owns(id: string): boolean {
        return [...this.#byWindow.values()].some((r) => r.originals.has(id));
    }

    /** Answer or Dismiss another machine's question, through the window driving it. Rejects with the reason it was refused. */
    act(item: DeckItem, action: RemoteQuestionAction): Promise<void> {
        let sender: number | null = null;
        let reported: Reported | null = null;
        for (const [s, r] of this.#byWindow) if (r.originals.has(item.id)) { sender = s; reported = r; }
        if (sender === null || reported === null) return Promise.reject(new Error('that question was already answered'));
        const original = reported.originals.get(item.id)!;
        const host = reported.host;
        const remote: RemoteDeckAction = action.kind === 'deck.answerForm'
            ? { kind: 'deck.answerForm', item: original, selections: action.selections, notes: action.notes, note: '' }
            : { kind: 'deck.dismiss', item: original, notes: action.notes };
        const id = `rq_${++this.#next}`;
        const to = sender;
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.#pending.delete(id)) return;
                reject(new Error(`${host} did not answer in time; the question is still there`));
            }, this.#ports.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            (timer as { unref?: () => void }).unref?.();
            this.#pending.set(id, { sender: to, resolve, reject, timer, host });
            if (!this.#ports.send(to, { id, action: remote })) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(new Error(`the window connected to ${host} is not open`));
            }
        });
    }

    /** The window that was asked says how it went. Only that window can settle its request. */
    settle(sender: number, requestId: string, outcome: unknown): boolean {
        const p = this.#pending.get(requestId);
        if (!p || p.sender !== sender) return false;
        clearTimeout(p.timer);
        this.#pending.delete(requestId);
        const o = outcome as Partial<Outcome> | null;
        if (o && o.ok === true) p.resolve();
        else p.reject(new Error(o && o.ok === false && typeof o.reason === 'string' ? o.reason : `${p.host} did not say whether it took the answer`));
        return true;
    }
}
