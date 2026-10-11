import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flowFormDefaults, siteFormDefaults } from '../src/core/forms.js';
import { FlowsSurface, HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE FORMS IN THEIR SURFACES — "Add a site" opens inside Hosting, "Add a flow" inside Flows; the
 * list stays visible under the form so the person sees what exists while adding. A surface with no
 * form open shows no form. The forms' problems come from the last refused submit, so a refusal is
 * shown where it was caused rather than logged somewhere nobody reads.
 */

const data: FeatureData = { ...EMPTY_FEATURES, hosting: { sites: [], processes: [], adding: null }, flows: { flows: [], adding: null } };

describe('Hosting', () => {
    it('with no form open there is no form; with the site form open it renders with its defaults and problems', () => {
        const closed = renderToStaticMarkup(<HostingSurface data={data} onAction={() => {}} onNavigate={() => {}} />);
        expect(closed).not.toContain('data-form=');

        const defaults = siteFormDefaults({ repoPath: '/w/tynn', files: ['artisan'], packageScripts: {} });
        const open = renderToStaticMarkup(
            <HostingSurface
                data={data}
                onAction={() => {}}
                onNavigate={() => {}}
                adding={{ kind: 'site', workspaceId: 'tynn', repoPath: '/w/tynn', defaults, problems: [{ field: 'name', message: 'tynn.gen is already a site.' }] }}
                onCloseForm={() => {}}
            />,
        );
        expect(open).toContain('data-surface="hosting"');
        expect(open).toContain('data-form="add-site"');
        expect(open).toContain('data-problem="name"');
        expect(open).toContain('already a site');
        // The list is still there under the form.
        expect(open).toMatch(/Add a site to serve a repo/);
    });
});

describe('Flows', () => {
    it('with the flow form open it renders with the hourly default and no problems', () => {
        const open = renderToStaticMarkup(
            <FlowsSurface data={data} onAction={() => {}} onNavigate={() => {}} adding={{ kind: 'flow', defaults: flowFormDefaults({ workspaceId: 'tynn' }), problems: [] }} onCloseForm={() => {}} />,
        );
        expect(open).toContain('data-surface="flows"');
        expect(open).toContain('data-form="add-flow"');
        expect(open).toContain('value="0 * * * *"');
        expect(open.match(/data-problem="/g) ?? []).toHaveLength(0);
    });
});
