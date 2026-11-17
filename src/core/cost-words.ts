/**
 * WHAT A COST FIGURE MEANS (Tynn #747, client onboarding call 2026-11-16). A client on a Claude subscription read "$3.25"
 * as a charge. The figure the provider reports (Claude's `total_cost_usd`) is what the tokens cost at API prices: billed
 * with an API key, included on a subscription plan.
 *
 * Genie does not read the account's credentials or its auth method to tell the two apart. It knows a plan only when the
 * provider itself reported a plan's limit windows (5 h, weekly) in the agent's ledger, which only a subscription plan
 * has. Then the figure reads as the API-price equivalent, in the plan. Otherwise it reads "at API prices", true for an
 * API key, and it claims no plan: never a guess.
 */
export interface CostWords {
    /** The readout: `≈ $0.61 this turn at API prices · in your plan`, or `$0.61 this turn at API prices`. */
    readonly text: string;
    /** The hover: what the figure is. */
    readonly title: string;
}

export type CostScope = 'this turn' | 'this session';

export function costWords(usd: number, scope: CostScope, onPlan: boolean): CostWords {
    const figure = `$${usd.toFixed(2)} ${scope} at API prices`;
    return onPlan
        ? { text: `≈ ${figure} · in your plan`, title: 'What these tokens would cost at API prices. Your plan includes them: this is not a charge.' }
        : { text: figure, title: 'What these tokens cost at API prices. An API key is billed this; a subscription plan includes it.' };
}
