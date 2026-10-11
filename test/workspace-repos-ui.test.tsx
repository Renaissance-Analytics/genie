import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * THE REPO REGISTRY ON THE WORKSPACE SURFACE (§6.1). Each registered repo is a row with its slug and
 * path; the host repo is marked and has no Remove; Open goes to its folder in the files panel; an Add
 * form takes a name and a path inside the envelope; the last outcome (a refusal's reason) is shown.
 */

const ops: WorkspaceOpsProps = {
    asleep: false,
    agentCount: 2,
    removePreview: false,
    lastOutcome: null,
    onHibernate: () => {},
    onWake: () => {},
    onPreviewRemove: () => {},
    onConfirmRemove: () => {},
    onCancelRemove: () => {},
    repos: {
        list: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.', host: true }, { name: 'genie2', slug: 'genie2', path: 'repos/genie2', host: false }],
        onAdd: () => {},
        onRemove: () => {},
        onOpen: () => {},
    },
};
const render = (o: WorkspaceOpsProps | undefined) =>
    renderToStaticMarkup(<Workspace workspace={{ id: 'tynn', name: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={o} />);

describe('repos on the Workspace surface', () => {
    it('lists each repo with slug and path; the host is marked and cannot be removed; others can; Open is offered for every one', () => {
        const html = render(ops);
        expect(html).toContain('data-repos');
        expect(html).toContain('data-repo="tynn-ai"');
        expect(html).toContain('data-repo-host');
        expect(html).toContain('data-repo="genie2"');
        expect(html).toContain('data-action="remove-repo" data-repo-slug="genie2"');
        expect(html).not.toContain('data-repo-slug="tynn-ai"');
        expect((html.match(/data-action="open-repo"/g) ?? []).length).toBe(2);
        expect(html).toMatch(/repos\/genie2/);
    });

    it('an Add form with name and path; no repos section at all without the ops (a remote guest, a test)', () => {
        expect(render(ops)).toContain('data-form="add-repo"');
        expect(render(undefined)).not.toContain('data-repos');
        expect(render({ ...ops, repos: undefined })).not.toContain('data-repos');
    });

    it('null repos (not loaded yet) draws the section with a skeleton, not an empty list', () => {
        expect(render({ ...ops, repos: { ...ops.repos!, list: null } })).toContain('data-repos-skeleton');
    });
});
