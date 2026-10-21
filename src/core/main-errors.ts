import type { DeckItem } from './deck.js';

/**
 * THE MAIN PROCESS'S POLICY FOR AN ERROR NOBODY CAUGHT (the owner, 2026-10-15): log it, record it as a recoverable
 * problem the person can see, and keep running — never a blocking dialog, never an exit.
 *
 * ## Why a listener at all
 *
 * Electron opens its own "A JavaScript error occurred in the main process" dialog for an uncaught exception ONLY when
 * the process has no `uncaughtException` listener. On Linux that dialog is `gtk_dialog_run` on the main thread: a
 * modal loop that blocks everything else the main process does. Measured on 2026-10-15 — an uncaught EPIPE from the
 * terminal host's pty raised it, and Genie froze behind it: the window, the DevTools endpoint, every agent and every
 * site unresponsive, with the dialog itself often hidden behind other windows. One listener is what removes that
 * dialog; this module is what the listener does instead of nothing.
 *
 * An `unhandledRejection` listener is installed beside it for the same reason: with none, Node's default
 * (`--unhandled-rejections=throw`) turns a rejected promise nobody awaited into an uncaught exception — the same dialog.
 *
 * ## What "recoverable" means here, and where the person sees it
 *
 * Each distinct error is a Deck item from Genie itself (`source: 'genie'`, the same surface as the Trust ask): the
 * Deck is where Genie says "something needs you", its count is the rail's one badge, and an item there is answered in
 * place — here with Dismiss. It is not an agent's warning row: an agent's recoverable provider problem (session.ts,
 * #261) belongs to that agent's stream; an error in the main process belongs to no agent.
 *
 * ## Repeats, and the bound
 *
 * A repeat — the same kind, message and top stack frame — is ONE item with a count, never N items: an EPIPE storm
 * from one dead pipe is one problem. The log line is written in full (with the stack) the first time, and again with
 * the count each time the count reaches a power of two. That bound matters beyond tidiness: when stderr is itself the
 * dead pipe, every log write can raise the next EPIPE, and a handler that logged every repeat would feed itself
 * forever. With powers of two it stops after one more line.
 *
 * At most `MAX_MAIN_ERRORS` distinct errors are kept; a new one past that replaces the one seen LEAST recently, and
 * the number replaced is itself a Deck item — nothing leaves the Deck without the person being told.
 *
 * ## Errors before the window exists
 *
 * The book exists from main.ts's first statement, so an error raised while Genie is still starting — before the
 * registry, before the window — is recorded and logged at once, and is on the Deck the moment the window first reads
 * it. It is never a native dialog. A `boot()` that REJECTS is a different thing — Genie did not start — and stays
 * main.ts's own `boot().catch`.
 */

/**
 * `stop-unverified`: an agent's stop could not be verified — a process of its run is still running, or the machine could
 * not be read (hosting plan 1.1/1.3). Not a crash: a Deck item, because "Stop" must never quietly mean "probably".
 */
export type MainErrorKind = 'uncaught-exception' | 'unhandled-rejection' | 'stop-unverified' | 'containment-unready';

export const MAIN_ERROR_DECK_PREFIX = 'genie:main-error:';
/** The Deck item that says how many distinct errors were replaced to keep the list bounded. */
export const MAIN_ERROR_OVERFLOW_ID = `${MAIN_ERROR_DECK_PREFIX}overflow`;
export const MAX_MAIN_ERRORS = 20;

export interface MainError {
    /** The Deck item's id: the prefix and a hash of the identity below. */
    readonly id: string;
    readonly kind: MainErrorKind;
    readonly message: string;
    /** The first `at …` line of the stack, or `''` when there is none (a rejection with a string reason). */
    readonly topFrame: string;
    readonly stack: string | null;
    readonly count: number;
    /** Epoch ms. */
    readonly firstAt: number;
    readonly lastAt: number;
}

export interface Recorded {
    readonly error: MainError;
    /** True the first time this error is seen (and the first time after a Dismiss). */
    readonly first: boolean;
    /** Whether this occurrence is written to the log: the first, then each power-of-two count. */
    readonly log: boolean;
}

const KIND_LABEL: Record<MainErrorKind, string> = {
    'uncaught-exception': 'uncaught exception',
    'unhandled-rejection': 'unhandled promise rejection',
    'stop-unverified': 'unverified stop',
    'containment-unready': 'uncontained start',
};

/** Whatever was thrown — an Error, a string, an object, `undefined` — as a message, its stack and the stack's top frame. */
export function describeThrown(thrown: unknown): { message: string; stack: string | null; topFrame: string } {
    if (thrown instanceof Error) {
        const code = (thrown as { code?: unknown }).code;
        const head = thrown.message || thrown.name || 'Error';
        const message = typeof code === 'string' && !head.includes(code) ? `${head} (${code})` : head;
        const stack = typeof thrown.stack === 'string' ? thrown.stack : null;
        const topFrame = stack?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('at ')) ?? '';
        return { message, stack, topFrame };
    }
    if (typeof thrown === 'string') return { message: thrown, stack: null, topFrame: '' };
    let text: string;
    try { text = JSON.stringify(thrown) ?? String(thrown); } catch { text = String(thrown); }
    return { message: text, stack: null, topFrame: '' };
}

/**
 * The identity of an error: kind, message, top frame. Two with the same identity are one problem seen twice.
 *
 * Hashed in plain TypeScript (cyrb53), not node:crypto: deck-resolve.ts imports this module for the id prefix, and the
 * renderer imports deck-resolve.ts — a Node builtin here would break the renderer's bundle.
 */
export function mainErrorId(kind: MainErrorKind, message: string, topFrame: string): string {
    const text = JSON.stringify([kind, message, topFrame]);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return MAIN_ERROR_DECK_PREFIX + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/** The log line for one recorded occurrence: the full stack the first time, the count after. */
export function mainErrorLogLine(recorded: Recorded): string {
    const e = recorded.error;
    const head = `[genie] ${KIND_LABEL[e.kind]} in the main process, recorded on the Deck; Genie keeps running`;
    if (recorded.first) return `${head}: ${e.stack ?? e.message}`;
    return `${head}: ${e.message}${e.topFrame ? ` ${e.topFrame}` : ''} — seen ${e.count} times`;
}

/** The Deck's title for one error: what happened, that Genie kept running, how many times. */
export function mainErrorTitle(e: MainError): string {
    const times = e.count === 1 ? '' : ` — ${e.count} times`;
    // prism-acp 0.21's supervisor could not be built or verified: its drivers refuse to start rather than run uncontained.
    if (e.kind === 'containment-unready') return `Agents cannot start contained: ${e.message.replace(/\.$/, '')}${times}. Until this is fixed an agent will not start, so none is left running uncontained. Each step is in ~/.genie/runtime/lifecycle.log.`;
    if (e.kind === 'stop-unverified') return `A stop could not be verified: ${e.message.replace(/\.$/, '')}${times}. Each step is in ~/.genie/runtime/lifecycle.log.`;
    return `Genie kept running after an ${KIND_LABEL[e.kind]}: ${e.message}${e.topFrame ? ` (${e.topFrame})` : ''}${times}. The stack is in Genie’s log.`;
}

const DISMISS = [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' as const }];

export class MainErrorBook {
    readonly #now: () => number;
    readonly #max: number;
    #errors: MainError[] = [];
    #replaced = 0;
    #replacedAt = 0;
    readonly #listeners = new Set<() => void>();

    constructor(options: { now?: () => number; max?: number } = {}) {
        this.#now = options.now ?? Date.now;
        this.#max = options.max ?? MAX_MAIN_ERRORS;
    }

    record(kind: MainErrorKind, thrown: unknown): Recorded {
        const { message, stack, topFrame } = describeThrown(thrown);
        const id = mainErrorId(kind, message, topFrame);
        const at = this.#now();
        const known = this.#errors.find((e) => e.id === id);
        let recorded: Recorded;
        if (known) {
            const next: MainError = { ...known, count: known.count + 1, lastAt: at };
            this.#errors = this.#errors.map((e) => (e.id === id ? next : e));
            recorded = { error: next, first: false, log: isPowerOfTwo(next.count) };
        } else {
            const fresh: MainError = { id, kind, message, topFrame, stack, count: 1, firstAt: at, lastAt: at };
            if (this.#errors.length >= this.#max) {
                // Bounded: the one seen least recently makes room, and the Deck says how many did.
                const stalest = this.#errors.reduce((a, b) => (b.lastAt < a.lastAt ? b : a));
                this.#errors = this.#errors.filter((e) => e !== stalest);
                this.#replaced++;
                this.#replacedAt = at;
            }
            this.#errors = [...this.#errors, fresh];
            recorded = { error: fresh, first: true, log: true };
        }
        this.#changed();
        return recorded;
    }

    list(): readonly MainError[] {
        return this.#errors;
    }

    /** How many distinct errors were replaced to keep the list bounded, since the person last dismissed that count. */
    get replaced(): number {
        return this.#replaced;
    }

    /** The person's Dismiss: the item leaves the Deck. The same error again is a new item, counted from one. */
    dismiss(id: string): boolean {
        if (id === MAIN_ERROR_OVERFLOW_ID) {
            if (this.#replaced === 0) return false;
            this.#replaced = 0;
            this.#changed();
            return true;
        }
        const before = this.#errors.length;
        this.#errors = this.#errors.filter((e) => e.id !== id);
        if (this.#errors.length === before) return false;
        this.#changed();
        return true;
    }

    deckItems(): DeckItem[] {
        const items: DeckItem[] = this.#errors.map((e): DeckItem => ({
            id: e.id,
            source: 'genie',
            agentId: null,
            agentName: null,
            workspaceId: null,
            title: mainErrorTitle(e),
            blocking: false,
            // Not blocking — nothing has stopped — but above a to-do: part of Genie may be in a state it did not expect.
            priority: 'high',
            at: e.firstAt,
            answer: { kind: 'inline', options: DISMISS },
            forwardedFrom: null,
        }));
        if (this.#replaced > 0) {
            items.push({
                id: MAIN_ERROR_OVERFLOW_ID,
                source: 'genie',
                agentId: null,
                agentName: null,
                workspaceId: null,
                title: `${this.#replaced} more ${this.#replaced === 1 ? 'error was' : 'errors were'} recorded in the main process and replaced here to keep this list to ${this.#max}; each is in Genie’s log.`,
                blocking: false,
                priority: 'high',
                at: this.#replacedAt,
                answer: { kind: 'inline', options: DISMISS },
                forwardedFrom: null,
            });
        }
        return items;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        // A listener that throws must not throw out of an uncaughtException handler: that would end the process.
        for (const l of this.#listeners) {
            try { l(); } catch { /* the Deck refreshes on the next change; the error itself is already recorded and logged */ }
        }
    }
}

/** What the policy needs of `process`: to listen. A stand-in in tests, `process` in main.ts. */
export interface ErrorEventSource {
    on(event: 'uncaughtException', listener: (error: unknown, origin?: string) => void): unknown;
    on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

const installed = new WeakSet<object>();

/**
 * INSTALL THE POLICY on `target` (main.ts: `process`, as its first statement). Exactly one listener for each event, so
 * a second call is a no-op rather than a second log line per error. The handler never throws: a throw from inside an
 * `uncaughtException` listener ends the process, which is the one outcome this policy exists to prevent.
 */
export function installMainErrorPolicy(target: ErrorEventSource, book: MainErrorBook, log: (line: string) => void = (line) => console.error(line)): void {
    if (installed.has(target)) return;
    installed.add(target);
    const handle = (kind: MainErrorKind, thrown: unknown) => {
        let line: string;
        try {
            const recorded = book.record(kind, thrown);
            if (!recorded.log) return;
            line = mainErrorLogLine(recorded);
        } catch {
            // Recording failed (it should not): the log is the last place left to say it.
            let text: string;
            try { text = String(thrown); } catch { text = 'a value that cannot be printed'; }
            line = `[genie] ${KIND_LABEL[kind]} in the main process (not recorded on the Deck): ${text}`;
        }
        // The log may itself be the dead pipe (a synchronous EPIPE on stderr): the error is on the Deck either way.
        try { log(line); } catch { /* nothing left to write to */ }
    };
    target.on('uncaughtException', (error) => handle('uncaught-exception', error));
    target.on('unhandledRejection', (reason) => handle('unhandled-rejection', reason));
}
