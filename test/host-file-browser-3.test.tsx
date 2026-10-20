import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostPathPickerContext, PathBrowse, relativeInside, type PickHostPath } from '../src/renderer/components/HostPathPicker.js';
import { AddFlowForm, AddSiteForm } from '../src/renderer/components/AddForms.js';
import { flowFormDefaults } from '../src/core/forms.js';
import { flowDocument } from '../src/core/flow-form.js';

/**
 * EVERY FILE AND FOLDER INPUT READS THE HOST, PART 3 (Tynn #835): the typed folder fields — a repo's path, a process's
 * folder, a flow command's folder, a site's root — get Browse, which picks over the HOST's disk inside the folder the
 * field is relative to and writes the relative path back. A folder outside it is refused in words; with no picker (or
 * no folder to be relative to) the field stays typed.
 */

describe('relativeInside — the picked folder as the field wants it', () => {
    it('inside: the relative path, forward-slashed', () => {
        expect(relativeInside('/w/tynn', '/w/tynn/repos/app')).toEqual({ ok: true, path: 'repos/app' });
        expect(relativeInside('C:\\w\\tynn', 'C:/w/tynn/dist')).toEqual({ ok: true, path: 'dist' });
        expect(relativeInside('c:/w/tynn/', 'C:/W/Tynn/public')).toEqual({ ok: true, path: 'public' });
    });

    it('the folder itself is `.`', () => {
        expect(relativeInside('/w/tynn', '/w/tynn')).toEqual({ ok: true, path: '.' });
    });

    it('outside — a sibling that merely starts with its name too — is refused in words (CONTROL: Linux keeps case)', () => {
        expect(relativeInside('/w/tynn', '/w/fancy/app')).toEqual({ ok: false, reason: '/w/fancy/app is not inside /w/tynn' });
        expect(relativeInside('/w/tynn', '/w/tynn-other')).toMatchObject({ ok: false });
        expect(relativeInside('/w/tynn', '/w/Tynn/app')).toMatchObject({ ok: false });
    });
});

const pick: PickHostPath = async () => '/w/tynn/repos/app';
const withPicker = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(HostPathPickerContext.Provider, { value: pick }, node));

describe('PathBrowse', () => {
    it('with a picker and a folder to be relative to: a Browse button', () => {
        expect(withPicker(createElement(PathBrowse, { name: 'path', root: () => '/w/tynn' }))).toContain('data-action="browse-path"');
    });

    it('no picker, or no folder: nothing — the field stays typed (CONTROL)', () => {
        expect(renderToStaticMarkup(createElement(PathBrowse, { name: 'path', root: () => '/w/tynn' }))).toBe('');
        expect(withPicker(createElement(PathBrowse, { name: 'path', root: null }))).toBe('');
    });
});

describe('the forms offer Browse', () => {
    it('a flow command’s folder, relative to the workspace', () => {
        const html = withPicker(createElement(AddFlowForm, { defaults: { ...flowFormDefaults({ workspaceId: 'tynn' }), document: flowDocument({ workspaceId: 'tynn', cron: '0 * * * *', step: { kind: 'command', command: 'php artisan inspire', folder: '' } as never }) }, problems: [], onSubmit: () => {}, onCancel: () => {}, root: '/w/tynn' }));
        expect(html).toContain('data-action="browse-path"');
    });

    it('a site’s root, relative to its repo', () => {
        const html = withPicker(createElement(AddSiteForm, { defaults: { name: 'app', mode: 'static', command: '', hostPort: null, root: 'dist', spa: false, phpVersion: null, hint: '' } as never, existingHosts: [], problems: [], onSubmit: () => {}, onCancel: () => {}, root: '/w/tynn/repos/app' }));
        expect(html).toContain('data-action="browse-path"');
    });
});
