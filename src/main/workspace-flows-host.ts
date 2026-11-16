import { canonicalFlowDocument } from '../core/flow-form.js';
import { cwdProblem } from '../core/workspace-save-guard.js';
import { flowTrustItems, rebindFlow } from '../core/workspace-flows.js';
import { importFlowDocument } from './flow-kinds.js';

/**
 * A FRESH CLONE'S `.flows/`, RESTORED (Tynn #756, PR5). Every flow comes in DISARMED: arming starts work on a person's machine
 * with nobody watching, and is theirs alone (main/flow-store.ts). A flow that runs a command or asks an agent waits for the
 * workspace's one-time trust. A flow already here with that name is never overwritten: the same is `present`, a different one is
 * `differs` and left for the person. The engine's own import decides what is a flow; its words are the refusal.
 */

export interface FlowPorts {
    list(workspaceId: string): readonly { readonly name: string; readonly document: unknown }[];
    create(input: { workspaceId: string; name: string; document: unknown; by: { kind: 'user' } }): Promise<unknown>;
}

export interface FlowRestore {
    readonly created: string[];
    readonly present: string[];
    readonly differs: string[];
    readonly waiting: { file: string; commands: string[] }[];
    readonly refused: { file: string; reason: string }[];
    /** Machine state somebody put in a file (armed, an id, runs...): dropped, and named. */
    readonly ignored: { file: string; keys: string[] }[];
}

/** What a flow file may NOT carry: it is the store's, or the machine's, and is rebuilt or chosen on each machine. */
const MACHINE_KEYS: ReadonlySet<string> = new Set(['armed', 'id', 'workspaceId', 'runs', 'inFlight', 'refusals', 'createdBy', 'createdAt', 'updatedAt', 'importedFrom']);

/** Key order must not decide whether two documents are the same flow. */
function canon(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const o = value as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

/** The folder each step of a flow runs in (`config.cwd`), as written. */
function stepFolders(document: unknown): string[] {
    const graph = (document as { graph?: { nodes?: unknown } } | null)?.graph;
    const nodes = Array.isArray(graph?.nodes) ? (graph!.nodes as unknown[]) : [];
    return nodes.flatMap((n) => {
        const cwd = (n as { config?: { cwd?: unknown } } | null)?.config?.cwd;
        return typeof cwd === 'string' ? [cwd] : [];
    });
}

const stemOf = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.json$/i, '');

export async function restoreFlows(files: readonly { path: string; text: string }[], workspaceId: string, ports: FlowPorts, options: { trusted: boolean }): Promise<FlowRestore> {
    const out: FlowRestore = { created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
    for (const file of files) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(file.text);
        } catch (error) {
            out.refused.push({ file: file.path, reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})` });
            continue;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            out.refused.push({ file: file.path, reason: 'a flow file is one JSON object' });
            continue;
        }
        const stripped: Record<string, unknown> = {};
        const dropped: string[] = [];
        for (const [key, value] of Object.entries(parsed)) {
            if (MACHINE_KEYS.has(key)) dropped.push(key); else stripped[key] = value;
        }
        if (dropped.length > 0) out.ignored.push({ file: file.path, keys: dropped.sort() });
        const document = canonicalFlowDocument(rebindFlow(stripped, workspaceId));
        const wandering = stepFolders(document).map((cwd) => ({ cwd, problem: cwdProblem(cwd) })).find((s) => s.problem !== null);
        if (wandering) {
            out.refused.push({ file: file.path, reason: `a step's cwd ${JSON.stringify(wandering.cwd)} ${wandering.problem}; a cwd is a folder inside the workspace, like repos/app` });
            continue;
        }
        const imported = importFlowDocument(document);
        if (!imported.ok) {
            out.refused.push({ file: file.path, reason: imported.problems.join('; ') });
            continue;
        }
        const name = stemOf(file.path);
        const here = ports.list(workspaceId).find((f) => f.name === name);
        if (here) {
            (canon(canonicalFlowDocument(here.document)) === canon(document) ? out.present : out.differs).push(file.path);
            continue;
        }
        const trust = flowTrustItems([{ path: file.path, value: document }]);
        if (!options.trusted && trust.length > 0) {
            out.waiting.push({ file: file.path, commands: trust.flatMap((t) => [...t.commands]) });
            continue;
        }
        await ports.create({ workspaceId, name, document, by: { kind: 'user' } });
        out.created.push(file.path);
    }
    return out;
}
