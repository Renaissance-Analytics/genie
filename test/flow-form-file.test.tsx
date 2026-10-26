import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flowFields, flowFormFromFields, formEditable } from '../src/core/flow-form.js';
import { flowFormDefaults, validateFlowForm, type FlowForm } from '../src/core/forms.js';
import { importFlowDocument } from '../src/main/flow-kinds.js';
import { AddFlowForm } from '../src/renderer/components/AddForms.js';

/**
 * A PERSON MAKES A FILE FLOW IN THE FORM (genie#1204 item 5 follow-up). The file trigger landed for agents (#1228);
 * the owner's question was about HIS UX ("i have no UX for managing Flows at all"). The Add/Edit form now offers what
 * starts the flow — a schedule, or a file being added (folder, kinds, a minimum size in MB) — and, for a file flow,
 * "Move the file" into a folder of the workspace. Everything the form builds is a document the engine accepts.
 */

const d = flowFormDefaults({ workspaceId: 'tynn' });
const nodesOf = (form: FlowForm) => (form.document as { graph: { nodes: { id: string; kind: string; config: Record<string, unknown> }[]; edges: unknown[] } }).graph;
const big = { name: 'big files out of git', trigger: 'file', watchFolder: '', extensions: '', minSizeMb: '5', step: 'move', moveTo: '.untracked' };

describe('the form builds a file flow', () => {
    it('the owner\'s case: any file of 5 MB or more is moved to .untracked — and the engine accepts it', () => {
        const form = flowFormFromFields(d, big);
        const graph = nodesOf(form);
        expect(graph.nodes.map((n) => [n.kind, n.config])).toEqual([
            ['genie/file_added', { workspace: 'tynn', minSizeBytes: 5_000_000 }],
            ['genie/file_move', { workspace: 'tynn', from: '{{in.path}}', to: '.untracked' }],
        ]);
        expect(graph.edges).toHaveLength(1);
        expect(validateFlowForm(form)).toEqual([]);
        const imported = importFlowDocument(form.document);
        expect(imported.ok ? [] : imported.problems).toEqual([]);
    });

    it('a folder and kinds are kept as typed; an empty filter is left out, not stored blank', () => {
        const form = flowFormFromFields(d, { ...big, watchFolder: 'uploads', extensions: 'png, jpg', minSizeMb: '' });
        expect(nodesOf(form).nodes[0]!.config).toEqual({ workspace: 'tynn', folder: 'uploads', extensions: 'png, jpg' });
    });

    it('a file flow can run a command or prompt an agent too; a schedule flow is built as before (CONTROL)', () => {
        const command = flowFormFromFields(d, { ...big, step: 'command', command: 'npm run thumbnails', folder: '' });
        expect(nodesOf(command).nodes.map((n) => n.kind)).toEqual(['genie/file_added', 'genie/terminal_run']);
        const scheduled = flowFormFromFields(d, { name: 'r', cron: '0 3 * * *', step: 'command', command: 'npm run report', folder: '' });
        expect(nodesOf(scheduled).nodes.map((n) => n.kind)).toEqual(['schedule_trigger', 'genie/terminal_run']);
    });

    it('reads back for Edit: the trigger, its filters in MB, and the move', () => {
        const fields = flowFields(flowFormFromFields(d, { ...big, watchFolder: 'uploads', extensions: 'png' }).document);
        expect(fields.trigger).toEqual({ kind: 'file', folder: 'uploads', extensions: 'png', minSizeMb: '5' });
        expect(fields.step).toEqual({ kind: 'move', to: '.untracked' });
        expect(formEditable(flowFormFromFields(d, big).document)).toBe(true);
    });
});

describe('what the form refuses, in words beside the field', () => {
    const problemsOf = (fields: Record<string, string>) => validateFlowForm(flowFormFromFields(d, { ...big, ...fields })).map((p) => p.field);

    it('a watched folder or a move folder outside the workspace', () => {
        expect(problemsOf({ watchFolder: '../other' })).toEqual(['watchFolder']);
        expect(problemsOf({ moveTo: '/etc' })).toEqual(['moveTo']);
        expect(problemsOf({ moveTo: '' })).toEqual(['moveTo']);
    });

    it('a size that is not a number of MB', () => {
        expect(problemsOf({ minSizeMb: 'big' })).toEqual(['minSizeMb']);
        expect(problemsOf({ minSizeMb: '-1' })).toEqual(['minSizeMb']);
    });

    it('a command that names the file in a file flow — a file name can carry shell syntax (CONTROL: in a scheduled flow it is allowed)', () => {
        expect(problemsOf({ step: 'command', command: 'mv "{{in.path}}" x/', folder: '' })).toEqual(['command']);
        const scheduled = flowFormFromFields(d, { name: 'r', cron: '0 3 * * *', step: 'command', command: 'echo {{in.firedAt}}', folder: '' });
        expect(validateFlowForm(scheduled)).toEqual([]);
    });
});

describe('the form, drawn', () => {
    const radios = (html: string, name: string) => (html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'g')) ?? []).map((t) => /value="([^"]*)"/.exec(t)?.[1]);

    it('offers what starts the flow; a file flow shows its filters and offers Move the file', () => {
        const html = renderToStaticMarkup(<AddFlowForm defaults={flowFormFromFields(d, big)} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(radios(html, 'trigger')).toEqual(['schedule', 'file']);
        expect(html).toContain('data-flow-trigger="file"');
        expect(html).toContain('name="watchFolder"');
        expect(html).toContain('name="minSizeMb"');
        expect(html).toContain('value="5"');
        expect(radios(html, 'step')).toEqual(['command', 'agent', 'log', 'move']);
        expect(html).toContain('value=".untracked"');
        expect(html).not.toContain('name="cron"');
    });

    it('CONTROL: a schedule flow shows the schedule and never offers Move the file', () => {
        const html = renderToStaticMarkup(<AddFlowForm defaults={d} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-flow-trigger="schedule"');
        expect(html).toContain('name="cron"');
        expect(html).not.toContain('name="watchFolder"');
        expect(radios(html, 'step')).toEqual(['command', 'agent', 'log']);
    });
});
