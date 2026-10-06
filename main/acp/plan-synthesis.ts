import type { PlanEntry } from '../agentsession/model';

/**
 * Synthesising a plan from TOOL NAMES, because the Claude CLI never sends a plan.
 *
 * Owner decision, 2026-10-06: *"synthesize the plan from tool names, both vocabularies."*
 *
 * ## The measurement this rests on
 *
 * Prism captured a real plan-building turn against the authenticated CLI: **139 frames and
 * no `plan`, `plan_update` or `plan_removed` of any kind.** The plan arrived entirely as
 * ordinary tool calls. The third-party adapter that was removed performed this synthesis;
 * its own comments state the rule — *"TodoWrite is rendered as a `plan` and Task* tools
 * are [suppressed]"* — and nothing else in the chain does it. So without this module
 * Genie's plan rail is permanently empty for claude, which is the one provider that
 * matters most.
 *
 * ## Two things this gets right on purpose
 *
 * **Suppression, not addition.** A recognised plan tool must NOT also appear in `tools[]`.
 * The adapter suppresses them, and emitting both shows the plan twice — once as the rail,
 * once as tool rows — which presents as a rendering bug in Genie rather than a mapping bug
 * anywhere. `applyPlanTool` returning non-null IS the suppression signal.
 *
 * **This is inference, and inference rots silently.** `TodoWrite` → `TaskCreate`/
 * `TaskUpdate` already happened: the adapter carries both names and prism's capture used
 * only the newer pair. The next rename would make the plan quietly stop appearing with
 * nothing complaining — the exact failure shape this estate keeps finding. So the defence
 * is a RUNTIME canary rather than a comment: {@link isUnrecognisedPlanTool} spots a name
 * that is unmistakably of this family but absent from the table, and the caller reports it.
 * A guard nobody can trip is how these end up checking nothing.
 */

/** What a recognised plan tool does to the list. */
export type PlanToolRole =
    /** Republishes the WHOLE list (`TodoWrite`). The adapter only ever emits `plan`,
     *  resending everything, so this replaces rather than merges. */
    | 'write-all'
    /** Adds one entry (`TaskCreate`). */
    | 'create'
    /** Changes one entry's status (`TaskUpdate`). */
    | 'update';

/**
 * Both vocabularies, per the owner's instruction.
 *
 * `TodoWrite` is the older name and `TaskCreate`/`TaskUpdate` the newer; a given CLI build
 * may emit either, so dropping the old one would break plans for anyone not yet upgraded.
 */
const ROLES: Readonly<Record<string, PlanToolRole>> = {
    TodoWrite: 'write-all',
    TaskCreate: 'create',
    TaskUpdate: 'update',
};

/** Every name that is suppressed as a tool call and surfaced as a plan instead. */
export const PLAN_TOOL_NAMES: readonly string[] = Object.keys(ROLES);

export function planToolRole(name: string): PlanToolRole | null {
    return ROLES[name] ?? null;
}

/**
 * Is this name unmistakably of the plan family, whatever it is called today?
 *
 * Deliberately loose and case-insensitive: a rename may also recase or re-split
 * (`todo_write`, `taskCreateMany`). Being loose here is safe because it only ever feeds the
 * canary — it never routes a tool into synthesis on its own.
 */
export function looksLikePlanTool(name: string): boolean {
    return /^(todo|task)/i.test(name);
}

/**
 * THE CANARY. A plan-shaped name the table does not know — i.e. the rename happening.
 *
 * The caller surfaces this instead of treating it as an ordinary tool, so the failure is
 * loud. Silence here is how the plan rail goes dark with nobody noticing, which is the
 * specific thing the owner was warned about before choosing synthesis.
 */
export function isUnrecognisedPlanTool(name: string): boolean {
    return looksLikePlanTool(name) && planToolRole(name) === null;
}

/**
 * CLI status → `PlanEntry` status.
 *
 * Three values on the wire (`pending | in_progress | completed`), four in `PlanEntry`
 * (`pending | in-progress | done | dropped`) — different spelling AND cardinality.
 * `dropped` has no wire counterpart; it is Genie's own and is never synthesised.
 *
 * Returns null for anything unrecognised, so the caller can leave the existing status
 * ALONE. Defaulting to `pending` would claim the task had not been started, which is a
 * statement about the work rather than about our ignorance.
 */
function statusOf(raw: unknown): PlanEntry['status'] | null {
    switch (raw) {
        case 'pending':
            return 'pending';
        case 'in_progress':
            return 'in-progress';
        case 'completed':
            return 'done';
        default:
            return null;
    }
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface PlanToolCall {
    name: string;
    /** The tool's arguments, straight off the wire — so untrusted and unvalidated. */
    input: unknown;
}

/**
 * Apply a tool call to the plan.
 *
 * **Returns null when this call is NOT a plan** — which is the signal to leave it in
 * `tools[]` as an ordinary tool call. Non-null means the list was understood, and the tool
 * call must be SUPPRESSED so the plan is not also rendered as tool rows.
 *
 * Null is also returned for a recognised NAME with a payload we cannot read. Recognising
 * the name but not the arguments is precisely when guessing is worst, and suppressing the
 * tool call while producing no plan would lose the information entirely — so it stays a
 * visible tool call instead.
 */
export function applyPlanTool(entries: readonly PlanEntry[], call: PlanToolCall): PlanEntry[] | null {
    const role = planToolRole(call.name);
    if (!role) return null;

    const input = (call.input ?? {}) as Record<string, unknown>;

    if (role === 'write-all') {
        const todos = input.todos;
        if (!Array.isArray(todos)) return null;
        const next: PlanEntry[] = [];
        for (const [i, raw] of todos.entries()) {
            const t = (raw ?? {}) as Record<string, unknown>;
            // `content` is TodoWrite's field; `subject` is the Task* one. Accept either, so
            // a build that mixes them still produces a plan.
            const title = str(t.content) ?? str(t.subject);
            if (!title) continue;
            next.push({
                id: str(t.id) ?? `plan-${i}`,
                title,
                status: statusOf(t.status) ?? 'pending',
            });
        }
        // An empty republish is a real state — the agent cleared its plan. But a payload
        // that produced nothing READABLE is not, and must not erase a good plan.
        return todos.length > 0 && next.length === 0 ? null : next;
    }

    if (role === 'create') {
        const title = str(input.subject) ?? str(input.content);
        if (!title) return null;
        return [
            ...entries,
            {
                id: str(input.taskId) ?? str(input.id) ?? `plan-${entries.length}`,
                title,
                // A task that has just been created has not been done.
                status: statusOf(input.status) ?? 'pending',
            },
        ];
    }

    // 'update'
    const id = str(input.taskId) ?? str(input.id);
    if (!id) return null;
    // An id we have never seen is NOT invented: an entry conjured from an update has no
    // title, and a titleless row in the rail is worse than a missing one.
    if (!entries.some((e) => e.id === id)) return [...entries];
    const mapped = statusOf(input.status);
    return entries.map((e) => (e.id === id && mapped ? { ...e, status: mapped } : { ...e }));
}
