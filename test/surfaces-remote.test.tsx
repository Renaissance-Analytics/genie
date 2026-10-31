import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * REMOTE ACCESS IN SETTINGS → WORKSTATION (§6.8). The PIN this screen shows, the paired devices
 * with a Revoke each, who is connected and who is driving, the lock as one button, and SHARING as a
 * roster FIRST and the minting form SECOND — a link is a credential you cannot unsend, so you see who
 * already holds one before you mint another. A just-minted URL is shown once with that said. No
 * transport yet → the section says so instead of inviting a device that cannot connect.
 */

const remote: NonNullable<FeatureData['remote']> = {
    host: 'alphar',
    url: 'wss://alphar.tailnet.invalid:7421',
    unavailable: null,
    locked: false,
    pin: { code: '482913', expiresAt: 10 },
    devices: [{ id: 'dev_1', label: 'glenn’s phone', pairedAt: 't', lastSeenAt: 't', expiresAt: 't' }],
    shares: [{ id: 'share_s', workspaceId: 'tynn', grantedTo: 'wren', expiresAt: 10, served: true, revoked: false }],
    connections: [{ id: 'conn_1', label: 'glenn’s phone', isOwner: true, workspaceId: null, driving: true }],
    servedLink: null,
    // The switch is on (Tynn #820): these describe a host that listens or tries to.
    enabled: true,
    firewall: false,
};
const render = (r: FeatureData['remote']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: r }} onAction={() => {}} onNavigate={() => {}} section="remote" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

describe('Remote access', () => {
    it('null draws a skeleton inside the section; nothing is claimed', () => {
        const html = render(null);
        expect(html).toContain('data-remote');
        expect(html).toContain('data-skeleton');
        expect(html).not.toMatch(/Pair a device/);
    });

    it('shows the PIN, the paired devices with Revoke, who is connected and driving, and the lock as one button', () => {
        const html = render(remote);
        expect(html).toMatch(/Pair a device/);
        expect(html).toContain('data-pin="482913"');
        // The QR is the PAGE a phone opens (§6.8), with the PIN in its hash — not the socket URL.
        expect(html).toContain('data-qr-value="https://alphar.tailnet.invalid:7421/mobile#pin=482913"');
        expect(html).toContain('data-device="dev_1"');
        expect(html).toMatch(/glenn’s phone/);
        expect((html.match(/>Revoke</g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(html).toContain('data-connection="conn_1"');
        expect(html).toMatch(/driving/);
        expect(html).toMatch(/>Lock</);
        expect(render({ ...remote, locked: true })).toMatch(/>Unlock</);
    });

    it('sharing: the roster comes BEFORE the mint form; a just-minted URL is shown once and said to be', () => {
        const html = render(remote);
        expect(html).toContain('data-share="share_s"');
        expect(html).toMatch(/wren/);
        expect(html).toContain('data-form="mint-share"');
        expect(html.indexOf('data-share="share_s"')).toBeLessThan(html.indexOf('data-form="mint-share"'));
        const served = render({ ...remote, servedLink: { id: 'share_new', url: 'wss://alphar.tailnet.invalid:7421/share/share_new#sekrit' } });
        expect(served).toContain('data-served-link');
        expect(served).toMatch(/share\/share_new#sekrit/);
        expect(served).toMatch(/shown once/i);
    });

    it('with no transport listening it says devices cannot connect yet and offers no PIN', () => {
        const html = render({ ...remote, url: null, pin: null });
        expect(html).toMatch(/cannot connect yet/);
        expect(html).not.toContain('data-pin=');
    });
});
