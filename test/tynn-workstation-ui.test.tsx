import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { RemoteSection, TynnWorkstationState } from '../src/renderer/features.js';

/**
 * THIS MACHINE ON THE TYNN NETWORK (Tynn #836; Genie 1's Tynn workstation registration). Settings → Remote access says
 * whether this machine is registered with Tynn — the thing a share, the relay and the Tynn workstations list all
 * stand on — and, when it is not, why, in Tynn's or Genie's own words.
 */
const base: RemoteSection = { host: 'alphar', url: null, unavailable: 'stopped', locked: false, pin: null, devices: [], shares: [], connections: [], servedLink: null, enabled: false, firewall: false };
const render = (tynnWorkstation: TynnWorkstationState | null | undefined) => renderToStaticMarkup(<RemoteAccess remote={{ ...base, tynnWorkstation }} workspaces={[]} onAction={() => {}} />);

describe('the Tynn row', () => {
    it('registered: says so, with this machine’s workstation id', () => {
        const html = render({ registered: true, host: 'https://tynn.example.com', workstationId: 'ws_01abc' });
        expect(html).toMatch(/data-tynn-workstation="registered"/);
        expect(html).toContain('ws_01abc');
        expect(html).toContain('tynn.example.com');
    });

    it('not registered: says why', () => {
        const html = render({ registered: false, reason: 'sign in to Tynn to register this machine' });
        expect(html).toMatch(/data-tynn-workstation="unregistered"/);
        expect(html).toContain('sign in to Tynn to register this machine');
    });

    // Tynn #838: this machine on the relay, as a host.
    it('reachable over the Tynn relay: says so, naming the relay', () => {
        const html = render({ registered: true, host: 'https://tynn.example.com', workstationId: 'ws_01abc', relay: { state: 'reachable', relay: 'wss://relay.example.com' } });
        expect(html).toMatch(/data-tynn-relay="reachable"/);
        expect(html).toContain('relay.example.com');
    });

    it('not reachable: Tynn’s own reason', () => {
        const html = render({ registered: true, host: 'https://tynn.example.com', workstationId: 'ws_01abc', relay: { state: 'unavailable', reason: 'No relay is configured for this workstation, so it cannot be reached over Tynn.' } });
        expect(html).toMatch(/data-tynn-relay="unavailable"/);
        expect(html).toContain('No relay is configured for this workstation, so it cannot be reached over Tynn.');
    });

    it('relay off (remote access off): says how to turn it on', () => {
        const html = render({ registered: true, host: 'https://tynn.example.com', workstationId: 'ws_01abc', relay: { state: 'off' } });
        expect(html).toMatch(/data-tynn-relay="off"/);
        expect(html).toContain('Turn on remote access');
    });

    it('not read yet: no row (CONTROL — the row is driven by the state, not always drawn)', () => {
        expect(render(null)).not.toContain('data-tynn-workstation');
        expect(render(undefined)).not.toContain('data-tynn-workstation');
    });
});
