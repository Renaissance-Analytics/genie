import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tabStrip, workspaceViewRoute } from '../src/core/workspace-tabs.js';
import { formatRoute, parseRoute } from '../src/core/route.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';
import { control } from './helpers/control-markup.js';

/**
 * THE ARTBOARD IS A TAB OF ITS OWN, LIKE FILES (Tynn #739; the owner, 2026-11-15: "We need to make them a dedicated tab like
 * we did for files"). It is in every workspace's strip, right after Files, not something the person adds to a tab grid; a
 * badge counts what waits for a verdict; and a link to one item opens the tab on it.
 */

describe('the strip', () => {
    it('ArtBoard follows Files, always, exactly once (COUNTED)', () => {
        const kinds = tabStrip({ tabs: [] }).map((t) => t.kind);
        expect(kinds).toEqual(['dashboard', 'files', 'artboard', 'add', 'settings']);
        expect(kinds.filter((k) => k === 'artboard')).toHaveLength(1);
        expect(tabStrip({ tabs: [] }, [{ id: 'a1', name: 'atlas' }], { github: true, tynn: true }).map((t) => t.kind).slice(0, 4)).toEqual(['dashboard', 'files', 'artboard', 'agent']);
    });

    it('is a tab with a label, current when its view is on screen; pressing it asks for the artboard view', () => {
        const opened: string[] = [];
        const html = renderToStaticMarkup(<WorkspaceTabs designed={{ tabs: [] }} agents={[]} current={{ kind: 'view', view: 'artboard' }} canDesign hasSettings onView={(v) => opened.push(v)} onAdd={() => {}} onOpenAgent={() => {}} />);
        expect(control(html, 'data-workspace-tab="artboard"')).toMatchObject({ tag: 'button', tab: true });
        expect(control(html, 'data-workspace-tab="artboard"')!.text).toMatch(/^ArtBoard(?![\w])/);
        expect(control(html, 'data-workspace-tab="artboard"')!.open).toContain('aria-selected="true"');
        expect(control(html, 'data-workspace-tab="files"')!.open).toContain('aria-selected="false"');
        // The strip lists Files before ArtBoard.
        expect(html.indexOf('data-workspace-tab="files"')).toBeLessThan(html.indexOf('data-workspace-tab="artboard"'));
        const strip = WorkspaceTabs({ designed: { tabs: [] }, agents: [], current: { kind: 'view', view: 'home' }, canDesign: true, hasSettings: true, onView: (v) => opened.push(v), onAdd: () => {}, onOpenAgent: () => {} });
        const tabsEl = (strip.props.children as Array<{ props: Record<string, unknown> } | null>).flat().find((c) => typeof c?.props?.['onTabChange'] === 'function');
        (tabsEl!.props['onTabChange'] as (value: string) => void)('artboard');
        expect(opened).toEqual(['artboard']);
    });
});

describe('the badge: items waiting for a verdict', () => {
    const tabs = (waiting: number | undefined) => renderToStaticMarkup(<WorkspaceTabs designed={{ tabs: [] }} agents={[]} current={{ kind: 'view', view: 'home' }} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} {...(waiting === undefined ? {} : { artboardWaiting: waiting })} />);

    it('shows the count on the tab, and flags it', () => {
        const html = tabs(3);
        expect(html).toContain('data-artboard-badge="3"');
        expect(control(html, 'data-workspace-tab="artboard"')!.text).toMatch(/ArtBoard\s*3/);
        expect(control(html, 'data-workspace-tab="artboard"')!.open).toContain('data-artboard-waiting="true"');
    });

    it('CONTROL: nothing waiting, or no count known — no badge, no flag', () => {
        for (const html of [tabs(0), tabs(undefined)]) {
            expect(html).not.toContain('data-artboard-badge');
            expect(control(html, 'data-workspace-tab="artboard"')!.open).not.toContain('data-artboard-waiting');
            expect(control(html, 'data-workspace-tab="artboard"')!.text).toMatch(/^ArtBoard$/);
        }
    });
});

describe('the workspace on its ArtBoard tab', () => {
    const ws = { id: 'tynn', name: 'tynn', path: '/w/tynn' };
    const board = { pluginId: 'ai.genie.artboard', pluginName: 'ArtBoard', id: 'board', title: 'ArtBoard', fancyComponent: { export: 'ArtBoardPanel' as const }, props: {} };

    it('the tab is current and its body is the board — nothing of the Dashboard beside it', () => {
        const html = renderToStaticMarkup(<Workspace view="artboard" workspace={ws} terminals={NO_TERMINALS} pluginPanels={[board]} />);
        expect(control(html, 'data-workspace-tab="artboard"')!.open).toContain('aria-selected="true"');
        expect(html).toContain('data-workspace-body="artboard"');
        expect(html).not.toContain('data-workspace-body="home"');
        // No bridge in this render, so the board says why instead of drawing nothing.
        expect(html).toMatch(/no ArtBoard host/);
    });

    it('with the ArtBoard plugin switched off, the tab says so in words', () => {
        const html = renderToStaticMarkup(<Workspace view="artboard" workspace={ws} terminals={NO_TERMINALS} pluginPanels={[]} />);
        expect(html).toContain('data-workspace-body="artboard"');
        expect(html).toMatch(/ArtBoard plugin is (not|switched) (enabled|off|on)/i);
    });

    it('CONTROL: another view does not draw the board', () => {
        const html = renderToStaticMarkup(<Workspace view="home" workspace={ws} terminals={NO_TERMINALS} pluginPanels={[board]} />);
        expect(html).not.toContain('data-workspace-body="artboard"');
    });
});

describe('the route: one click, straight to the item', () => {
    it('the artboard view is a workspace view, with an item the link points at', () => {
        const route = parseRoute('genie://workspace/tynn?view=artboard&item=login');
        expect(route).toMatchObject({ surface: 'workspace', workspaceId: 'tynn', view: 'artboard', artboardItem: 'login' });
        expect(formatRoute(route)).toBe('genie://workspace/tynn?view=artboard&item=login');
        expect(workspaceViewRoute('tynn', 'artboard')).toBe('genie://workspace/tynn?view=artboard');
    });

    it('an item on any other view is ignored, and a view with no item has none', () => {
        expect(parseRoute('genie://workspace/tynn?view=settings&item=login')).not.toHaveProperty('artboardItem');
        expect(parseRoute('genie://workspace/tynn?view=artboard')).not.toHaveProperty('artboardItem');
    });
});
