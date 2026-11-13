// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction, FirewallRuleFacts, FirewallRuleView, RemoteSection } from '../src/renderer/features.js';
import { registerAppIcons } from '../src/renderer/icons.js';

/**
 * THE WINDOWS FIREWALL ROW SAYS WHETHER GENIE'S RULE IS THERE, AND OFFERS REMOVING IT (Tynn #685). The owner, on Settings →
 * Remote access: "If it's already allowed I should see that it is already allowed and I should have a button for clearing
 * that rule that allowed it." The row always offered "Allow through Windows Firewall", whatever Windows had.
 *
 * The row draws main's reading of the rule (`remote.firewallRule`, read from Windows by netsh, main/remote-firewall.ts):
 * present and letting the port in = "Allowed", with what Windows reports, and Remove; absent = Allow; present but NOT
 * letting the port in (disabled, another port) = says why, Allow to fix it, and Remove; unreadable = the reason, and Allow.
 */
registerAppIcons();

const facts = (over: Partial<FirewallRuleFacts> = {}): FirewallRuleFacts => ({
    fields: [
        { label: 'Enabled', value: 'Yes' }, { label: 'Direction', value: 'In' }, { label: 'Profiles', value: 'Domain,Private,Public' },
        { label: 'RemoteIP', value: '100.64.0.0/255.192.0.0' }, { label: 'Protocol', value: 'TCP' }, { label: 'LocalPort', value: '7421' },
        { label: 'Action', value: 'Allow' },
    ],
    enabled: true, inbound: true, allow: true, protocol: 'TCP', localPort: '7421', remoteIp: '100.64.0.0/255.192.0.0', profiles: 'Domain,Private,Public',
    ...over,
});
const base: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: true };
const render = (firewallRule: FirewallRuleView | null | undefined, over: Partial<RemoteSection> = {}) =>
    renderToStaticMarkup(<RemoteAccess remote={{ ...base, firewallRule, ...over }} workspaces={[]} onAction={() => {}} />);
/** The firewall row alone, so words elsewhere on the page never satisfy an assertion about it. */
const row = (html: string): string => /<div[^>]*data-firewall-rule="[^"]*"[^]*?<\/div>/.exec(html)?.[0] ?? '';
const ALLOW = 'data-action="remote-firewall"';
const REMOVE = 'data-action="remote-firewall-remove"';
/** A button by its handle, start tag through its end, so an icon inside it can be asserted. */
const button = (html: string, handle: string): string => new RegExp(`<button[^>]*${handle}[^]*?</button>`).exec(html)?.[0] ?? '';

describe('Genie’s rule is there and lets the port in', () => {
    const present: FirewallRuleView = { state: 'present', port: 7421, covers: true, rules: [facts()] };

    it('says it is already allowed, with what Windows reports: protocol, port, who may connect, the profiles', () => {
        const r = row(render(present));
        expect(r).toContain('data-firewall-rule="allowed"');
        expect(r).toContain('Allowed through Windows Firewall');
        expect(r).toContain('TCP 7421');
        expect(r).toContain('100.64.0.0/255.192.0.0');
        expect(r).toContain('Domain,Private,Public');
    });

    it('offers Remove (a Fancy Button with its icon), and no Allow', () => {
        const html = render(present);
        expect(button(html, REMOVE)).toContain('Remove');
        expect(button(html, REMOVE)).toContain('data-react-fancy-icon');
        expect(html).not.toContain(ALLOW);
    });

    it('Remove asks main to remove the rule (clicked in a live DOM)', () => {
        const actions: FeatureAction[] = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => { root.render(<RemoteAccess remote={{ ...base, firewallRule: present }} workspaces={[]} onAction={(a) => { actions.push(a); }} />); });
        act(() => { (host.querySelector(`[${REMOVE}]`) as HTMLElement).click(); });
        expect(actions).toEqual([{ kind: 'remote.removeFirewall' }]);
        act(() => root.unmount());
        host.remove();
    });

    it('with Remote access OFF the rule is still shown, and Remove still offered: the rule outlives the switch', () => {
        const html = render(present, { enabled: false, url: null, unavailable: 'stopped' });
        expect(row(html)).toContain('Allowed through Windows Firewall');
        expect(html).toContain(REMOVE);
    });
});

describe('Genie’s rule is not there', () => {
    it('Windows has none: says so, offers Allow (with its icon), no Remove', () => {
        const html = render({ state: 'absent' });
        expect(row(html)).toContain('data-firewall-rule="absent"');
        expect(button(html, ALLOW)).toContain('Allow through Windows Firewall');
        expect(button(html, ALLOW)).toContain('data-react-fancy-icon');
        expect(html).not.toContain(REMOVE);
        expect(row(html)).not.toContain('Allowed through');
    });
});

describe('Genie’s rule is there but does NOT let the port in', () => {
    it('disabled: says so in words, offers Allow to put it right, and Remove', () => {
        const html = render({ state: 'present', port: 7421, covers: false, rules: [facts({ enabled: false })] });
        expect(row(html)).toContain('data-firewall-rule="not-allowing"');
        expect(row(html)).toContain('turned off');
        expect(row(html)).not.toContain('Allowed through');
        expect(html).toContain(ALLOW);
        expect(html).toContain(REMOVE);
    });

    it('another port: names the port it lets in and the one remote access uses', () => {
        const r = row(render({ state: 'present', port: 7421, covers: false, rules: [facts({ localPort: '7422' })] }));
        expect(r).toContain('7422');
        expect(r).toContain('7421');
    });

    it('in a language Genie cannot read: says Windows has the rule, shows its lines as Windows printed them, offers Remove', () => {
        const de = facts({ enabled: null, inbound: null, allow: null, protocol: null, localPort: null, remoteIp: null, profiles: null, fields: [{ label: 'Aktiviert', value: 'Ja' }, { label: 'Lokaler Port', value: '7421' }] });
        const html = render({ state: 'present', port: 7421, covers: null, rules: [de] });
        expect(row(html)).toContain('data-firewall-rule="present"');
        expect(row(html)).toContain('Lokaler Port');
        expect(html).toContain(REMOVE);
    });
});

describe('Windows could not be read, or has not been yet', () => {
    it('unreadable: the reason in words, and Allow (offer the fix rather than hide a missing rule)', () => {
        const html = render({ state: 'unknown', reason: 'netsh did not answer' });
        expect(row(html)).toContain('netsh did not answer');
        expect(html).toContain(ALLOW);
        expect(html).not.toContain(REMOVE);
    });

    it('not read yet: Allow, as before', () => {
        const html = render(null);
        expect(html).toContain(ALLOW);
        expect(html).not.toContain(REMOVE);
    });
});

describe('CONTROL: not Windows', () => {
    it('no firewall row, no Allow, no Remove, whatever a reading says', () => {
        const html = render({ state: 'present', port: 7421, covers: true, rules: [facts()] }, { firewall: false });
        expect(html).not.toContain('data-firewall-rule');
        expect(html).not.toContain(ALLOW);
        expect(html).not.toContain(REMOVE);
    });
});
