import { describe, expect, it } from 'vitest';
import { flowDocument, type FlowStep } from '../src/core/flow-form.js';
import { withElements, type ElementSources } from '../src/core/workspace-elements.js';
import { flowFileName, flowsDeclaration, flowTrustItems, rebindFlow, WORKSPACE_TOKEN, type FlowSource } from '../src/core/workspace-flows.js';
import { scanForMachineState } from '../src/core/workspace-save-guard.js';
import type { LiveModel } from '../src/core/workspace-save.js';
import { elementSourcesFor, type SourcePorts } from '../src/main/workspace-save-sources.js';
import { restoreFlows, type FlowPorts } from '../src/main/workspace-flows-host.js';

/**
 * FLOWS, SAVED AS FILES (Tynn #756, PR5): each flow of a workspace is its own `.flows/<name>.json` holding the flow engine's own
 * document, so CI and automation can read it without Genie. The workspace's id is saved as the token ${workspace} and
 * re-bound on restore; a flow that names ANOTHER workspace is left out; a flow's id, arming, runs and history never go in. A
 * fresh clone restores flows DISARMED (arming is a person's decision), and one that runs a command waits for the workspace's
 * one-time trust. Fixtures are invented names.
 */

const WS = 'ws_acme';
const command = (text: string, folder = ''): FlowStep => ({ kind: 'command', command: text, folder });
const docOf = (step: FlowStep, workspaceId = WS) => flowDocument({ workspaceId, cron: '0 3 * * *', step }) as unknown as Record<string, unknown>;
const source = (name: string, document: Record<string, unknown>, workspaceId = WS): FlowSource => ({ name, workspaceId, document });
const nodesOf = (doc: unknown) => ((doc as { graph: { nodes: { id: string; kind: string; config: Record<string, unknown> }[] } }).graph.nodes);

describe('the file a flow is saved as', () => {
    it('is named for the flow: lower case, words joined by dashes, never empty, never a collision', () => {
        expect(flowFileName('Nightly Backup', new Set())).toBe('nightly-backup');
        expect(flowFileName('Weekly_Report #2!', new Set())).toBe('weekly-report-2');
        expect(flowFileName('   ', new Set())).toBe('flow');
        expect(flowFileName('日本語', new Set())).toBe('flow');
        expect(flowFileName('Nightly Backup', new Set(['nightly-backup']))).toBe('nightly-backup-2');
        expect(flowFileName('Nightly Backup', new Set(['nightly-backup', 'nightly-backup-2']))).toBe('nightly-backup-3');
        expect(flowFileName('x'.repeat(200), new Set())).toHaveLength(60);
    });

    it('is .flows/<name>.json holding the engine’s own document, with nothing of Genie’s beside it', () => {
        const doc = docOf(command('npm run backup'));
        const { files } = flowsDeclaration([source('Nightly backup', doc)], WS);
        expect(files.map((f) => f.path)).toEqual(['.flows/nightly-backup.json']);
        const saved = files[0]!.value as { $schema: string; version: number; graph: { nodes: unknown[]; edges: unknown[] } };
        expect(Object.keys(saved).sort()).toEqual(['$schema', 'graph', 'version']);
        expect(saved.$schema).toBe('https://particle.academy/schemas/workflow/v1.json');
        expect(saved.version).toBe(1);
        expect(saved.graph.nodes).toHaveLength(2);
        expect(saved.graph.edges).toHaveLength(1);
    });

    it('carries the workspace as the token ${workspace}, never its id, and leaves the flow it was given untouched', () => {
        const doc = docOf(command('npm run backup', 'repos/app'));
        const before = JSON.stringify(doc);
        const { files } = flowsDeclaration([source('Nightly backup', doc)], WS);
        const step = nodesOf(files[0]!.value).find((n) => n.kind === 'genie/terminal_run')!;
        expect(step.config).toEqual({ workspace: WORKSPACE_TOKEN, command: 'npm run backup', cwd: 'repos/app' });
        expect(JSON.stringify(files[0]!.value)).not.toContain(WS);
        expect(JSON.stringify(doc)).toBe(before);
    });

    it('a flow that names ANOTHER workspace is left out and said; another workspace’s flows are not this one’s at all', () => {
        const other = docOf(command('npm run x'), 'ws_other');
        const mine = docOf(command('npm run backup'));
        const out = flowsDeclaration([source('Reaches out', other), source('Mine', mine), source('Theirs', other, 'ws_other')], WS);
        expect(out.files.map((f) => f.path)).toEqual(['.flows/mine.json']);
        expect(out.excluded).toEqual([{ field: '.flows/reaches-out.json', reason: expect.stringContaining('another workspace') }]);
    });

    it('two flows whose names slug alike are two files, in the order given', () => {
        const doc = docOf(command('echo 1'));
        const { files } = flowsDeclaration([source('Backup', doc), source('backup', doc)], WS);
        expect(files.map((f) => f.path)).toEqual(['.flows/backup.json', '.flows/backup-2.json']);
    });

    it('a flow an earlier beta wrote in the old top-level shape is saved in the canonical one', () => {
        const canonical = docOf(command('echo 1'));
        const old = { version: 1, nodes: (canonical.graph as { nodes: unknown[] }).nodes, edges: (canonical.graph as { edges: unknown[] }).edges };
        const { files } = flowsDeclaration([source('Old shape', old)], WS);
        expect(Object.keys(files[0]!.value as object).sort()).toEqual(['$schema', 'graph', 'version']);
    });

    it('CONTROL: no flows is no files', () => {
        expect(flowsDeclaration([], WS)).toEqual({ files: [], excluded: [] });
    });

    it('the guard finds nothing in a saved flow (the token is not a machine), and finds an absolute folder (the control)', () => {
        const clean = flowsDeclaration([source('Nightly backup', docOf(command('npm run backup', 'repos/app')))], WS).files;
        expect(clean).toHaveLength(1);
        expect(scanForMachineState(clean.map((f) => f.value))).toEqual([]);
        const dirty = flowsDeclaration([source('Elsewhere', docOf(command('npm run backup', 'C:/Users/x/app')))], WS).files;
        expect(scanForMachineState(dirty.map((f) => f.value)).map((v) => v.rule)).toEqual(['unsafe-cwd']);
    });
});

describe('what a person must trust before a flow comes in', () => {
    const files = (...docs: [string, Record<string, unknown>][]) => docs.map(([name, doc]) => ({ path: `.flows/${name}.json`, value: doc }));

    it('a flow that runs a command, or asks an agent, lists what it would run', () => {
        const items = flowTrustItems(files(['nightly', docOf(command('npm run backup'))], ['ask', docOf({ kind: 'agent', agent: 'lift@acme', prompt: 'Check the queue.' })]));
        expect(items).toEqual([
            { file: '.flows/nightly.json', commands: ['npm run backup'] },
            { file: '.flows/ask.json', commands: ['ask lift@acme: Check the queue.'] },
        ]);
    });

    it('CONTROL: a flow that only logs lists nothing', () => {
        expect(flowTrustItems(files(['quiet', docOf({ kind: 'log' })]))).toEqual([]);
    });
});

describe('re-binding the token on a clone', () => {
    it('puts the clone’s workspace id where the token is, in every node', () => {
        const saved = flowsDeclaration([source('Nightly backup', docOf(command('npm run backup')))], WS).files[0]!.value;
        const bound = rebindFlow(saved, 'ws_clone');
        expect(nodesOf(bound).find((n) => n.kind === 'genie/terminal_run')!.config.workspace).toBe('ws_clone');
        expect(JSON.stringify(bound)).not.toContain(WORKSPACE_TOKEN);
    });

    it('CONTROL: a flow with no token is returned as it is', () => {
        const doc = docOf({ kind: 'log' });
        expect(rebindFlow(doc, 'ws_clone')).toEqual(doc);
    });
});

describe('flows in Save to repo', () => {
    const model = (): LiveModel => ({ manifest: { name: 'Acme' }, manifestText: '{"name":"Acme"}\n', files: [{ path: '.genie/tabs.json', value: { tabs: [] } }] });
    const sources = (flows: FlowSource[]): ElementSources => ({ services: [], workspace: { overrides: {}, defaultAgent: null, envFile: null, mcpOff: [] }, agents: [], flows });

    it('are files beside project.json, and the files already in the model stay', () => {
        const out = withElements(model(), sources([source('Nightly backup', docOf(command('npm run backup')))]), WS);
        expect(out.model.files.map((f) => f.path)).toEqual(['.genie/tabs.json', '.flows/nightly-backup.json']);
    });

    it('a flow left out is told with the rest of what was left out', () => {
        const out = withElements(model(), sources([source('Reaches out', docOf(command('x'), 'ws_other'))]), WS);
        expect(out.excluded.map((e) => e.field)).toEqual(['.flows/reaches-out.json']);
    });

    it('CONTROL: sources with no flows leave the files as they were', () => {
        const out = withElements(model(), sources([]), WS);
        expect(out.model.files.map((f) => f.path)).toEqual(['.genie/tabs.json']);
    });

    it('the workspace’s flows are read from the store as name, workspace and document only: no id, arming, runs or history', () => {
        const record = { id: 'flow_1', workspaceId: WS, name: 'Nightly backup', document: docOf(command('npm run backup')), armed: true, runs: [{ at: 'x' }], inFlight: { at: 'y' }, createdBy: { kind: 'user' }, refusals: [] };
        const other = { ...record, id: 'flow_2', workspaceId: 'ws_other', name: 'Not mine' };
        const ports = {
            services: { list: () => [] }, settings: { workspaceValues: () => ({}) },
            registry: { defaultAgentOf: () => null, workspaceMcpOff: () => [], listAgents: () => [], listWorkspaces: () => [] },
            flows: { list: () => [record, other] },
        } as unknown as SourcePorts;
        const s = elementSourcesFor(ports, WS);
        expect(s.flows).toEqual([{ name: 'Nightly backup', workspaceId: WS, document: record.document }]);
    });
});

describe('a fresh clone’s flows', () => {
    const saved = (name: string, text: string, workspaceId = WS) => ({ path: `.flows/${name}.json`, value: flowsDeclaration([source(text, docOf(command('npm run backup'), workspaceId), workspaceId)], workspaceId).files[0]?.value });
    const file = (name: string, value: unknown) => ({ path: `.flows/${name}.json`, text: JSON.stringify(value) });
    const rig = (existing: { name: string; document: unknown }[] = []) => {
        const created: { workspaceId: string; name: string; document: unknown; by: { kind: 'user' } }[] = [];
        const ports: FlowPorts = { list: () => existing, create: async (input) => { created.push(input); return input; } };
        return { ports, created };
    };
    const nightly = () => saved('nightly-backup', 'Nightly backup').value;

    it('are created for the clone’s workspace: the token re-bound, the name from the file, by the person, never armed', async () => {
        const { ports, created } = rig();
        const out = await restoreFlows([file('nightly-backup', nightly())], 'ws_clone', ports, { trusted: true });
        expect(out.created).toEqual(['.flows/nightly-backup.json']);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ workspaceId: 'ws_clone', name: 'nightly-backup', by: { kind: 'user' } });
        expect(created[0]).not.toHaveProperty('armed');
        const step = nodesOf(created[0]!.document).find((n) => n.kind === 'genie/terminal_run')!;
        expect(step.config.workspace).toBe('ws_clone');
    });

    it('an armed: true someone put in the file is ignored, and said', async () => {
        const { ports, created } = rig();
        const hand = { ...(nightly() as object), armed: true, id: 'flow_x', workspaceId: 'ws_x', runs: [] };
        const out = await restoreFlows([file('nightly-backup', hand)], 'ws_clone', ports, { trusted: true });
        expect(out.created).toEqual(['.flows/nightly-backup.json']);
        expect(out.ignored).toEqual([{ file: '.flows/nightly-backup.json', keys: ['armed', 'id', 'runs', 'workspaceId'] }]);
        expect(created[0]).not.toHaveProperty('armed');
        expect(created[0]!.document).not.toHaveProperty('armed');
    });

    it('a flow that runs a command waits for the workspace’s trust, and nothing is created', async () => {
        const { ports, created } = rig();
        const out = await restoreFlows([file('nightly-backup', nightly())], 'ws_clone', ports, { trusted: false });
        expect(out.waiting).toEqual([{ file: '.flows/nightly-backup.json', commands: ['npm run backup'] }]);
        expect(out.created).toEqual([]);
        expect(created).toEqual([]);
    });

    it('CONTROL: a flow that only logs does not wait for trust', async () => {
        const { ports } = rig();
        const quiet = flowsDeclaration([source('Quiet', docOf({ kind: 'log' }))], WS).files[0]!.value;
        const out = await restoreFlows([file('quiet', quiet)], 'ws_clone', ports, { trusted: false });
        expect(out.waiting).toEqual([]);
        expect(out.created).toEqual(['.flows/quiet.json']);
    });

    it('a flow already here with that name is left alone: the same is present, a different one is reported and not overwritten', async () => {
        const same = rebindFlow(nightly(), 'ws_clone');
        const present = rig([{ name: 'nightly-backup', document: same }]);
        expect((await restoreFlows([file('nightly-backup', nightly())], 'ws_clone', present.ports, { trusted: true })).present).toEqual(['.flows/nightly-backup.json']);
        const differs = rig([{ name: 'nightly-backup', document: docOf({ kind: 'log' }, 'ws_clone') }]);
        const out = await restoreFlows([file('nightly-backup', nightly())], 'ws_clone', differs.ports, { trusted: true });
        expect(out.differs).toEqual(['.flows/nightly-backup.json']);
        expect(differs.created).toEqual([]);
    });

    it('a file the engine refuses, and one that is not JSON, are refused with their reasons; the rest still come in', async () => {
        const { ports } = rig();
        const bad = { $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: { nodes: [{ id: 'n', kind: 'nobody/registered', position: { x: 0, y: 0 }, config: {} }], edges: [] } };
        const out = await restoreFlows([file('bad', bad), { path: '.flows/broken.json', text: '{ nope' }, file('nightly-backup', nightly())], 'ws_clone', ports, { trusted: true });
        expect(out.refused.map((r) => r.file)).toEqual(['.flows/bad.json', '.flows/broken.json']);
        expect(out.refused[1]!.reason).toContain('not valid JSON');
        expect(out.created).toEqual(['.flows/nightly-backup.json']);
    });

    it('a save, then a restore into another workspace, gives the same flow for it', async () => {
        const original = docOf(command('npm run backup', 'repos/app'));
        const { files } = flowsDeclaration([source('Nightly backup', original)], WS);
        const { ports, created } = rig();
        await restoreFlows(files.map((f) => ({ path: f.path, text: JSON.stringify(f.value) })), 'ws_clone', ports, { trusted: true });
        expect(created[0]!.document).toEqual(docOf(command('npm run backup', 'repos/app'), 'ws_clone'));
    });

    it('CONTROL: an empty folder restores nothing', async () => {
        const { ports } = rig();
        expect(await restoreFlows([], 'ws_clone', ports, { trusted: true })).toEqual({ created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] });
    });
});
