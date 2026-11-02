// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE RAIL MOVES WITH THE ARROW KEYS (react-fancy 6.1.0 Sidebar `keyboardNav`): the rail is ONE Tab stop — the current
 * item — and Up/Down/Home/End move focus between its items (a roving tabindex). A rendered claim: the tabindex is set
 * after mount, so this commits the tree in a DOM (happy-dom), as test/rate-limit-popover.test.tsx does.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
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
const memory = { getItem: () => '0', setItem: () => {} };
const items = () => [...host.querySelectorAll<HTMLElement>('[data-react-fancy-sidebar-item]')];
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('the rail’s keyboard', () => {
    it('one Tab stop, the current item; ArrowDown and End move focus along the items', () => {
        act(() => root.render(
            <Sidebar route="genie://dashboard" deckCount={0} workspaces={[]} available={['deck', 'dashboard', 'genie', 'hosting', 'settings']} onNavigate={() => {}} railStorage={memory} />,
        ));
        const all = items();
        expect(all.length).toBeGreaterThanOrEqual(5);
        const stops = all.filter((el) => el.getAttribute('tabindex') === '0');
        expect(stops.map((el) => el.dataset['nav'])).toEqual(['genie://dashboard']);
        expect(all.filter((el) => el.getAttribute('tabindex') === '-1')).toHaveLength(all.length - 1);

        const dashboard = all.find((el) => el.dataset['nav'] === 'genie://dashboard')!;
        act(() => dashboard.focus());
        key(dashboard, 'ArrowDown');
        expect((document.activeElement as HTMLElement | null)?.dataset['nav']).toBe(all[all.indexOf(dashboard) + 1]!.dataset['nav']);
        key(document.activeElement!, 'End');
        expect(document.activeElement).toBe(all[all.length - 1]);
    });
});
