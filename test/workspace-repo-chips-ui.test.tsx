import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { repoChip } from '../src/core/repo-status.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * A LOCKED REPO IN THE WORKSPACE HEADER. REWRITTEN 2026-11-16 (the owner: "I don't need all of the repos listed in the
 * workspace header"): healthy repos are not in the header (Settings lists them); a locked one is red as
 * `web · index.lock held`, with "Remove stale lock" only once the lock is stale, on every view.
 */
const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 0, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: {
        list: [
            { name: 'App', slug: 'app', path: '.', host: true, branch: 'main', lock: null },
            { name: 'API', slug: 'api', path: 'repos/api', host: false, branch: 'main', lock: null },
            { name: 'Web', slug: 'web', path: 'repos/web', host: false, branch: 'main', lock: { heldSince: 1, stale: true } },
        ],
        onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {},
    },
};
const render = (o: WorkspaceOpsProps | null = ops, view: 'home' | 'terminals' | 'settings' = 'home') =>
    renderToStaticMarkup(<Workspace view={view} workspace={{ id: 'acme', name: 'Acme', path: '/w/acme' }} terminals={NO_TERMINALS} ops={o ?? undefined} />);
// The one bar (TopBar.tsx): its markup up to the view's body. The locked repo sits at its right end.
const header = (html: string) => html.slice(html.indexOf('data-top-bar'), html.indexOf('data-view-body'));

describe('repo chips', () => {
    it('only the locked repo is in the header (COUNTED: one of three)', () => {
        const h = header(render());
        expect((h.match(/data-repo-chip="/g) ?? []).length).toBe(1);
        expect(h).not.toContain('api · main');
    });

    it('a locked repo is red and says so; "Remove stale lock" is offered only for a STALE lock', () => {
        const html = header(render());
        expect(html).toMatch(/data-repo-chip="web"[^>]*data-tone="bad"/);
        expect(html).toContain('web · index.lock held');
        expect(html).toMatch(/<button[^>]*data-action="remove-stale-lock"[^>]*data-repo-slug="web"/);
        const fresh = header(render({ ...ops, repos: { ...ops.repos!, list: [{ name: 'Web', slug: 'web', path: 'repos/web', host: false, branch: 'main', lock: { heldSince: 1, stale: false } }] } }));
        expect(fresh).toContain('web · index.lock held');
        expect(fresh).not.toContain('remove-stale-lock');
        expect(repoChip({ slug: 'docs', branch: null, lock: null })).toMatchObject({ tone: 'normal', label: 'docs' });
    });

    it('on every view; none when there is no repo list (not loaded, or no ops)', () => {
        expect((header(render(ops, 'terminals')).match(/data-repo-chip="/g) ?? []).length).toBe(1);
        expect(render({ ...ops, repos: { ...ops.repos!, list: null } })).not.toContain('data-repo-chip');
        expect(render(null)).not.toContain('data-repo-chip');
    });
});
