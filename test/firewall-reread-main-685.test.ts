import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import { firewallReader } from '../src/main/remote-firewall.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { FirewallRuleView } from '../src/renderer/features.js';

/**
 * THE ROW SHOWS WHAT WINDOWS HAS NOW, NOT AT START (Tynn #685, review): a rule added or removed outside Genie (wf.msc, netsh,
 * an installer) must show without a restart. Opening Settings → Remote access, and the window regaining focus while it is
 * open, asks main to read Windows again. Main's read is DEBOUNCED: a read in flight is joined, and one within the last few
 * seconds is not repeated, so opening the page over and over never spawns netsh in a burst. Allow and Remove still read
 * fresh, whatever the debounce says: the row must show what the action did.
 */
const ABSENT: FirewallRuleView = { state: 'absent' };
const PRESENT: FirewallRuleView = {
    state: 'present', port: 7421, covers: true,
    rules: [{ fields: [{ label: 'LocalPort', value: '7421' }], enabled: true, inbound: true, allow: true, protocol: 'TCP', localPort: '7421', remoteIp: '100.64.0.0/255.192.0.0', profiles: 'Domain,Private,Public' }],
};

describe('firewallReader — main’s debounced read of Windows', () => {
    function rig(answers: FirewallRuleView[]) {
        let t = 0;
        let reads = 0;
        const gates: Array<() => void> = [];
        const read = () => new Promise<FirewallRuleView>((resolve) => { const v = answers[Math.min(reads, answers.length - 1)]!; reads += 1; gates.push(() => resolve(v)); });
        const reader = firewallReader(read, { minIntervalMs: 5000, now: () => t });
        const open = async () => { for (let i = 0; i < 5; i += 1) { while (gates.length) gates.shift()!(); await new Promise((done) => setTimeout(done, 0)); } };
        return { reader, reads: () => reads, advance: (ms: number) => { t += ms; }, open };
    }

    it('nothing read yet: null; a read fills it', async () => {
        const r = rig([PRESENT]);
        expect(r.reader.rule()).toBeNull();
        const p = r.reader.reread();
        await r.open(); await p;
        expect(r.reader.rule()).toEqual(PRESENT);
    });

    it('rereads in a burst (the page opened five times at once): ONE netsh', async () => {
        const r = rig([PRESENT]);
        const all = [r.reader.reread(), r.reader.reread(), r.reader.reread(), r.reader.reread(), r.reader.reread()];
        await r.open(); await Promise.all(all);
        expect(r.reads()).toBe(1);
    });

    it('a reread within the interval after a read is not repeated; after it, Windows is read again and a change shows', async () => {
        const r = rig([ABSENT, PRESENT]);
        let p = r.reader.reread(); await r.open(); await p;
        r.advance(4999);
        p = r.reader.reread(); await r.open(); await p;
        expect(r.reads()).toBe(1);
        expect(r.reader.rule()).toEqual(ABSENT);
        r.advance(1);
        p = r.reader.reread(); await r.open(); await p;
        expect(r.reads()).toBe(2);
        expect(r.reader.rule()).toEqual(PRESENT);
    });

    it('refresh (after Allow or Remove) reads fresh even inside the interval', async () => {
        const r = rig([ABSENT, PRESENT]);
        let p = r.reader.reread(); await r.open(); await p;
        p = r.reader.refresh(); await r.open(); await p;
        expect(r.reads()).toBe(2);
        expect(r.reader.rule()).toEqual(PRESENT);
    });

    it('refresh while a reread is in flight waits for it, then reads AGAIN (that read began before the change)', async () => {
        const r = rig([ABSENT, PRESENT]);
        const first = r.reader.reread();
        const fresh = r.reader.refresh();
        await r.open(); await first;
        await r.open(); await fresh;
        expect(r.reads()).toBe(2);
        expect(r.reader.rule()).toEqual(PRESENT);
    });
});

describe('main: remote.readFirewall rereads through the debounce, and answers with the reading', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-firewall-reread-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, hostName: 'alphar', remoteTransport: { onConnection: () => () => {} } });
    });
    afterEach(async () => { await services.shutdown(); await rm(dir, { recursive: true, force: true }); });

    it('calls reread (never the forced refresh), and the answer carries what Windows has now', async () => {
        const calls: string[] = [];
        let now: FirewallRuleView = ABSENT;
        const firewall: NonNullable<FeaturePorts['firewall']> = {
            rule: () => now,
            reread: async () => { calls.push('reread'); now = PRESENT; },
            refresh: async () => { calls.push('refresh'); },
            allow: async () => ({ ok: true }),
            remove: async () => ({ ok: true }),
        };
        const snap = await handleFeatureAction(services, { kind: 'remote.readFirewall' }, state(), { firewall });
        expect(calls).toEqual(['reread']);
        expect(snap.remote!.firewallRule).toEqual(PRESENT);
    });

    it('CONTROL: no firewall port (not Windows): nothing to read, refused in words', async () => {
        await expect(handleFeatureAction(services, { kind: 'remote.readFirewall' }, state())).rejects.toThrow('only on Windows');
    });
});
