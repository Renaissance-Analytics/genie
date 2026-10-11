import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * PAIRING FOR PHONES (§6.8): the PIN panel also draws a QR code (Fancy's `QrCode`, SVG) carrying the
 * host URL and the PIN together, so a phone scans once instead of typing a MagicDNS name. The value
 * stays beside it as text — a code is an image of a value, not the value. When nothing listens, the
 * panel says WHY in the listener's own words, not just that devices cannot connect.
 */

const remote: NonNullable<FeatureData['remote']> = {
    host: 'alphar',
    url: 'ws://alphar.tailnet.invalid:7421/genie',
    unavailable: null,
    locked: false,
    pin: { code: '482913', expiresAt: Date.now() + 120_000 },
    devices: [],
    shares: [],
    connections: [],
    servedLink: null,
};
const render = (r: FeatureData['remote']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: r }} onAction={() => {}} onNavigate={() => {}} group="workstation" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

describe('pairing QR', () => {
    it('with a PIN the panel draws an SVG QR carrying the PAGE a phone opens (§6.8) and the PIN, labelled for the destination, value beside it as text', () => {
        const html = render(remote);
        expect(html).toContain('data-pairing-qr');
        // The socket URL is nothing a phone can scan into; the page URL on the same port is, and it dials the socket itself.
        expect(html).toContain('data-qr-value="http://alphar.tailnet.invalid:7421/mobile#pin=482913"');
        expect(html).toMatch(/<svg[^>]*>/);
        expect(html).toMatch(/Pair this device/);
        expect(html).toContain('data-pin="482913"');
    });

    it('without a PIN there is no QR at all', () => {
        expect(render({ ...remote, pin: null })).not.toContain('data-pairing-qr');
    });

    it('when nothing listens the reason is shown in the listener’s own words', () => {
        const html = render({ ...remote, url: null, pin: null, unavailable: 'Tailscale is not running (BackendState Stopped)' });
        expect(html).toMatch(/cannot connect/);
        expect(html).toMatch(/Tailscale is not running \(BackendState Stopped\)/);
        expect(html).not.toContain('data-pairing-qr');
    });
});
