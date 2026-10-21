import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { headerRepos, repoChip } from '../src/core/repo-status.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * REPO CHIPS IN THE WORKSPACE HEADER (the board): one per repo — `api · main` with the git-branch icon; a locked repo
 * in red as `web · index.lock held`, with "Remove stale lock" only once the lock is stale. The chips are in the header
 * on EVERY view of the workspace; the repo list under Settings stays where it was.
 */
const ops: WorkspaceOpsProps = {
    asleep: false, agentCount: 0, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: {
        list: [
            { name: 'Tynn', slug: 'tynn', path: '.', host: true, branch: 'main', lock: null },
            { name: 'API', slug: 'api', path: 'repos/api', host: false, branch: 'main', lock: null },
            { name: 'Web', slug: 'web', path: 'repos/web', host: false, branch: 'main', lock: { heldSince: 1, stale: true } },
            { name: 'Docs', slug: 'docs', path: 'repos/docs', host: false, branch: null, lock: null },
        ],
        onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {},
    },
};
// `null` means "no ops at all" — a default parameter would swallow `undefined`, which is how a test once tested nothing.
const render = (o: WorkspaceOpsProps | null = ops, view: 'home' | 'terminals' | 'settings' = 'home') =>
    renderToStaticMarkup(<Workspace view={view} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={o ?? undefined} />);

describe('repo chips', () => {
    /*
     * REWRITTEN for beta.33 item 23 (the owner: "why the fuck is any content at all behind the fucking chat panel?"): one
     * chip per repo IN THE ROW overflowed the page column. The row holds HEADER_REPOS_INLINE chips — a locked repo first —
     * and "+N more" opens the rest in a Popover (test/workspace-header-fits.test.tsx). Here: the locked `web`, then `tynn`
     * and `api` in the row; `docs` behind "+1 more".
     */
    it('`slug · branch` chips in the header, a locked repo first; the rest behind "+N more"; the slug alone without a branch', () => {
        const html = render();
        expect((html.match(/data-repo-chip="/g) ?? []).length).toBe(3);
        expect(html).toMatch(/data-repo-chip="api"[^>]*>[^<]*(<[^>]*>[^<]*)*api · main/);
        expect(html).toMatch(/data-action="more-repos"[\s\S]*?\+1 more/);
        const docs = headerRepos(ops.repos!.list!).more.find((r) => r.slug === 'docs');
        expect(docs && repoChip({ slug: docs.slug, branch: docs.branch ?? null, lock: docs.lock ?? null })).toMatchObject({ tone: 'normal', label: 'docs' });
    });

    it('a locked repo is red and says so; "Remove stale lock" is offered only for a STALE lock', () => {
        const html = render();
        expect(html).toMatch(/data-repo-chip="web"[^>]*data-tone="bad"/);
        expect(html).toContain('web · index.lock held');
        expect(html).toMatch(/<button[^>]*data-action="remove-stale-lock"[^>]*data-repo-slug="web"/);
        const fresh = render({ ...ops, repos: { ...ops.repos!, list: [{ name: 'Web', slug: 'web', path: 'repos/web', host: false, branch: 'main', lock: { heldSince: 1, stale: false } }] } });
        expect(fresh).toContain('web · index.lock held');
        expect(fresh).not.toContain('remove-stale-lock');
    });

    it('the chips are on every view; none when there is no repo list (not loaded, or no ops)', () => {
        expect((render(ops, 'terminals').match(/data-repo-chip="/g) ?? []).length).toBe(3);
        expect(render({ ...ops, repos: { ...ops.repos!, list: null } })).not.toContain('data-repo-chip');
        expect(render(null)).not.toContain('data-repo-chip');
    });
});
