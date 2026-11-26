import { randomBytes } from 'node:crypto';
import type { ElevationPromptEvent } from '../core/elevation.js';
import type { AskPassword, PasswordAnswer, PasswordQuestion } from './linux-elevation.js';

/**
 * WHO IS ASKED FOR THE PASSWORD (Tynn #973): the ONE connection the person clicked from, and only it. The host sends that
 * connection an `ask` event (ELEVATION_EVENT); its answer (`elevation.answer`) counts only from that same connection, for
 * that prompt id, once. No capable client (an older Genie, a phone, nobody connected), the connection leaving, Cancel, or
 * no answer within PROMPT_TIMEOUT_MS: refused with a reason, never a hang. The broker holds no password: an answer is
 * handed straight to the waiting run and the broker keeps nothing of it.
 */

export const PROMPT_TIMEOUT_MS = 5 * 60_000;

export interface ElevationBrokerPorts {
    /** Send one connection its prompt event; `false` = it is not connected (any more). */
    send(connectionId: string, event: ElevationPromptEvent): boolean;
    /** Whether that connection said it can show Genie's password prompt (CAP_ELEVATION_PROMPT). */
    capable(connectionId: string): boolean;
    readonly now?: () => number;
    readonly schedule?: (ms: number, fn: () => void) => () => void;
    readonly newId?: () => string;
    readonly timeoutMs?: number;
}

/** Who clicked: the admitted connection, and whether it may change this host. */
export interface ElevationCaller {
    readonly connectionId: string;
    readonly isOwner: boolean;
    readonly readonly: boolean;
}

interface Pending {
    readonly connectionId: string;
    readonly settle: (answer: PasswordAnswer) => void;
}

export const NO_CLIENT = 'no Genie window is connected to ask for the administrator password; open Genie and try again. Nothing was run';
export const NOT_CAPABLE = 'the window you clicked from cannot ask for the administrator password (an older Genie, or a phone); do it from Genie on a computer. Nothing was run';

export class ElevationBroker {
    readonly #ports: ElevationBrokerPorts;
    readonly #pending = new Map<string, Pending>();

    constructor(ports: ElevationBrokerPorts) {
        this.#ports = ports;
    }

    /** The asker for one caller: every question goes to its connection, or is refused with why. */
    askerFor(caller: ElevationCaller | null): AskPassword {
        return (question) => this.ask(caller, question);
    }

    ask(caller: ElevationCaller | null, question: PasswordQuestion): Promise<PasswordAnswer> {
        if (caller === null || caller.connectionId === '') return Promise.resolve({ refused: NO_CLIENT });
        if (!caller.isOwner || caller.readonly) return Promise.resolve({ refused: 'only this machine’s owner can run something on it as administrator; nothing was run' });
        if (!this.#ports.capable(caller.connectionId)) return Promise.resolve({ refused: NOT_CAPABLE });
        const id = this.#ports.newId?.() ?? randomBytes(16).toString('base64url');
        const now = this.#ports.now?.() ?? Date.now();
        const timeoutMs = this.#ports.timeoutMs ?? PROMPT_TIMEOUT_MS;
        return new Promise<PasswordAnswer>((resolve) => {
            let cancelTimer: () => void = () => {};
            const settle = (answer: PasswordAnswer) => {
                if (!this.#pending.delete(id)) return;
                cancelTimer();
                // Closed in the client whatever ended it, so a prompt is never left on a screen with nothing waiting on it.
                this.#ports.send(caller.connectionId, { kind: 'close', id });
                resolve(answer);
            };
            this.#pending.set(id, { connectionId: caller.connectionId, settle });
            const schedule = this.#ports.schedule ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
            cancelTimer = schedule(timeoutMs, () => settle({ refused: `nobody answered the password prompt within ${Math.round(timeoutMs / 60_000)} minutes; nothing was run` }));
            const sent = this.#ports.send(caller.connectionId, { kind: 'ask', id, title: question.title, items: question.items, commands: question.commands, attempt: question.attempt, retry: question.retry, expiresAt: now + timeoutMs });
            if (!sent) settle({ refused: NO_CLIENT });
        });
    }

    /**
     * The client's answer. Counted only from the connection that was asked, for a prompt still open; `null` is Cancel. The
     * return says only whether it was taken, never anything about the password.
     */
    answer(connectionId: string, id: unknown, password: unknown): boolean {
        if (typeof id !== 'string') return false;
        const pending = this.#pending.get(id);
        if (!pending || pending.connectionId !== connectionId) return false;
        if (password === null) pending.settle({ refused: 'you cancelled the password prompt; nothing was run' });
        else if (typeof password === 'string') pending.settle({ password });
        else return false;
        return true;
    }

    /** A connection left: every prompt it was asked is refused at once. */
    dropConnection(connectionId: string): void {
        for (const [, p] of [...this.#pending]) if (p.connectionId === connectionId) p.settle({ refused: 'the window that was asked for the password closed; nothing was run' });
    }

    /** How many prompts are open (tests, and the host's own status). */
    get open(): number {
        return this.#pending.size;
    }
}
