import { describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import type { Headroom } from '../src/core/headroom.js';
import { PROBE_STALE_MS, UsageProbes, type UsageProbePorts } from '../src/core/usage-probe.js';

/**
 * A SWITCHED-TO ACCOUNT IS READ AT ONCE (Tynn #1084; the owner, beta.66.1: he switched to an account and it showed "Usage
 * unknown: not read yet" and never updated). A Claude reading only ever came from a turn of an agent in that account's
 * folder, and nothing took one on a switch. The probe is the one place that asks: on a switch, an account's first use and the
 * Accounts panel opening, only when the account has no reading of its own in 15 min and was not asked in 15 min; the
 * person's "Check usage now" asks at once. The reading is THAT account's, never another's (#1070).
 */
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 9);
const account = (id: string, over: Partial<AccountRecord> = {}): AccountRecord => ({
    id, provider: 'claude', label: id, labelEdited: false, home: '', legacy: false, createdAt: '2026-11-01T00:00:00Z',
    identity: { name: null, email: `${id}@example.test`, plan: 'max' }, configDir: `/accounts/${id}`, ...over,
});
const room = (left: number): Headroom => ({ plan: 'max', window: '7d', leftPct: left, resetsAtMs: T0 + 90 * 60 * MIN, over: false,
    windows: [{ window: '7d', usedPct: 100 - left, leftPct: left, resetsAtMs: T0 + 90 * 60 * MIN, over: false }] });

function rig(options: { last?: Record<string, number>; read?: (a: AccountRecord) => Promise<Headroom>; canRead?: (a: AccountRecord) => string | null } = {}) {
    let now = T0;
    const asked: string[] = [];
    const offered: Array<{ id: string; room: Headroom }> = [];
    let changed = 0;
    const ports: UsageProbePorts = {
        read: async (a) => { asked.push(a.id); return options.read ? options.read(a) : room(68); },
        canRead: options.canRead ?? (() => null),
        lastReadingAt: (id) => options.last?.[id] ?? null,
        offer: (a, r) => { offered.push({ id: a.id, room: r }); },
        changed: () => { changed += 1; },
        now: () => now,
    };
    return { probes: new UsageProbes(ports), asked, offered, changes: () => changed, advance: (ms: number) => { now += ms; } };
}

describe('UsageProbes: an account with no reading is read at once, keyed to it', () => {
    it('an unread account is read, and the reading is offered under THAT account', async () => {
        const r = rig();
        expect(await r.probes.request(account('new'))).toBe('read');
        expect(r.asked).toEqual(['new']);
        expect(r.offered).toEqual([{ id: 'new', room: room(68) }]);
    });

    it('says "reading" while it runs and tells the windows, then clears', async () => {
        let release!: (h: Headroom) => void;
        const r = rig({ read: () => new Promise<Headroom>((res) => { release = res; }) });
        const done = r.probes.request(account('new'));
        expect(r.probes.state('new')).toEqual({ state: 'reading' });
        expect(r.changes()).toBeGreaterThan(0);
        // Whether it may be read is asked first (canRead may ask Claude Code), then the read starts.
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(r.probes.state('new')).toEqual({ state: 'reading' });
        release(room(50));
        await done;
        expect(r.probes.state('new')).toBeNull();
    });

    it('an account a real run reported within 15 min is not asked', async () => {
        const r = rig({ last: { busy: T0 - 5 * MIN } });
        expect(await r.probes.request(account('busy'))).toBe('skipped');
        expect(r.asked).toEqual([]);
    });

    it('a reading older than 15 min is stale: the account is asked', async () => {
        const r = rig({ last: { old: T0 - PROBE_STALE_MS - 1 } });
        expect(await r.probes.request(account('old'))).toBe('read');
    });

    it('at most one probe per account per 15 min across triggers, even when the read failed', async () => {
        const r = rig({ read: async () => { throw new Error('no usage reported'); } });
        expect(await r.probes.request(account('a'))).toBe('failed');
        r.advance(5 * MIN);
        expect(await r.probes.request(account('a'))).toBe('skipped');
        r.advance(PROBE_STALE_MS);
        expect(await r.probes.request(account('a'))).toBe('failed');
        expect(r.asked).toEqual(['a', 'a']);
    });

    it('two triggers at once make one read', async () => {
        const r = rig();
        await Promise.all([r.probes.request(account('a')), r.probes.request(account('a'))]);
        expect(r.asked).toEqual(['a']);
    });

    it('"Check usage now" asks at once, whatever the 15-min rules say', async () => {
        const r = rig({ last: { a: T0 - MIN } });
        expect(await r.probes.request(account('a'), { manual: true })).toBe('read');
        expect(await r.probes.request(account('a'), { manual: true })).toBe('read');
        expect(r.asked).toEqual(['a', 'a']);
    });

    it('a failed read says why, and the reason stays until the next read', async () => {
        const r = rig({ read: async () => { throw new Error('Claude Code reported no usage for this account'); } });
        await r.probes.request(account('a'), { manual: true });
        expect(r.probes.state('a')).toMatchObject({ state: 'failed', reason: 'Claude Code reported no usage for this account' });
        expect(r.offered).toEqual([]);
    });

    it('an account that cannot be read here (the default home is signed in to someone else) is never read, and says why', async () => {
        const r = rig({ canRead: () => 'the default Claude home is signed in to another account' });
        const { configDir: _own, ...home } = account('home');
        expect(await r.probes.request(home as AccountRecord, { manual: true })).toBe('failed');
        expect(r.asked).toEqual([]);
        expect(r.probes.state('home')).toMatchObject({ state: 'failed', reason: 'the default Claude home is signed in to another account' });
    });

    it('only Claude accounts are probed', async () => {
        const r = rig();
        expect(await r.probes.request(account('cx', { provider: 'codex' }))).toBe('skipped');
        expect(r.asked).toEqual([]);
    });
});
