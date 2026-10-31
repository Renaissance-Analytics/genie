import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAIR_CONFIRM_MS, PairApprovals, pairRefusal } from '../src/core/pair-confirm.js';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';

/**
 * PAIRING NEEDS THE PIN *AND* ALLOW ON THE DESKTOP (the owner, 2026-10-31, q_8c07b142: "add the confirm").
 *
 * Genie 1 (v0.7.0-beta.342, main/mobile/auth.ts:20) refused to mint a token on a correct PIN alone: it raised a one-time
 * desktop confirm ("Pair this device?", `confirmPair`, answered in background.ts:2841 with Pair / Deny, dismissed = deny)
 * "so a tailnet peer who somehow learns the PIN still can't pair silently". Genie 2 (genie#1349) paired on the PIN
 * alone. These tests hold the confirm back in place, on top of what Genie 2 already has (crypto PIN, two minutes, one
 * use, five tries, constant-time compare): a correct PIN raises a prompt that names the device; only Allow pairs; Deny
 * or no answer within the PIN's lifetime fails, and the phone is told why. The clock and the timer are injected.
 */

/** A clock and a timer under the test's hand: `advance` moves time and fires what fell due. */
function fakeClock(start = 1_000_000) {
    let t = start;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    return {
        now: () => t,
        schedule: (ms: number, fn: () => void) => {
            const timer = { at: t + ms, fn, live: true };
            timers.push(timer);
            return () => { timer.live = false; };
        },
        advance(ms: number) {
            t += ms;
            for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); }
        },
    };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('PairApprovals — the desktop half of the confirm', () => {
    it('asking raises ONE request naming the device, where it came from and when it lapses; Allow answers `allow` and clears it', async () => {
        const clock = fakeClock();
        const approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        const asked = approvals.ask({ label: 'Pixel 7', from: '100.101.7.9' });
        expect(approvals.requests()).toEqual([{ id: asked.id, label: 'Pixel 7', from: '100.101.7.9', host: 'alphar', replaces: null, raisedAt: 1_000_000, expiresAt: 1_000_000 + PAIR_CONFIRM_MS }]);
        expect(approvals.answer(asked.id, true)).toEqual({ ok: true });
        await expect(asked.answer).resolves.toBe('allow');
        expect(approvals.requests()).toEqual([]);
    });

    it('the prompt lives as long as a PIN: two minutes', () => {
        expect(PAIR_CONFIRM_MS).toBe(120_000);
    });

    it('Deny answers `deny`', async () => {
        const clock = fakeClock();
        const approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        const asked = approvals.ask({ label: 'Pixel 7', from: '100.101.7.9' });
        approvals.answer(asked.id, false);
        await expect(asked.answer).resolves.toBe('deny');
        expect(approvals.requests()).toEqual([]);
    });

    it('NO ANSWER within the lifetime is `timeout`: still pending a millisecond before, gone at the deadline, and a late Allow is refused', async () => {
        const clock = fakeClock();
        const approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        const asked = approvals.ask({ label: 'Pixel 7', from: '100.101.7.9' });
        let outcome: string | null = null;
        void asked.answer.then((a) => { outcome = a; });
        clock.advance(PAIR_CONFIRM_MS - 1);
        await settle();
        expect(outcome).toBeNull();
        expect(approvals.requests()).toHaveLength(1);
        clock.advance(1);
        await settle();
        expect(outcome).toBe('timeout');
        expect(approvals.requests()).toEqual([]);
        expect(approvals.answer(asked.id, true)).toEqual({ ok: false, reason: 'that pairing request is no longer waiting — it was answered, it timed out, or the device went away' });
    });

    it('a device that goes away while it waits withdraws its request (`gone`) and the prompt disappears', async () => {
        const clock = fakeClock();
        const approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        const asked = approvals.ask({ label: 'Pixel 7', from: '100.101.7.9' });
        approvals.cancel(asked.id);
        await expect(asked.answer).resolves.toBe('gone');
        expect(approvals.requests()).toEqual([]);
    });

    it('every change is announced, so the desktop draws the prompt and takes it down without a poll', () => {
        const clock = fakeClock();
        const approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        let changes = 0;
        approvals.onChange(() => { changes += 1; });
        const a = approvals.ask({ label: 'Pixel 7', from: 'x' });
        approvals.answer(a.id, true);
        approvals.ask({ label: 'iPad', from: 'y' });
        clock.advance(PAIR_CONFIRM_MS);
        expect(changes).toBe(4);
    });

    it('the phone is told WHY, in words: denied, or nobody answered in two minutes', () => {
        expect(pairRefusal('deny', 'alphar')).toBe('Pairing was denied on alphar. Ask for a new PIN to try again.');
        expect(pairRefusal('timeout', 'alphar')).toBe('Nobody pressed Allow on alphar within 2 minutes. Ask for a new PIN to try again.');
    });
});

const snapshot = { agents: [], workspaces: [], deckItems: [], signals: {} };

function fakeApi() {
    const acted: unknown[] = [];
    const api: HostApi = {
        invoke: async (method, args) => {
            if (method === 'snapshot') return snapshot;
            if (method === 'features.snapshot') return { remote: { pin: null, devices: [], shares: [], connections: [], pairRequests: [{ id: 'pair_1', label: 'Pixel 7' }] } };
            if (method === 'features.act') { acted.push(args[0]); return { ok: true }; }
            return { ok: true };
        },
        onEvent: () => () => {},
        workspaceOfAgent: () => null,
    };
    return { api, acted };
}

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    let closed = false;
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    t.onClose(() => { closed = true; });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: (auth: unknown, label = 'Pixel 7') => { t.send(JSON.stringify({ kind: 'hello', auth, label, profile: 'mobile' })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
        pending: () => inbox.length,
        closed: () => closed,
        close: () => t.close(),
    };
}

describe('RemoteHost — a correct PIN is not enough; Allow on the desktop is', () => {
    let dir: string;
    let devices: DeviceStore;
    let host: RemoteHost;
    let approvals: PairApprovals;
    let clock: ReturnType<typeof fakeClock>;
    let api: ReturnType<typeof fakeApi>;
    let connect: () => ReturnType<typeof client>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-pair-confirm-'));
        clock = fakeClock();
        api = fakeApi();
        let n = 0;
        devices = await DeviceStore.open(dir, { now: clock.now, random: () => `tok${n++}` });
        approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
        host = new RemoteHost({
            api: api.api,
            hostName: 'alphar',
            baton: new Baton(),
            pins: new PairingPins({ now: clock.now, random: () => 0.482913 }),
            shares: new ShareLinks({ host: 'x', now: clock.now, random: () => 's' }),
            devices,
            confirm: approvals,
            transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
            now: clock.now,
        });
        connect = () => {
            const pair = inMemoryPair();
            const server = { ...pair.server, remoteAddress: '100.101.7.9' };
            for (const cb of connections) cb(server);
            return client(pair.client);
        };
    });

    afterEach(async () => {
        await devices.flushed();
        await rm(dir, { recursive: true, force: true });
    });

    it('the right PIN raises "Pair this device?" naming the phone and its address — and pairs NOTHING until Allow; the phone is told it is waiting', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        const first = await phone.hello({ kind: 'pin', code });
        expect(first).toEqual({ kind: 'pairing', host: 'alphar', expiresAt: 1_000_000 + PAIR_CONFIRM_MS });
        expect(approvals.requests()).toMatchObject([{ label: 'Pixel 7', from: '100.101.7.9', host: 'alphar' }]);
        // No token, no device, no connection yet: the PIN alone has paired nothing.
        expect(devices.list()).toEqual([]);
        expect(host.connections()).toEqual([]);
        expect(phone.pending()).toBe(0);
        // The phone cannot act while it waits.
        expect(await phone.call('snapshot')).toEqual({ kind: 'refused', reason: 'say hello first' });

        approvals.answer(approvals.requests()[0]!.id, true);
        expect(await phone.next()).toMatchObject({ kind: 'welcome', host: 'alphar', isOwner: true, token: 'tok0' });
        expect(devices.list().map((d) => d.label)).toEqual(['Pixel 7']);
        expect(host.connections()).toHaveLength(1);
    });

    it('Deny: nothing is paired, the phone is told it was denied, and the socket closes', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code });
        approvals.answer(approvals.requests()[0]!.id, false);
        expect(await phone.next()).toEqual({ kind: 'refused', reason: 'Pairing was denied on alphar. Ask for a new PIN to try again.' });
        await settle();
        expect(phone.closed()).toBe(true);
        expect(devices.list()).toEqual([]);
    });

    it('NO ANSWER within the PIN’s lifetime: nothing is paired and the phone is told nobody pressed Allow', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code });
        clock.advance(PAIR_CONFIRM_MS);
        expect(await phone.next()).toEqual({ kind: 'refused', reason: 'Nobody pressed Allow on alphar within 2 minutes. Ask for a new PIN to try again.' });
        expect(devices.list()).toEqual([]);
        expect(approvals.requests()).toEqual([]);
    });

    it('a WRONG PIN never reaches the desktop: no prompt for a guess', async () => {
        host.issuePin();
        const phone = connect();
        expect(await phone.hello({ kind: 'pin', code: '000000' })).toEqual({ kind: 'refused', reason: 'wrong PIN' });
        expect(approvals.requests()).toEqual([]);
    });

    it('the PIN is still single use while the prompt is up: a second phone with the same PIN is refused', async () => {
        const { code } = host.issuePin();
        await connect().hello({ kind: 'pin', code });
        expect(await connect().hello({ kind: 'pin', code })).toEqual({ kind: 'refused', reason: 'no PIN is active; issue a new one' });
        expect(approvals.requests()).toHaveLength(1);
    });

    it('a phone that hangs up while it waits takes its prompt with it', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code });
        expect(approvals.requests()).toHaveLength(1);
        phone.close();
        await settle();
        expect(approvals.requests()).toEqual([]);
        expect(devices.list()).toEqual([]);
    });

    it('a token from an earlier pairing needs no prompt — only a NEW pairing does', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code });
        approvals.answer(approvals.requests()[0]!.id, true);
        await phone.next();
        expect(await connect().hello({ kind: 'token', token: 'tok0' })).toMatchObject({ kind: 'welcome' });
        expect(approvals.requests()).toEqual([]);
    });

    it('Allow is given on THIS screen only: a remote owner cannot answer the prompt, and never sees it in the snapshot', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code });
        approvals.answer(approvals.requests()[0]!.id, true);
        await phone.next();
        const owner = connect();
        await owner.hello({ kind: 'token', token: 'tok0' });
        expect(await owner.call('baton.take')).toMatchObject({ ok: true });
        expect(await owner.call('features.act', { kind: 'remote.answerPair', id: 'pair_1', allow: true })).toEqual({ kind: 'result', id: 2, ok: false, reason: 'a device is allowed on alphar’s own screen, never from another device' });
        expect(api.acted).toEqual([]);
        const snap = await owner.call('features.snapshot') as { kind: 'result'; ok: true; value: { remote: { pairRequests: unknown[] } } };
        expect(snap.value.remote.pairRequests).toEqual([]);
    });

    it('RE-PAIR: a PIN issued to replace a device names it in the prompt, and Allow swaps the old pairing for the new one', async () => {
        const { code } = host.issuePin();
        const first = connect();
        await first.hello({ kind: 'pin', code });
        approvals.answer(approvals.requests()[0]!.id, true);
        await first.next();
        const old = devices.list()[0]!;

        const again = host.issuePin({ replaces: old.id });
        const phone = connect();
        await phone.hello({ kind: 'pin', code: again.code });
        expect(approvals.requests()[0]!.replaces).toEqual({ id: old.id, label: 'Pixel 7' });
        approvals.answer(approvals.requests()[0]!.id, true);
        expect(await phone.next()).toMatchObject({ kind: 'welcome', token: 'tok1' });
        expect(devices.list().map((d) => d.id)).not.toContain(old.id);
        expect(devices.list()).toHaveLength(1);
    });

    it('the host announces a change when a prompt is raised and when a device pairs, so Settings and the prompt redraw', async () => {
        let changes = 0;
        host.onChange(() => { changes += 1; });
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code });
        const before = changes;
        approvals.answer(approvals.requests()[0]!.id, true);
        await phone.next();
        expect(changes).toBeGreaterThan(before);
    });
});
