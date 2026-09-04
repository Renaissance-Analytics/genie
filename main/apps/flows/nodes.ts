/**
 * PURE. Which Genie tools exist as flow nodes — DERIVED, never hand-written.
 *
 * A flow node that reaches Genie is a Genie tool call in a different costume. So
 * the palette has to be exactly the set of tools an app could already be granted,
 * and the only way to guarantee that permanently is to generate it from
 * {@link APP_CAPABILITIES} rather than maintain a second list beside it.
 *
 * What that buys, concretely:
 *
 * - `capabilities.ts` already fails the BUILD when a Genie tool is added without
 *   being classified. Deriving the palette from it extends that property to
 *   flows for free — an unclassified tool cannot become a node, so nobody can
 *   widen the flow surface by forgetting something.
 * - {@link UNGRANTABLE_TOOLS} produce no node kind AT ALL. Not a node that
 *   refuses at run time — no node. A tool nobody may ever hold is unreachable by
 *   construction rather than by a check someone has to remember to write.
 * - Resolution is a LOOKUP against that derived set, never string surgery on the
 *   kind. An app that hand-writes `genie.submitFeedback` into a graph resolves to
 *   nothing, because the name was never in the map to begin with.
 *
 * Nothing here grants anything, and nothing here runs. This is the vocabulary;
 * `admission.ts` decides whether a graph may run and the executor enforces it
 * call by call through the same bridge the GApp window uses.
 */

import { APP_CAPABILITIES, isAppCapability, type CapabilityRisk } from '../capabilities';

/**
 * Namespace for every Genie node kind.
 *
 * Fancy's builtins live in the same id space (`@particle-academy/api_request`),
 * and marketplace nodes are namespaced by vendor. Genie takes its own prefix so a
 * Genie node and a Fancy node can never be confused for one another — in the
 * editor palette, in a stored graph, or in the executor's lookup.
 */
export const GENIE_NODE_PREFIX = 'genie.';

/** A Genie tool, presented as something an author can drop on a canvas. */
export interface GenieFlowNodeKind {
    /** The `data.kind` written into the graph, e.g. `genie.manageTerminals`. */
    kind: string;
    /** The Genie tool this node calls. */
    tool: string;
    /** The capability that governs it — what a consent prompt would name. */
    capability: string;
    /** The capability's user-facing label, for the palette. */
    label: string;
    /** Carried through so an editor can mark the dangerous steps as dangerous. */
    risk: CapabilityRisk;
}

/** The node kind that runs `tool`. Says nothing about whether it EXISTS. */
export function nodeKindForTool(tool: string): string {
    return `${GENIE_NODE_PREFIX}${tool}`;
}

/**
 * Every Genie tool node, in capability order.
 *
 * Built once at module load: the capability model is a compile-time constant, so
 * a per-call rebuild would be waste with no upside.
 */
const NODE_KINDS: readonly GenieFlowNodeKind[] = APP_CAPABILITIES.flatMap((capability) =>
    capability.tools.map((tool) => ({
        kind: nodeKindForTool(tool),
        tool,
        capability: capability.key,
        label: capability.label,
        risk: capability.risk,
    })),
);

const BY_KIND: ReadonlyMap<string, GenieFlowNodeKind> = new Map(
    NODE_KINDS.map((n) => [n.kind, n] as const),
);

export function listGenieNodeKinds(): readonly GenieFlowNodeKind[] {
    return NODE_KINDS;
}

/** The Genie node for a kind, or null when the kind is not one of ours. */
export function genieNodeKind(kind: string): GenieFlowNodeKind | null {
    return BY_KIND.get(kind) ?? null;
}

/**
 * The tool a node kind calls, or null.
 *
 * Null for a Fancy builtin, for an ungrantable tool, for a tool that does not
 * exist, and for a string that merely starts with the prefix. The executor treats
 * null as "this node cannot reach Genie", which is the safe reading of every one
 * of those cases.
 */
export function toolForNodeKind(kind: string): string | null {
    return BY_KIND.get(kind)?.tool ?? null;
}

/**
 * The palette an app may actually author with.
 *
 * Filtered by what the user CONSENTED to, so the canvas cannot offer a step that
 * is certain to be refused at run time. `isAppCapability` guards a hand-edited or
 * migrated grant row: an invented capability key must not widen the palette, the
 * same way it must not widen a call in `decideAppCall`.
 */
export function paletteForCapabilities(granted: readonly string[]): readonly GenieFlowNodeKind[] {
    const held = new Set(granted.filter(isAppCapability));
    return NODE_KINDS.filter((n) => held.has(n.capability));
}
