import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { ConnectRemote, RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import type { RemoteSection } from '../src/renderer/features.js';

/**
 * CONNECTING TO ANOTHER MACHINE IS FINDABLE, AND SAYS WHAT TO DO (workstation plan row M1; the owner: "I still have no
 * idea how to connect to other workstations").
 *
 * Genie 1 (v0.7.0-beta.342, renderer/pages/master.tsx `HostsButton` / `HostsPanel`) had a stacked-servers icon in the
 * title bar, beside Sites, on the LOCAL window only. It opened a list of your machines, each with Open, and an empty list
 * said what to do on the other machine. Genie 2 had buried the same thing four levels deep in Settings, and drew NOTHING
 * when Tynn listed no workstations, so "that machine is not set up" looked like "there is no such feature".
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const GUIDANCE = 'Install Genie, sign in to Tynn, and turn on Remote access on the machine you want to reach.';
const base = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {} };

describe('an empty list of your Tynn workstations says what to do on the other machine', () => {
    it('Tynn listed none: the steps, word for word — never an empty space', () => {
        const html = renderToStaticMarkup(<ConnectRemote {...base} tynnWorkstations={{ ok: true, workstations: [] }} onOpenWorkstation={() => {}} />);
        expect(html).toContain('data-tynn-workstations="empty"');
        expect(html).toContain(GUIDANCE);
    });

    it('Tynn gave a reason: its reason, AND the steps', () => {
        const html = renderToStaticMarkup(<ConnectRemote {...base} tynnWorkstations={{ ok: false, reason: 'No relay is configured' }} onOpenWorkstation={() => {}} />);
        expect(html).toContain('No relay is configured');
        expect(html).toContain(GUIDANCE);
    });

    it('CONTROL: a list with a machine in it shows the machine, not the steps', () => {
        const html = renderToStaticMarkup(
            <ConnectRemote {...base} tynnWorkstations={{ ok: true, workstations: [{ id: 'ws_a', name: 'studio', active: true, connectable: true, local: true, source: 'owner' }] }} onOpenWorkstation={() => {}} />,
        );
        expect(html).toContain('data-tynn-workstation-row="ws_a"');
        expect(html).not.toContain(GUIDANCE);
    });
});

describe('the Tynn list is the main way; host and PIN is the other one', () => {
    it('the Tynn list comes first, and the host/PIN form sits in a closed tailnet section after it', () => {
        const html = renderToStaticMarkup(<ConnectRemote {...base} tynnWorkstations={{ ok: true, workstations: [] }} onOpenWorkstation={() => {}} />);
        const tynn = html.indexOf('data-tynn-workstations=');
        const tailnet = html.indexOf('data-connect-tailnet');
        const form = html.indexOf('data-form="connect-remote"');
        expect(tynn).toBeGreaterThanOrEqual(0);
        expect(tailnet).toBeGreaterThan(tynn);
        expect(form).toBeGreaterThan(tailnet);
        expect(html).toMatch(/<details[^>]*data-connect-tailnet=""(?![^>]*\sopen)[^>]*>/);
    });

    it('a refusal from the form opens it, so the reason is never folded away', () => {
        const state = { connected: false, host: null, isOwner: false, workspaceId: null, driver: null, driving: false, locked: false, lastRefusal: 'wrong PIN', token: null };
        const html = renderToStaticMarkup(<ConnectRemote {...base} state={state} tynnWorkstations={{ ok: true, workstations: [] }} />);
        expect(html).toMatch(/<details[^>]*data-connect-tailnet=""[^>]*\sopen=""/);
    });

    it('in Settings → Remote access, "Drive another machine" comes before this machine’s pairing and devices', () => {
        const remote: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], shares: [], connections: [], servedLink: null, enabled: true, firewall: false };
        const html = renderToStaticMarkup(<RemoteAccess remote={remote} workspaces={[]} onAction={() => {}} connect={{ ...base, tynnWorkstations: { ok: true, workstations: [] } }} />);
        expect(html.indexOf('Drive another machine')).toBeGreaterThanOrEqual(0);
        expect(html.indexOf('Drive another machine')).toBeLessThan(html.indexOf('data-remote-enabled'));
        expect(html.indexOf('Drive another machine')).toBeLessThan(html.indexOf('Paired devices'));
    });
});

describe('the Remote access switch says it is how your other machines reach this one through Tynn', () => {
    const remote: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], shares: [], connections: [], servedLink: null, enabled: true, firewall: false };
    const render = (r: RemoteSection) => renderToStaticMarkup(<RemoteAccess remote={r} workspaces={[]} onAction={() => {}} />);
    const sentence = (html: string) => /data-remote-enabled="[a-z]+"[^]*?<span>([^<]*)<\/span>/.exec(html)?.[1] ?? '';

    it('ON: your other machines through Tynn, and your tailnet', () => {
        const words = sentence(render(remote));
        expect(words).toContain('Tynn');
        expect(words).toContain('tailnet');
        expect(words).toContain('alphar');
    });

    it('OFF: still names Tynn, so a person without Tailscale knows this is the switch', () => {
        const words = sentence(render({ ...remote, enabled: false, url: null, unavailable: 'stopped' }));
        expect(words).toContain('Remote access is off');
        expect(words).toContain('Tynn');
    });

    it('the setting’s own description says the same', () => {
        expect(SETTINGS.find((s) => s.key === 'remote_access')?.description).toContain('Tynn');
    });
});

describe('the title bar carries "Connect to another machine" (Genie 1’s Hosts button)', () => {
    const render = (connect?: Parameters<typeof TitleBar>[0]['connect']) =>
        renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={null} onNavigate={() => {}} onOpenPalette={() => {}} platform="generic" {...(connect ? { connect } : {})} />);

    it('an icon among the system icons, named for what it does', () => {
        const html = render({ workstations: { ok: true, workstations: [] }, onOpenWorkstation: () => {} });
        expect(html).toMatch(/data-system-icon="Connect"[^>]*aria-label="Connect to another machine"|aria-label="Connect to another machine"[^>]*data-system-icon="Connect"/);
    });

    it('CONTROL: a window that cannot connect (a host’s own window) draws no button', () => {
        expect(render()).not.toContain('data-system-icon="Connect"');
    });
});

describe('wired: the shell hands the title bar its connect, and the palette offers it', () => {
    const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
    const shell = strip(readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8'));

    it('the Command Window’s actions include it', () => {
        const actions = /const paletteActions[^=]*= \[([^]*?)\n {4}\];/.exec(app)?.[1] ?? '';
        expect(actions).toContain('CONNECT_PALETTE_ACTION');
    });

    it('the shell passes connect to the TitleBar — but not while this window shows another machine (Genie 1 hid the Hosts button in a host window)', () => {
        const bar = /<TitleBar([^]*?)\/>/.exec(shell)?.[1] ?? '';
        expect(bar).toMatch(/\bconnect=\{remote \|\| !remoteConnect \? undefined : /);
    });
});
