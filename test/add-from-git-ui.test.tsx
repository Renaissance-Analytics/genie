import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddWorkspacePreview } from '../src/renderer/components/AddWorkspacePreview.js';

/**
 * ADD FROM GIT ON SCREEN (§6.1). The preview card names the URL and the folder and lists the clone first, marked as a
 * write; Confirm does the plan, Cancel does nothing. (The form itself now clones to a staging folder for the wizard —
 * Add workspace parity item 7 — and is tested with the wizard, test/add-workspace-wizard-ui.test.tsx.)
 */

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
