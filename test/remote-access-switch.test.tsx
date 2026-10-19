import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { remoteAccess } from '../src/main/remote-access.js';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { RemoteSection } from '../src/renderer/features.js';

/**
 * THIS MACHINE AS A HOST: OFF BY DEFAULT, A SWITCH, RESTART, THE FIREWALL (Tynn #820; the owner, 2026-10-19: remote
 * access "Off by default", as Genie 1 had it — `mobile.setRemoteEnabled`, `restart`, `allowFirewall`). Genie 2 started
 * the listener whenever Tailscale was present: another device on the tailnet could reach this Genie without anyone
 * having turned it on.
 */

describe('the setting', () => {
    it('remote_access exists, is the host’s, and is OFF by default', () => {
        const def = SETTINGS.find((s) => s.key === 'remote_access');
        expect(def).toMatchObject({ scope: 'host', type: 'boolean', default: false });
    });
});

describe('remoteAccess — the listener follows the switch', () => {
    function fakeListener() {
        const calls: string[] = [];
        let listening = false;
        return {
            calls,
            listener: {
                start: async () => { calls.push('start'); listening = true; },
                stop: async () => { calls.push('stop'); listening = false; },
                unavailable: () => (listening ? null : 'stopped'),
            },
        };
    }

    it('OFF: nothing is started — and turning it on starts it; off again stops it', async () => {
        const f = fakeListener();
        let enabled = false;
        const access = remoteAccess({ listener: f.listener, enabled: () => enabled, onChange: () => {} });
        await access.apply();
        expect(f.calls).toEqual([]);
        enabled = true;
        await access.apply();
        expect(f.calls).toEqual(['start']);
        enabled = false;
        await access.apply();
        expect(f.calls).toEqual(['start', 'stop']);
    });

    it('applying ON twice starts once — it does not restart a listener that is already up', async () => {
        const f = fakeListener();
        const access = remoteAccess({ listener: f.listener, enabled: () => true, onChange: () => {} });
        await access.apply();
        await access.apply();
        expect(f.calls).toEqual(['start']);
    });

    it('Restart stops and starts it while on; while off it starts nothing', async () => {
        const f = fakeListener();
        let enabled = true;
        const access = remoteAccess({ listener: f.listener, enabled: () => enabled, onChange: () => {} });
        await access.apply();
        await access.restart();
        expect(f.calls).toEqual(['start', 'stop', 'start']);
        enabled = false;
        await access.apply();
        await access.restart();
        expect(f.calls).toEqual(['start', 'stop', 'start', 'stop']);
    });
});

describe('Settings → Remote access', () => {
    const base: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], shares: [], connections: [], servedLink: null, enabled: true, firewall: true };
    const render = (remote: RemoteSection) => renderToStaticMarkup(<RemoteAccess remote={remote} workspaces={[]} onAction={() => {}} />);

    it('OFF: the switch says so, nothing is offered to pair, and it says no device can reach this Genie', () => {
        const html = render({ ...base, enabled: false, url: null, unavailable: 'stopped' });
        expect(html).toMatch(/data-remote-enabled="false"/);
        expect(html).toContain('Remote access is off');
        expect(html).not.toContain('Pair a device');
        expect(html).not.toContain('data-action="remote-restart"');
    });

    it('ON: listening, Pair a device, Restart; on Windows, Allow through Windows Firewall', () => {
        const html = render(base);
        expect(html).toMatch(/data-remote-enabled="true"/);
        expect(html).toContain('Pair a device');
        expect(html).toContain('data-action="remote-restart"');
        expect(html).toContain('data-action="remote-firewall"');
    });

    it('CONTROL: not Windows — no firewall button (there is no rule to add)', () => {
        expect(render({ ...base, firewall: false })).not.toContain('data-action="remote-firewall"');
    });
});
