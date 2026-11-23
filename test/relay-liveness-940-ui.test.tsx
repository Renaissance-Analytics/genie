import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { RemoteSection, TynnWorkstationState } from '../src/renderer/features.js';

/**
 * SETTINGS → REMOTE SAYS WHERE THE RELAY LINK STANDS (Tynn #940): connected, or reconnecting since when, and why. One
 * small line, the same place "Reachable through the Tynn relay" already is.
 */
const base: RemoteSection = { host: 'alphar', url: null, unavailable: 'stopped', locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: false };
const render = (tynnWorkstation: TynnWorkstationState) => renderToStaticMarkup(<RemoteAccess remote={{ ...base, tynnWorkstation }} workspaces={[]} onAction={() => {}} />);
const registered = { registered: true as const, host: 'https://tynn.example.com', workstationId: 'ws_01abc' };
const since = Date.UTC(2026, 10, 20, 14, 2, 0);

describe('the relay link line (Tynn #940)', () => {
    it('reconnecting: says so, since when (a machine-readable time), and why', () => {
        const html = render({ ...registered, relay: { state: 'reconnecting', since, reason: 'the relay sent nothing for 75 s' } });
        expect(html).toMatch(/data-tynn-relay="reconnecting"/);
        expect(html).toMatch(/Reconnecting to the Tynn relay/);
        expect(html).toContain(`dateTime="${new Date(since).toISOString()}"`);
        expect(html).toContain('the relay sent nothing for 75 s');
    });

    it('CONTROL: connected says connected, with no "since" and no reconnecting words', () => {
        const html = render({ ...registered, relay: { state: 'reachable', relay: 'wss://relay.example.com' } });
        expect(html).toMatch(/data-tynn-relay="reachable"/);
        expect(html).not.toMatch(/Reconnecting/);
        expect(html).not.toContain('dateTime=');
    });
});
