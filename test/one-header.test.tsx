import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tabsFor } from '../src/core/agent-view.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/*
 * ONE HEADER, AND NOTHING THE TABS ALREADY GIVE (the owner: "the extra files tab in agents view and the different headers
 * based on the view. I don't need all of the repos listed in the workspace header either, or the agents in pill. they
 * have tabs and a dashboard.").
 */
const workspace = { id: 'ws', name: 'Acme', path: '/w/acme' };
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/acme' };
const repo = (slug: string, lock: { heldSince: number; stale: boolean } | null = null) => ({ name: slug, slug, path: `repos/${slug}`, host: false, branch: 'main', lock });
const ops = (list = [repo('api'), repo('web'), repo('docs'), repo('cli')]): WorkspaceOpsProps => ({
    asleep: false, agentCount: 2, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: { list, onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} },
});
const ws = (o: WorkspaceOpsProps = ops()) => renderToStaticMarkup(<Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} ops={o} onTogglePanel={() => {}} />);
const av = (props: Partial<Parameters<typeof AgentView>[0]> = {}) => renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} workspace={workspace} {...props} />);
const header = (html: string) => html.slice(html.indexOf('<header data-view-header'), html.indexOf('</header>') + 9);
const open = (html: string) => /<header data-view-header=""[^>]*>/.exec(html)?.[0] ?? '';
const parts = (h: string) => ['data-header-title', 'data-react-fancy-breadcrumbs', 'data-header-path', 'data-header-actions'].map((p) => h.indexOf(p));

describe('one header for the workspace and the agent', () => {
    it('the same element and the same classes', () => {
        expect(open(ws())).not.toBe('');
        expect(open(ws())).toBe(open(av()));
    });

    it('the same parts in the same order: title (crumbs), path, actions', () => {
        for (const h of [header(ws()), header(av())]) {
            const at = parts(h);
            expect(at.every((i) => i > 0), at.join()).toBe(true);
            expect([...at].sort((a, b) => a - b)).toEqual(at);
        }
    });

    it('the path sits in the header once, the same way in both', () => {
        expect(header(ws())).toMatch(/data-header-path=""[^>]*>\/w\/acme</);
        expect(header(av())).toMatch(/data-header-path=""[^>]*>\/w\/acme</);
    });
});

describe('the workspace header lists no repos and no agents', () => {
    it('no repo chips and no "+N more"', () => {
        const h = header(ws());
        expect(h).not.toContain('data-repo-chip');
        expect(h).not.toContain('more-repos');
    });

    it('a locked repo is a problem, so it alone still shows, with its fix', () => {
        const h = header(ws(ops([repo('api'), repo('web', { heldSince: 1, stale: true })])));
        expect((h.match(/data-repo-chip="/g) ?? []).length).toBe(1);
        expect(h).toMatch(/data-repo-chip="web"[^>]*data-tone="bad"/);
        expect(h).toContain('data-action="remove-stale-lock"');
    });
});

describe('the agent view has no Files tab', () => {
    it('no fidelity offers it', () => {
        for (const f of ['declared', 'observed', 'remote'] as const) expect(tabsFor(f)).not.toContain('files');
    });

    it('none drawn; an old ?tab=files falls back to the first tab', () => {
        const html = av({ tab: 'files', files: NO_FILES });
        expect(html).not.toContain('data-tab="files"');
        expect(html).not.toContain('data-files-panel');
        expect(html).toMatch(/data-tab="stream"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-tab="stream"/);
    });
});
