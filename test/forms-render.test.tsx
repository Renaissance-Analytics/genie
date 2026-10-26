import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { flowFormDefaults, siteFormDefaults, type FlowForm } from '../src/core/forms.js';
import { AddSiteForm } from '../src/renderer/components/AddForms.js';

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

// "Add a flow" was a form until genie#1204: a flow is drawn on the canvas now (test/flow-editor-window.test.tsx).
