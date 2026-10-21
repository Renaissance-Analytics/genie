import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tabStrip } from '../src/core/workspace-tabs.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * FILES IS ITS OWN WORKSPACE TAB (beta.35 item 41; the owner, 2026-10-21, a screenshot of Moic Suite with the file
 * panel docked inside the Dashboard tab — the tree, a Markdown editor and "Working in Moic Suite" squeezed side by side:
 * "add a dedicated Files workspace tab so I don't [get] garbage like this").
 *
 * Files is a tab in the workspace's strip, right after Dashboard. The workspace's files (`?files=`, which the header's
 * Files button, ⌘B and every "open this file" already make) ARE that tab: the tree and the editor take the whole tab,
 * and nothing else is drawn beside them.
 */

describe('the strip', () => {
    it('Files follows Dashboard, always (COUNTED)', () => {
        const kinds = tabStrip({ tabs: [] }).map((t) => t.kind);
        expect(kinds).toEqual(['dashboard', 'files', 'add', 'settings']);
        expect(kinds.filter((k) => k === 'files')).toHaveLength(1);
    });

    it('a Files tab, labelled; current when the files are open; pressing it asks for the files view', () => {
        const opened: string[] = [];
        const html = renderToStaticMarkup(<WorkspaceTabs designed={{ tabs: [] }} agents={[]} current={{ kind: 'view', view: 'files' }} canDesign hasSettings onView={(v) => opened.push(v)} onAdd={() => {}} onOpenAgent={() => {}} />);
        expect(html).toMatch(/data-workspace-tab="files"[^>]*data-current="true"[^>]*>Files</);
        expect(html).not.toMatch(/data-workspace-tab="home"[^>]*data-current="true"/);
        const tabs = WorkspaceTabs({ designed: { tabs: [] }, agents: [], current: { kind: 'view', view: 'home' }, canDesign: true, hasSettings: true, onView: (v) => opened.push(v), onAdd: () => {}, onOpenAgent: () => {} });
        const files = (tabs.props.children as Array<{ props: Record<string, unknown> }>).flat().find((c) => c?.props?.['data-workspace-tab'] === 'files');
        (files!.props['onClick'] as () => void)();
        expect(opened).toEqual(['files']);
    });
});

describe('the workspace with its files open', () => {
    const ws = { id: 'tynn', name: 'tynn', path: '/w/tynn' };
    it('the Files tab is current and the files take the whole body — no dashboard beside them', () => {
        const html = renderToStaticMarkup(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} files={{ tree: async () => [], state: async () => null, open: async () => ({ ok: false, path: '', error: '' }), watch: async () => {}, onChanged: () => () => {} } as never} panel="files" />);
        expect(html).toMatch(/data-workspace-tab="files"[^>]*data-current="true"/);
        expect(html).toContain('data-workspace-body="files"');
        expect(html).not.toContain('data-workspace-body="home"');
    });

    it('CONTROL: files closed — the Dashboard is current and its body is drawn', () => {
        const html = renderToStaticMarkup(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} panel={null} />);
        expect(html).toMatch(/data-workspace-tab="home"[^>]*data-current="true"/);
        expect(html).toContain('data-workspace-body="home"');
        expect(html).not.toContain('data-workspace-body="files"');
    });
});
