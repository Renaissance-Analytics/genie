import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RemoteSection } from '../src/renderer/features.js';
import { ConnectDialog, ConnectMenu } from '../src/renderer/components/ConnectMenu.js';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * SETTINGS → REMOTE ACCESS IS THIS MACHINE'S OWN (Tynn #640; the owner, a host window on beta.61: "why does the remote
 * access settings page show any connection to other machines at all … that is for settings on the host I am connected
 * to"). Connecting to other machines lives in the title bar's host picker alone (Genie 1's HostsButton: a local window
 * only); the page holds the remote-access settings of this machine, or of the host this window drives. Disconnect is the
 * host badge's, in the title bar.
 */
const base: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: false } as RemoteSection;
const connected = { connected: true, host: 'studio', isOwner: true, workspaceId: null, driver: 'pilot', driving: true, locked: false, lastRefusal: null, needsBaton: false } as never;
const connectFor = (state: unknown) => ({ state, remembered: ['wss://studio.tail.ts.net:7421/genie'], onConnect: () => {}, onDisconnect: () => {}, tynnWorkstations: { ok: true, workstations: [{ id: 'ws_b', name: 'studio', active: true, connected: true, role: 'drone' }] }, onOpenWorkstation: () => {}, onUpgradeHost: () => {} }) as never;
const page = (remote: RemoteSection | null, connect: unknown) => renderToStaticMarkup(<RemoteAccess remote={remote} workspaces={[]} onAction={() => {}} connect={connect as never} />);
const others = (html: string) => {
    expect(html).not.toContain('data-drive-another');
    expect(html).not.toMatch(/Drive another machine/i);
    expect(html).not.toContain('data-remote-connected');
    expect(html).not.toContain('data-connect-tailnet');
    expect(html).not.toMatch(/Your Tynn workstations/);
};

describe('the page holds only the remote settings of the machine it shows', () => {
    it('a local window (a pilot): this machine’s own switch, and no way to other machines', () => {
        const html = page({ ...base, tynnWorkstation: { registered: true, host: 'https://tynn.ai', workstationId: 'ws_a', role: 'pilot' } as never }, connectFor(null));
        others(html);
        expect(html).toContain('data-remote-enabled');
    });

    it('a host window: the host’s own settings, nothing to drive another machine, and Upgrade for its owner', () => {
        const html = page({ ...base, host: 'studio' }, connectFor(connected));
        others(html);
        expect(html).toContain('data-remote-enabled');
        expect(html).toMatch(/data-action="upgrade-host"[^>]*>(?:<[^>]+>)*Upgrade studio/);
    });

    it('a host window whose host has sent no settings yet: says so, still nothing about other machines', () => {
        const html = page(null, connectFor(connected));
        others(html);
        expect(html).toContain('Open Genie on studio to see its settings');
    });

    it('a drone: its own settings, and no way out', () => {
        const html = page({ ...base, tynnWorkstation: { registered: true, host: 'https://tynn.ai', workstationId: 'ws_b', role: 'drone' } as never }, connectFor(null));
        others(html);
        expect(html).toContain('data-remote-enabled');
    });
});

describe('Disconnect is the host badge’s, in the title bar', () => {
    const bar = (remote: Record<string, unknown>) => renderToStaticMarkup(<TitleBar route="genie://studio/dashboard" workstation={null} remote={{ host: 'studio', driver: 'pilot', driving: true, locked: false, ...remote } as never} onNavigate={() => {}} onOpenPalette={() => {}} platform="generic" />);

    it('a host window: Disconnect beside the host’s name', () => {
        expect(bar({ onDisconnect: () => {} })).toMatch(/data-remote-badge[\s\S]*data-action="disconnect-host"[^>]*>(?:<[^>]+>)*Disconnect/);
    });

    it('CONTROL: a window that cannot disconnect shows no button', () => {
        expect(bar({})).not.toContain('disconnect-host');
    });
});

describe('the host picker holds every way to another machine', () => {
    it('the menu’s other ways open a dialog, not the settings page', () => {
        const html = renderToStaticMarkup(<ConnectMenu workstations={null} onOpenWorkstation={() => {}} onOpenSurface={() => {}} onOpenLink={() => {}} />);
        expect(html).toMatch(/data-action="open-connect-surface"[^>]*>(?:<[^>]+>)*Other ways/);
        expect(html).not.toMatch(/>Remote access</);
    });

    it('that dialog shows what it is given: the host and PIN form, your machines, the ones remembered', () => {
        const html = renderToStaticMarkup(<ConnectDialog mode="other" onClose={() => {}} workstations={null} onOpenSurface={() => {}} onSwitch={() => {}} other={<p data-other-ways="">form</p>} />);
        expect(html).toContain('Connect to another machine');
        expect(html).toContain('data-other-ways=""');
    });

    it('the window wires it: the picker and the Command Window open that dialog; nothing navigates to the settings page to connect', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/onOpenSurface=\{\(\) => setConnectDialog\('other'\)\}/);
        expect(app).toMatch(/other=\{<ConnectRemote /);
        expect(app).toMatch(/onOpenConnectOther=\{\(\) => setConnectDialog\('other'\)\}/);
        expect(app).toMatch(/onDisconnect: remote\.disconnect,/);
        expect(app).not.toMatch(/navigate\(CONNECT_ROUTE\)/);
        expect(readFileSync('src/renderer/components/TitleBar.tsx', 'utf8')).not.toMatch(/onNavigate\(CONNECT_ROUTE\)/);
        // Still only in a local window, never on a drone (Genie 1 hid it in a host window).
        expect(readFileSync('src/renderer/Shell.tsx', 'utf8')).toMatch(/connect=\{remote \|\| !remoteConnect \|\| !mayBrowse\(/);
    });
});
