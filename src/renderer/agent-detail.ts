/**
 * Which id to subscribe an agent's live detail by: the RESOLVED detail's own id. Main pushes on
 * `genie:agent-changed:<id>`, and a route may name an agent by name (`chat=moic`); subscribing by that name heard
 * nothing. `null` until the detail resolves — no subscription on a guess.
 */
export function chatSubscriptionId(_routeName: string, detail: { agent: { id: string } } | null): string | null {
    return detail ? detail.agent.id : null;
}

/**
 * WHAT AN AGENT SWITCH SHOWS FIRST (the owner, 2026-10-16: switching agent tabs redrew everything and flashed). The
 * detail hook used to reset to empty on every switch, so a frame never showed the previous agent's rows under the new
 * one's name; the chat emptied and refilled. This keeps each agent's last detail by the key it was asked by AND by its
 * id: a switch shows THAT agent's detail at once, never another's (an agent not seen yet shows nothing, as before),
 * and the live detail replaces it as it lands. Bounded: the least recently shown goes first.
 */
/** The rows a cache may hold in all (#386 review): the count cap alone let 24 ledgers of up to 4 MiB each stay. */
export const AGENT_DETAIL_CACHE_MAX_BYTES = 48 * 1024 * 1024;

const encoder = new TextEncoder();
/**
 * Each row's size, measured once (Tynn #665). A pushed detail is a new object, but its rows are the rows the page already
 * holds, by reference (core/agent-push-wire.ts): keyed by the row, a push costs the rows it added. Keyed by the detail it
 * cost the whole ledger again — a 6,000-row thread serialised and encoded per push, ~0.8 GB a minute in #664's soak.
 */
const rowSizes = new WeakMap<object, number>();
function rowBytes(row: unknown): number {
    const keyed = row !== null && typeof row === 'object';
    if (keyed) { const known = rowSizes.get(row); if (known !== undefined) return known; }
    const r = row as { at?: unknown; event?: unknown } | null;
    let size = 0;
    try { size = encoder.encode(JSON.stringify({ event: r?.event, at: r?.at })).length; } catch { /* unmeasurable: counted as nothing */ }
    if (keyed) rowSizes.set(row, size);
    return size;
}
/** A detail's size as the history read counts it (core/thread-store.ts `rowBytes`): each row's time and event, as JSON. */
export function detailBytes(detail: { readonly rows?: readonly unknown[] }): number {
    let bytes = 0;
    for (const row of detail.rows ?? []) bytes += rowBytes(row);
    return bytes;
}

export class AgentDetailCache<D extends { readonly agent: { readonly id: string } }> {
    readonly #limit: number;
    readonly #maxBytes: number;
    readonly #byKey = new Map<string, D>();
    /** Each detail's size, measured once (a detail is never changed in place: a new one replaces it). */
    readonly #sizes = new WeakMap<D, number>();
    /** The detail shown last: never evicted, whatever it weighs. */
    #current: D | null = null;

    constructor(limit = 24, maxBytes = AGENT_DETAIL_CACHE_MAX_BYTES) {
        this.#limit = limit;
        this.#maxBytes = maxBytes;
    }

    /** The state a switch to `key` opens with: its last detail (resolved), or nothing (not resolved). */
    show(key: string): { detail: D | null; resolved: boolean } {
        const detail = this.#byKey.get(key);
        if (detail === undefined) return { detail: null, resolved: false };
        this.#touch(key, detail);
        return { detail, resolved: true };
    }

    /** Remember the detail that landed for `key` (a name or an id), under the agent's id too. */
    remember(key: string, detail: D | null): void {
        if (detail === null) return;
        this.#touch(key, detail);
        if (detail.agent.id !== key) this.#touch(detail.agent.id, detail);
        // Least recently shown first, by count and by bytes; never the one shown last.
        while (this.#byKey.size > this.#limit || this.bytes() > this.#maxBytes) {
            const oldest = [...this.#byKey.entries()].find(([, d]) => d !== this.#current);
            if (oldest === undefined) break;
            this.#byKey.delete(oldest[0]);
        }
    }

    /**
     * A DETAIL THAT LANDED for `key` — the first answer, or a push — and what to show for it (Tynn #659). A whole detail is
     * remembered and shown. One whose rows are PENDING (its host is still reading or sending its ledger: a first read, or a
     * switch back after the window's replica was dropped) is never remembered, so it never replaces the rows kept for the
     * agent: they are shown, with everything else the new detail says (its session, its mail), until a whole one lands.
     * An agent with nothing kept shows the pending detail as it is, which the chat draws as loading.
     */
    land(key: string, detail: D | null): D | null {
        if (detail === null) return null;
        if ((detail as { rowsPending?: boolean }).rowsPending !== true) {
            this.remember(key, detail);
            return detail;
        }
        const kept = this.#byKey.get(key) ?? this.#byKey.get(detail.agent.id);
        if (kept === undefined || kept.agent.id !== detail.agent.id) return detail;
        this.#current = kept;
        return { ...detail, rows: (kept as unknown as { rows: unknown }).rows, rowsPending: false };
    }

    /** The rows held, in bytes: each detail once, however many keys it is kept under. */
    bytes(): number {
        let total = 0;
        for (const d of new Set(this.#byKey.values())) total += this.#sizeOf(d);
        return total;
    }

    #sizeOf(d: D): number {
        let size = this.#sizes.get(d);
        if (size === undefined) { size = detailBytes(d as unknown as { rows?: readonly unknown[] }); this.#sizes.set(d, size); }
        return size;
    }

    size(): number { return this.#byKey.size; }

    #touch(key: string, detail: D): void {
        this.#current = detail;
        this.#byKey.delete(key);
        this.#byKey.set(key, detail);
    }
}
