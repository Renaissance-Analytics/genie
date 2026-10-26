import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL, flowFields, flowFormFromFields } from '../src/core/flow-form.js';
import { flowFormDefaults, validateFlowForm } from '../src/core/forms.js';

/**
 * "ADD A FLOW" MAKES A SCHEDULE THAT RUNS SOMETHING (hosting ship line P4). The form could only make a schedule
 * feeding a `log` node that said "tick": nothing a person would schedule. Now it builds a schedule feeding one
 * step — a command in the workspace (genie/terminal_run, in a folder inside it), or a prompt to an agent
 * (genie/agent_prompt, an inbox address) — and validation names each field the step needs when it is missing.
 * Pure: core/flow-form.ts has no Node imports, so the renderer's form uses it as is.
 */

describe('what a flow runs', () => {
    const d = flowFormDefaults({ workspaceId: 'tynn' });

    it('a command: schedule → genie/terminal_run with the workspace, the command and the folder; armed only when ticked', () => {
        const command = flowFormFromFields(d, { name: 'report', cron: '0 3 * * *', step: 'command', command: 'npm run report', folder: 'repos/app', armed: 'on' });
        expect(command).toMatchObject({ workspaceId: 'tynn', name: 'report', armed: true });
        // The engine's own shape (WorkflowSchema): the steps under graph, where importWorkflow reads them.
        expect(command.document).toEqual({
            $schema: FLOW_SCHEMA_URL,
            version: 1,
            graph: {
                nodes: [
                    { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } },
                    { id: 's', kind: 'genie/terminal_run', position: { x: 240, y: 0 }, config: { workspace: 'tynn', command: 'npm run report', cwd: 'repos/app' } },
                ],
                edges: [{ id: 'e1', source: 't', target: 's' }],
            },
        });
        expect(validateFlowForm(command)).toEqual([]);
        // At the workspace root there is no folder at all.
        const root = flowFormFromFields(d, { name: 'prune', cron: '0 4 * * *', step: 'command', command: 'npm run prune', folder: '' });
        expect((root.document as { graph: { nodes: Array<{ config: unknown }> } }).graph.nodes[1]!.config).toEqual({ workspace: 'tynn', command: 'npm run prune' });
    });

    it('a prompt: schedule → genie/agent_prompt with the address and the prompt; not armed unless ticked', () => {
        const agent = flowFormFromFields(d, { name: 'standup', cron: '0 9 * * 1-5', step: 'agent', agent: 'claude:atlas', prompt: 'post the standup' });
        expect((agent.document as { graph: { nodes: unknown[] } }).graph.nodes[1]).toMatchObject({ kind: 'genie/agent_prompt', config: { agent: 'claude:atlas', prompt: 'post the standup' } });
        expect(agent.armed).toBe(false);
        expect(validateFlowForm(agent)).toEqual([]);
    });

    it('reads back what a document runs — what an open form is prefilled with; a log-only flow reads as log', () => {
        const command = flowFormFromFields(d, { name: 'r', cron: '0 3 * * *', step: 'command', command: 'npm run report', folder: 'repos/app' });
        const agent = flowFormFromFields(d, { name: 's', cron: '0 9 * * 1-5', step: 'agent', agent: 'claude:atlas', prompt: 'post the standup' });
        // A schedule flow reads back as one (genie#1204: the form also makes file flows, test/flow-form-file.test.tsx).
        expect(flowFields(command.document)).toEqual({ cron: '0 3 * * *', trigger: { kind: 'schedule' }, step: { kind: 'command', command: 'npm run report', folder: 'repos/app' } });
        expect(flowFields(agent.document)).toEqual({ cron: '0 9 * * 1-5', trigger: { kind: 'schedule' }, step: { kind: 'agent', agent: 'claude:atlas', prompt: 'post the standup' } });
        expect(flowFields(d.document)).toEqual({ cron: '0 * * * *', trigger: { kind: 'schedule' }, step: { kind: 'log' } });
    });

    it('names each missing or unsafe field: no command, a folder outside the workspace, no agent, no prompt', () => {
        expect(validateFlowForm(flowFormFromFields(d, { name: 'x', cron: '0 3 * * *', step: 'command', command: ' ', folder: '../elsewhere' }))).toEqual([
            { field: 'command', message: 'Node s: a command to run is needed.' },
            { field: 'folder', message: 'Node s: the folder must be inside the workspace — a relative path like repos/app.' },
        ]);
        expect(validateFlowForm(flowFormFromFields(d, { name: 'x', cron: '0 3 * * *', step: 'command', command: 'ls', folder: '/etc' })).map((p) => p.field)).toEqual(['folder']);
        expect(validateFlowForm(flowFormFromFields(d, { name: 'x', cron: '0 3 * * *', step: 'command', command: 'ls', folder: 'C:\\Windows' })).map((p) => p.field)).toEqual(['folder']);
        expect(validateFlowForm(flowFormFromFields(d, { name: 'x', cron: '0 3 * * *', step: 'agent', agent: '', prompt: '' }))).toEqual([
            { field: 'agent', message: 'Node s: which agent to prompt — an address like claude:atlas.' },
            { field: 'prompt', message: 'Node s: a prompt to send is needed.' },
        ]);
    });
});
