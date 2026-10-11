import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flowFormDefaults, siteFormDefaults } from '../src/core/forms.js';
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

describe('Add a flow', () => {
    const defaults = flowFormDefaults({ workspaceId: 'tynn' });

    it('prefills the name and the hourly UTC schedule, and arming is OFF by default with the reason beside it', () => {
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
