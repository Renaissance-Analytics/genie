import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectRemote, SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * "DRIVE ANOTHER MACHINE" (§6.8) — the client side: a host, a PIN (or a token this device remembers), a label for this
 * screen; while connected, who you are driving and a Disconnect. A refusal from the host is shown where it was caused.
 *
 * WHERE IT LIVES (Tynn #640): the title bar's host picker, Other ways… → a dialog that draws `ConnectRemote` (App.tsx
 * `other={<ConnectRemote …/>}`, test/remote-settings-own-only.test.tsx). It used to be drawn in Settings → Remote access;
 * that page now holds this machine's own settings only, so it draws the form for nobody, given the prop or not.
 */

const remote = { host: 'alphar', url: null, unavailable: 'not started', locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: false };
type Connect = Parameters<typeof ConnectRemote>[0];
const settings = (connect: Parameters<typeof SettingsSurface>[0]['remoteConnect']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote }} onAction={() => {}} onNavigate={() => {}} section="remote" remoteConnect={connect} />);
/** What the host picker's dialog draws. */
const render = (connect: Connect) => renderToStaticMarkup(<ConnectRemote {...connect} />);

describe('Drive another machine', () => {
    it('is not in Settings → Remote access, with or without the prop; the form has host, PIN and label fields and a Connect', () => {
        const props: Connect = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {} };
        expect(settings(undefined)).not.toContain('data-form="connect-remote"');
        expect(settings(props)).not.toContain('data-form="connect-remote"');
        // CONTROL: the page itself is drawn (its own switch), so the absence above is of the form, not of the page.
        expect(settings(props)).toContain('data-remote-enabled');
        const html = render(props);
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
