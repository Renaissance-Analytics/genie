// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addressOf, type AddressContext } from '../src/core/address.js';
import { routeFor, useAddressQualifier } from '../src/renderer/window-address.js';

/*
 * A LATE ADDRESS REWRITE NEVER UNDOES A NAVIGATION (Tynn #1023, found by #1009's CI rows). Once the window has its
 * snapshot, it rewrites an internal route (`genie://settings`) to this machine's address form. It used to rewrite the
 * address it had last RENDERED; the window learns of a new hash only when its `hashchange` is delivered, a task later. A
 * navigation made in between (a person's click, a row's `location.hash =`) was replaced by the old page's address:
 *   gate 1122-020342-554d85: `#genie://settings` went back to `#genie://<ws>/dashboard`;
 *   rerun 1122-013356-260f53: Settings → Notifications was put back to `#genie://<ws>/settings` (General).
 * It now qualifies the address the window is AT when the snapshot arrives.
 */
const pilot: AddressContext = { workstation: 'gt-11220205-b6b2af28', workspaces: [{ id: 'ws_a', name: 'work', path: '/w' }], agents: [] };
const drone: AddressContext = { workstation: 'gpd0e98c5', workspaces: [{ id: 'ws_d', name: 'genie-b601', path: '/d' }], agents: [] };

/** The window as App runs it: its rendered address (useRoute's state) and the context from its snapshot. */
function Window({ address, ctx }: { address: string; ctx: AddressContext | null }) {
    useAddressQualifier(address, ctx ? addressOf(routeFor(address, ctx), ctx) : address, ctx);
    return null;
}

let host: HTMLDivElement;
let root: Root;
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); window.location.hash = ''; });

const qualified = (route: string, ctx: AddressContext) => `#${addressOf(route, ctx)}`;

describe('the window\'s address rewrite (Tynn #1023)', () => {
    it('a navigation made before the snapshot lands STAYS: the section asked for is the one qualified', () => {
        window.location.hash = '#genie://dashboard';
        act(() => root.render(<Window address="genie://dashboard" ctx={null} />));
        // The person (or a row) goes to Settings. Its hashchange has not reached the window yet: it still renders the Dashboard.
        window.location.hash = '#genie://settings';
        // The snapshot lands now.
        act(() => root.render(<Window address="genie://dashboard" ctx={pilot} />));
        expect(window.location.hash).toBe(qualified('genie://settings', pilot));
        expect(window.location.hash).not.toBe(qualified('genie://dashboard', pilot));
    });

    it('a section within Settings asked for before the snapshot stays too (the click #1009 lost)', () => {
        window.location.hash = '#genie://settings';
        act(() => root.render(<Window address="genie://settings" ctx={null} />));
        window.location.hash = '#genie://settings/notifications';
        act(() => root.render(<Window address="genie://settings" ctx={pilot} />));
        expect(window.location.hash).toBe(qualified('genie://settings/notifications', pilot));
    });

    it('CONTROL: with nothing pending, the address it renders is qualified as before', () => {
        window.location.hash = '#genie://dashboard';
        act(() => root.render(<Window address="genie://dashboard" ctx={null} />));
        expect(window.location.hash).toBe('#genie://dashboard');
        act(() => root.render(<Window address="genie://dashboard" ctx={pilot} />));
        expect(window.location.hash).toBe(qualified('genie://dashboard', pilot));
    });

    it('CONTROL: a window that now reads another machine still takes its page there (beta.61 step four)', () => {
        const at = qualified('genie://settings/remote', pilot);
        window.location.hash = at;
        act(() => root.render(<Window address={at.slice(1)} ctx={pilot} />));
        expect(window.location.hash).toBe(at);
        act(() => root.render(<Window address={at.slice(1)} ctx={drone} />));
        expect(window.location.hash).toBe(qualified('genie://settings/remote', drone));
    });
});
