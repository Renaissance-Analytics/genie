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
export class AgentDetailCache<D extends { readonly agent: { readonly id: string } }> {
    readonly #limit: number;
    readonly #byKey = new Map<string, D>();

    constructor(limit = 24) {
        this.#limit = limit;
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
        while (this.#byKey.size > this.#limit) {
            const oldest = this.#byKey.keys().next().value;
            if (oldest === undefined) break;
            this.#byKey.delete(oldest);
        }
    }

    #touch(key: string, detail: D): void {
        this.#byKey.delete(key);
        this.#byKey.set(key, detail);
    }
}
