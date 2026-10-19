import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RailItem } from '../src/core/rail-view.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { WorkspaceRuntimeModal } from '../src/renderer/components/WorkspaceRuntimeModal.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * THE WORKSPACE ROW, GENIE 1'S (the owner, 2026-10-19): the pulse while its agents work (their sessions, not terminals),
 * and the background-process and site indicators — always there, greyed when there is nothing — each opening that
 * workspace's own config in a modal, as Genie 1's did.
 */
const row = (over: Partial<RailItem>): RailItem => ({ id: 'tynn', path: '/w/tynn', name: 'tynn', count: 2, alert: false, working: 0, processes: 'none', processesTitle: 'No background processes — click to open', sites: null, sitesTitle: 'No hosted sites yet — click to open the Site Manager', ...over } as RailItem);
const memory = (collapsed: boolean): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', collapsed ? '1' : '0']]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const sidebar = (items: RailItem[], collapsed = false) => renderToStaticMarkup(
    <Sidebar route="genie://dashboard" deckCount={0} workspaces={items} available={['deck', 'dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} railStorage={memory(collapsed)} onOpenProcesses={() => {}} onOpenSites={() => {}} />,
);
const rowHtml = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-workspace="${id}"[\\s\\S]*?</button>`))?.[0] ?? '';

describe('the pulse', () => {
    it('lit while its agents work, with how many; dark otherwise (COUNTED)', () => {
        const html = sidebar([row({ id: 'tynn', working: 2 }), row({ id: 'fancy', name: 'fancy', working: 0 })]);
        expect(rowHtml(html, 'tynn')).toMatch(/data-agent-active="true"/);
        expect(rowHtml(html, 'tynn')).toMatch(/2 agents working/);
        expect(rowHtml(html, 'fancy')).not.toMatch(/data-agent-active/);
        expect(html.match(/data-agent-active="true"/g) ?? []).toHaveLength(1);
    });

    it('the collapsed rail still glows the working workspace’s icon', () => {
        expect(sidebar([row({ working: 1 })], true)).toMatch(/data-agent-active="true"/);
    });
});

describe('the process and site indicators', () => {
    it('both always shown with their tone and Genie 1’s title — greyed (none) when there is nothing', () => {
        const html = rowHtml(sidebar([row({})]), 'tynn');
        expect(html).toMatch(/data-ws-processes="tynn"[^>]*data-tone="none"/);
        expect(html).toMatch(/data-ws-sites="tynn"[^>]*data-tone="none"/);
        expect(html).toContain('No hosted sites yet — click to open the Site Manager');
    });

    it('a running process and a failed site say so', () => {
        const html = rowHtml(sidebar([row({ processes: 'running', processesTitle: 'Background processes (1) — click to open', sites: 'failed', sitesTitle: '1 hosted site · 1 failed — click to open the Site Manager' })]), 'tynn');
        expect(html).toMatch(/data-ws-processes="tynn"[^>]*data-tone="running"/);
        expect(html).toMatch(/data-ws-sites="tynn"[^>]*data-tone="failed"/);
    });
});

// Fancy's Modal renders through a portal, which a static render does not draw: walk the element tree the component
// returns and render what is inside the Modal (as test/update-window.test.tsx does).
function inside(node: ReactNode): string {
    const parts: string[] = [];
    const walk = (n: ReactNode): void => {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (!isValidElement(n)) { if (typeof n === 'string') parts.push(n); return; }
        const el = n as ReactElement<Record<string, unknown>>;
        if (el.props['data-workspace-runtime'] !== undefined) { parts.push(renderToStaticMarkup(el)); return; }
        walk(el.props.children as ReactNode);
    };
    walk(node);
    return parts.join('');
}

describe('the config modal', () => {
    const data = {
        ...EMPTY_FEATURES,
        hosting: {
            sites: [{ id: 's1', name: 'tynn', host: 'tynn.gen', workspaceId: 'tynn', repoPath: '/w/tynn', serve: null, port: null, state: 'running', processIds: [], problem: null }, { id: 's2', name: 'fancy', host: 'fancy.gen', workspaceId: 'fancy', repoPath: '/w/fancy', serve: null, port: null, state: 'running', processIds: [], problem: null }],
            processes: [{ id: 'p1', workspaceId: 'tynn', name: 'queue', state: 'running', pid: 1, exitCode: null, restarts: 0, since: 1 }, { id: 'p2', workspaceId: 'fancy', name: 'vite', state: 'running', pid: 2, exitCode: null, restarts: 0, since: 1 }],
            adding: null, frontDoor: null,
        },
    } as never;
    const ws = { id: 'tynn', path: '/w/tynn', name: 'tynn' };

    it('Processes: only this workspace’s, named for it', () => {
        const html = inside(WorkspaceRuntimeModal({ kind: 'processes', workspace: ws, data, onAction: () => {}, onClose: () => {} }));
        expect(html).toMatch(/Background processes — tynn/);
        expect(html).toContain('queue');
        expect(html).not.toContain('vite');
    });

    it('Sites: only this workspace’s', () => {
        const html = inside(WorkspaceRuntimeModal({ kind: 'sites', workspace: ws, data, onAction: () => {}, onClose: () => {} }));
        expect(html).toMatch(/Sites — tynn/);
        expect(html).toContain('tynn.gen');
        expect(html).not.toContain('fancy.gen');
    });
});
