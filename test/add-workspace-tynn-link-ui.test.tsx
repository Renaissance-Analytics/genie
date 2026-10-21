import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { startDraft, type SourceAnalysis } from '../src/core/envelope-plan.js';
import { NewWorkspaceForm } from '../src/renderer/components/AddWorkspaceModal.js';
import { WorkspaceStepView } from '../src/renderer/components/AddWorkspaceWizard.js';
import { CreateTynnProjectView, TynnProjectLink, TynnProjectPickerView } from '../src/renderer/components/TynnProjectLink.js';

/**
 * THE OPTIONAL TYNN PROJECT ON SCREEN (Add workspace parity item 5) — Genie 1's ProjectPicker ("Project (optional)", "— No
 * project (just a folder) —", its description) with its "New project" mode, the CreateProjectForm (Name; Owner only when
 * there is a choice; Slug derived and editable; Create project / Select existing). Genie 1's GApp variant is not here:
 * Genie 2 has no GApps. The same picker sits on New workspace and on the wizard's Workspace step.
 */

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}
const noop = () => {};
const projects = [{ id: '42', name: 'Acme', slug: 'acme', vision: null, isWorkspace: true, repositories: [], envelope: null }, { id: '7', name: 'Moic Suite', slug: 'moic', vision: null, isWorkspace: true, repositories: [], envelope: null }];
const owners = [{ kind: 'user' as const, id: '1', label: 'Personal (your account)' }, { kind: 'organization' as const, id: '3', label: 'Acme Org' }];

describe('Project (optional) — Genie 1’s picker', () => {
    it('"No project" by default, the person’s projects, Genie 1’s words; New project when it can create', () => {
        const html = renderToStaticMarkup(<TynnProjectPickerView tynn={{ ok: true, projects }} projectId={null} onProject={noop} onNew={noop} />);
        expect(html).toContain('Project (optional)');
        expect(html).toMatch(/data-field="tynn-project"[\s\S]*?— No project \(just a folder\) —[\s\S]*?Acme[\s\S]*?Moic Suite/);
        expect(html).toContain('Optionally link this workspace to a Tynn project. Not required, and not required later either — the workspace works the same without one.');
        expect(html).toContain('data-action="new-tynn-project"');
        // CONTROL: no way to create (an older host) → no New project button.
        expect(renderToStaticMarkup(<TynnProjectPickerView tynn={{ ok: true, projects }} projectId={null} onProject={noop} />)).not.toContain('data-action="new-tynn-project"');
    });

    it('loading, and a list Tynn cannot give, are said; nothing to pick then', () => {
        expect(renderToStaticMarkup(<TynnProjectPickerView tynn={null} projectId={null} onProject={noop} />)).toContain('Loading Tynn projects…');
        const off = renderToStaticMarkup(<TynnProjectPickerView tynn={{ ok: false, reason: 'not signed in to Tynn' }} projectId={null} onProject={noop} onNew={noop} />);
        expect(off).toContain('No Tynn projects available — not signed in to Tynn');
        expect(off).not.toContain('data-field="tynn-project"');
        expect(off).not.toContain('data-action="new-tynn-project"');
    });

    it('choosing sets the id, choosing "No project" clears it; New project goes to the form', () => {
        const got: Array<string | null> = [];
        let opened = 0;
        const ui = TynnProjectPickerView({ tynn: { ok: true, projects }, projectId: '42', onProject: (id) => got.push(id), onNew: () => { opened += 1; } });
        const [select] = findAll(ui, (p) => p['data-field'] === 'tynn-project');
        expect(select?.value).toBe('42');
        (select!.onChange as (e: { target: { value: string } }) => void)({ target: { value: '7' } });
        (select!.onChange as (e: { target: { value: string } }) => void)({ target: { value: '' } });
        expect(got).toEqual(['7', null]);
        for (const b of findAll(ui, (p) => p['data-action'] === 'new-tynn-project')) (b.onClick as () => void)();
        expect(opened).toBe(1);
    });
});

describe('Create new project — Genie 1’s form, without GApps', () => {
    const base = { name: '', slug: '', ownerKey: 'user:1', owners, busy: false, error: null, onName: noop, onSlug: noop, onOwner: noop, onCreate: noop, onCancel: noop };

    it('Name, Owner (a choice only when there is one), Slug; Create project needs a name', () => {
        const html = renderToStaticMarkup(<CreateTynnProjectView {...base} name="Acme App" slug="acme-app" />);
        expect(html).toContain('Create new project');
        expect(html).toMatch(/data-field="tynn-project-name"[^>]*value="Acme App"|value="Acme App"[^>]*data-field="tynn-project-name"/);
        expect(html).toMatch(/data-field="tynn-project-owner"[\s\S]*?Personal \(your account\)[\s\S]*?Acme Org/);
        expect(html).toContain('Who owns the project. Defaults to your personal account.');
        expect(html).toMatch(/data-field="tynn-project-slug"[^>]*value="acme-app"|value="acme-app"[^>]*data-field="tynn-project-slug"/);
        expect(html).toContain('URL slug, auto-derived from the name. Editable.');
        expect(html).not.toMatch(/GApp/i);
        expect(html).not.toMatch(/data-action="create-tynn-project"[^>]*disabled=""/);
        expect(renderToStaticMarkup(<CreateTynnProjectView {...base} name="   " />)).toMatch(/data-action="create-tynn-project"[^>]*disabled=""/);
        // One owner (personal only): nothing to choose, so no Owner field.
        expect(renderToStaticMarkup(<CreateTynnProjectView {...base} owners={[owners[0]!]} name="x" />)).not.toContain('data-field="tynn-project-owner"');
    });

    it('busy says so and holds the button; Tynn’s refusal is shown', () => {
        const html = renderToStaticMarkup(<CreateTynnProjectView {...base} name="Acme" busy error="The slug has already been taken." />);
        expect(html).toMatch(/data-action="create-tynn-project"[^>]*disabled=""[^>]*>[\s\S]*?Creating…/);
        expect(html).toContain('The slug has already been taken.');
    });

    it('the buttons do what they say', () => {
        const did: string[] = [];
        const ui = CreateTynnProjectView({ ...base, name: 'Acme', onCreate: () => did.push('create'), onCancel: () => did.push('back') });
        for (const b of findAll(ui, (p) => p['data-action'] === 'create-tynn-project' || p['data-action'] === 'select-existing-tynn-project')) (b.onClick as () => void)();
        expect(did.sort()).toEqual(['back', 'create']);
    });
});

describe('where the picker sits', () => {
    const analysis: SourceAnalysis = { root: '/src/acme-app', sourceKind: 'plain-folder', repos: [], knowledge: [], other: [], rootEntries: null, submodules: [] };
    const slot = <div data-test-slot="">PICKER</div>;

    it('New workspace and the wizard’s Workspace step draw it; without one (no Tynn on this host) they do not', () => {
        const form = { name: 'acme', parent: '/w', sep: '/', busy: false, error: null, onName: noop, onBrowse: noop, onCreate: noop, onCancel: noop };
        expect(renderToStaticMarkup(<NewWorkspaceForm {...form} tynnLink={slot} />)).toContain('data-test-slot');
        expect(renderToStaticMarkup(<NewWorkspaceForm {...form} />)).not.toContain('data-test-slot');
        const draft = startDraft(analysis, { parent: '/w' });
        expect(renderToStaticMarkup(<WorkspaceStepView draft={draft} sep="/" onName={noop} onBrowse={noop} tynnLink={slot} />)).toContain('data-test-slot');
        expect(renderToStaticMarkup(<WorkspaceStepView draft={draft} sep="/" onName={noop} onBrowse={noop} />)).not.toContain('data-test-slot');
    });

    it('the live picker starts by loading the person’s projects', () => {
        const html = renderToStaticMarkup(<TynnProjectLink api={{ projects: async () => ({ ok: true, projects }) }} projectId={null} onProject={noop} />);
        expect(html).toContain('Project (optional)');
        expect(html).toContain('Loading Tynn projects…');
    });
});
