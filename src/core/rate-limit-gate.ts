/**
 * RATE LIMITS PAUSE, THEY DO NOT BREAK (Tynn story #287, task #792). The owner, 2026-10-17: "When it hits you cannot
 * process anything else and everything dies, so genie needs to be able to detect that automatically and show a timer
 * to the user and then auto start back up a little bit after the timer".
 *
 * ONE GATE PER PROVIDER LOGIN: every agent on the person's Claude account shares one limit, so one breach pauses them
 * all, and codex's account is another gate. Fed the provider's OWN structured readings, which prism-acp carries under
 * `_meta["particle.academy/rate_limit"]`:
 *  - Claude's SDKRateLimitEvent (code.claude.com/docs/en/agent-sdk/typescript): `status` 'allowed' | 'allowed_warning' |
 *    'rejected', `resetsAt`, `errorCode: 'credits_required'` — the session cannot continue until credits are bought.
 *    prism-acp: `{ status, rateLimitType, resetsAtMs, windows, raw }`; its advice, kept: test `status !== 'allowed'`,
 *    never a breach spelling (none had been captured when it was written).
 *  - codex's `account/rateLimits`: `primary` / `secondary` `{ usedPercent, windowDurationMins, resetsAtMs }`.
 *
 * A RESET TIME IS NEVER INVENTED. A breach with no reset (a turn that failed `rate_limit` with no reading) is retried on
 * a STATED backoff, and says so; `credits_required` is the person's — no timer would ever end it.
 */

export interface LimitReading {
    /** The provider's window key: Claude's `five_hour` / `seven_day`, codex's `primary` / `secondary`. */
    readonly window: string;
    readonly status: 'allowed' | 'rejected' | 'needs-person';
    readonly resetsAtMs: number | null;
}

export interface GateKey {
    readonly provider: string;
    /** The login the limit belongs to; `default` while Genie runs every agent of a provider on the person's one login. */
    readonly account: string;
}

export type GateView =
    | { readonly state: 'open' }
    | { readonly state: 'paused'; readonly window: string; readonly resetsAtMs: number; readonly resumeAtMs: number; readonly message: string | null }
    | { readonly state: 'retrying'; readonly nextTryAtMs: number; readonly attempt: number; readonly message: string | null }
    | { readonly state: 'needs-person'; readonly message: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The readings in a rate-limit `_meta` value; `[]` for a shape it does not know — nothing is guessed. */
export function limitReadingsFromMeta(value: unknown): LimitReading[] {
    if (!isRecord(value)) return [];
    if (typeof value['status'] === 'string' && isRecord(value['windows'])) {
        const status = value['status'];
        const raw = isRecord(value['raw']) ? value['raw'] : {};
        const windows = value['windows'];
        const type = typeof value['rateLimitType'] === 'string' ? value['rateLimitType'] : Object.keys(windows)[0];
        if (type === undefined) return [];
        const w = isRecord(windows[type]) ? windows[type] : {};
        const reset = num(w['resetsAtMs']) ?? num(value['resetsAtMs']);
        if (raw['errorCode'] === 'credits_required') return [{ window: type, status: 'needs-person', resetsAtMs: null }];
        const allowed = status === 'allowed' || status === 'allowed_warning';
        return [{ window: type, status: allowed ? 'allowed' : 'rejected', resetsAtMs: reset }];
    }
    const out: LimitReading[] = [];
    for (const window of ['primary', 'secondary']) {
        const w = value[window];
        if (!isRecord(w)) continue;
        const used = num(w['usedPercent']);
        if (used === null) continue;
        out.push({ window, status: used >= 100 ? 'rejected' : 'allowed', resetsAtMs: num(w['resetsAtMs']) });
    }
    return out;
}

interface LoginState {
    /** Rejected windows and when each resets. */
    readonly rejected: Map<string, number>;
    message: string | null;
    retry: { nextTryAtMs: number; attempt: number } | null;
    needsPerson: boolean;
    /** Was held (paused, retrying or needs-person) and has not yet been reported by due(). */
    held: boolean;
}

const DEFAULT_MARGIN_MS = 2 * 60_000;
const DEFAULT_BACKOFF_MS: readonly number[] = [15 * 60_000, 30 * 60_000, 60 * 60_000];

export class RateLimitGate {
    readonly #marginMs: number;
    readonly #backoff: readonly number[];
    readonly #logins = new Map<string, { key: GateKey; state: LoginState }>();

    constructor(options: { marginMs?: number; retryBackoffMs?: readonly number[] } = {}) {
        this.#marginMs = options.marginMs ?? DEFAULT_MARGIN_MS;
        this.#backoff = options.retryBackoffMs && options.retryBackoffMs.length > 0 ? options.retryBackoffMs : DEFAULT_BACKOFF_MS;
    }

    #state(key: GateKey): LoginState {
        const id = `${key.provider}\u0000${key.account}`;
        let entry = this.#logins.get(id);
        if (!entry) {
            entry = { key: { provider: key.provider, account: key.account }, state: { rejected: new Map(), message: null, retry: null, needsPerson: false, held: false } };
            this.#logins.set(id, entry);
        }
        return entry.state;
    }

    /** The provider's readings for a login: rejected windows pause it, an allowed reading lifts its own window. */
    report(key: GateKey, readings: readonly LimitReading[], nowMs: number, message: string | null): GateView {
        const s = this.#state(key);
        for (const r of readings) {
            if (r.status === 'needs-person') {
                s.needsPerson = true;
                s.held = true;
            } else if (r.status === 'rejected' && r.resetsAtMs !== null) {
                // A reset already past still waits the margin from NOW: the provider needs a moment to refresh.
                s.rejected.set(r.window, Math.max(r.resetsAtMs, nowMs));
                s.retry = null; // a known reset replaces a guess-free backoff
                s.held = true;
            } else if (r.status === 'rejected') {
                this.#retry(s, nowMs);
            } else {
                s.rejected.delete(r.window);
            }
        }
        if (message !== null && readings.some((r) => r.status !== 'allowed')) s.message = message;
        // EVERY window allowed: the limit has lifted — a no-reset backoff is over, and a login still waiting on it is let
        // go at the next wake (due) instead of at a guessed time (genie#1195: Codex's own reading said 3% used).
        if (readings.length > 0 && readings.every((r) => r.status === 'allowed')) s.retry = null;
        return this.view(key, nowMs);
    }

    /** A turn failed for the limit with no structured reading: a known pause stands; otherwise the backoff. */
    breach(key: GateKey, nowMs: number, message: string | null): GateView {
        const s = this.#state(key);
        if (message !== null) s.message = message;
        if (s.rejected.size === 0 && !s.needsPerson) this.#retry(s, nowMs);
        return this.view(key, nowMs);
    }

    #retry(s: LoginState, nowMs: number): void {
        const attempt = (s.retry?.attempt ?? 0) + 1;
        const step = this.#backoff[Math.min(attempt, this.#backoff.length) - 1]!;
        s.retry = { nextTryAtMs: nowMs + step, attempt };
        s.held = true;
    }

    view(key: GateKey, _nowMs: number): GateView {
        const s = this.#state(key);
        if (s.needsPerson) return { state: 'needs-person', message: s.message };
        if (s.rejected.size > 0) {
            let window = '';
            let resetsAtMs = -Infinity;
            for (const [w, at] of s.rejected) if (at > resetsAtMs) { window = w; resetsAtMs = at; }
            return { state: 'paused', window, resetsAtMs, resumeAtMs: resetsAtMs + this.#marginMs, message: s.message };
        }
        // A retry is "retrying" only while it HOLDS the login. Once it fired (due let the login go) the try is in flight:
        // said as retrying, its past time was re-armed at once — a 0 ms wake loop — and an allowed reading then held the
        // session again with nothing left to let it go (genie#1195). It stays counted for the next breach's step.
        if (s.retry && s.held) return { state: 'retrying', nextTryAtMs: s.retry.nextTryAtMs, attempt: s.retry.attempt, message: s.message };
        return { state: 'open' };
    }

    /**
     * The logins whose hold has ended by `nowMs` — a pause past its reset and margin, a retry whose time has come, or a
     * window an allowed reading lifted — each named ONCE. A retry stays counted: if the try hits the limit again,
     * `breach` takes the next step of the backoff.
     */
    due(nowMs: number): GateKey[] {
        const out: GateKey[] = [];
        for (const { key, state: s } of this.#logins.values()) {
            if (!s.held || s.needsPerson) continue;
            if (s.rejected.size > 0) {
                const last = Math.max(...s.rejected.values());
                if (nowMs < last + this.#marginMs) continue;
                s.rejected.clear();
            } else if (s.retry) {
                if (nowMs < s.retry.nextTryAtMs) continue;
                s.held = false;
                out.push(key);
                continue;
            }
            s.held = false;
            s.retry = null;
            s.message = null;
            out.push(key);
        }
        return out;
    }

    /** A try went through: the backoff is over, and the next breach starts again at its first step. */
    ok(key: GateKey): void {
        const s = this.#state(key);
        s.retry = null;
        if (s.rejected.size === 0 && !s.needsPerson) { s.held = false; s.message = null; }
    }

    /** The person's "Resume now": open at once, nothing left to resume later. */
    resumeNow(key: GateKey): void {
        const s = this.#state(key);
        s.rejected.clear();
        s.retry = null;
        s.needsPerson = false;
        s.held = false;
        s.message = null;
    }
}
