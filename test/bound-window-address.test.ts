import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AddressContext } from '../src/core/address.js';
import { parseRoute } from '../src/core/route.js';
import { takeOverRouteOf, takeOverTerminalOf } from '../src/core/take-over-route.js';
import * as windowAddress from '../src/renderer/window-address.js';

/*
 * A TAKE OVER WINDOW FOR ANOTHER MACHINE OPENS ITS TERMINAL, NOT THAT MACHINE'S DASHBOARD (Tynn #529 part A; the release
 * pair run at 19bc065e, gp-11082051-0e98c5, check 3). The Pilot opened its Take Over window on `#genie://takeover/term_…`
 * bound to the drone. Before it was connected, the window read THIS machine's (the Pilot's) snapshot through its own
 * bridge, so its address was rewritten to `#genie://<pilot>/takeover/term_…`. Once connected to the drone, that address
 * named a machine the drone is not, `routeOfAddress` read it as nothing, and the window fell back to the Dashboard:
 * "genie://gpd0e98c5/dashboard", "nobody is driving", never attached. A window bound to another host reads that host's
 * Genie or nothing of this machine's — its address, too.
 */
const { windowBridge, routeFor, rewrittenAddress } = windowAddress as unknown as {
    windowBridge<B>(input: { bound: string | null; connected: boolean; remote: B | null; local: B | undefined }): B | undefined;
    routeFor(address: string, ctx: AddressContext | null): string;
    rewrittenAddress(address: string, ctx: AddressContext | null, before?: string | null): string | null;
};

const pilot: AddressContext = { workstation: 'gpp0e98c5', workspaces: [{ id: 'ws_p', name: 'pilot-work', path: '/p' }], agents: [] };
const drone: AddressContext = { workstation: 'gpd0e98c5', workspaces: [{ id: 'ws_d', name: 'genie-b601', path: '/d' }], agents: [] };
const LOCAL = { ctx: pilot } as const;
const REMOTE = { ctx: drone } as const;

/**
 * The window as App runs it: the bridge it reads (windowBridge), the address context from that bridge's snapshot, the route
 * (routeFor), and the rewrite of its hash (rewrittenAddress) — a phase at a time, before and after it connects.
 */
function simulate(bound: string | null, hash: string, phases: Array<{ connected: boolean }>): { hash: string; route: string } {
    let address = hash.replace(/^#/, '');
    let route = '';
    // The workstation this window read last: where its address may come FROM when it now reads another.
    let before: string | null = null;
    for (const phase of phases) {
        // Each phase settles: the rewrite (an effect) runs, and the route is read again from the rewritten address.
        for (let i = 0; i < 3; i += 1) {
            const bridge = windowBridge({ bound, connected: phase.connected, remote: phase.connected ? REMOTE : null, local: LOCAL });
            const ctx = bridge ? bridge.ctx : null;
            route = routeFor(address, ctx);
            const next = rewrittenAddress(address, ctx, before);
            if (next !== null) address = next;
        }
        const read = windowBridge({ bound, connected: phase.connected, remote: phase.connected ? REMOTE : null, local: LOCAL });
        if (read) before = read.ctx.workstation;
    }
    return { hash: `#${address}`, route };
}

describe('a Take Over window bound to another host', () => {
    const terminal = 'term_512762fc-f83f-4305-a77c-3337117f88c8';
    const opened = `#${takeOverRouteOf(terminal)}`;

    it('opened by the Pilot, connected to the drone: its view is the Take Over view on that terminal, its hash the drone\'s', () => {
        const end = simulate('wss://gp-0e98c5-drone.example:7421/genie', opened, [{ connected: false }, { connected: true }]);
        expect(parseRoute(end.route)).toMatchObject({ surface: 'takeover', terminalId: terminal });
        expect(end.hash).toBe(`#genie://gpd0e98c5/takeover/${terminal}`);
        expect(takeOverTerminalOf(end.hash)).toBe(terminal);
    });

    it('before it connects it reads nothing of this machine: no bridge, the address left as main opened it', () => {
        expect(windowBridge({ bound: 'wss://drone', connected: false, remote: null, local: LOCAL })).toBeUndefined();
        const before = simulate('wss://drone', opened, [{ connected: false }]);
        expect(before.hash).toBe(opened);
        expect(parseRoute(before.route)).toMatchObject({ surface: 'takeover', terminalId: terminal });
    });

    it('CONTROL: a window that is not bound reads this machine, and its address is this machine\'s', () => {
        expect(windowBridge({ bound: null, connected: false, remote: null, local: LOCAL })).toBe(LOCAL);
        const own = simulate(null, opened, [{ connected: false }]);
        expect(own.hash).toBe(`#genie://gpp0e98c5/takeover/${terminal}`);
        expect(parseRoute(own.route)).toMatchObject({ surface: 'takeover', terminalId: terminal });
    });

    it('CONTROL: once connected, a bound window reads its host', () => {
        expect(windowBridge({ bound: 'wss://drone', connected: true, remote: REMOTE, local: LOCAL })).toBe(REMOTE);
    });

    it('App decides its bridge, its route and its rewrite with these, and with nothing else', () => {
        const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
        const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
        expect(app).toMatch(/const resolvedBridge = windowBridge\(\{ bound: remote\.bound, connected: remote\.state\?\.connected === true,/);
        expect(app).toMatch(/const route = routeFor\(address, addressContext\);/);
        expect(app).toMatch(/const next = rewrittenAddress\(address, addressContext, readBefore\.current\);/);
    });
});

/*
 * A PILOT'S OWN WINDOW CONNECTING IN PLACE (beta.61 blocker step four, Azure pair gp-11110111-a378e7): Settings → Remote
 * access, Connect. Connected, the window reads the Drone, but its hash still named the Pilot
 * (`#genie://gppa378e7/settings/remote`): the Drone read that as nothing and showed its Dashboard, so Settings → Remote
 * access, and its Disconnect, were never drawn. Its page goes with it to the host it now drives, as it comes back on leaving.
 */
describe('a Pilot\'s own window connecting in place', () => {
    it('on Settings, Remote access: connected, the same page on the Drone, at the Drone\'s address', () => {
        const end = simulate(null, '#genie://gpp0e98c5/settings/remote', [{ connected: false }, { connected: true }]);
        expect(parseRoute(end.route)).toMatchObject({ surface: 'settings', section: 'remote' });
        expect(end.hash).toBe('#genie://gpd0e98c5/settings/remote');
    });

    it('CONTROL: not connected, it stays this machine\'s', () => {
        const own = simulate(null, '#genie://gpp0e98c5/settings/remote', [{ connected: false }]);
        expect(own.hash).toBe('#genie://gpp0e98c5/settings/remote');
        expect(parseRoute(own.route)).toMatchObject({ surface: 'settings', section: 'remote' });
    });

    it('CONTROL: an address of a workstation it reads neither before nor after is not moved', () => {
        expect(rewrittenAddress('genie://somewhere-else/settings/remote', drone, 'gpp0e98c5')).toBeNull();
    });
});
