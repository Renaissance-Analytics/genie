/**
 * PURE. Building the nodes of a flow graph — the ONE way Genie makes one.
 *
 * ## Why this exists at all
 *
 * A node's `type` is not decoration. `runFlow` resolves a node's executor by
 * walking `[node.id, node.type, ...kindIds(kind), "*"]` and taking the first
 * registry hit, so what goes in `type` decides whether the node runs.
 *
 * `<FlowEditor>` writes the node's KIND ID there — `addNode` in
 * `@particle-academy/fancy-flow` builds exactly this:
 *
 * ```js
 * { id, type: kind.name, position: at,
 *   data: { kind: kind.name, label: kind.label, config: defaultConfigFor(kind) } }
 * ```
 *
 * Genie previously hand-wrote nodes with a COARSE type (`'trigger'`,
 * `'action'`) — the six-kit convention fancy-flow used at v0.48 and dropped.
 * A node written that way and a node the editor produces are two different
 * documents, and Genie's executors only ever matched the first. So every node an
 * author dragged onto the canvas aborted the run with "No executor registered",
 * while the suite stayed green: the tests hand-wrote their graphs the same way
 * the starter did.
 *
 * **The fix is not to teach the tests the editor's shape. It is to have ONE
 * function that makes a node**, used by the starter graph, by the flow templates,
 * by the MCP authoring tool, and by the tests — so a graph Genie makes and a
 * graph a person draws cannot be different kinds of document. Where a graph
 * comes from should never change whether it runs.
 *
 * ## It is DERIVED from the live registry, never from a literal
 *
 * `label`, `config` and the id itself all come from `getNodeKind`. A kind that is
 * renamed, gains a config field, or disappears is reflected here the moment the
 * package updates, instead of drifting until somebody notices at run time.
 */

import { defaultConfigFor, getNodeKind } from '@particle-academy/fancy-flow/engine';

/** A node in a stored graph. Structural: a stored graph may be anything. */
export interface FlowNodeDoc {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: {
        kind: string;
        label: string;
        config: Record<string, unknown>;
    };
}

export interface FlowEdgeDoc {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
}

export interface FlowGraphDoc {
    nodes: FlowNodeDoc[];
    edges: FlowEdgeDoc[];
}

/**
 * A node of `kindName`, shaped exactly as `<FlowEditor>` would have made it.
 *
 * Returns `null` for a kind nothing has registered — the same answer `addNode`
 * gives, and the honest one: a node naming a kind that does not exist has no
 * ports, no config and no executor, and writing it into a graph would produce a
 * document that can only fail later, further from the mistake.
 */
export function newFlowNode(
    kindName: string,
    position: { x: number; y: number } = { x: 80, y: 80 },
    id: string = newFlowNodeId(),
): FlowNodeDoc | null {
    const kind = getNodeKind(kindName);
    if (!kind) return null;

    return {
        id,
        // `kind.name`, not `kindName`: an ALIAS resolves to the kind, and writing
        // the alias into the document would pin a stored graph to a spelling the
        // package is free to retire. The canonical id is the one that keeps
        // meaning what it means.
        type: kind.name,
        position,
        data: {
            kind: kind.name,
            label: kind.label,
            config: defaultConfigFor(kind),
        },
    };
}

let seq = 0;

/**
 * An id for a new node.
 *
 * Time plus a counter, because two nodes added in the same millisecond — which
 * is every node of a template graph — must not collide. A collision is not a
 * cosmetic problem: `runFlow` keys `portValues` by `${nodeId}:${portId}` and
 * looks executors up by `node.id` first, so two nodes sharing an id would read
 * each other's outputs.
 */
export function newFlowNodeId(): string {
    seq += 1;
    return `n${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * What a new flow starts as: a manual trigger, and nothing else.
 *
 * Not an empty graph. `decideFlowAdmission` refuses one — an empty graph is
 * nearly always a failed load or a bad edit, and reporting success for it would
 * hide both — so a new flow would open already complaining.
 *
 * Built through {@link newFlowNode} rather than written as a literal, which is
 * the whole point of this module existing: the starter was the ONE hand-written
 * graph whose shape matched Genie's old executors, so it worked while everything
 * a person could actually draw did not, and no test could see the difference.
 */
export function starterFlowGraph(): FlowGraphDoc {
    const start = newFlowNode('@particle-academy/manual_trigger', { x: 80, y: 80 }, 'start');
    // The manual trigger is a fancy-flow builtin and is always registered, so
    // this cannot be null in practice. Returning an empty graph if it somehow
    // were is still better than writing a node with no kind.
    return { nodes: start ? [start] : [], edges: [] };
}

/** An edge from one node's output port to another's input port. */
export function newFlowEdge(
    source: string,
    target: string,
    handles: { sourceHandle?: string; targetHandle?: string } = {},
): FlowEdgeDoc {
    const from = handles.sourceHandle ? `${source}:${handles.sourceHandle}` : source;
    const to = handles.targetHandle ? `${target}:${handles.targetHandle}` : target;
    return {
        id: `e-${from}-${to}`,
        source,
        target,
        ...handles,
    };
}
