/**
 * THE CHAT'S PLAN LINE, HOVERED (Tynn #703): what the popover under "Working · Plan n/m" lists. Every OPEN item of the
 * agent's active plan, in the plan's own order, with its status and the current one marked; the done ones are only counted.
 */
export interface ChatPlanItem {
    readonly content: string;
    /** `in_progress` or `pending` (whatever the provider calls an item that is not done). */
    readonly status: string;
    readonly current: boolean;
}

export interface ChatPlanView {
    readonly items: readonly ChatPlanItem[];
    /** How many items are done (left out of `items`). */
    readonly done: number;
    /** All items, done or not. */
    readonly of: number;
}

/** `null` = no plan, or nothing left open: the line has no list to show. */
export function chatPlanView(steps: readonly { readonly content: string; readonly status: string }[] | null | undefined): ChatPlanView | null {
    if (!steps || steps.length === 0) return null;
    const items = steps.filter((s) => s.status !== 'completed').map((s): ChatPlanItem => ({ content: s.content, status: s.status, current: s.status === 'in_progress' }));
    if (items.length === 0) return null;
    return { items, done: steps.length - items.length, of: steps.length };
}

/**
 * THE WHOLE PLAN, FOR THE DASHBOARD'S HOVER (Tynn #918; the owner, 2026-11-19: "hovering the plan column must show the
 * agent's FULL plan"). Every step in the plan's order, done ones included, each with its status and the in-progress one
 * marked. The steps are the host's (`LiveSession.planSteps`), so every client lists the same plan.
 */
export function fullPlanView(steps: readonly { readonly content: string; readonly status: string }[] | null | undefined): ChatPlanView | null {
    if (!steps || steps.length === 0) return null;
    const items = steps.map((s): ChatPlanItem => ({ content: s.content, status: s.status, current: s.status === 'in_progress' }));
    return { items, done: steps.filter((s) => s.status === 'completed').length, of: steps.length };
}
