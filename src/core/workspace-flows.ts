import { canonicalFlowDocument } from './flow-form.js';
import type { Exclusion } from './workspace-elements.js';

/**
 * FLOWS, SAVED AS FILES (Tynn #756, PR5; the owner, 2026-11-16: "workflows ... should be in the .flows folder so CI and
 * automation config can ship with the workspace"). Each flow of a workspace is `.flows/<name>.json` holding the flow engine's
 * own document (`{ $schema, version: 1, graph: { nodes, edges } }`) and nothing of Genie's beside it, so a runner without Genie
 * can read it. What stays on the machine: the flow's id, whether it is armed, its runs and history, who made it.
 *
 * The workspace's id is a per-machine ULID, so a node's `workspace` is saved as the token ${workspace} and put back by
 * {@link rebindFlow} on a clone. A flow that names ANOTHER workspace cannot be restored anywhere else, so it is left out and said.
 */

export const WORKSPACE_TOKEN = '${workspace}';

/** The file stem for a flow's name: lower case, words joined by dashes, never empty, never one already taken. */
export function flowFileName(name: string, taken: ReadonlySet<string>): string {
    const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'flow';
    if (!taken.has(stem)) return stem;
    for (let n = 2; ; n++) {
        const candidate = `${stem}-${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** What a save reads of a flow: its name, its workspace and its document. Nothing else of the store's record. */
export interface FlowSource {
    readonly name: string;
    readonly workspaceId: string;
    readonly document: Record<string, unknown>;
}

type Node = { kind?: unknown; config?: Record<string, unknown> } & Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The nodes of a canonical document, or null when it is not a flow document. */
function nodesOf(doc: unknown): Node[] | null {
    if (!isRecord(doc) || !isRecord(doc.graph) || !Array.isArray(doc.graph.nodes)) return null;
    return doc.graph.nodes.filter(isRecord) as Node[];
}

/** The document with every node's `workspace` (when it is `from`) set to `to`. The input is not changed; an unchanged one is returned as it is. */
function mapWorkspace(doc: unknown, from: string, to: string): unknown {
    if (!isRecord(doc) || !isRecord(doc.graph) || !Array.isArray(doc.graph.nodes)) return doc;
    let changed = false;
    const nodes = doc.graph.nodes.map((node) => {
        if (!isRecord(node) || !isRecord(node.config) || node.config.workspace !== from) return node;
        changed = true;
        return { ...node, config: { ...node.config, workspace: to } };
    });
    return changed ? { ...doc, graph: { ...doc.graph, nodes } } : doc;
}

/** A saved flow with the clone's workspace id where the token is. */
export function rebindFlow(document: unknown, workspaceId: string): unknown {
    return mapWorkspace(document, WORKSPACE_TOKEN, workspaceId);
}

/** This workspace's flows as `.flows/<name>.json` files, in the order given; the ones that cannot be saved, with why. */
export function flowsDeclaration(flows: readonly FlowSource[], workspaceId: string): { files: { path: string; value: unknown }[]; excluded: Exclusion[] } {
    const files: { path: string; value: unknown }[] = [];
    const excluded: Exclusion[] = [];
    const taken = new Set<string>();
    for (const flow of flows) {
        if (flow.workspaceId !== workspaceId) continue;
        const stem = flowFileName(flow.name, taken);
        const path = `.flows/${stem}.json`;
        const doc = canonicalFlowDocument(flow.document);
        const nodes = nodesOf(doc);
        if (nodes === null) { excluded.push({ field: path, reason: 'it is not a flow document, so it was not saved' }); continue; }
        if (nodes.some((n) => typeof n.config?.workspace === 'string' && n.config.workspace !== workspaceId && n.config.workspace !== WORKSPACE_TOKEN)) {
            excluded.push({ field: path, reason: 'a step names another workspace, which a clone would not have' });
            continue;
        }
        taken.add(stem);
        files.push({ path, value: mapWorkspace(doc, workspaceId, WORKSPACE_TOKEN) });
    }
    return { files, excluded };
}

/** What a flow file would run: a person trusts these before the flow comes in. */
export interface FlowTrustItem {
    readonly file: string;
    readonly commands: readonly string[];
}

export function flowTrustItems(files: readonly { path: string; value: unknown }[]): FlowTrustItem[] {
    const items: FlowTrustItem[] = [];
    for (const file of files) {
        const commands: string[] = [];
        for (const node of nodesOf(canonicalFlowDocument(file.value)) ?? []) {
            const c = node.config ?? {};
            if (node.kind === 'genie/terminal_run' && typeof c.command === 'string') commands.push(c.command);
            else if (node.kind === 'genie/agent_prompt' && typeof c.agent === 'string' && typeof c.prompt === 'string') commands.push(`ask ${c.agent}: ${c.prompt}`);
        }
        if (commands.length > 0) items.push({ file: file.path, commands });
    }
    return items;
}
