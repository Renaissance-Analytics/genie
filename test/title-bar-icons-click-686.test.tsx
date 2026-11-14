// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dndHeader } from '../src/core/dnd-header.js';
import { updateChip } from '../src/core/update-chip.js';
import { TitleBar, type TitleBarProps } from '../src/renderer/components/TitleBar.js';
import { registerAppIcons } from '../src/renderer/icons.js';

/**
 * THE HEADER'S CONNECT BUTTON OPENS THE HOST PICKER (Tynn #686; the owner, beta.62.1: the monitor icon "does nothing").
 *
 * The title bar is the window's drag region: a control that is not `no-drag` (itself or an ancestor inside the bar) hands
 * its click to the OS as the start of a window drag, and the button never hears it. Connect is `Popover.Trigger` >
 * `Tooltip` > `Button`; its `no-drag` class sat on the Trigger. react-fancy 6.7.2's Trigger rendered a `<span>` that wore
 * that class around the button. From 6.23.0 the Trigger renders no wrapper and joins its `className` onto its child, and
 * that child is the `Tooltip`, which keeps `className` for its own bubble. So the bubble was `no-drag` and the button was
 * not. The static guard (title-bar-clickable) rendered the bar without `connect`, so it never counted this button.
 *
 * This renders the bar with EVERY system icon in a live DOM, counts each interactive element's drag region, and clicks
 * each icon for what it does. A happy-dom click cannot see the OS drag region, which is why the region is asserted too.
 */
registerAppIcons();
const NO_DRAG = '[-webkit-app-region:no-drag]';

let host: HTMLDivElement;
let root: Root;
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

interface Calls { refresh: number; inbox: number; share: number; dnd: number; update: number; navigate: string[] }
function draw(): Calls {
    const calls: Calls = { refresh: 0, inbox: 0, share: 0, dnd: 0, update: 0, navigate: [] };
    const props: TitleBarProps = {
        route: 'genie://dashboard',
        workstation: { name: 'alphar', healthy: true },
        onNavigate: (r) => { calls.navigate.push(r); },
        onOpenPalette: () => {},
        platform: 'generic',
        update: updateChip({ phase: 'available', version: '2.0.0-beta.63', percent: null } as never),
        onOpenUpdate: () => { calls.update += 1; },
        inbox: { unread: 2, open: false, onToggle: () => { calls.inbox += 1; } },
        share: { onShare: () => { calls.share += 1; } },
        dnd: { view: dndHeader({ do_not_disturb: false })!, onToggle: () => { calls.dnd += 1; } },
        gapps: { apps: [] },
        connect: { workstations: { ok: true, workstations: [] }, onOpenWorkstation: () => {}, onRefresh: () => { calls.refresh += 1; } },
    };
    act(() => { root.render(<TitleBar {...props} />); });
    return calls;
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: HTMLElement | null) => act(() => { el!.click(); });

/** Whether the element, or an ancestor up to the bar itself, opts out of the bar's drag region. */
function noDrag(el: Element, bar: Element): boolean {
    for (let at: Element | null = el; at && at !== bar; at = at.parentElement) {
        if (at.classList.contains(NO_DRAG)) return true;
    }
    return false;
}

describe('every control in the title bar, with every system icon drawn, is out of the drag region', () => {
    it('counted in the live DOM: Connect among them', () => {
        draw();
        const bar = q('[data-title-bar]')!;
        const controls = [...bar.querySelectorAll('button, a, input, select, textarea, [role="button"]')];
        // Positive control: the walk finds the system icons it claims to check, Connect among them.
        for (const sel of ['[data-system-icon="Connect"]', '[data-system-icon="AgentInbox"]', '[data-system-icon="DoNotDisturb"]', '[data-action="share-workstation"]', '[data-update-chip]']) {
            expect(controls.some((c) => c.matches(sel)), sel).toBe(true);
        }
        expect(controls.filter((c) => !noDrag(c, bar)).map((c) => c.outerHTML.slice(0, 120))).toEqual([]);
    });
});

describe('Connect (the monitor icon) opens the host picker', () => {
    it('one click: the menu is in the DOM, the button says it is expanded, and Tynn’s list is read again', () => {
        const calls = draw();
        const button = q('[data-system-icon="Connect"]');
        expect(button).not.toBeNull();
        expect(q('[data-connect-menu]')).toBeNull();
        click(button);
        expect(q('[data-connect-menu]')).not.toBeNull();
        expect(button!.getAttribute('aria-expanded')).toBe('true');
        expect(calls.refresh).toBe(1);
    });

    it('a second click closes it', () => {
        draw();
        const button = q('[data-system-icon="Connect"]');
        click(button);
        click(button);
        expect(q('[data-connect-menu]')).toBeNull();
    });
});

describe('the other header icons do what they say on one click', () => {
    it('AgentInbox, Share, Do Not Disturb, the update chip, and GApps (its store)', () => {
        const calls = draw();
        click(q('[data-system-icon="AgentInbox"]'));
        click(q('[data-action="share-workstation"]'));
        click(q('[data-system-icon="DoNotDisturb"]'));
        click(q('[data-update-chip]'));
        expect({ inbox: calls.inbox, share: calls.share, dnd: calls.dnd, update: calls.update }).toEqual({ inbox: 1, share: 1, dnd: 1, update: 1 });
        expect(q('[data-gapp-store]')).toBeNull();
        click(q('[data-feature="GApps"]'));
        expect(q('[data-gapp-store]')).not.toBeNull();
    });
});
