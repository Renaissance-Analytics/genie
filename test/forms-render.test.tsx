import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { flowFormDefaults, siteFormDefaults, type FlowForm } from '../src/core/forms.js';
import { AddFlowForm, AddSiteForm } from '../src/renderer/components/AddForms.js';

/**
 * THE FORMS, RENDERED — "Add a site" and "Add a flow". Defaults prefilled from disk, the hint that
 * says what Genie will do, every problem shown beside its field at once, and a submit that is the
 * form's only way out besides Cancel. Guided, consistent, start to finish.
 */

describe('Add a site', () => {
    const defaults = siteFormDefaults({ repoPath: 'C:/_Projects/tynn.ai/repos/tynn', files: ['artisan'], packageScripts: {} });

    it('prefills the name and mode from the defaults and shows the hint', () => {
        const html = renderToStaticMarkup(<AddSiteForm defaults={defaults} existingHosts={[]} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-form="add-site"');
        expect(html).toContain('value="tynn"');
        expect(html).toMatch(/Laravel detected/);
        expect(html).toMatch(/name="mode"/);
        expect(html).toContain('php artisan serve');
        expect(html).toMatch(/Add site/);
        expect(html).toMatch(/Cancel/);
    });

    it('shows every problem beside its field — COUNTED', () => {
        const html = renderToStaticMarkup(
            <AddSiteForm
                defaults={{ ...defaults, name: '' }}
                existingHosts={[]}
                problems={[{ field: 'name', message: 'A site needs a name — one hostname label (a-z, 0-9, hyphens).' }, { field: 'hostPort', message: 'A proxy site needs either a dev server command or a port you already run.' }]}
                onSubmit={() => {}}
                onCancel={() => {}}
            />,
        );
        expect(html.match(/data-problem="/g) ?? []).toHaveLength(2);
        expect(html).toContain('data-problem="name"');
        expect(html).toContain('data-problem="hostPort"');
        expect(html).toContain('needs a name');
    });

    it('static defaults show the root and the SPA switch on', () => {
        const d = siteFormDefaults({ repoPath: '/w/dash', files: ['dist/index.html'], packageScripts: {} });
        const html = renderToStaticMarkup(<AddSiteForm defaults={d} existingHosts={[]} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toContain('value="dist"');
        expect(html).toMatch(/name="spa"[^>]*checked/);
    });
});

/**
 * The "What it runs" radios, one tag each, in the order drawn. React's server renderer writes an input's `checked` and
 * `value` LAST and `checked` first (`name="step" checked="" value="log"`), so a radio is found by its value and then
 * asked whether it is checked — never matched by attribute order (the same rule as test/deck-form-ui.test.tsx).
 */
const stepRadios = (html: string): string[] => html.match(/<input[^>]*name="step"[^>]*>/g) ?? [];
const valueOf = (tag: string): string | undefined => /value="([^"]*)"/.exec(tag)?.[1];
const checkedSteps = (html: string): Array<string | undefined> => stepRadios(html).filter((t) => t.includes('checked=""')).map(valueOf);

describe('Add a flow', () => {
    const defaults = flowFormDefaults({ workspaceId: 'tynn' });

    it('says the schedule is this machine’s local time, and offers what it runs: a command, a prompt to an agent, or only a note', () => {
        const html = renderToStaticMarkup(<AddFlowForm defaults={defaults} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toMatch(/local time/);
        expect(html).not.toMatch(/UTC/);
        // Exactly three choices, each once, in this order — COUNTED.
        expect(stepRadios(html).map(valueOf)).toEqual(['command', 'agent', 'log']);
        // The default runs nothing but a note: that one radio, and only it, is checked; its step's fields are the only ones drawn (none).
        expect(checkedSteps(html)).toEqual(['log']);
        expect(html).not.toContain('name="command"');
        expect(html).not.toContain('name="agent"');
    });

    it('a form for a command flow shows the command and folder, prefilled; one for an agent shows the agent and prompt — with their problems beside them', () => {
        const withStep = (name: string, step: Record<string, unknown>): FlowForm => ({
            workspaceId: 'tynn',
            name,
            armed: false,
            document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } }, { id: 's', position: { x: 240, y: 0 }, ...step }], edges: [{ id: 'e1', source: 't', target: 's' }] } },
        });
        const command = withStep('report', { kind: 'genie/terminal_run', config: { workspace: 'tynn', command: 'npm run report', cwd: 'repos/app' } });
        const html = renderToStaticMarkup(<AddFlowForm defaults={command} problems={[{ field: 'command', message: 'Node s: a command to run is needed.' }]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(checkedSteps(html)).toEqual(['command']);
        expect(html).toContain('value="npm run report"');
        expect(html).toContain('value="repos/app"');
        expect(html).toContain('data-problem="command"');

        const agent = withStep('standup', { kind: 'genie/agent_prompt', config: { agent: 'claude:atlas', prompt: 'post the standup' } });
        const agentHtml = renderToStaticMarkup(<AddFlowForm defaults={agent} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(checkedSteps(agentHtml)).toEqual(['agent']);
        expect(agentHtml).toContain('value="claude:atlas"');
        expect(agentHtml).toContain('post the standup');
        expect(agentHtml).not.toContain('name="command"');
    });

    it('prefills the name and the hourly schedule, and arming is OFF by default with the reason beside it', () => {
        const html = renderToStaticMarkup(<AddFlowForm defaults={defaults} problems={[]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-form="add-flow"');
        expect(html).toContain('value="tynn hourly"');
        expect(html).toContain('value="0 * * * *"');
        expect(html).toMatch(/name="armed"(?![^>]*checked)/);
        expect(html).toMatch(/arm/i);
        expect(html).toMatch(/Add flow/);
    });

    it('shows a cron problem beside the cron field', () => {
        const html = renderToStaticMarkup(<AddFlowForm defaults={defaults} problems={[{ field: 'cron', message: 'Node t: "nope" is not a cron expression Genie can evaluate (five fields: minute hour day month weekday).' }]} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-problem="cron"');
        expect(html).toContain('five fields');
    });
});
