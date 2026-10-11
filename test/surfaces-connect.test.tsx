import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * "DRIVE ANOTHER MACHINE" (§6.8) — the client side in Settings → Workstation: a host, a PIN (or a
 * token this device remembers), a label for this screen; while connected, who you are driving and a
 * Disconnect. A refusal from the host is shown where it was caused. Without the prop the form is
 * absent — a window that cannot connect (a test, the live check) draws no dead control.
 */

const remote = { host: 'alphar', url: null, locked: false, pin: null, devices: [], shares: [], connections: [], servedLink: null };
const render = (connect: Parameters<typeof SettingsSurface>[0]['remoteConnect']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote }} onAction={() => {}} onNavigate={() => {}} group="workstation" remoteConnect={connect} />);

describe('Drive another machine', () => {
    it('is absent without the prop; present with host, PIN and label fields and a Connect', () => {
        expect(render(undefined)).not.toContain('data-form="connect-remote"');
        const html = render({ state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {} });
        expect(html).toContain('data-form="connect-remote"');
        expect(html).toMatch(/name="host"/);
        expect(html).toMatch(/name="pin"/);
        expect(html).toMatch(/name="label"/);
        expect(html).toMatch(/>Connect</);
    });

    it('offers the hosts this device already paired with (no PIN needed), and shows a refusal beside the form', () => {
        const html = render({ state: { connected: false, host: null, isOwner: false, workspaceId: null, driver: null, driving: false, locked: false, lastRefusal: 'wrong PIN', token: null }, remembered: ['wss://studio:7421/genie'], onConnect: () => {}, onDisconnect: () => {} });
        expect(html).toMatch(/studio:7421/);
        expect(html).toContain('data-problem="connect"');
        expect(html).toMatch(/wrong PIN/);
    });

    it('while connected: names the host, who is driving, and offers Disconnect instead of Connect', () => {
        const html = render({ state: { connected: true, host: 'studio', isOwner: true, workspaceId: null, driver: 'laptop', driving: true, locked: false, lastRefusal: null, token: 'tok' }, remembered: [], onConnect: () => {}, onDisconnect: () => {} });
        expect(html).toMatch(/Driving studio/);
        expect(html).toMatch(/>Disconnect</);
        expect(html).not.toMatch(/>Connect</);
    });
});
