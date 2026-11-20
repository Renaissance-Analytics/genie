// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FILES, NO_TERMINALS } from '../src/renderer/bridge.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { BUILT_IN_TAB, WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';
import { ICON_NAMES } from '../src/renderer/icons.js';
import { markupRoot, markupText } from './helpers/markup-text.js';

/*
 * THE WORKSPACE HEADER IS THREE ICONS; BUILT-IN TABS ARE ICONS (Tynn #945). The owner, 2026-11-20, on a screenshot with ~5
 * header icons plus "Pop out" and "Close": "the only icon that should be in the header of the workspace dashboard is terminal,
 * share, and garbage clean up. The whole tab ui is bad, our hardcoded tabs should use icons with tooltips instead of labels."
 *
 * Before: the bar's right end held Terminal, Files (the folder tree), Hibernate (the moon), Remove (the trash) and Share, and
 * the Files view's own header said "Pin", "Pop out" and "Close" in words. Every built-in tab said its name in words.
 *
 * Now: the bar holds Terminal, Share and Clean up, and nothing else. What left stays reachable: Files is its own tab (and ⌘B),
 * Hibernate / Wake is a card on the workspace's Settings, and Pin / Pop out / Close are one view menu in the Files header. A
 * built-in tab is an icon, named for a screen reader (aria-label) and on hover or focus (a react-fancy Tooltip); a tab you
 * designed and an agent's tab keep their names.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: 'ws', name: 'Acme', path: '/w/acme' };
const ops = (o: Partial<WorkspaceOpsProps> = {}): WorkspaceOpsProps => ({
    asleep: false, agentCount: 2, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    onShare: () => {},
    repos: { list: [], onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} },
    ...o,
});
const wsEl = (o: WorkspaceOpsProps = ops(), view: 'home' | 'settings' = 'home') => (
    <Workspace view={view} workspace={workspace} terminals={NO_TERMINALS} files={NO_FILES} ops={o} onTogglePanel={() => {}} agentTabs={[{ id: 'a1', name: 'atlas', state: 'idle' }]} onOpenScratchTerminal={async () => ({ ok: true as const })} />
);
const ws = (o?: WorkspaceOpsProps, view?: 'home' | 'settings') => renderToStaticMarkup(wsEl(o, view));
/** The bar's own markup: from its opening tag to the end of its nav. */
const bar = (html: string) => { const at = html.indexOf('data-top-bar'); return at < 0 ? '' : html.slice(html.lastIndexOf('<', at), html.indexOf('</nav>', at) + 6); };
/** Every data-action in the bar, in order. */
const barActions = (html: string) => [...bar(html).matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

describe('the header: Terminal, Share and Clean up, nothing else', () => {
    it('exactly those three actions in the bar (COUNTED)', () => {
        expect(barActions(ws()).sort()).toEqual(['open-scratch-terminal', 'remove-workspace', 'share-workspace']);
    });

    it('asleep: still those three; Wake is not in the bar either', () => {
        expect(barActions(ws(ops({ asleep: true }))).sort()).toEqual(['open-scratch-terminal', 'remove-workspace', 'share-workspace']);
    });

    it('the moved ones are gone from the bar: no files toggle (the tree), no hibernate (the moon)', () => {
        const b = bar(ws());
        expect(b).not.toContain('data-action="toggle-files"');
        expect(b).not.toContain('data-action="hibernate"');
        expect(b).not.toContain('data-action="wake"');
    });

    it('CONTROL: the gauge counts a fourth action when one is there (a locked repo\'s fix)', () => {
        const locked = ops({ repos: { list: [{ name: 'web', slug: 'web', path: 'repos/web', host: false, branch: 'main', lock: { heldSince: 1, stale: true } }], onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} } });
        expect(barActions(ws(locked))).toContain('remove-stale-lock');
        expect(barActions(ws(locked))).toHaveLength(4);
    });
});

describe('what left the header stays reachable', () => {
    it('Files: its own tab, always in the strip', () => {
        expect(bar(ws())).toContain('data-workspace-tab="files"');
    });

    it('Hibernate: a card on the workspace\'s Settings, and Wake there when it is asleep', () => {
        const hibernate = vi.fn();
        const wake = vi.fn();
        const awake = ws(ops({ onHibernate: hibernate }), 'settings');
        expect(awake).toMatch(/data-ws-card="hibernate"/);
        expect(awake).toContain('data-action="hibernate"');
        expect(awake).not.toContain('data-action="wake"');
        const asleep = ws(ops({ asleep: true, onWake: wake }), 'settings');
        expect(asleep).toContain('data-action="wake"');
        expect(asleep).not.toContain('data-action="hibernate"');
    });

    it('the Hibernate card is not on the Dashboard', () => {
        expect(ws()).not.toContain('data-ws-card="hibernate"');
    });

    it('pressing it hibernates', async () => {
        const hibernate = vi.fn();
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => root.render(wsEl(ops({ onHibernate: hibernate }), 'settings')));
        await act(async () => { host.querySelector<HTMLButtonElement>('[data-ws-card="hibernate"] [data-action="hibernate"]')!.click(); });
        expect(hibernate).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
        host.remove();
    });
});

describe('built-in tabs are icons with a tooltip; yours keep their names', () => {
    const strip = () => renderToStaticMarkup(
        <WorkspaceTabs designed={{ tabs: [{ id: 't1', name: 'Release board', layout: 'single', cells: [null] }] }} agents={[{ id: 'a1', name: 'atlas', state: 'idle' }]} current={{ kind: 'view', view: 'home' }} canDesign hasSettings github tynn storage onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} path="/w/acme" />,
    );
    const tabEl = (html: string, value: string) => markupRoot(html).querySelector(`[data-workspace-tab="${value}"]`);

    it('every built-in tab: an icon, no words, and its name as aria-label', () => {
        const html = strip();
        for (const [view, { label }] of Object.entries(BUILT_IN_TAB)) {
            const el = tabEl(html, view);
            expect(el, view).not.toBeNull();
            expect(el!.getAttribute('aria-label'), view).toBe(label);
            expect(markupText(el!.innerHTML).trim(), view).toBe('');
            expect(el!.querySelector('svg, [data-react-fancy-icon], [data-tynn-logo]'), view).not.toBeNull();
        }
    });

    it('the built-ins are the strip\'s fixed tabs: Dashboard, Files, ArtBoard, Tynn, GitHub, Storage, Settings', () => {
        expect(Object.keys(BUILT_IN_TAB).sort()).toEqual(['artboard', 'files', 'github', 'home', 'settings', 'storage', 'tynn']);
    });

    it('their icons are registered (an unregistered name renders an empty span)', () => {
        for (const { icon } of Object.values(BUILT_IN_TAB)) if (icon) expect(ICON_NAMES, icon).toContain(icon);
    });

    it('a tab you designed and an agent\'s tab keep their names', () => {
        const html = strip();
        expect(markupText(tabEl(html, 'tab:t1')!.innerHTML)).toContain('Release board');
        expect(markupText(tabEl(html, 'agent:a1')!.innerHTML)).toContain('atlas');
    });

    describe('the tooltip', () => {
        let host: HTMLElement;
        let root: Root;
        beforeEach(() => {
            vi.useFakeTimers();
            host = document.createElement('div');
            document.body.appendChild(host);
            root = createRoot(host);
        });
        afterEach(() => {
            act(() => root.unmount());
            host.remove();
            vi.useRealTimers();
        });
        const render = (current: string) => act(() => root.render(
            <WorkspaceTabs designed={{ tabs: [] }} agents={[]} current={{ kind: 'view', view: current }} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} path="/w/acme" />,
        ));
        const hover = (view: string) => {
            const el = host.querySelector(`[data-workspace-tab="${view}"]`)!;
            act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); });
            act(() => { vi.advanceTimersByTime(1000); });
            return document.querySelector('[data-react-fancy-tooltip]')?.textContent ?? null;
        };

        it('hovering a built-in tab names it in a react-fancy Tooltip', () => {
            render('home');
            expect(hover('settings')).toBe('Settings');
        });

        it('the selected tab\'s tooltip carries the path (no path column, no native title on top of it)', () => {
            render('home');
            expect(host.querySelector('[data-workspace-tab="home"]')!.hasAttribute('title')).toBe(false);
            expect(hover('home')).toBe('Dashboard · /w/acme');
        });

        it('CONTROL: nothing is shown before the hover', () => {
            render('home');
            expect(document.querySelector('[data-react-fancy-tooltip]')).toBeNull();
        });
    });
});

describe('the Files header: no "Pop out" or "Close" words; one view menu', () => {
    const base: FilesPanelProps = {
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [], state: { files: [], activity: [], unreported: [], changed: null }, tabs: [], open: null,
        pinned: false, onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {}, onPopOut: () => {},
    };
    const header = (html: string) => markupRoot(html).querySelector('header');

    it('the header says neither Pin, Pop out nor Close, and offers one view menu', () => {
        const html = renderToStaticMarkup(<FilesPanel {...base} />);
        const text = markupText(header(html)!.innerHTML);
        for (const word of ['Pop out', 'Close', 'Pin']) expect(text, word).not.toContain(word);
        expect(html).toContain('data-action="files-view-menu"');
    });

    it('opening the menu offers Pin, Pop out and Close, and each does what it says', async () => {
        const onPin = vi.fn();
        const onPopOut = vi.fn();
        const onClose = vi.fn();
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => root.render(<FilesPanel {...base} onPin={onPin} onPopOut={onPopOut} onClose={onClose} />));
        const open = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('[data-action="files-view-menu"]')!.click(); }); };
        const pick = async (action: string) => {
            await open();
            const item = document.querySelector<HTMLElement>(`[data-action="${action}"]`);
            expect(item, action).not.toBeNull();
            await act(async () => { (item!.closest('[role="menuitem"]') as HTMLElement ?? item!).click(); });
        };
        await pick('pin-files');
        await pick('pop-out-files');
        await pick('close-files');
        expect(onPin).toHaveBeenCalledTimes(1);
        expect(onPopOut).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
        host.remove();
    });
});
