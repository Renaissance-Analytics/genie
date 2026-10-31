import { PIN_TTL_MS } from './remote.js';

/**
 * "PAIR THIS DEVICE?" — THE DESKTOP'S HALF OF PAIRING (the owner, 2026-10-31, q_8c07b142: "add the confirm").
 *
 * A correct PIN is not enough. Genie 1 (v0.7.0-beta.342, main/mobile/auth.ts:20) raised a one-time desktop confirm
 * before minting a token, "so a tailnet peer who somehow learns the PIN still can't pair silently", answered with Pair or
 * Deny, a dismissal counting as Deny (main/background.ts:2841). Kept from it: the prompt names the device and where it
 * connects from, says what pairing grants, and only an explicit Allow pairs. Changed: it is not an OS-modal question but
 * a prompt in Genie's own window that never takes focus, and it lapses after a PIN's lifetime rather than waiting forever.
 *
 * This is the pure queue: the RemoteHost asks, the desktop window answers through a feature action. Clock and timer are
 * injected.
 */

/** How long the prompt waits for Allow: a PIN's lifetime (two minutes). No answer by then is a refusal. */
export const PAIR_CONFIRM_MS = PIN_TTL_MS;

/** How a prompt ended: Allow, Deny, nobody answered, or the device hung up first. */
export type PairAnswer = 'allow' | 'deny' | 'timeout' | 'gone';

export interface PairRequest {
    readonly id: string;
    /** The device's own name for itself (the phone's model, or what was typed). */
    readonly label: string;
    /** Where it connects from (its tailnet address). */
    readonly from: string;
    /** This machine. */
    readonly host: string;
    /** A Re-pair: the device this pairing takes the place of. */
    readonly replaces: { readonly id: string; readonly label: string } | null;
    readonly raisedAt: number;
    readonly expiresAt: number;
}

/** What the RemoteHost needs of the confirm: ask, and withdraw the question if the device leaves. */
export interface PairConfirm {
    ask(input: { label: string; from: string; replaces?: { id: string; label: string } | null }): { id: string; expiresAt: number; answer: Promise<PairAnswer> };
    cancel(id: string): void;
}

const NOT_WAITING = 'that pairing request is no longer waiting — it was answered, it timed out, or the device went away';

/** What the phone is told when the pairing did not happen. */
export function pairRefusal(answer: Exclude<PairAnswer, 'allow'>, host: string): string {
    if (answer === 'deny') return `Pairing was denied on ${host}. Ask for a new PIN to try again.`;
    if (answer === 'timeout') return `Nobody pressed Allow on ${host} within ${Math.round(PAIR_CONFIRM_MS / 60_000)} minutes. Ask for a new PIN to try again.`;
    return `The pairing with ${host} was abandoned.`;
}

interface Pending {
    readonly request: PairRequest;
    readonly settle: (answer: PairAnswer) => void;
    readonly stopTimer: () => void;
}

export class PairApprovals implements PairConfirm {
    readonly #host: string;
    readonly #now: () => number;
    readonly #schedule: (ms: number, fn: () => void) => () => void;
    readonly #ttlMs: number;
    readonly #pending = new Map<string, Pending>();
    readonly #listeners = new Set<() => void>();
    #next = 0;

    constructor(deps: { host: string; now: () => number; schedule?: (ms: number, fn: () => void) => () => void; ttlMs?: number }) {
        this.#host = deps.host;
        this.#now = deps.now;
        this.#schedule = deps.schedule ?? ((ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
        this.#ttlMs = deps.ttlMs ?? PAIR_CONFIRM_MS;
    }

    ask(input: { label: string; from: string; replaces?: { id: string; label: string } | null }): { id: string; expiresAt: number; answer: Promise<PairAnswer> } {
        const id = `pair_${++this.#next}_${this.#now().toString(36)}`;
        const raisedAt = this.#now();
        const request: PairRequest = { id, label: input.label, from: input.from, host: this.#host, replaces: input.replaces ?? null, raisedAt, expiresAt: raisedAt + this.#ttlMs };
        let settle: (answer: PairAnswer) => void = () => {};
        const answer = new Promise<PairAnswer>((resolve) => { settle = resolve; });
        const stopTimer = this.#schedule(this.#ttlMs, () => this.#end(id, 'timeout'));
        this.#pending.set(id, { request, settle, stopTimer });
        this.#changed();
        return { id, expiresAt: request.expiresAt, answer };
    }

    /** The person's Allow (`true`) or Deny (`false`), from this machine's own window. */
    answer(id: string, allow: boolean): { ok: true } | { ok: false; reason: string } {
        const p = this.#pending.get(id);
        if (!p || this.#now() >= p.request.expiresAt) {
            if (p) this.#end(id, 'timeout');
            return { ok: false, reason: NOT_WAITING };
        }
        this.#end(id, allow ? 'allow' : 'deny');
        return { ok: true };
    }

    cancel(id: string): void {
        this.#end(id, 'gone');
    }

    /** What is waiting on the person now, oldest first. */
    requests(): PairRequest[] {
        return [...this.#pending.values()].map((p) => p.request);
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #end(id: string, answer: PairAnswer): void {
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        p.stopTimer();
        p.settle(answer);
        this.#changed();
    }

    #changed(): void {
        for (const l of this.#listeners) l();
    }
}

/** "1:42 left" — a prompt's countdown, never below zero. */
export function timeLeftWords(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}
