import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountsView, activeAccountOf, headerLimits, type AccountsSnapshot, type AccountView, type KnownAccountRecord } from '../src/core/accounts-view.js';
import { HeadroomBoard, HeadroomFeed } from '../src/core/headroom-board.js';
import { rateLimitAlert, type Headroom, type LimitWindow } from '../src/core/headroom.js';
import { ReadingAttribution } from '../src/core/reading-attribution.js';
import { AccountIdentityReader } from '../src/main/account-identity.js';
import { AccountsHost } from '../src/main/accounts-host.js';
import type { ProviderHealthPorts } from '../src/main/provider-health.js';

// THE DASHBOARD AFTER A SIGN-IN SWITCHES THE ACTIVE ACCOUNT (Tynn #753). The owner, on a fresh account: "I am still seeing 8%
// remaining". A fresh Claude account reports only its 7d window, so the 5 h figure on screen was the previous account's.
// A window's reading belongs to the account active when it arrived; a window the new account has not reported is unknown;
// a window past its reset reads Refreshed; a reading that omits a window never keeps the old account's figure for it.
// Fixtures use no real person.

const T0 = 1_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const KNOWN: KnownAccountRecord[] = [
    { id: A, provider: 'claude', label: 'first@example.test', identity: { email: 'first@example.test', plan: null } },
    { id: B, provider: 'claude', label: 'second@example.test', identity: { email: 'second@example.test', plan: null } },
];

const win = (window: string, leftPct: number, resetsAtMs: number): LimitWindow => ({ window, usedPct: 100 - leftPct, leftPct, resetsAtMs, over: false });
const roomOf = (...windows: LimitWindow[]): Headroom => ({ plan: null, window: windows[0]!.window, leftPct: windows[0]!.leftPct, resetsAtMs: windows[0]!.resetsAtMs, over: false, windows });
const A_5H_8 = () => roomOf(win('5h', 8, T0 + 4 * HOUR));
const B_7D_96 = () => roomOf(win('7d', 96, T0 + 6 * DAY));

/** genie-host's composition: the active account stamps a reading as it arrives; a read of who is signed in may change it. */
class Host {
    now = T0;
    active = A;
    readonly feed = new HeadroomFeed(() => MIN, () => this.now);
    readonly attribution = new ReadingAttribution();
    reading(room: Headroom, runId = 'run_1'): void {
        const stamp = this.attribution.stamp('claude', room, { accountId: this.active, runId });
        if (stamp) this.feed.offer('claude', room, stamp);
    }
    signedIn(): void { this.attribution.signedIn('claude'); }
    readStart(): void { this.attribution.readStart('claude', this.active); }
    readEnd(): boolean {
        const r = this.attribution.readEnd('claude', this.active);
        if (r.held) this.feed.offer('claude', r.held.room, r.held.stamp);
        return r.changed;
    }
    snapshot(): AccountsSnapshot { return { providers: accountsView(KNOWN, this.feed.accounts(), { claude: this.active }), offers: [] }; }
    activeAccount(): AccountView { return activeAccountOf(this.snapshot().providers.find((p) => p.provider === 'claude')!)!; }
    header(): Readonly<Record<string, Headroom>> { return headerLimits(this.feed.view(), this.snapshot()); }
}

const windowOf = (account: AccountView, window: string) => account.windows.find((w) => w.window === window);
const figures = (value: unknown): number[] => JSON.stringify(value).match(/"leftPct":(\d+)/g)?.map((m) => Number(m.split(':')[1])) ?? [];

describe('after a sign-in switches the active account, the Dashboard shows the NEW account, never the old one', () => {
    it('the owner’s case: A has 5h at 8%; a sign-in to B; B reports only 7d at 96% while Genie reads who is signed in → no 5h row, 7d 96%, never 8%', () => {
        const host = new Host();
        host.reading(A_5H_8());
        host.signedIn();
        host.readStart();
        host.now = T0 + 2 * MIN;
        host.reading(B_7D_96());
        host.active = B;
        host.readEnd();
        const shown = host.activeAccount();
        expect(shown.id).toBe(B);
        expect(windowOf(shown, '5h')).toBeUndefined(); // B has no 5 h reading: no 5 h row at all (Tynn #1070)
        expect(windowOf(shown, '7d')).toMatchObject({ refreshed: false, leftPct: 96 });
        expect(figures(host.header())).not.toContain(8);
        expect(rateLimitAlert(host.header(), host.now)).toBeNull();
    });

    it('a switch to B before B has any reading: the chip reads unknown, the header shows no Claude limit, the window is told', () => {
        const host = new Host();
        host.reading(A_5H_8());
        host.signedIn();
        host.readStart();
        host.active = B;
        expect(host.readEnd()).toBe(true);
        const shown = host.activeAccount();
        expect(shown.id).toBe(B);
        expect(shown).toMatchObject({ read: false, windows: [] }); // usage unknown, no rows made up (Tynn #1070)
        expect(host.header()['claude']).toBeUndefined();
        expect(rateLimitAlert(host.header(), host.now)).toBeNull();
    });

    it('the identity read says nothing (the active account stays A): B’s 7d-only reading after the sign-in does not keep A’s 5h at 8%', () => {
        const host = new Host();
        host.reading(A_5H_8());
        host.signedIn();
        host.readStart();
        host.readEnd();
        host.now = T0 + 2 * MIN;
        host.reading(B_7D_96());
        const shown = host.activeAccount();
        expect(windowOf(shown, '5h')).toBeUndefined(); // B has no 5 h reading: no 5 h row at all (Tynn #1070)
        expect(windowOf(shown, '7d')).toMatchObject({ refreshed: false, leftPct: 96 });
        expect(figures(host.header())).not.toContain(8);
    });

    it('a fresh reading keeps no earlier window and waits out no buffer', () => {
        const board = new HeadroomBoard();
        const source = { provider: 'claude', accountId: A };
        expect(board.offer(source, A_5H_8(), T0, MIN, { accountId: A, runId: 'run_1' })).toBe(true);
        expect(board.offer(source, B_7D_96(), T0 + 1, MIN, { accountId: A, runId: 'run_1', fresh: true })).toBe(true);
        expect(board.accounts(T0 + 2)[0]!.room.windows.map((w) => w.window)).toEqual(['7d']);
    });

    it('CONTROL: B’s reading arriving AFTER the identity read is B’s: no 5h row, 7d 96%', () => {
        const host = new Host();
        host.reading(A_5H_8());
        host.signedIn();
        host.readStart();
        host.active = B;
        host.readEnd();
        host.now = T0 + 2 * MIN;
        host.reading(B_7D_96());
        const shown = host.activeAccount();
        expect(windowOf(shown, '5h')).toBeUndefined(); // B has no 5 h reading: no 5 h row at all (Tynn #1070)
        expect(windowOf(shown, '7d')).toMatchObject({ refreshed: false, leftPct: 96 });
        expect(figures(host.header())).not.toContain(8);
    });

    it('CONTROL: a window past its reset time reads Refreshed and warns about nothing', () => {
        const host = new Host();
        host.reading(roomOf(win('5h', 8, T0 + HOUR)));
        host.now = T0 + 2 * HOUR;
        expect(windowOf(host.activeAccount(), '5h')).toEqual({ refreshed: true, window: '5h' });
        expect(rateLimitAlert(host.header(), host.now)).toBeNull();
    });

    it('CONTROL: with no sign-in between, the same account’s 7d-only reading keeps its 5h (genie#1268)', () => {
        const host = new Host();
        host.reading(A_5H_8());
        host.now = T0 + 2 * MIN;
        host.reading(B_7D_96());
        expect(windowOf(host.activeAccount(), '5h')).toMatchObject({ refreshed: false, leftPct: 8 });
        expect(windowOf(host.activeAccount(), '7d')).toMatchObject({ refreshed: false, leftPct: 96 });
    });
});

describe('the identity reader tells its hooks around every read', () => {
    let dir = '';
    afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });
    const portsFor = (run: ProviderHealthPorts['run']): ProviderHealthPorts => ({
        platform: 'linux', arch: 'x64', env: { PATH: '/bin' }, isFile: (p) => p === '/bin/claude' || p === '/bin/codex', readText: () => '', readHead: () => null,
        realpath: (p) => p, chosen: () => null, now: () => 0, run,
    });
    const status = (email: string) => { const stdout = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email }); return { exitCode: 0, stdout, streams: { stdout, stderr: '' } }; };

    it('start before the read, end after the new account is recorded, and end even when the read fails', async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-switch-753-'));
        const host = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') } });
        const seen: string[] = [];
        const hooks = { readStart: (p: string) => { seen.push(`start ${p} ${host.activeFor('claude').identity.email}`); }, readEnd: (p: string) => { seen.push(`end ${p} ${host.activeFor('claude').identity.email}`); } };
        const run = vi.fn(async () => status('first@example.test'));
        await new AccountIdentityReader(host, () => portsFor(run), () => {}, hooks).refreshProvider('claude');
        run.mockImplementation(async () => status('second@example.test'));
        await new AccountIdentityReader(host, () => portsFor(run), () => {}, hooks).refreshProvider('claude');
        run.mockImplementation(async () => { throw new Error('timed out'); });
        await new AccountIdentityReader(host, () => portsFor(run), () => {}, hooks).refreshProvider('claude');
        expect(seen).toEqual([
            'start claude null', 'end claude first@example.test',
            'start claude first@example.test', 'end claude second@example.test',
            'start claude second@example.test', 'end claude second@example.test',
        ]);
    });
});
