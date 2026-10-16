import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { knowledgeFormDefaults } from '../src/core/forms.js';
import { KnowledgeSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE KNOWLEDGE SURFACE'S ADD PATH — "Add a memory" in the header; the form inside the surface with
 * title, body, class and a scope that offers this machine and every workspace; problems beside
 * their field; and after an add, a line naming what was filed and every link that did not resolve,
 * with why. The results stay visible under all of it.
 */

const workspaces = [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }];
const render = (knowledge: FeatureData['knowledge']) =>
    renderToStaticMarkup(<KnowledgeSurface data={{ ...EMPTY_FEATURES, knowledge }} onAction={() => {}} onNavigate={() => {}} workspaces={workspaces} />);

describe('Knowledge', () => {
    it('offers Add a memory; with no form open there is no form', () => {
        const html = render({ hits: null, query: '', adding: null, lastAdd: null });
        expect(html).toMatch(/Add a memory/);
        expect(html).not.toContain('data-form=');
    });

    it('with the form open: title, body, the four classes, a scope with this machine and every workspace, problems beside their field, Cancel', () => {
        const html = render({ hits: [], query: '', adding: { defaults: knowledgeFormDefaults({ workspaceId: 'tynn' }), problems: [{ field: 'title', message: 'A memory needs a title.' }] }, lastAdd: null });
        expect(html).toContain('data-form="add-memory"');
        expect(html).toMatch(/name="title"/);
        expect(html).toMatch(/<textarea[^>]*name="body"/);
        for (const c of ['profile', 'episodic', 'procedural', 'knowledge']) expect(html).toContain(`value="${c}"`);
        expect(html).toContain('value="system"');
        expect(html).toContain('value="workspace:tynn"');
        expect(html).toContain('value="workspace:fancy"');
        expect(html).toContain('data-problem="title"');
        expect(html).toMatch(/Cancel/);
    });

    it('after an add: the line names the memory and every unresolved link with its reason; with none unresolved it says only what was added', () => {
        const some = render({ hits: [], query: 'x', adding: null, lastAdd: { id: 'kn_1', title: 'Caddy note', unresolved: [{ ref: 'hosting', reason: 'ambiguous' }, { ref: 'nope', reason: 'missing' }] } });
        expect(some).toContain('data-knowledge-added');
        expect(some).toMatch(/Added “Caddy note”/);
        expect(some).toMatch(/\[\[hosting\]\].*more than one memory has that name/);
        expect(some).toMatch(/\[\[nope\]\].*no memory has that name/);
        const none = render({ hits: [], query: 'x', adding: null, lastAdd: { id: 'kn_1', title: 'Caddy note', unresolved: [] } });
        expect(none).toMatch(/Added “Caddy note”/);
        expect(none).not.toMatch(/did not resolve/);
    });
});
