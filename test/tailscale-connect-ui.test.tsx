import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { RemoteSection } from '../src/renderer/features.js';
import type { TailscaleStatus } from '../src/main/tailscale-cli.js';
import { control } from './helpers/control-markup.js';

/**
 * TAILSCALE FROM GENIE (Tynn #821; Genie 1's tailscale.status / install / up + openAuth). Remote access runs over the
 * tailnet, so Settings → Remote access says where Tailscale stands — absent, stopped, needs sign-in, running — and offers
 * the one action that moves it on: Install, Connect (which asks Tailscale for a fresh sign-in link and opens it). Running, it names this
 * machine on the tailnet and counts its peers.
 */
const base: RemoteSection = { host: 'alphar', url: null, unavailable: 'Tailscale is not installed', locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: false };
const ts = (over: Partial<TailscaleStatus>): TailscaleStatus => ({ installed: true, running: false, state: 'needs-login', self: null, peers: [], remedy: null, ...over });
const render = (tailscale: TailscaleStatus | null) => renderToStaticMarkup(<RemoteAccess remote={{ ...base, tailscale }} workspaces={[]} onAction={() => {}} />);

describe('Settings → Remote access → Tailscale', () => {
    it('absent: says so and offers Install — nothing else', () => {
        const html = render(ts({ installed: false, state: 'absent', remedy: { message: 'Tailscale is not installed.' } }));
        expect(html).toMatch(/data-tailscale="absent"/);
        expect(html).toContain('data-action="tailscale-install"');
        expect(html).not.toContain('data-action="tailscale-up"');
    });

    it('needs sign-in: Connect, which asks Tailscale for a fresh link; never a kept link to open (Tynn #675)', () => {
        expect(render(ts({ state: 'needs-login' }))).toContain('data-action="tailscale-up"');
        // A status that still carries the daemon's last link (it may be long expired) offers no way to open it.
        const stale = render(ts({ state: 'needs-login', authUrl: 'https://login.tailscale.com/a/expired0000' } as Partial<TailscaleStatus>));
        expect(stale).toContain('data-action="tailscale-up"');
        expect(stale).not.toContain('data-action="tailscale-signin"');
        expect(stale).not.toContain('login.tailscale.com');
    });

    it('stopped (or needs an operator): the remedy, with its exact command', () => {
        const html = render(ts({ state: 'stopped', remedy: { message: 'The Tailscale service is not running.', command: 'sudo systemctl enable --now tailscaled' } }));
        expect(html).toContain('The Tailscale service is not running.');
        expect(html).toContain('sudo systemctl enable --now tailscaled');
    });

    it('running: this machine on the tailnet and its peers (COUNTED); no install, no connect', () => {
        const html = render(ts({ state: 'running', running: true, self: { ip: '100.64.0.7', hostname: 'alphar', online: true, dnsName: 'alphar.tail1234.ts.net' }, peers: [{ hostname: 'studio' }, { hostname: 'beast' }] as never }));
        expect(html).toMatch(/data-tailscale="running"[\s\S]*?alphar\.tail1234\.ts\.net/);
        expect(html).toContain('2 devices on your tailnet');
        expect(html).not.toContain('data-action="tailscale-install"');
        expect(html).not.toContain('data-action="tailscale-up"');
    });

    it('CONTROL: status not read yet — no Tailscale row claims anything', () => {
        expect(render(null)).not.toContain('data-tailscale=');
    });
});
