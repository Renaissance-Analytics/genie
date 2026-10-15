import { getNodeKind } from '@particle-academy/fancy-flow/engine';
import { WORKFLOW_SCHEMA_URL, importWorkflow } from '@particle-academy/fancy-flow/schema';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL, canonicalFlowDocument, flowDocument, flowNodes } from '../src/core/flow-form.js';
import { GENIE_NODE_KINDS, ensureGenieKinds, importFlowDocument } from '../src/main/flow-kinds.js';

/**
 * GENIE'S STEP KINDS ARE REGISTERED WITH FANCY-FLOW, AND A DOCUMENT HAS ONE SHAPE.
 *
 * fancy-flow's `importWorkflow` reads a document's steps from `graph.nodes`. Genie wrote them at the top level, so
 * the engine validated ZERO nodes and every document passed — a command step with no command included. And the
 * engine knew none of Genie's kinds, so once it did read the nodes it would have refused every Genie step as an
 * unknown kind. Here: the kinds are in the engine's own registry (`registerNodeKind`, read by `/schema`'s
 * `importWorkflow`), the canonical shape is the engine's `WorkflowSchema`, and an old document is migrated.
 */

const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
const graphDoc = (step: Record<string, unknown>) => ({
    $schema: FLOW_SCHEMA_URL,
    version: 1,
    graph: { nodes: [trigger, { id: 's', position: { x: 240, y: 0 }, ...step }], edges: [{ id: 'e1', source: 't', target: 's' }] },
});

describe('the kinds are in fancy-flow’s registry', () => {
    it('after ensureGenieKinds the engine’s OWN importWorkflow (the /schema entry) knows all three, with no issue, and registering again changes nothing', () => {
        ensureGenieKinds();
        ensureGenieKinds();
        for (const kind of GENIE_NODE_KINDS) expect(getNodeKind(kind.name)?.name).toBe(kind.name);
        const complete = [
            { kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 'npm run report' } },
            { kind: 'genie/agent_prompt', config: { agent: 'claude:atlas', prompt: 'post the standup' } },
            { kind: 'genie/knowledge_add', config: { workspace: 'ws-example', title: 'Nightly report' } },
        ];
        // Counted: three documents, each read by the engine with its two nodes and no issue at all.
        const results = complete.map((step) => importWorkflow(graphDoc(step)));
        expect(results.map((r) => [r.ok, r.graph.nodes.length, r.issues])).toEqual([[true, 2, []], [true, 2, []], [true, 2, []]]);
    });

    it('the schema URL Genie writes is the engine’s', () => {
        expect(FLOW_SCHEMA_URL).toBe(WORKFLOW_SCHEMA_URL);
    });
});

describe('importFlowDocument — the one way a document is read (the store accepts through it, the runner runs through it)', () => {
    it('a step missing the config its kind REQUIRES is refused in the engine’s words, naming the node — one per kind, counted; control: complete, accepted', () => {
        const missing = [
            graphDoc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example' } }),
            graphDoc({ kind: 'genie/agent_prompt', config: { prompt: 'post the standup' } }),
            graphDoc({ kind: 'genie/knowledge_add', config: { workspace: 'ws-example' } }),
        ];
        const refused = missing.map((d) => importFlowDocument(d));
        expect(refused.map((r) => (r.ok ? 'accepted' : r.problems))).toEqual([['node s: command: Command is required'], ['node s: agent: Agent is required'], ['node s: title: Title is required']]);
        const control = importFlowDocument(graphDoc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 'npm run report' } }));
        expect(control.ok).toBe(true);
    });

    it('a required field that is only WHITESPACE is blank and refused, worded by its label — counted: blank command, blank agent, blank prompt; control: non-blank, accepted', () => {
        const blank = [
            graphDoc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: '   ' } }),
            graphDoc({ kind: 'genie/agent_prompt', config: { agent: ' \t ', prompt: 'post the standup' } }),
            graphDoc({ kind: 'genie/agent_prompt', config: { agent: 'claude:atlas', prompt: '\n  ' } }),
        ];
        // The engine alone lets them through: it only treats "" as missing.
        ensureGenieKinds();
        expect(blank.map((d) => importWorkflow(d).issues)).toEqual([[], [], []]);
        const refused = blank.map((d) => importFlowDocument(d));
        expect(refused.map((r) => (r.ok ? 'accepted' : r.problems))).toEqual([['node s: command: Command is required'], ['node s: agent: Agent is required'], ['node s: prompt: Prompt is required']]);
        const control = importFlowDocument(graphDoc({ kind: 'genie/agent_prompt', config: { agent: 'claude:atlas', prompt: 'post the standup' } }));
        expect(control.ok).toBe(true);
    });

    it('a kind nobody registered is refused as unknown; a wrong-typed config value is refused (the engine only WARNS — Genie refuses)', () => {
        const unknown = importFlowDocument(graphDoc({ kind: 'genie/no_such_kind', config: {} }));
        expect(unknown).toEqual({ ok: false, problems: ['node s: Unknown kind "genie/no_such_kind" — register it before importing.'] });
        const typed = importFlowDocument(graphDoc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 42 } }));
        expect(typed).toEqual({ ok: false, problems: ['node s: command: Command must be a string'] });
        // The same document as the engine sees it: the issue IS only a warning there, and ok.
        expect(importWorkflow(graphDoc({ kind: 'genie/terminal_run', config: { workspace: 'ws-example', command: 42 } }))).toMatchObject({ ok: true, issues: [{ level: 'warning' }] });
    });

    it('a document carrying steps both at the top level and under graph is refused — the engine would silently drop the top-level ones', () => {
        const both = { ...graphDoc({ kind: 'log', config: { message: 'tick' } }), nodes: [trigger] };
        expect(importFlowDocument(both)).toEqual({ ok: false, problems: ['the document has nodes or edges both at the top level and under graph; send one graph'] });
    });

    it('an OLD top-level document is read migrated: its steps are validated (refused when incomplete) — not skipped', () => {
        const old = { version: 1, nodes: [trigger, { id: 's', kind: 'genie/terminal_run', position: { x: 240, y: 0 }, config: { workspace: 'ws-example' } }], edges: [{ id: 'e1', source: 't', target: 's' }] };
        expect(importFlowDocument(old)).toEqual({ ok: false, problems: ['node s: command: Command is required'] });
    });
});

describe('canonicalFlowDocument — the migration', () => {
    it('moves a version-1 document’s top-level nodes and edges under graph and adds $schema; everything else is kept', () => {
        const old = { version: 1, metadata: { name: 'nightly' }, nodes: [trigger], edges: [] };
        expect(canonicalFlowDocument(old)).toEqual({ $schema: FLOW_SCHEMA_URL, version: 1, metadata: { name: 'nightly' }, graph: { nodes: [trigger], edges: [] } });
    });

    it('a canonical document is returned AS IS (the same object); one without $schema gains it; another version or a non-object is left for the engine to refuse', () => {
        const canonical = graphDoc({ kind: 'log', config: { message: 'tick' } });
        expect(canonicalFlowDocument(canonical)).toBe(canonical);
        const noSchema = { version: 1, graph: canonical.graph };
        expect(canonicalFlowDocument(noSchema)).toEqual(canonical);
        const v2 = { version: 2, nodes: [], edges: [] };
        expect(canonicalFlowDocument(v2)).toBe(v2);
        expect(canonicalFlowDocument(null)).toBeNull();
        expect(canonicalFlowDocument('nope')).toBe('nope');
    });

    it('flowNodes reads both through the migration — the same nodes either way', () => {
        const old = { version: 1, nodes: [trigger], edges: [] };
        expect(flowNodes(old)).toEqual([trigger]);
        expect(flowNodes(canonicalFlowDocument(old))).toEqual([trigger]);
    });
});

describe('what the form writes is canonical and the engine accepts it', () => {
    it('each step the form makes — a command, a prompt, a log — imports with no issue, in the graph shape', () => {
        const steps = [
            { kind: 'command', command: 'npm run report', folder: 'repos/app' },
            { kind: 'agent', agent: 'claude:atlas', prompt: 'post the standup' },
            { kind: 'log' },
        ] as const;
        for (const step of steps) {
            const document = flowDocument({ workspaceId: 'ws-example', cron: '0 3 * * *', step });
            expect(document).toMatchObject({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { edges: [{ id: 'e1', source: 't', target: 's' }] } });
            expect(document).not.toHaveProperty('nodes');
            expect(importFlowDocument(document)).toMatchObject({ ok: true, document });
        }
    });
});
