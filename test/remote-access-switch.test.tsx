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

    /*
     * TWO AT ONCE (Azure pair gp-11102138, beta.61): the window turned remote access on and genie-host's own setting watcher
     * applied it too, while the first start was still asking Tailscale for its cert (engine.remoteAccess took 34.6 s). Both
     * saw a listener not yet up and started one; the second bound the same port: `listen EADDRINUSE …:7421`.
     */
    function slowListener() {
        const calls: string[] = [];
        let listening = false, binding = false;
        const release: Array<() => void> = [];
        return {
            calls, release: () => { for (const r of release.splice(0)) r(); },
            listener: {
                start: async () => {
                    calls.push('start');
                    if (listening || binding) throw new Error('listen EADDRINUSE: address already in use');
                    binding = true;
                    await new Promise<void>((r) => release.push(r));
                    binding = false; listening = true;
                },
                stop: async () => { calls.push('stop'); listening = false; },
                unavailable: () => (listening ? null : 'not started'),
            },
        };
    }

    it('two applies while the first start is still in flight start it once, and both end with it listening', async () => {
        const f = slowListener();
        const access = remoteAccess({ listener: f.listener, enabled: () => true, onChange: () => {} });
        const first = access.apply(), second = access.apply();
        await new Promise((r) => setTimeout(r, 10));
        f.release();
        await expect(Promise.all([first, second])).resolves.toBeDefined();
        expect(f.calls).toEqual(['start']);
        expect(f.listener.unavailable()).toBeNull();
    });

    it('a Restart while a start is in flight waits for it, then stops and starts once each', async () => {
        const f = slowListener();
        const access = remoteAccess({ listener: f.listener, enabled: () => true, onChange: () => {} });
        const first = access.apply();
        const restart = access.restart();
        await new Promise((r) => setTimeout(r, 10));
        f.release();
        await new Promise((r) => setTimeout(r, 10));
        f.release();
        await Promise.all([first, restart]);
        expect(f.calls).toEqual(['start', 'stop', 'start']);
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
    const base: RemoteSection = { host: 'alphar', url: 'wss://alphar.tail.ts.net:7421/genie', unavailable: null, locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: true };
    const render = (remote: RemoteSection) => renderToStaticMarkup(<RemoteAccess remote={remote} workspaces={[]} onAction={() => {}} />);

    /*
     * CONNECTED TO A DRONE (Azure pair gp-11102252): the window draws the Drone's Remote access, whose role is `drone`, and
     * "Drive another machine" was hidden by THAT role, so the Pilot had no Disconnect and no remembered hosts.
     */
    it('connected to a drone: Disconnect and the remembered hosts are still there', () => {
        const connect = { state: { connected: true, host: 'drone', isOwner: true, workspaceId: null, driver: 'pilot', driving: true, locked: false, lastRefusal: null, needsBaton: false } as never, remembered: [], onConnect: () => {}, onDisconnect: () => {}, known: [{ url: 'wss://drone:7421/genie', name: 'drone', lastConnectedAt: 1 }] as never };
        const html = renderToStaticMarkup(<RemoteAccess remote={{ ...base, tynnWorkstation: { role: 'drone' } as never }} workspaces={[]} onAction={() => {}} connect={connect as never} />);
        expect(html).toContain('data-remote-connected');
        expect(html).toMatch(/>Disconnect</);
    });

    /*
     * A DRONE WITH NO WINDOW OPEN (Azure pair gp-11102335, beta.61): it answers no feature snapshot, so the page it draws has
     * no Remote access section yet (`remote: null`, the skeleton). "Drive another machine" is this window's, not the
     * host's: it was inside the skeleton's gate, so for 150 s the Pilot drove the Drone with no Disconnect.
     */
    it('connected to a host that has sent no Remote access yet: Disconnect is there, beside its skeleton', () => {
        const connect = { state: { connected: true, host: 'drone', isOwner: true, workspaceId: null, driver: 'pilot', driving: true, locked: false, lastRefusal: null, needsBaton: false } as never, remembered: [], onConnect: () => {}, onDisconnect: () => {} };
        const html = renderToStaticMarkup(<RemoteAccess remote={null} workspaces={[]} onAction={() => {}} connect={connect as never} />);
        expect(html).toContain('data-remote-connected');
        expect(html).toMatch(/>Disconnect</);
    });

    it('connected and the host has sent no Remote access: it says so, in words, naming the host, never an endless skeleton', () => {
        const connect = { state: { connected: true, host: 'drone', isOwner: true, workspaceId: null, driver: 'pilot', driving: true, locked: false, lastRefusal: null, needsBaton: false } as never, remembered: [], onConnect: () => {}, onDisconnect: () => {} };
        const html = renderToStaticMarkup(<RemoteAccess remote={null} workspaces={[]} onAction={() => {}} connect={connect as never} />);
        expect(html).toContain('Open Genie on drone to see its settings');
        expect(html).not.toContain('data-skeleton');
    });

    it('once the host\'s Remote access arrives, the words go', () => {
        const connect = { state: { connected: true, host: 'drone', isOwner: true, workspaceId: null, driver: 'pilot', driving: true, locked: false, lastRefusal: null, needsBaton: false } as never, remembered: [], onConnect: () => {}, onDisconnect: () => {} };
        const html = renderToStaticMarkup(<RemoteAccess remote={base} workspaces={[]} onAction={() => {}} connect={connect as never} />);
        expect(html).not.toContain('to see its settings');
        expect(html).toContain('data-remote-connected');
    });

    it('CONTROL: not connected and nothing read yet, there is only the skeleton', () => {
        const connect = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {} };
        const html = renderToStaticMarkup(<RemoteAccess remote={null} workspaces={[]} onAction={() => {}} connect={connect as never} />);
        expect(html).not.toContain('data-drive-another');
    });

    it('CONTROL: not connected, a drone is still offered no way out', () => {
        const connect = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {} };
        const html = renderToStaticMarkup(<RemoteAccess remote={{ ...base, tynnWorkstation: { role: 'drone' } as never }} workspaces={[]} onAction={() => {}} connect={connect as never} />);
        expect(html).not.toContain('data-drive-another');
    });

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
