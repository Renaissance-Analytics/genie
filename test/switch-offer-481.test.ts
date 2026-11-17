import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountHeadroom } from '../src/core/headroom-board.js';
import type { WindowReading } from '../src/core/headroom.js';
import { memoryPair } from '../src/core/line-transport.js';
import { SETTINGS } from '../src/core/settings.js';
import { sectionOf } from '../src/core/settings-nav.js';
import {
    SWITCH_OFFER_LEFT_PCT, SWITCH_OFFER_WINDOWS_SETTING, SwitchOfferService, SwitchOfferWatcher, nearLimit, offerWatches, parseSwitchOfferWindows, switchTargets,
    type KnownAccount, type SwitchOffer, type SwitchOfferWindows,
} from '../src/core/switch-offer.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer, type EngineServerOptions } from '../src/main/session-engine-server.js';

/**
 * ACCOUNTS S8 (Tynn #481): SWITCH OFFERS IN THE HOST. When the ACTIVE account's chosen window (5 h, weekly or both: the
 * `switch_offer_windows` setting) is near its limit (10% left, or spent), the host makes ONE offer per account per window per
 * reset, suggesting another known account of the same provider with more room, best first. Nothing switches: an offer is only
 * offered. Fixtures name no person.
 */
const HOUR = 3_600_000;
const T0 = 100 * HOUR;
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const C = `account_${'c'.repeat(32)}`;
const X = `account_${'d'.repeat(32)}`;

const live = (window: string, leftPct: number, resetsAtMs: number, over = false): WindowReading => ({ refreshed: false, window, leftPct, over, resetsAtMs });
const refreshed = (window: string): WindowReading => ({ refreshed: true, window });
const reading = (accountId: string, windows: WindowReading[], provider = 'claude'): AccountHeadroom => ({
    provider, accountId, runId: 'run_1', windows, room: { plan: null, window: '5h', leftPct: 0, resetsAtMs: 0, over: false, windows: [] },
});
const KNOWN: KnownAccount[] = [
    { id: A, provider: 'claude', label: 'Work Max' },
    { id: B, provider: 'claude', label: 'Personal Pro' },
    { id: C, provider: 'claude', label: 'ada@example.invalid' },
    { id: X, provider: 'codex', label: 'Codex Plus' },
];
const ACTIVE = { claude: A, codex: X };
const check = (w: SwitchOfferWatcher, choice: SwitchOfferWindows, readings: AccountHeadroom[], active: Record<string, string> = ACTIVE): SwitchOffer[] =>
    w.check({ choice, active, readings, known: KNOWN });

describe('S8: the setting', () => {
    it('is host-scoped, offers 5 h / weekly / both, defaults to both, and is placed on Settings → Providers', () => {
        const def = SETTINGS.find((s) => s.key === SWITCH_OFFER_WINDOWS_SETTING);
        expect(def).toMatchObject({ key: 'switch_offer_windows', scope: 'host', type: 'enum', options: ['5h', 'weekly', 'both'], default: 'both' });
        expect(sectionOf('switch_offer_windows')).toBe('providers');
    });
    it('CONTROL: an unset or unknown value reads as both', () => {
        expect(parseSwitchOfferWindows(undefined)).toBe('both');
        expect(parseSwitchOfferWindows('hourly')).toBe('both');
    });
    it('5h and weekly read as chosen', () => {
        expect(parseSwitchOfferWindows('5h')).toBe('5h');
        expect(parseSwitchOfferWindows('weekly')).toBe('weekly');
    });
});

describe('S8: which windows a choice watches, and what is near', () => {
    it('5h watches the 5 h window; weekly watches 7d and the model weekly windows; both watches all of them', () => {
        expect(offerWatches('5h', '5h')).toBe(true);
        expect(offerWatches('5h', '7d')).toBe(false);
        expect(offerWatches('weekly', '7d')).toBe(true);
        expect(offerWatches('weekly', '7d opus')).toBe(true);
        expect(offerWatches('weekly', '5h')).toBe(false);
        for (const w of ['5h', '7d', '7d opus']) expect(offerWatches('both', w)).toBe(true);
    });
    it('CONTROL: a window that is neither 5 h nor weekly is never watched', () => {
        for (const c of ['5h', 'weekly', 'both'] as const) expect(offerWatches(c, '1d')).toBe(false);
    });
    it('10% left is near, 11% is not, and a spent window is near whatever its figure', () => {
        expect(SWITCH_OFFER_LEFT_PCT).toBe(10);
        expect(nearLimit(live('5h', 10, T0))).toBe(true);
        expect(nearLimit(live('5h', 0, T0))).toBe(true);
        expect(nearLimit(live('5h', 11, T0))).toBe(false);
        expect(nearLimit(live('5h', 40, T0, true))).toBe(true);
    });
    it('CONTROL: a Refreshed window is never near', () => {
        expect(nearLimit(refreshed('5h'))).toBe(false);
    });
});

describe('S8: when an offer is made (the story acceptance)', () => {
    it('with weekly chosen, a 5 h dip makes no offer, and a weekly dip does', () => {
        const w = new SwitchOfferWatcher();
        expect(check(w, 'weekly', [reading(A, [live('5h', 5, T0 + HOUR), live('7d', 60, T0 + 90 * HOUR)])])).toEqual([]);
        expect(check(w, 'weekly', [reading(A, [live('5h', 5, T0 + HOUR), live('7d', 8, T0 + 90 * HOUR)])]).map((o) => o.window)).toEqual(['7d']);
    });
    it('with both chosen, either window\'s dip makes an offer', () => {
        expect(check(new SwitchOfferWatcher(), 'both', [reading(A, [live('5h', 5, T0 + HOUR), live('7d', 60, T0 + 90 * HOUR)])]).map((o) => o.window)).toEqual(['5h']);
        expect(check(new SwitchOfferWatcher(), 'both', [reading(A, [live('5h', 60, T0 + HOUR), live('7d', 9, T0 + 90 * HOUR)])]).map((o) => o.window)).toEqual(['7d']);
    });
    it('a second reading in the same window makes no second offer, a small drift in its reset time included', () => {
        const w = new SwitchOfferWatcher();
        expect(check(w, '5h', [reading(A, [live('5h', 9, T0 + HOUR)])])).toHaveLength(1);
        expect(check(w, '5h', [reading(A, [live('5h', 4, T0 + HOUR)])])).toEqual([]);
        expect(check(w, '5h', [reading(A, [live('5h', 2, T0 + HOUR + 30_000)])])).toEqual([]);
    });
    it('after the reset (read Refreshed, or a new reset time) the next window\'s dip offers again', () => {
        const w = new SwitchOfferWatcher();
        expect(check(w, '5h', [reading(A, [live('5h', 9, T0 + HOUR)])])).toHaveLength(1);
        expect(check(w, '5h', [reading(A, [live('5h', 9, T0 + 6 * HOUR)])])).toHaveLength(1);
        expect(check(w, '5h', [reading(A, [refreshed('5h')])])).toEqual([]);
        expect(check(w, '5h', [reading(A, [live('5h', 9, T0 + 6 * HOUR)])])).toHaveLength(1);
    });
    it('only the provider\'s ACTIVE account is offered for; each provider has its own active account', () => {
        const w = new SwitchOfferWatcher();
        const offers = check(w, '5h', [reading(B, [live('5h', 3, T0 + HOUR)]), reading(X, [live('5h', 3, T0 + HOUR)], 'codex')]);
        expect(offers.map((o) => [o.provider, o.accountId])).toEqual([['codex', X]]);
    });
    it('one account\'s offer never spends another\'s: B, once active, gets its own offer in the same window', () => {
        const w = new SwitchOfferWatcher();
        expect(check(w, '5h', [reading(A, [live('5h', 5, T0 + HOUR)])])).toHaveLength(1);
        expect(check(w, '5h', [reading(A, [live('5h', 5, T0 + HOUR)]), reading(B, [live('5h', 6, T0 + HOUR)])], { claude: B })).toHaveLength(1);
    });
    it('the offer names the provider, the account, the window, its share left and when it resets', () => {
        const [offer] = check(new SwitchOfferWatcher(), '5h', [reading(A, [live('5h', 8, T0 + 2 * HOUR)])]);
        expect(offer).toMatchObject({ provider: 'claude', accountId: A, label: 'Work Max', window: '5h', leftPct: 8, over: false, resetsAtMs: T0 + 2 * HOUR });
        expect(typeof offer!.id).toBe('string');
    });
    it('CONTROL: readings with room make no offer', () => {
        expect(check(new SwitchOfferWatcher(), 'both', [reading(A, [live('5h', 50, T0 + HOUR), live('7d', 70, T0 + 90 * HOUR)])])).toEqual([]);
    });
});

describe('S8: which account the offer suggests (decision 3, and the coordinator 2026-11-16: unknown room is offered last)', () => {
    it('another known account of the same provider with more room in the same window, best first; a window reset since counts as full', () => {
        const readings = [reading(A, [live('5h', 5, T0 + HOUR)]), reading(B, [live('5h', 40, T0 + 2 * HOUR)]), reading(C, [refreshed('5h')])];
        expect(switchTargets({ provider: 'claude', accountId: A, window: '5h', leftPct: 5 }, readings, KNOWN)).toEqual([
            { accountId: C, label: 'ada@example.invalid', room: 'reset', leftPct: null, resetsAtMs: null },
            { accountId: B, label: 'Personal Pro', room: 'reported', leftPct: 40, resetsAtMs: T0 + 2 * HOUR },
        ]);
    });
    it('CONTROL: not one also near, the account itself or another provider\'s', () => {
        const readings = [
            reading(A, [live('5h', 5, T0 + HOUR)]), reading(B, [live('7d', 90, T0 + 90 * HOUR), live('5h', 60, T0 + HOUR)]),
            reading(C, [live('5h', 9, T0 + HOUR)]), reading(X, [live('5h', 90, T0 + HOUR)], 'codex'),
        ];
        expect(switchTargets({ provider: 'claude', accountId: A, window: '5h', leftPct: 5 }, readings, KNOWN).map((t) => t.accountId)).toEqual([B]);
    });
    it('an account with no reading of that window (not used yet) is offered AFTER those with room, marked room unknown; a spent one is not', () => {
        const readings = [reading(A, [live('5h', 5, T0 + HOUR)]), reading(B, [live('5h', 40, T0 + 2 * HOUR)])];
        expect(switchTargets({ provider: 'claude', accountId: A, window: '5h', leftPct: 5 }, readings, KNOWN)).toEqual([
            { accountId: B, label: 'Personal Pro', room: 'reported', leftPct: 40, resetsAtMs: T0 + 2 * HOUR },
            { accountId: C, label: 'ada@example.invalid', room: 'unknown', leftPct: null, resetsAtMs: null },
        ]);
        expect(switchTargets({ provider: 'claude', accountId: A, window: '7d opus', leftPct: 5 }, readings, KNOWN).map((t) => [t.accountId, t.room]))
            .toEqual([[B, 'unknown'], [C, 'unknown']]);
        const spent = [reading(A, [live('5h', 5, T0 + HOUR)]), reading(B, [live('5h', 50, T0 + HOUR, true)])];
        expect(switchTargets({ provider: 'claude', accountId: A, window: '5h', leftPct: 5 }, spent, KNOWN).map((t) => [t.accountId, t.room])).toEqual([[C, 'unknown']]);
    });
    it('CONTROL: with no other account of the provider the offer still comes, and suggests nobody', () => {
        const [offer] = check(new SwitchOfferWatcher(), '5h', [reading(X, [live('5h', 5, T0 + HOUR)], 'codex')]);
        expect(offer).toMatchObject({ accountId: X, targets: [] });
    });
});

describe('S8: the host service (what a window is offered)', () => {
    const service = (state: { readings: AccountHeadroom[]; active: Record<string, string>; choice: unknown; now: number }) => new SwitchOfferService({
        readings: () => state.readings, known: () => KNOWN, active: () => state.active, choice: () => state.choice, now: () => state.now,
    });
    it('lists the pending offer with its suggestions; Not now removes it and it does not come back in that window', () => {
        const state = { readings: [reading(A, [live('5h', 5, T0 + HOUR)]), reading(B, [live('5h', 70, T0 + 3 * HOUR)])], active: { claude: A }, choice: 'both', now: T0 };
        const s = service(state);
        s.check();
        const offers = s.offers();
        expect(offers).toHaveLength(1);
        expect(offers[0]).toMatchObject({ accountId: A, window: '5h', targets: [{ accountId: B, leftPct: 70, room: 'reported' }, { accountId: C, room: 'unknown' }] });
        expect(s.dismiss(offers[0]!.id)).toBe(true);
        expect(s.offers()).toEqual([]);
        state.readings = [reading(A, [live('5h', 1, T0 + HOUR)]), state.readings[1]!];
        s.check();
        expect(s.offers()).toEqual([]);
    });
    it('an offer whose account is no longer the active one, or whose window has reset, is no longer offered', () => {
        const state = { readings: [reading(A, [live('5h', 5, T0 + HOUR)])], active: { claude: A } as Record<string, string>, choice: '5h', now: T0 };
        const s = service(state);
        s.check();
        expect(s.offers()).toHaveLength(1);
        state.active = { claude: B };
        expect(s.offers()).toEqual([]);
        state.active = { claude: A };
        expect(s.offers()).toHaveLength(1);
        state.now = T0 + HOUR;
        expect(s.offers()).toEqual([]);
    });
    it('the window choice is read at each check: an offer for a window no longer chosen is withdrawn', () => {
        const state = { readings: [reading(A, [live('5h', 5, T0 + HOUR), live('7d', 50, T0 + 90 * HOUR)])], active: { claude: A }, choice: 'weekly' as unknown, now: T0 };
        const s = service(state);
        s.check();
        expect(s.offers()).toEqual([]);
        state.choice = '5h';
        s.check();
        expect(s.offers().map((o) => o.window)).toEqual(['5h']);
        state.choice = 'weekly';
        expect(s.offers()).toEqual([]);
    });
    it('CONTROL: dismissing an offer that is not there changes nothing', () => {
        const s = service({ readings: [], active: {}, choice: 'both', now: T0 });
        expect(s.dismiss('nope')).toBe(false);
        expect(s.offers()).toEqual([]);
    });
});

describe('S8: a window reads and dismisses the host\'s offers', () => {
    const close: Array<() => void> = [];
    afterEach(() => { for (const fn of close.splice(0)) fn(); });
    async function connection(extra: Partial<EngineServerOptions>, local = true) {
        const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', ...extra });
        const client = new SessionEngineClient(), [host, window] = memoryPair();
        server.accept(host, { local }); close.push(() => window.close());
        expect(await client.connect(window, 'fixture')).toMatchObject({ ok: true });
        return client;
    }
    const OFFER: SwitchOffer = { id: 'o1', provider: 'claude', accountId: A, label: 'Work Max', window: '5h', leftPct: 5, over: false, resetsAtMs: T0 + HOUR, targets: [] };
    it('this machine\'s window lists the offers and Not now dismisses one', async () => {
        const dismissed: string[] = [];
        const client = await connection({ switchOffers: { offers: () => [OFFER], dismiss: (id) => { dismissed.push(id); return true; } } });
        expect(await client.switchOffers()).toEqual([OFFER]);
        expect(await client.dismissSwitchOffer('o1')).toBe(true);
        expect(dismissed).toEqual(['o1']);
    });
    it('another connection is refused', async () => {
        const client = await connection({ switchOffers: { offers: () => { throw new Error('must not be read'); }, dismiss: () => true } }, false);
        expect(await client.call('engine.switchOffers', [])).toMatchObject({ ok: false });
    });
});

describe('S8: genie-host makes the offers', () => {
    const host = readFileSync(join(__dirname, '..', 'src/main/genie-host.ts'), 'utf8').replace(/\r\n/g, '\n');
    it('checks them at each shown reading, reads the choice from the host settings, and serves them to windows', () => {
        expect(host).toMatch(/headroomFeed\.subscribe\(\(\) => \{[^}]*switchOffers\.check\(\)/);
        expect(host).toContain('settings.snapshot()[SWITCH_OFFER_WINDOWS_SETTING]');
        expect(host).toMatch(/switchOffers: \{/);
    });
});
