import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadroomFeed } from '../src/core/headroom-board.js';
import type { Headroom } from '../src/core/headroom.js';
import type { AccountHeadroom } from '../src/core/headroom-board.js';
import { SwitchOfferService, SWITCH_OFFER_WINDOWS_SETTING, type KnownAccount } from '../src/core/switch-offer.js';
import { AccountsHost } from '../src/main/accounts-host.js';
import { SettingsStore } from '../src/main/settings-store.js';

/**
 * ACCOUNTS S12 (Tynn #485): RESTART SURVIVAL. Across a host restart (and so a window's): the known accounts and their names,
 * the active account per provider, the window choice, the offers' "already offered" state and the offers still standing, and
 * each account's last readings, which is how an idle account's room is known. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const HOUR = 3_600_000;
const T0 = 100 * HOUR;
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const KNOWN: KnownAccount[] = [{ id: A, provider: 'claude', label: 'Work Max' }, { id: B, provider: 'claude', label: 'ada@example.invalid' }];
const near: AccountHeadroom = { provider: 'claude', accountId: A, runId: 'r', windows: [{ refreshed: false, window: '5h', leftPct: 5, over: false, resetsAtMs: T0 + HOUR }],
    room: { plan: null, window: '5h', leftPct: 5, resetsAtMs: T0 + HOUR, over: false, windows: [] } };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-restart-485-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('S12: the book and the settings survive a host restart', () => {
    it('CONTROL: every known account, its name and the active account per provider are found again', async () => {
        let n = 0;
        const options = { root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'c'), codex: join(dir, 'x') }, mintId: () => `account_${String(++n).padStart(32, '0')}` };
        const book = await AccountsHost.open(options);
        const work = (await book.recordSignedIn('claude', { name: null, email: 'work@example.invalid', plan: null }))!;
        const ada = (await book.recordSignedIn('claude', { name: null, email: 'ada@example.invalid', plan: 'pro' }))!;
        await book.rename(work.id, 'Work Max');
        const again = await AccountsHost.open(options);
        expect(again.list().filter((a) => a.provider === 'claude').map((a) => [a.id, a.label])).toEqual([[work.id, 'Work Max'], [ada.id, 'ada@example.invalid']]);
        expect(again.activeFor('claude').id).toBe(ada.id);
    });
    it('CONTROL: the offer-window choice is kept by the host settings', async () => {
        const store = await SettingsStore.open(dir);
        await store.set(SWITCH_OFFER_WINDOWS_SETTING, 'weekly');
        expect((await SettingsStore.open(dir)).snapshot()[SWITCH_OFFER_WINDOWS_SETTING]).toBe('weekly');
    });
});

describe('S12: the offers survive a host restart', () => {
    const service = (disk: { saved: unknown }) => new SwitchOfferService({
        readings: () => [near], known: () => KNOWN, active: () => ({ claude: A }), choice: () => 'both', now: () => T0,
        load: () => disk.saved, save: (state) => { disk.saved = JSON.parse(JSON.stringify(state)); },
    });
    it('an offer still standing is offered again after the restart, before any new reading', () => {
        const disk = { saved: undefined as unknown };
        const before = service(disk);
        before.check();
        expect(before.offers()).toHaveLength(1);
        expect(service(disk).offers().map((o) => o.accountId)).toEqual([A]);
    });
    it('Not now before the restart stays Not now: the same window is not offered again', () => {
        const disk = { saved: undefined as unknown };
        const before = service(disk);
        before.check();
        before.dismiss(before.offers()[0]!.id);
        const after = service(disk);
        after.check();
        expect(after.offers()).toEqual([]);
    });
    it('CONTROL: a saved state that is not one is read as nothing, never a crash', () => {
        const s = service({ saved: 'not json state' });
        s.check();
        expect(s.offers()).toHaveLength(1);
    });
});

describe('S12: each account\'s last readings survive a host restart', () => {
    const room: Headroom = { plan: 'max', window: '5h', leftPct: 40, resetsAtMs: T0 + HOUR, over: false, windows: [{ window: '5h', usedPct: 60, leftPct: 40, resetsAtMs: T0 + HOUR, over: false }] };
    it('an idle account\'s reading is known again after the restart', () => {
        const before = new HeadroomFeed(() => 0, () => T0);
        before.offer('claude', room, { accountId: B, runId: 'r1' });
        const after = new HeadroomFeed(() => 0, () => T0);
        after.restore(JSON.parse(JSON.stringify(before.snapshot())));
        expect(after.accounts()).toEqual(before.accounts());
        expect(after.accounts().map((a) => a.accountId)).toEqual([B]);
    });
    it('CONTROL: a saved board that is not one is read as nothing', () => {
        const feed = new HeadroomFeed(() => 0, () => T0);
        feed.restore('garbage');
        feed.restore([{ nope: true }]);
        expect(feed.accounts()).toEqual([]);
    });
});

describe('S12: genie-host keeps them on disk', () => {
    it('the offers in switch-offers.json and the board in headroom-board.json, read at start and written as they change', () => {
        const host = source('src/main/genie-host.ts');
        expect(host).toContain("join(home, 'switch-offers.json')");
        expect(host).toContain("join(home, 'headroom-board.json')");
        expect(host).toMatch(/headroomFeed\.restore\(/);
        expect(host).toMatch(/load: \(\) => \{ try \{ return JSON\.parse\(readFileSync\(switchOffersFile/);
    });
});
