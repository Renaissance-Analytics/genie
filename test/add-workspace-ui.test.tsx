import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { pickerStart, workspaceFolderName } from '../src/core/add-workspace.js';
import { carryOverV1, SETTINGS } from '../src/core/settings.js';
import { AddWorkspaceSource, NewWorkspaceForm } from '../src/renderer/components/AddWorkspaceModal.js';

/**
 * ADD A WORKSPACE THE WAY GENIE 1 DID (the owner, 2026-10-21: "This … is NOT the correct way. Look at Genie 1"; and
 * "when this file browser … opens from the workstation scope, it should default to the default project folder … set in
 * general settings like it was for genie 1. If I am opening this ui in the scope of a workspace then it should open to that
 * workspace's location").
 *
 * Genie 1 (AddWorkspaceModal.tsx, add-workspace.ts, workspace-onboarding.ts): "How should Genie start?" — Start something
 * new / Bring in what you already have; New workspace = Workspace name + Folder (prefilled from `primary_workspace`) +
 * "Lands at <folder>\<slug>.agi", then Create workspace.
 */

describe('the folder a new workspace gets', () => {
    it('Genie 1’s slug: lowercase, dashes, .agi — and nothing for a name with no letters or digits', () => {
        expect(workspaceFolderName('Acme Storefront')).toBe('acme-storefront.agi');
        expect(workspaceFolderName('  My   API v2!! ')).toBe('my-api-v2.agi');
        expect(workspaceFolderName('!!!')).toBe('');
        expect(workspaceFolderName('')).toBe('');
    });

    // Parity row 3 (Genie 1 workspace-onboarding.ts:73-92): a dot is kept, and a name that already ends in .agi is not
    // given a second one — "foo.agi" stays "foo.agi", not "foo-agi.agi".
    it('keeps a dot, and never adds a second .agi', () => {
        expect(workspaceFolderName('foo.agi')).toBe('foo.agi');
        expect(workspaceFolderName('Foo.AGI')).toBe('foo.agi');
        expect(workspaceFolderName('acme.io')).toBe('acme.io.agi');
        expect(workspaceFolderName('Release v1.2 beta')).toBe('release-v1.2-beta.agi');
        // Dots and dashes at either end are trimmed, as Genie 1 trimmed them: a folder never starts with a dot.
        expect(workspaceFolderName('.hidden.')).toBe('hidden.agi');
        expect(workspaceFolderName('...')).toBe('');
    });
});

describe('where a folder picker opens', () => {
    it('in a workspace: that workspace’s folder; from the workstation: the Primary workspace; else home; never the bare root when anything better is known', () => {
        expect(pickerStart({ workspacePath: 'C:/w/tynn.agi', primaryWorkspace: 'C:/_Projects', home: 'C:/Users/me' })).toBe('C:/w/tynn.agi');
        expect(pickerStart({ primaryWorkspace: 'C:/_Projects', home: 'C:/Users/me' })).toBe('C:/_Projects');
        expect(pickerStart({ primaryWorkspace: '  ', home: 'C:/Users/me' })).toBe('C:/Users/me');
        expect(pickerStart({})).toBe('/');
    });
});

describe('the Primary workspace setting', () => {
    it('is a workstation (host) setting in General, labelled as Genie 1 labelled it, empty by default', () => {
        const def = SETTINGS.find((s) => s.key === 'primary_workspace');
        expect(def).toMatchObject({ group: 'general', scope: 'host', type: 'string', default: '', label: 'Primary workspace' });
        expect(def?.description).toMatch(/Default destination for NEW projects/);
    });

    it('Genie 1’s value carries over', () => {
        expect(carryOverV1({ primary_workspace: 'C:\\_Projects' }).applied['primary_workspace']).toBe('C:\\_Projects');
    });
});

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}

describe('How should Genie start?', () => {
    it('Genie 1’s two groups and their cards — and each card goes where it says (COUNTED: four)', () => {
        const went: string[] = [];
        const ui = AddWorkspaceSource({ onNew: () => went.push('new'), onOpenExisting: () => went.push('existing'), onGit: () => went.push('git'), onTynn: () => went.push('tynn') });
        const html = renderToStaticMarkup(ui);
        expect(html).toContain('How should Genie start?');
        expect(html).toMatch(/Start something new[\s\S]*New workspace[\s\S]*Bring in what you already have[\s\S]*Open existing folder[\s\S]*Import from Git[\s\S]*Import from Tynn/);
        expect(html).toContain('Name it, say where it lives. Genie makes the folder and its first commit.');
        const cards = findAll(ui, (p) => typeof p['data-add-source'] === 'string');
        expect(cards.map((c) => c['data-add-source'])).toEqual(['new', 'existing', 'git', 'tynn']);
        for (const c of cards) (c.onClick as () => void)();
        expect(went).toEqual(['new', 'existing', 'git', 'tynn']);
    });
});

describe('New workspace', () => {
    const base = { name: '', parent: '', sep: '\\', busy: false, error: null, onName: () => {}, onBrowse: () => {}, onCreate: () => {}, onCancel: () => {} };

    it('the folder comes prefilled; it says where it lands; Create workspace waits for a name', () => {
        const empty = renderToStaticMarkup(NewWorkspaceForm({ ...base, parent: 'C:\\_Projects' }));
        expect(empty).toContain('Workspace name');
        expect(empty).toMatch(/value="C:\\_Projects"/);
        expect(empty).toMatch(/data-action="create-workspace"[^>]*disabled=""/);
        const named = renderToStaticMarkup(NewWorkspaceForm({ ...base, name: 'Acme Storefront', parent: 'C:\\_Projects' }));
        expect(named).toContain('Lands at C:\\_Projects\\acme-storefront.agi');
        expect(named).not.toMatch(/data-action="create-workspace"[^>]*disabled=""/);
    });

    it('with no folder yet it asks for one; Browse is there; a refusal shows in the form', () => {
        const html = renderToStaticMarkup(NewWorkspaceForm({ ...base, name: 'acme', error: 'C:\\w\\acme.agi is not empty.' }));
        expect(html).toContain('Pick the folder your workspaces live in.');
        expect(html).toContain('data-action="browse-parent"');
        expect(html).toMatch(/data-add-error=""[^>]*>[^<]*C:\\w\\acme\.agi is not empty\./);
        expect(html).toMatch(/data-action="create-workspace"[^>]*disabled=""/);
    });

    it('pressing Create creates; Browse browses (the buttons do what they say)', () => {
        const done: string[] = [];
        const ui = NewWorkspaceForm({ ...base, name: 'acme', parent: '/w', onCreate: () => done.push('create'), onBrowse: () => done.push('browse') });
        for (const b of findAll(ui, (p) => p['data-action'] === 'create-workspace' || p['data-action'] === 'browse-parent')) (b.onClick as () => void)();
        expect(done.sort()).toEqual(['browse', 'create']);
    });
});
