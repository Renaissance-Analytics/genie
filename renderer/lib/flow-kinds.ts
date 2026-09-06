/**
 * Putting Genie's own steps on the canvas.
 *
 * ## Why the renderer has to do this at all
 *
 * fancy-flow's node registry is per-PROCESS, and `<FlowEditor>` reads the
 * renderer's. Main knowing about Genie's node kinds does nothing for the palette
 * a person sees — which is exactly what went wrong: the kinds were derived in
 * main, served on an IPC channel nothing called, and never registered anywhere
 * the editor could see them. The canvas offered fancy-flow's builtins, every one
 * of which Genie's executor is designed to refuse, and offered none of the steps
 * Genie can actually run.
 *
 * ## The registered set IS the palette, for GENIE's steps
 *
 * A GApp window is its own renderer process, and it acts for exactly one app. So
 * registering only what that app was granted means the palette cannot offer a
 * Genie step that would certainly be refused at run time — enforced by the
 * process boundary rather than by a filter somebody could pass wrongly.
 *
 * The full list still crosses IPC as `all`, for a surface that wants to show
 * what is possible but not yet permitted. It is deliberately NOT registered:
 * shown and unauthorable is the point.
 *
 * ## Not registering is no lever at all over FANCY's own steps
 *
 * fancy-flow registers its own builtins at import, and withholding them is not
 * on the table — the canvas needs `branch`, `merge` and the rest. So the only
 * way to keep one out of the palette is to say so at render time. That is
 * `paletteKindFilter` below.
 *
 * ## Registering does not grant anything
 *
 * A kind is a shape on a canvas. Every one of these still goes through the same
 * `decideAppCall` gate in main when the flow runs, and `check` refuses a graph
 * that reaches too far while the author is still drawing it. Nothing here is an
 * authority decision — it is the vocabulary the author is allowed to see.
 */

import { getNodeKind, registerNodeKind } from '@particle-academy/fancy-flow/engine';
import { PAUSES_WITHOUT_RESUME } from '../../main/flows/pauses';

/**
 * Which registered kinds the palette offers — `<FlowEditor>`'s `kindFilter`.
 *
 * Hides the steps that would park a run Genie cannot resume, so one cannot be
 * dragged onto a canvas at all. `pauses.ts` holds the list and the whole
 * argument; the two things worth knowing here are:
 *
 *  - **It is the SAME list the refusals read.** Not a copy. Add a kind there and
 *    the palette hides it with no second edit — and the doors keep refusing it,
 *    which they must, because this filter only ever sees the palette. A graph
 *    that arrives hand-authored, imported, or written by an agent through
 *    `manageFlows` never passes through here.
 *  - **The filter runs BEFORE the palette's search box** (verified in
 *    `NodePalette`: it filters the full list, then the query filters that). So a
 *    hidden kind cannot be typed back into view, which a post-search filter
 *    would have allowed.
 *
 * Declared at module scope rather than inline in the panel because `NodePalette`
 * memoises its grouping on the filter's identity: a new closure every render
 * would rebuild the palette on every keystroke in the config panel.
 */
export function paletteKindFilter({ kind }: { kind: { name: string } }): boolean {
    return !PAUSES_WITHOUT_RESUME.has(kind.name);
}

/**
 * A Genie step, as main describes it over IPC.
 *
 * Structurally `GenieNodeDefinition` from `main/apps/flows/kinds.ts`, restated
 * here because the renderer must not import main. Everything in it is
 * serializable — no icon, no render function — because the two processes have to
 * end up with the SAME kind, and a React element crosses IPC as `{}`.
 */
export interface FlowNodeDefinitionView {
    name: string;
    aliases: string[];
    tool: string;
    capability: string;
    category: 'io' | 'human' | 'data' | 'output';
    label: string;
    description: string;
    configSchema: {
        key: string;
        label: string;
        type: 'text' | 'textarea' | 'number' | 'select' | 'switch' | 'json';
        description?: string;
        required?: boolean;
        default?: unknown;
        options?: { value: string; label: string }[];
    }[];
    inputs: { id: string }[];
    outputs: { id: string }[];
    sideEffects: 'none' | 'idempotent' | 'unsafe-to-replay';
}

/**
 * Register these kinds, and hand back the way to remove them.
 *
 * Two properties a panel depends on:
 *
 *  - **Idempotent.** `registerNodeKind` throws on a duplicate id, and a React
 *    panel remounts for reasons that have nothing to do with flows. A kind
 *    already present is left alone rather than replaced — replacing would also
 *    work today and would quietly become "last mount wins" the moment two
 *    surfaces register different definitions for one name.
 *  - **Reversible.** The returned undo removes exactly what this call added,
 *    and nothing else. A window that switches to another app must not keep
 *    offering the previous app's steps — that would be a palette showing
 *    something the current grant never covered.
 */
export function registerFlowKinds(defs: readonly FlowNodeDefinitionView[]): () => void {
    const undos: (() => void)[] = [];

    for (const def of defs) {
        // Already there — from an earlier mount, or from another surface in this
        // same window. Not ours to remove, so nothing is pushed onto `undos`.
        if (getNodeKind(def.name)) continue;
        undos.push(registerNodeKind(def as never));
    }

    return () => {
        while (undos.length) undos.pop()?.();
    };
}
