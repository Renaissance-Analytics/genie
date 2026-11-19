// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tabsFor } from '../src/core/agent-view.js';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/*
 * ONE TOP BAR FOR EVERY VIEW (the owner on beta.64, 2026-11-17: "you still have two different workspace views happening.
 * agents should not have a different header UX than workspaces, the only difference is the main content. I prefer the
 * tabs along the top layout. the way you have workspaces headers now it's a lot of wasted space.").
 *
 * Before: a workspace drew a header row (crumb, path, actions) ABOVE its tab strip; an agent drew the strip, then a header
 * row (crumbs "Tynn / tynn", provider, "Turn N · running", path, Stop this turn, Chat, Take over), then a row of its own
 * tabs (Stream, Changes, Shells, Settings). Three rows of chrome on one, two on the other, in a different order.
 *
 * Now: the workspace's tab strip is the ONE bar, on top, in both. What is selected puts its status and actions, as icons,
 * at the bar's right end; an agent's own views are a segmented control in that same place. No crumbs (the tab IS the
 * name), the path is the selected tab's tooltip, and the content starts right under the bar in both views.
 *
 * Earlier contract (2026-11-16, "the different headers based on the view"): the two views shared ONE header component.
 * That is kept, stronger: they share one BAR, and it is the only one.
 */
const workspace = { id: 'ws', name: 'Acme', path: '/w/acme' };
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/acme/repos/api' };
const repo = (slug: string, lock: { heldSince: number; stale: boolean } | null = null) => ({ name: slug, slug, path: `repos/${slug}`, host: false, branch: 'main', lock });
const ops = (list = [repo('api'), repo('web'), repo('docs'), repo('cli')]): WorkspaceOpsProps => ({
    asleep: false, agentCount: 2, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: { list, onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} },
});
const agentTabs = [{ id: 'a1', name: 'atlas', state: 'working' }];
const wsEl = (o: WorkspaceOpsProps = ops()) => <Workspace view="home" workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} ops={o} onTogglePanel={() => {}} agentTabs={agentTabs} onOpenScratchTerminal={async () => ({ ok: true as const })} />;
/** The agent's page as Shell composes it: the workspace's strip handed to the agent view as its bar. */
const strip = (trailing: ReactNode, path?: string) => (
    <WorkspaceTabs designed={{ tabs: [] }} agents={agentTabs} current={{ kind: 'agent', id: 'a1' }} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} trailing={trailing} {...(path ? { path } : {})} />
);
const avEl = (props: Partial<Parameters<typeof AgentView>[0]> = {}) => (
    <AgentView agent={agent} session={null} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} workspace={workspace} onTakeOver={() => {}} bar={(trailing) => strip(trailing, agent.cwd)} {...props} />
);
const ws = (o?: WorkspaceOpsProps) => renderToStaticMarkup(wsEl(o));
const av = (props?: Partial<Parameters<typeof AgentView>[0]>) => renderToStaticMarkup(avEl(props));
/** The bar's own markup: from its opening tag to the end of its nav. */
const bar = (html: string) => { const at = html.indexOf('data-top-bar'); return at < 0 ? '' : html.slice(html.lastIndexOf('<', at), html.indexOf('</nav>', at) + 6); };
const openTag = (html: string) => /<nav[^>]*data-top-bar=""[^>]*>/.exec(html)?.[0] ?? '';
const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1] ?? '';

describe('one bar, on top, the same in both views', () => {
    it('exactly one top bar in each (COUNTED), and no second header row', () => {
        for (const html of [ws(), av()]) {
            expect(html.match(/data-top-bar=""/g)?.length ?? 0).toBe(1);
            expect(html.match(/data-view-header=""/g)?.length ?? 0).toBe(1);
            expect(html).not.toMatch(/<header data-view-header/);
        }
    });

    it('the same element with the same classes: one height for both', () => {
        expect(openTag(ws())).not.toBe('');
        expect(classOf(openTag(ws()))).toBe(classOf(openTag(av())));
        expect(classOf(openTag(ws())).split(' ')).toContain('min-h-8');
    });

    it('no crumbs: the selected tab is the name', () => {
        for (const html of [ws(), av()]) {
            expect(html).not.toContain('data-react-fancy-breadcrumbs');
            expect(html).not.toContain('data-crumb=');
        }
    });

    it('the path is the selected tab\'s tooltip, not a column', () => {
        const w = ws();
        const a = av();
        for (const html of [w, a]) expect(html).not.toContain('data-header-path');
        expect(w).toMatch(/data-workspace-tab="home"[^>]*title="[^"]*\/w\/acme"|title="[^"]*\/w\/acme"[^>]*data-workspace-tab="home"/);
        expect(a).toMatch(/data-workspace-tab="agent:a1"[^>]*title="[^"]*\/w\/acme\/repos\/api"|title="[^"]*\/w\/acme\/repos\/api"[^>]*data-workspace-tab="agent:a1"/);
    });

    it('the agent\'s own views are IN the bar: a segmented control at its right end, keyboard tabs', () => {
        const b = bar(av());
        expect(b).toContain('data-agent-subviews');
        for (const t of tabsFor('declared')) expect(b, t).toMatch(new RegExp(`role="tab"[^>]*data-tab="${t}"|data-tab="${t}"[^>]*role="tab"`));
        expect(b).toMatch(/data-tab="stream"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-tab="stream"/);
        // Each named for a screen reader and on hover, since it shows an icon.
        for (const t of tabsFor('declared')) expect(b).toMatch(new RegExp(`data-tab="${t}"[^>]*aria-label="[A-Z][a-z]+"|aria-label="[A-Z][a-z]+"[^>]*data-tab="${t}"`));
    });

    it('the actions are in the bar, as icons with a name (Chat, Take over), not words', () => {
        const b = bar(av());
        for (const name of ['chat', 'take-over']) {
            const at = b.indexOf(`data-action="${name}"`);
            expect(at, name).toBeGreaterThan(0);
            const open = b.slice(b.lastIndexOf('<button', at), b.indexOf('>', at) + 1);
            expect(open, name).toMatch(/aria-label="[^"]+"/);
            const inner = b.slice(b.indexOf('>', at) + 1, b.indexOf('</button>', at));
            expect(inner.replace(/<[^>]+>/g, '').replace(/[⌘⇧A-Z]+$/, '').trim(), name).toBe('');
        }
        const w = bar(ws());
        expect(w).toContain('data-action="open-scratch-terminal"');
        expect(w).toContain('data-action="hibernate"');
    });

    it('CONTROL: the workspace still draws its strip, every tab', () => {
        const html = ws();
        expect(html).toContain('data-workspace-tab="home"');
        expect(html).toContain('data-workspace-tab="agent:a1"');
        expect(html).toContain('data-workspace-tab="settings"');
    });

    it('both bars carry every tab of the strip', () => {
        for (const html of [ws(), av()]) {
            for (const t of ['home', 'agent:a1', 'settings']) expect(bar(html), t).toContain(`data-workspace-tab="${t}"`);
        }
    });

    it('with no workspace strip (the Doctor window), the agent still gets the same bar, itself as its one tab', () => {
        const html = av({ bar: undefined, workspace: undefined });
        expect(classOf(openTag(html))).toBe(classOf(openTag(ws())));
        expect(bar(html)).toContain('data-agent-subviews');
        expect(bar(html)).toMatch(/aria-selected="true"[^>]*>[^<]*atlas|>atlas</);
    });
});

describe('the content starts right under the bar', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLElement;
    let root: Root;
    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('workspace: the bar, then its body; agent: the bar, then its body. Two children, the same shape (COUNTED)', async () => {
        await act(async () => root.render(wsEl()));
        const w = host.querySelector('[data-surface="workspace"]')!;
        expect([...w.children].map((c) => c.hasAttribute('data-top-bar') ? 'bar' : 'body')).toEqual(['bar', 'body']);
        await act(async () => root.render(avEl()));
        const a = host.querySelector('[data-surface="agent"]')!;
        expect([...a.children].map((c) => c.hasAttribute('data-top-bar') ? 'bar' : 'body')).toEqual(['bar', 'body']);
    });
});

describe('the workspace bar lists no repos and no agents', () => {
    it('no repo chips and no "+N more"', () => {
        const h = bar(ws());
        expect(h).not.toContain('data-repo-chip');
        expect(h).not.toContain('more-repos');
    });

    it('a locked repo is a problem, so it alone still shows, with its fix', () => {
        const h = bar(ws(ops([repo('api'), repo('web', { heldSince: 1, stale: true })])));
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
