import { describe, expect, it } from 'vitest';
import { accountRoom, activeOutWords, whenActiveOut, ActiveOutService, ACTIVE_OUT_SETTING, type AccountRoom, type ActiveOut } from '../src/core/active-out.js';
import { shortDateTime } from '../src/core/clock-words.js';
import type { Headroom } from '../src/core/headroom.js';
import { SETTINGS } from '../src/core/settings.js';

/**
 * WHEN THE ACTIVE ACCOUNT RUNS OUT (Tynn #1089). An agent held on the active account's spent window waits for its reset unless
 * the person moves it; another account may have room. The person sets the rule (a framework, not a policy): `Ask me` (the
 * default) says so where the agent is held, with one click to switch; `Switch` switches the active account through the
 * normal switch, and says it did. With no account with room it says so plainly, with the reset, and the message waits.
 *
 * Whether an account has room is ONE function (`accountRoom`), fed today by the headroom board's readings, so a turn-free
 * read (Tynn #1091, prism-acp readRateLimits) can feed it later without touching anything that decides.
 */

const NOW = Date.UTC(2026, 10, 27, 17, 0, 0);
const DAY = 24 * 3_600_000;
const room = (leftPct: number, resetsAtMs: number, window = '7d'): Headroom => ({
    plan: null, window, leftPct, resetsAtMs, over: false, windows: [{ window, usedPct: 100 - leftPct, leftPct, resetsAtMs, over: false }],
});
const RESET = NOW + 6 * DAY;
const known = [
    { id: 'acct_a', provider: 'claude', label: 'Account 1' },
    { id: 'acct_b', provider: 'claude', label: 'Account 2' },
    { id: 'acct_c', provider: 'claude', label: 'Account 3' },
];

describe('accountRoom: whether an account has room, from its own reading', () => {
    it('a window at 0 % left is spent until its reset', () => {
        expect(accountRoom(room(0, RESET), NOW)).toEqual({ state: 'spent', resetsAtMs: RESET });
    });

    it('the TIGHTEST window decides: 98 % of the 5 h left but the week spent is spent', () => {
        const both: Headroom = { ...room(98, NOW + 3_600_000, '5h'), windows: [
            { window: '5h', usedPct: 2, leftPct: 98, resetsAtMs: NOW + 3_600_000, over: false },
            { window: '7d', usedPct: 100, leftPct: 0, resetsAtMs: RESET, over: false },
        ] };
        expect(accountRoom(both, NOW)).toEqual({ state: 'spent', resetsAtMs: RESET });
    });

    it('room is the share left in its tightest window', () => {
        expect(accountRoom(room(35, RESET), NOW)).toEqual({ state: 'room', leftPct: 35 });
    });

    it('no reading, or a spent window already past its reset, is unknown — never guessed as room', () => {
        expect(accountRoom(null, NOW)).toEqual({ state: 'unknown' });
        expect(accountRoom(room(0, NOW - 1), NOW)).toEqual({ state: 'unknown' });
    });
});

describe('whenActiveOut: what happens when the active account runs out', () => {
    const rooms: Record<string, AccountRoom> = {
        acct_a: { state: 'spent', resetsAtMs: RESET },
        acct_b: { state: 'room', leftPct: 35 },
        acct_c: { state: 'room', leftPct: 70 },
    };
    const input = (choice: 'ask' | 'switch', over: Partial<Record<string, AccountRoom>> = {}) => ({
        provider: 'claude', activeId: 'acct_a', known, choice, room: (id: string) => ({ ...rooms, ...over })[id] ?? { state: 'unknown' as const },
    });

    it('Ask me (the default): the account with the MOST room is offered, with the active one\'s reset', () => {
        expect(whenActiveOut(input('ask'))).toEqual({ kind: 'ask', active: { id: 'acct_a', label: 'Account 1' }, resetsAtMs: RESET, other: { id: 'acct_c', label: 'Account 3', leftPct: 70 } });
    });

    it('Switch: the same account, to switch to', () => {
        expect(whenActiveOut(input('switch'))).toMatchObject({ kind: 'switch', other: { id: 'acct_c' }, resetsAtMs: RESET });
    });

    it('no other account with room: says so, whatever the setting', () => {
        const none = { acct_b: { state: 'spent' as const, resetsAtMs: NOW + DAY }, acct_c: { state: 'unknown' as const } };
        expect(whenActiveOut(input('switch', none))).toEqual({ kind: 'no-room', active: { id: 'acct_a', label: 'Account 1' }, resetsAtMs: RESET });
    });

    it('CONTROL: an active account with room is not out', () => {
        expect(whenActiveOut(input('ask', { acct_a: { state: 'room', leftPct: 5 } }))).toEqual({ kind: 'fine' });
    });

    it('in words, the reset said plainly', () => {
        const at = shortDateTime(RESET);
        expect(activeOutWords(whenActiveOut(input('ask')))).toBe(`Account 1 is out until ${at} · Account 3 has room.`);
        expect(activeOutWords(whenActiveOut(input('switch')))).toBe(`Account 1 is out until ${at}, so Genie switched to Account 3, which has room (your setting: When the active account runs out).`);
        const none = { acct_b: { state: 'spent' as const, resetsAtMs: NOW + DAY }, acct_c: { state: 'unknown' as const } };
        expect(activeOutWords(whenActiveOut(input('ask', none)))).toBe(`No Claude account has room: Account 1 is out until ${at}. What you send waits and goes then.`);
    });
});

describe('the setting', () => {
    it('"When the active account runs out": Ask me (default) or Switch to the account with the most room', () => {
        const s = SETTINGS.find((x) => x.key === ACTIVE_OUT_SETTING);
        expect(s).toMatchObject({ label: 'When the active account runs out', type: 'enum', options: ['ask', 'switch'], default: 'ask', scope: 'host' });
        expect(s?.optionLabels).toEqual({ ask: 'Ask me', switch: 'Switch to the account with the most room' });
    });
});

describe('ActiveOutService: the setting, acted on while an agent is held on the spent active account', () => {
    const rooms: Record<string, AccountRoom> = { acct_a: { state: 'spent', resetsAtMs: RESET }, acct_b: { state: 'room', leftPct: 35 }, acct_c: { state: 'room', leftPct: 70 } };
    const service = (choice: 'ask' | 'switch', held = true) => {
        const switched: string[] = [];
        const told: Array<ActiveOut | null> = [];
        let active = 'acct_a';
        const s = new ActiveOutService({
            providers: () => ['claude'], known: () => known, activeId: () => active, room: (id) => rooms[id] ?? { state: 'unknown' }, choice: () => choice,
            heldOnActive: () => held,
            switchTo: async (id) => { switched.push(id); active = id; return { ok: true }; },
            tell: (_provider, out) => { told.push(out); },
        });
        return { s, switched, told };
    };

    it('Ask me: tells where the agent is held, and switches nothing', async () => {
        const w = service('ask');
        await w.s.check();
        expect(w.switched).toEqual([]);
        expect(w.told.at(-1)).toMatchObject({ kind: 'ask', other: { id: 'acct_c' } });
    });

    it('Switch: switches the active account ONCE, through the normal switch, and says it did', async () => {
        const w = service('switch');
        await w.s.check();
        await w.s.check();
        expect(w.switched).toEqual(['acct_c']);
        expect(w.told[0]).toMatchObject({ kind: 'switch', other: { id: 'acct_c' } });
    });

    it('CONTROL: no agent held on it, nothing is said or switched (a spent account nobody waits on is left alone)', async () => {
        const w = service('switch', false);
        await w.s.check();
        expect(w.switched).toEqual([]);
        expect(w.told.filter((t) => t !== null)).toEqual([]);
    });
});

describe('ActiveOutService: said once, not on every reading', () => {
    it('another account\'s share moving (a reading a minute) does not say the line again in the held agents\' streams', async () => {
        const told: Array<ActiveOut | null> = [];
        let roomyLeft = 70;
        const s = new ActiveOutService({
            providers: () => ['claude'], known: () => known, activeId: () => 'acct_a',
            room: (id) => (id === 'acct_a' ? { state: 'spent', resetsAtMs: RESET } : id === 'acct_c' ? { state: 'room', leftPct: roomyLeft } : { state: 'unknown' }),
            choice: () => 'ask', heldOnActive: () => true, switchTo: async () => ({ ok: true }), tell: (_p, out) => { told.push(out); },
        });
        await s.check();
        roomyLeft = 68;
        await s.check();
        roomyLeft = 66;
        await s.check();
        expect(told).toHaveLength(1);
    });
});
