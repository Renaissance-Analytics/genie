import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddFromGitForm, AddWorkspacePreview } from '../src/renderer/components/AddWorkspacePreview.js';

/**
 * ADD FROM GIT ON SCREEN (§6.1). A small form: the URL, and one button that picks the parent folder on the
 * host and shows the plan. The preview card names the URL and the folder and lists the clone first,
 * marked as a write; Confirm does the plan, Cancel does nothing.
 */

describe('AddFromGitForm', () => {
    it('takes a URL and offers to pick the parent folder and preview; nothing else', () => {
        const html = renderToStaticMarkup(<AddFromGitForm onPreview={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-form="add-from-git"');
        expect(html).toMatch(/name="url"/);
        expect(html).toContain('data-action="pick-parent-and-preview"');
        expect(html).toMatch(/Nothing is cloned until you confirm the plan/);
    });
});

describe('AddWorkspacePreview for a git source', () => {
    it('names the URL and the folder, lists the clone first as a write, offers Confirm', () => {
        const html = renderToStaticMarkup(<AddWorkspacePreview preview={{ ok: true, source: 'git', url: 'https://github.com/example/fancy-ui.git', path: '/w/fancy-ui', kind: 'simple-repo', steps: [{ action: 'git clone https://github.com/example/fancy-ui.git into /w/fancy-ui', path: '/w/fancy-ui', writes: true }, { action: 'write project.json', path: '/w/fancy-ui', writes: true }, { action: 'register in Genie', path: '/w/fancy-ui', writes: false }] }} onConfirm={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-add-preview="simple-repo"');
        expect(html).toContain('data-add-source="git"');
        expect(html).toMatch(/github\.com\/example\/fancy-ui\.git/);
        expect(html).toMatch(/git clone/);
        expect(html).toContain('data-action="confirm-add"');
        expect(html).toMatch(/Clone and add/);
    });
});
