/**
 * Which id to subscribe an agent's live detail by: the RESOLVED detail's own id. Main pushes on
 * `genie:agent-changed:<id>`, and a route may name an agent by name (`chat=moic`); subscribing by that name heard
 * nothing. `null` until the detail resolves — no subscription on a guess.
 */
export function chatSubscriptionId(_routeName: string, detail: { agent: { id: string } } | null): string | null {
    return detail ? detail.agent.id : null;
}
