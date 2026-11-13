import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { FirewallRuleView } from '../src/renderer/features.js';

/**
 * THE FIREWALL RULE'S STATE REACHES THE ROW, AND EACH ACTION READS WINDOWS AGAIN (Tynn #685). The snapshot carries main's
 * reading of Genie's rule (`remote.firewallRule`); Allow and Remove each go through the port's elevation, then read the
 * rule again, so the row shows what Windows now has, never what the action hoped for. Failures say why in words.
 */
const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const PRESENT: FirewallRuleView = {
    state: 'present', port: 7421, covers: true,
    rules: [{ fields: [{ label: 'LocalPort', value: '7421' }], enabled: true, inbound: true, allow: true, protocol: 'TCP', localPort: '7421', remoteIp: '100.64.0.0/255.192.0.0', profiles: 'Domain,Private,Public' }],
};

/** A Windows firewall that answers as told, and records what was asked of it, in order. */
function fakeFirewall(opts: { initial: FirewallRuleView | null; afterAllow?: FirewallRuleView; afterRemove?: FirewallRuleView; allow?: { ok: boolean; cancelled?: boolean; error?: string }; remove?: { ok: boolean; cancelled?: boolean; error?: string } }) {
    const calls: string[] = [];
    let now = opts.initial;
    let pending: FirewallRuleView | null = null;
    const port: NonNullable<FeaturePorts['firewall']> = {
        rule: () => now,
        refresh: async () => { calls.push('refresh'); if (pending) now = pending; },
        reread: async () => { calls.push('reread'); },
        allow: async () => { calls.push('allow'); pending = opts.afterAllow ?? now; return opts.allow ?? { ok: true }; },
        remove: async () => { calls.push('remove'); pending = opts.afterRemove ?? now; return opts.remove ?? { ok: true }; },
    };
    return { port, calls };
}

let dir: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-firewall-685-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, hostName: 'alphar', remoteTransport: { onConnection: () => () => {} } });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('the snapshot', () => {
    it('carries main’s reading of the rule, and says this machine has a firewall to manage', async () => {
        const fw = fakeFirewall({ initial: PRESENT });
        const snap = await featureSnapshot(services, state(), { firewall: fw.port });
        expect(snap.remote!.firewall).toBe(true);
        expect(snap.remote!.firewallRule).toEqual(PRESENT);
    });

    it('CONTROL: no firewall port (not Windows): no firewall, no reading', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.remote!.firewall).toBe(false);
        expect(snap.remote!.firewallRule).toBeNull();
    });
});

describe('Allow', () => {
    it('elevates, THEN reads Windows again: the answer carries the new reading', async () => {
        const fw = fakeFirewall({ initial: { state: 'absent' }, afterAllow: PRESENT });
        const snap = await handleFeatureAction(services, { kind: 'remote.allowFirewall' }, state(), { firewall: fw.port });
        expect(fw.calls).toEqual(['allow', 'refresh']);
        expect(snap.remote!.firewallRule).toEqual(PRESENT);
        expect(snap.remote!.firewallOutcome).toBe('Allowed: devices on your tailnet can reach this port.');
    });
});

describe('Remove', () => {
    it('elevates, THEN reads Windows again: the row shows the rule gone', async () => {
        const fw = fakeFirewall({ initial: PRESENT, afterRemove: { state: 'absent' } });
        const snap = await handleFeatureAction(services, { kind: 'remote.removeFirewall' }, state(), { firewall: fw.port });
        expect(fw.calls).toEqual(['remove', 'refresh']);
        expect(snap.remote!.firewallRule).toEqual({ state: 'absent' });
        expect(snap.remote!.firewallOutcome).toBe('Removed: Windows Firewall no longer lets devices on your tailnet reach this port.');
    });

    it('declined at the Windows prompt: says nothing changed, and still reads Windows again', async () => {
        const fw = fakeFirewall({ initial: PRESENT, remove: { ok: false, cancelled: true } });
        const snap = await handleFeatureAction(services, { kind: 'remote.removeFirewall' }, state(), { firewall: fw.port });
        expect(fw.calls).toEqual(['remove', 'refresh']);
        expect(snap.remote!.firewallOutcome).toBe('Cancelled: Windows asked, and nothing was changed.');
        expect(snap.remote!.firewallRule).toEqual(PRESENT);
    });

    it('failed: the reason in words, and the row shows what Windows still has', async () => {
        const fw = fakeFirewall({ initial: PRESENT, remove: { ok: false, error: 'Windows Firewall did not remove the rule (netsh exit 5).' } });
        const snap = await handleFeatureAction(services, { kind: 'remote.removeFirewall' }, state(), { firewall: fw.port });
        expect(snap.remote!.firewallOutcome).toBe('Windows Firewall did not remove the rule (netsh exit 5).');
        expect(snap.remote!.firewallRule).toEqual(PRESENT);
    });

    it('failed because there was nothing to remove (someone removed it first): says that, not "failed"', async () => {
        const fw = fakeFirewall({ initial: PRESENT, afterRemove: { state: 'absent' }, remove: { ok: false, error: 'Windows Firewall did not remove the rule (netsh exit 1).' } });
        const snap = await handleFeatureAction(services, { kind: 'remote.removeFirewall' }, state(), { firewall: fw.port });
        expect(snap.remote!.firewallOutcome).toBe('Windows has no rule named “Genie 2 remote access” now: there is nothing to remove.');
    });

    it('CONTROL: no firewall port: refused in words', async () => {
        await expect(handleFeatureAction(services, { kind: 'remote.removeFirewall' }, state())).rejects.toThrow('only on Windows');
    });
});
