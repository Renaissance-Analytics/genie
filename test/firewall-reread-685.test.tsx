// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction, FirewallRuleView, RemoteSection } from '../src/renderer/features.js';
import { registerAppIcons } from '../src/renderer/icons.js';

/**
 * THE ROW SHOWS WHAT WINDOWS HAS NOW, NOT AT START (Tynn #685, review): a rule added or removed outside Genie (wf.msc, netsh,
 * an installer) must show without a restart. Opening Settings → Remote access, and the window regaining focus while it is
 * open, asks main to read Windows again. Main's read is DEBOUNCED: a read in flight is joined, and one within the last few
 * seconds is not repeated, so opening the page over and over never spawns netsh in a burst. Allow and Remove still read
 * fresh, whatever the debounce says: the row must show what the action did.
 */
registerAppIcons();
const ABSENT: FirewallRuleView = { state: 'absent' };
const PRESENT: FirewallRuleView = {
    state: 'present', port: 7421, covers: true,
    rules: [{ fields: [{ label: 'LocalPort', value: '7421' }], enabled: true, inbound: true, allow: true, protocol: 'TCP', localPort: '7421', remoteIp: '100.64.0.0/255.192.0.0', profiles: 'Domain,Private,Public' }],
};

describe('the row asks for a fresh read when it opens, and on window focus', () => {
    const base: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: true };
    let host: HTMLDivElement;
    let root: Root;
    let actions: FeatureAction[];
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        actions = [];
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); });
    const draw = (remote: RemoteSection) => act(() => { root.render(<RemoteAccess remote={remote} workspaces={[]} onAction={(a) => { actions.push(a); }} />); });
    const reads = () => actions.filter((a) => a.kind === 'remote.readFirewall').length;

    it('opening the page: one read asked for', () => {
        draw({ ...base, firewallRule: ABSENT });
        expect(reads()).toBe(1);
    });

    it('a snapshot redrawing the page does not ask again; the window regaining focus does', () => {
        draw({ ...base, firewallRule: ABSENT });
        draw({ ...base, firewallRule: ABSENT, firewallOutcome: 'x' });
        expect(reads()).toBe(1);
        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(reads()).toBe(2);
    });

    it('a changed answer redraws the row: absent → allowed', () => {
        draw({ ...base, firewallRule: ABSENT });
        expect(host.querySelector('[data-firewall-rule]')?.getAttribute('data-firewall-rule')).toBe('absent');
        draw({ ...base, firewallRule: PRESENT });
        expect(host.querySelector('[data-firewall-rule]')?.getAttribute('data-firewall-rule')).toBe('allowed');
    });

    it('closed (unmounted): focus asks for nothing', () => {
        draw({ ...base, firewallRule: ABSENT });
        act(() => root.render(<div />));
        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(reads()).toBe(1);
    });

    it('CONTROL: not Windows: no row, no read asked for', () => {
        draw({ ...base, firewall: false });
        expect(reads()).toBe(0);
    });
});
