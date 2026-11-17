// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MAGICDNS_SETTINGS, TAILSCALE_APP_STORE, TAILSCALE_GOOGLE_PLAY, offerKeep, phoneAddress, phonePlatform } from '../src/core/pairing-guide.js';
import { parseTailscaleStatus } from '../src/core/tailscale.js';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import { MobileShell } from '../src/renderer/components/MobileShell.js';
import type { FeatureAction, RemoteSection } from '../src/renderer/features.js';

/**
 * PAIRING A PHONE, AS THE CLIENT CALL WENT (Tynn #750, #752). Pair a device showed a PIN at once; the phone then turned
 * out to need the Tailscale app, signed in to the same account, and nothing on the screen said so or where to get it.
 * After pairing, nothing gave the phone an address to come back to: the person bookmarked a raw Tailscale IP by hand and
 * mistyped it twice. Now the first pairing shows the two store QRs first; the desktop shows the page the phone keeps, by
 * its MagicDNS name (and says when the tailnet has none); and the phone, once paired, is shown how to keep it.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const base: RemoteSection = {
    host: 'alphar', url: 'ws://alphar.tailnet.invalid:7421/genie', unavailable: null, locked: false,
    pin: null, devices: [], connections: [], enabled: true, firewall: false,
};
const paired = { id: 'dev_1', label: 'phone', pairedAt: 't', lastSeenAt: 't', expiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString() };
const html = (remote: RemoteSection) => renderToStaticMarkup(<RemoteAccess remote={remote} workspaces={[]} onAction={() => {}} />);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });
function mount(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(node));
    return host;
}
const click = (el: HTMLElement, selector: string) => act(() => (el.querySelector(selector) as HTMLElement).click());

describe('the address a phone keeps (#752)', () => {
    it('phoneAddress: the page on the listener’s port by its name; an IP is said to be no name; nothing listening is null', () => {
        expect(phoneAddress('ws://alphar.tail1234.ts.net:7421/genie')).toEqual({ url: 'http://alphar.tail1234.ts.net:7421/mobile', named: true });
        expect(phoneAddress('wss://alphar.tail1234.ts.net:7421/genie')).toEqual({ url: 'https://alphar.tail1234.ts.net:7421/mobile', named: true });
        expect(phoneAddress('ws://100.101.102.103:7421/genie')).toEqual({ url: 'http://100.101.102.103:7421/mobile', named: false });
        expect(phoneAddress(null)).toBeNull();
    });

    it('MagicDNS off on the tailnet: the listener addresses itself by its IP, since its name would not resolve on the phone', () => {
        const status = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'alphar.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103'] }, CurrentTailnet: { MagicDNSEnabled: false, MagicDNSSuffix: 'tail1234.ts.net' } }));
        expect(status).toEqual({ ok: true, ip: '100.101.102.103', dnsName: '100.101.102.103' });
    });

    it('CONTROL: MagicDNS on (or not reported, an older Tailscale), the name stands', () => {
        const self = { DNSName: 'alphar.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103'] };
        expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: self, CurrentTailnet: { MagicDNSEnabled: true } }))).toEqual({ ok: true, ip: '100.101.102.103', dnsName: 'alphar.tail1234.ts.net' });
        expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: self }))).toEqual({ ok: true, ip: '100.101.102.103', dnsName: 'alphar.tail1234.ts.net' });
    });

    it('Settings shows the page the phone opens, by name, not the socket URL', () => {
        const out = html(base);
        expect(out).toContain('data-phone-address="http://alphar.tailnet.invalid:7421/mobile"');
        expect(out).not.toContain('ws://alphar.tailnet.invalid:7421/genie');
    });

    it('listening by IP only, Settings says to turn MagicDNS on, and links Tailscale’s DNS page', () => {
        const out = html({ ...base, url: 'ws://100.101.102.103:7421/genie' });
        expect(out).toContain('data-magicdns="off"');
        expect(out).toContain(`href="${MAGICDNS_SETTINGS}"`);
    });

    it('CONTROL: listening by name, no MagicDNS nudge', () => {
        expect(html(base)).not.toContain('data-magicdns');
    });
});

describe('the phone’s app first (#750)', () => {
    it('no device paired yet: Pair a device shows the Tailscale app step first (both stores, same account, on both), and Next asks for the PIN', () => {
        const actions: FeatureAction[] = [];
        const el = mount(<RemoteAccess remote={base} workspaces={[]} onAction={(a) => actions.push(a)} />);
        click(el, '[data-action="pair-device"]');
        expect(actions).toEqual([]);
        const step = el.querySelector('[data-pair-step="app"]');
        expect(step).not.toBeNull();
        expect(step!.querySelector(`[data-qr-value="${TAILSCALE_APP_STORE}"]`)).not.toBeNull();
        expect(step!.querySelector(`[data-qr-value="${TAILSCALE_GOOGLE_PLAY}"]`)).not.toBeNull();
        expect(step!.querySelector(`a[href="${TAILSCALE_APP_STORE}"]`)).not.toBeNull();
        expect(step!.querySelector(`a[href="${TAILSCALE_GOOGLE_PLAY}"]`)).not.toBeNull();
        expect(step!.textContent).toMatch(/same Tailscale account/i);
        click(el, '[data-action="pair-next"]');
        expect(actions).toEqual([{ kind: 'remote.issuePin' }]);
    });

    it('CONTROL: a device already paired, Pair a device asks for the PIN at once (no extra click for someone who has done it)', () => {
        const actions: FeatureAction[] = [];
        const el = mount(<RemoteAccess remote={{ ...base, devices: [paired] }} workspaces={[]} onAction={(a) => actions.push(a)} />);
        click(el, '[data-action="pair-device"]');
        expect(actions).toEqual([{ kind: 'remote.issuePin' }]);
    });

    it('while a PIN shows, the store links are beside it, for a phone still without the app', () => {
        const out = html({ ...base, devices: [paired], pin: { code: '482913', expiresAt: Date.now() + 120_000 } });
        expect(out).toContain(`href="${TAILSCALE_APP_STORE}"`);
        expect(out).toContain(`href="${TAILSCALE_GOOGLE_PLAY}"`);
    });
});

describe('the phone keeps Genie (#752)', () => {
    it('phonePlatform reads the browser: iPhone, Android, anything else', () => {
        expect(phonePlatform(IPHONE)).toBe('ios');
        expect(phonePlatform(ANDROID)).toBe('android');
        expect(phonePlatform(DESKTOP)).toBe('other');
    });

    it('offerKeep: once, after a PIN pairing; never on a token redial, from the home screen, or after Done', () => {
        expect(offerKeep({ pairedWithPin: true, standalone: false, dismissed: false })).toBe(true);
        expect(offerKeep({ pairedWithPin: false, standalone: false, dismissed: false })).toBe(false);
        expect(offerKeep({ pairedWithPin: true, standalone: true, dismissed: false })).toBe(false);
        expect(offerKeep({ pairedWithPin: true, standalone: false, dismissed: true })).toBe(false);
    });

    const shell = (keep: Parameters<typeof MobileShell>[0]['keep']) => (
        <MobileShell host="alphar" locked={false} refusal={null} items={[]} answering={null} onAnswer={() => {}} onDisconnect={() => {}} keep={keep} />
    );

    it('on an iPhone, the card gives the address and Safari’s Share, then Add to Home Screen, and says Tailscale stays on on both', () => {
        const out = renderToStaticMarkup(shell({ address: 'http://alphar.tail1234.ts.net:7421/mobile', platform: 'ios', onDone: () => {} }));
        expect(out).toContain('data-mobile-keep');
        expect(out).toContain('http://alphar.tail1234.ts.net:7421/mobile');
        expect(out).toMatch(/Share/);
        expect(out).toMatch(/Add to Home Screen/);
        expect(out).toMatch(/Tailscale on/i);
    });

    it('on Android, the browser menu’s Add to Home screen', () => {
        const out = renderToStaticMarkup(shell({ address: 'http://alphar.tail1234.ts.net:7421/mobile', platform: 'android', onDone: () => {} }));
        expect(out).toContain('data-mobile-keep');
        expect(out).toMatch(/Add to Home screen|Install app/);
        expect(out).not.toMatch(/Share, then/);
    });

    it('Done puts it away', () => {
        let done = 0;
        const el = mount(shell({ address: 'http://alphar.tail1234.ts.net:7421/mobile', platform: 'ios', onDone: () => { done += 1; } }));
        click(el, '[data-action="keep-done"]');
        expect(done).toBe(1);
    });

    it('CONTROL: no keep, no card', () => {
        expect(renderToStaticMarkup(shell(null))).not.toContain('data-mobile-keep');
    });
});
