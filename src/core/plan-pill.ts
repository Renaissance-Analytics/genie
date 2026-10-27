import type { ChatDraft } from './chat-drafts.js';

/**
 * TALK ABOUT A PLAN STEP (genie#1280; the owner, 2026-10-27: "show a chat icon on item hover that, when clicked, sends a
 * styled pill to the user input (like the pasted image), so a user can talk about it").
 *
 * The click puts a paste pill into THAT agent's draft — its own composer (genie#1261) — through react-fancy 5.65's
 * `PromptInputHandle`: read the draft, add a text pill and its marker, set it back. Sent, the pill expands in place to
 * the full step, quoted as a plan step. It SHOWS the step's first words (react-fancy 5.66's text-pill `label`), not
 * "Pasted text · N characters". The label is display only, and it is kept with the draft (core/chat-drafts.ts).
 *
 * `setDraft` does not fire `onDraftChange` (react-fancy 5.65), so the new draft is handed to the keeper here, or a
 * restart would lose the pill.
 *
 * FOCUS: the click is the person's gesture, so the insert they asked for focuses the composer (`focus: true`). Nothing
 * else ever does (genie#1235): an insert carries `focus` explicitly, and only the click sets it.
 *
 * Pure: the pure core imports no UI package, so the handle and the marker are described here by shape.
 */

/** react-fancy's pill marker character (`PILL_MARK`): a pill is its id wrapped in a pair of them. */
export const PILL_MARK = '￼';

/** The slice of react-fancy's `PromptInputHandle` an insert uses. */
export interface DraftHandle {
    getDraft(): ChatDraft;
    setDraft(draft: ChatDraft, options?: { focus?: boolean }): void;
}

export interface ChatInsert {
    /** Which chat's composer: the agent the step belongs to. */
    readonly agentId: string;
    /** One per click, so a second click on the same step is a second insert. */
    readonly seq: number;
    readonly pill: { readonly id: string; readonly text: string; readonly label: string };
    /** Only the person's own click focuses the composer. */
    readonly focus: boolean;
}

/** What the pill sends: the full step, quoted. */
export function planStepText(step: string): string {
    return `Plan step: "${step.trim()}"`;
}

/** How many of the step's words the pill shows. */
export const PLAN_LABEL_WORDS = 6;
/** react-fancy's own cap on a pill label (5.66.0). Cut to it here, so the ellipsis is ours. */
export const PLAN_LABEL_MAX = 80;

/** What the pill shows: the step's first words, with an ellipsis when there is more. */
export function planStepLabel(step: string): string {
    const words = step.trim().split(/\s+/).filter((w) => w !== '');
    let label = words.slice(0, PLAN_LABEL_WORDS).join(' ');
    let cut = words.length > PLAN_LABEL_WORDS;
    if (label.length > PLAN_LABEL_MAX - 1) {
        label = label.slice(0, PLAN_LABEL_MAX - 1).trimEnd();
        cut = true;
    }
    return cut ? `${label}…` : label;
}

/** The insert for a click on a step's chat icon. */
export function planStepInsert(agentId: string, step: string, seq: number): ChatInsert {
    return { agentId, seq, pill: { id: `plan-step-${seq}`, text: planStepText(step), label: planStepLabel(step) }, focus: true };
}

/** The draft with the pill added after what is there, and a space after it for the caret. */
export function withPill(draft: ChatDraft, pill: { id: string; text: string; label?: string }): ChatDraft {
    const before = draft.text === '' || /\s$/.test(draft.text) ? draft.text : `${draft.text} `;
    return {
        ...draft,
        text: `${before}${PILL_MARK}${pill.id}${PILL_MARK} `,
        pills: [...draft.pills.filter((p) => p.id !== pill.id), { kind: 'text', id: pill.id, text: pill.text, ...(pill.label !== undefined ? { label: pill.label } : {}) }],
    };
}

/**
 * Apply an insert to its agent's composer. `false` = that composer is not mounted yet: nothing is applied and the insert
 * waits. `keep` is the draft keeper's `change`.
 */
export function applyChatInsert(handles: ReadonlyMap<string, DraftHandle>, insert: ChatInsert, keep?: (agentId: string, draft: ChatDraft) => void): boolean {
    const handle = handles.get(insert.agentId);
    if (!handle) return false;
    const next = withPill(handle.getDraft(), insert.pill);
    handle.setDraft(next, { focus: insert.focus });
    keep?.(insert.agentId, next);
    return true;
}
