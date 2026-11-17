import { describe, expect, it } from 'vitest';
import type { AccountHeadroom } from '../src/core/headroom-board.js';
import type { WindowReading } from '../src/core/headroom.js';
import {
    LIMIT_NOTICE_DECK_PREFIX, LimitAlertService, LimitAlertWatcher, LimitNoticeBook, limitAlertSound, limitAlertWords, parseLimitAlerts, removeLimitAlert, serializeLimitAlerts, upsertLimitAlert, windowMatches, type LimitAlertSignal, type RateLimitAlert,
} from '../src/core/limit-alerts.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { SETTINGS } from '../src/core/settings.js';
import { sectionOf } from '../src/core/settings-nav.js';

// Tynn #748: rate-limit alerts the person adds at the thresholds they choose, each with its own sound. Fixtures name no person.
const HOUR = 3_600_000;
const T0 = 10 * HOUR;
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;

const live = (window: string, usedPct: number, resetsAtMs: number): WindowReading => ({ refreshed: false, window, leftPct: Math.max(0, 100 - usedPct), over: usedPct > 100, resetsAtMs });
const account = (accountId: string, ...windows: WindowReading[]): AccountHeadroom => ({
    provider: 'claude', accountId, runId: 'run_1', windows,
    room: { plan: null, window: '5h', leftPct: 0, resetsAtMs: 0, over: false, windows: [] },
});
const alert90: RateLimitAlert = { id: 'l1', thresholdPct: 90, window: 'any', sound: 'alert-vega' };
const alert50: RateLimitAlert = { id: 'l2', thresholdPct: 50, window: '5h', sound: 'chime-jade' };

describe('crossing a threshold upward', () => {
    it('fires once, naming the account, the window and when it resets', () => {
        const w = new LimitAlertWatcher();
        const fired = w.check([account(A, live('5h', 92, T0 + 2 * HOUR))], [alert90]);
        expect(fired).toHaveLength(1);
        expect(fired[0]).toMatchObject({ alert: alert90, accountId: A, window: '5h', usedPct: 92, resetsAtMs: T0 + 2 * HOUR });
    });

    it('CONTROL: a reading under the threshold fires nothing', () => {
        expect(new LimitAlertWatcher().check([account(A, live('5h', 89, T0 + HOUR))], [alert90])).toEqual([]);
    });

    it('an exact hit counts as crossing', () => {
        expect(new LimitAlertWatcher().check([account(A, live('5h', 90, T0 + HOUR))], [alert90])).toHaveLength(1);
    });

    it('a reading that STAYS above does not repeat, however often it is read', () => {
        const w = new LimitAlertWatcher();
        const reset = T0 + 2 * HOUR;
        expect(w.check([account(A, live('5h', 91, reset))], [alert90])).toHaveLength(1);
        expect(w.check([account(A, live('5h', 93, reset))], [alert90])).toEqual([]);
        expect(w.check([account(A, live('5h', 99, reset))], [alert90])).toEqual([]);
    });

    it('a small drift in the provider reset time is the same window, not a new one', () => {
        const w = new LimitAlertWatcher();
        expect(w.check([account(A, live('5h', 91, T0 + 2 * HOUR))], [alert90])).toHaveLength(1);
        expect(w.check([account(A, live('5h', 92, T0 + 2 * HOUR + 30_000))], [alert90])).toEqual([]);
    });

    it('dropping below re-arms it: crossing up again fires again', () => {
        const w = new LimitAlertWatcher();
        const reset = T0 + 2 * HOUR;
        expect(w.check([account(A, live('5h', 91, reset))], [alert90])).toHaveLength(1);
        expect(w.check([account(A, live('5h', 40, reset))], [alert90])).toEqual([]);
        expect(w.check([account(A, live('5h', 95, reset))], [alert90])).toHaveLength(1);
    });

    it('a window reset re-arms it: the next window crossing fires again', () => {
        const w = new LimitAlertWatcher();
        expect(w.check([account(A, live('5h', 95, T0 + 2 * HOUR))], [alert90])).toHaveLength(1);
        // The window was read Refreshed after its reset time...
        expect(w.check([account(A, { refreshed: true, window: '5h' })], [alert90])).toEqual([]);
        // ...and the next window crosses again.
        expect(w.check([account(A, live('5h', 91, T0 + 8 * HOUR))], [alert90])).toHaveLength(1);
    });

    it('a new reset time with no Refreshed reading between is a new window too', () => {
        const w = new LimitAlertWatcher();
        expect(w.check([account(A, live('5h', 95, T0 + 2 * HOUR))], [alert90])).toHaveLength(1);
        expect(w.check([account(A, live('5h', 92, T0 + 8 * HOUR))], [alert90])).toHaveLength(1);
    });

    it('each alert fires on its own: 50 then 90 as the reading climbs', () => {
        const w = new LimitAlertWatcher();
        const reset = T0 + HOUR;
        expect(w.check([account(A, live('5h', 55, reset))], [alert50, alert90]).map((f) => f.alert.id)).toEqual(['l2']);
        expect(w.check([account(A, live('5h', 93, reset))], [alert50, alert90]).map((f) => f.alert.id)).toEqual(['l1']);
    });

    it('one reading past two thresholds fires both, lowest first', () => {
        const fired = new LimitAlertWatcher().check([account(A, live('5h', 95, T0 + HOUR))], [alert90, alert50]);
        expect(fired.map((f) => f.alert.id)).toEqual(['l2', 'l1']);
    });

    it('a window past its allowance (over) crosses every threshold', () => {
        const over: WindowReading = { refreshed: false, window: '5h', leftPct: 0, over: true, resetsAtMs: T0 + HOUR };
        expect(new LimitAlertWatcher().check([account(A, over)], [{ ...alert90, thresholdPct: 100 }])).toHaveLength(1);
    });
});

describe('per account', () => {
    it('A crossing does not fire for B, and B crossing later still fires', () => {
        const w = new LimitAlertWatcher();
        const reset = T0 + HOUR;
        expect(w.check([account(A, live('5h', 95, reset)), account(B, live('5h', 10, reset))], [alert90]).map((f) => f.accountId)).toEqual([A]);
        expect(w.check([account(A, live('5h', 96, reset)), account(B, live('5h', 92, reset))], [alert90]).map((f) => f.accountId)).toEqual([B]);
    });
});

describe('the window an alert watches', () => {
    it('windowMatches: 5h is the 5-hour window, 7d the weekly, any is every window', () => {
        expect(windowMatches('5h', '5h')).toBe(true);
        expect(windowMatches('5h', '7d')).toBe(false);
        expect(windowMatches('7d', '7d')).toBe(true);
        expect(windowMatches('7d', '5h')).toBe(false);
        expect(windowMatches('any', '5h')).toBe(true);
        expect(windowMatches('any', '7d opus')).toBe(true);
        expect(windowMatches('7d', '7d opus')).toBe(false);
    });

    it('a 5-hour alert ignores a weekly reading above it, and the weekly alert hears it', () => {
        const reset = T0 + HOUR;
        const weekly = account(A, live('7d', 96, reset));
        expect(new LimitAlertWatcher().check([weekly], [{ ...alert90, window: '5h' }])).toEqual([]);
        expect(new LimitAlertWatcher().check([weekly], [{ ...alert90, window: '7d' }]).map((f) => f.window)).toEqual(['7d']);
    });

    it('an any alert is armed per window: the 5-hour crossing does not use up the weekly one', () => {
        const w = new LimitAlertWatcher();
        const reset = T0 + HOUR;
        expect(w.check([account(A, live('5h', 95, reset), live('7d', 20, reset + 100 * HOUR))], [alert90]).map((f) => f.window)).toEqual(['5h']);
        expect(w.check([account(A, live('5h', 96, reset), live('7d', 91, reset + 100 * HOUR))], [alert90]).map((f) => f.window)).toEqual(['7d']);
    });
});

describe('the armed state survives a host restart', () => {
    it('a restored watcher does not fire again for a crossing already told', () => {
        const first = new LimitAlertWatcher();
        const reset = T0 + 2 * HOUR;
        expect(first.check([account(A, live('5h', 95, reset))], [alert90])).toHaveLength(1);
        const saved = JSON.parse(JSON.stringify(first.snapshot()));
        const second = new LimitAlertWatcher(saved);
        expect(second.check([account(A, live('5h', 96, reset))], [alert90])).toEqual([]);
    });

    it('CONTROL: a fresh watcher with no saved state does fire for the same reading', () => {
        expect(new LimitAlertWatcher().check([account(A, live('5h', 96, T0 + 2 * HOUR))], [alert90])).toHaveLength(1);
    });

    it('a restored watcher still re-arms on a drop', () => {
        const reset = T0 + 2 * HOUR;
        const first = new LimitAlertWatcher();
        first.check([account(A, live('5h', 95, reset))], [alert90]);
        const second = new LimitAlertWatcher(JSON.parse(JSON.stringify(first.snapshot())));
        second.check([account(A, live('5h', 30, reset))], [alert90]);
        expect(second.check([account(A, live('5h', 94, reset))], [alert90])).toHaveLength(1);
    });

    it('a snapshot that is not the right shape is an empty one, never a throw', () => {
        expect(() => new LimitAlertWatcher('nonsense' as never)).not.toThrow();
        expect(new LimitAlertWatcher({ x: 'no' } as never).check([account(A, live('5h', 95, T0 + HOUR))], [alert90])).toHaveLength(1);
    });

    it('a removed alert armed entry is forgotten, so a new alert with that threshold starts fresh', () => {
        const w = new LimitAlertWatcher();
        w.check([account(A, live('5h', 95, T0 + HOUR))], [alert90]);
        expect(Object.keys(w.snapshot())).toHaveLength(1);
        w.check([account(A, live('5h', 95, T0 + HOUR))], []);
        expect(w.snapshot()).toEqual({});
    });
});

describe('what is said', () => {
    it('names the account, the window, the figure and the reset time', () => {
        const [f] = new LimitAlertWatcher().check([account(A, live('5h', 92, T0 + 2 * HOUR))], [alert90]);
        const words = limitAlertWords(f!, 'Work account');
        expect(words.title).toBe('Work account: 92% of the 5-hour window used');
        expect(words.body).toContain('90%');
        expect(words.body).toMatch(/Resets .*(AM|PM)/);
    });

    it('the weekly window is called weekly', () => {
        const [f] = new LimitAlertWatcher().check([account(A, live('7d', 92, T0 + 2 * HOUR))], [alert90]);
        expect(limitAlertWords(f!, 'Work account').title).toContain('weekly window');
    });
});

describe('Do Not Disturb holds the sound', () => {
    it('plays the alert own sound normally', () => {
        expect(limitAlertSound('alert-vega', {})).toEqual({ kind: 'wav', file: 'alert-vega.ogg' });
        expect(limitAlertSound('triumphant', {})).toEqual({ kind: 'wav', file: 'triumphant.wav' });
        expect(limitAlertSound('synth', {})).toEqual({ kind: 'synth', motif: 'attention' });
    });

    it('is silent in Do Not Disturb, even with the question-chime opt-in', () => {
        expect(limitAlertSound('alert-vega', { do_not_disturb: true })).toBeNull();
        expect(limitAlertSound('alert-vega', { do_not_disturb: true, dnd_question_sound: true })).toBeNull();
    });

    it('is silent when the master switch is off, and when the alert is None', () => {
        expect(limitAlertSound('alert-vega', { notification_sounds: false })).toBeNull();
        expect(limitAlertSound('off', {})).toBeNull();
    });

    it('a sound Genie does not ship plays the Default chime, never a missing file', () => {
        expect(limitAlertSound('no-such-sound', {})).toEqual({ kind: 'synth', motif: 'attention' });
    });
});

describe('the list in settings', () => {
    it('is a hidden host setting that starts empty: nothing new is heard until one is added', () => {
        const def = SETTINGS.find((s) => s.key === 'rate_limit_alerts');
        expect(def).toMatchObject({ group: 'general', scope: 'host', type: 'string', default: '[]', hidden: true });
        expect(parseLimitAlerts(def!.default as string)).toEqual([]);
        expect(sectionOf('rate_limit_alerts')).toBe('notifications');
    });

    it('add keeps the list ordered by threshold', () => {
        let list: RateLimitAlert[] = [];
        list = upsertLimitAlert(list, { id: 'a', thresholdPct: 98, window: 'any', sound: 'synth' });
        list = upsertLimitAlert(list, { id: 'b', thresholdPct: 75, window: '5h', sound: 'synth' });
        list = upsertLimitAlert(list, { id: 'c', thresholdPct: 90, window: '7d', sound: 'synth' });
        expect(list.map((a) => a.thresholdPct)).toEqual([75, 90, 98]);
    });

    it('edit replaces by id and re-orders', () => {
        const list = upsertLimitAlert(
            [{ id: 'a', thresholdPct: 75, window: 'any', sound: 'synth' }, { id: 'b', thresholdPct: 90, window: 'any', sound: 'synth' }],
            { id: 'a', thresholdPct: 95, window: '7d', sound: 'alert-rigel' },
        );
        expect(list).toEqual([{ id: 'b', thresholdPct: 90, window: 'any', sound: 'synth' }, { id: 'a', thresholdPct: 95, window: '7d', sound: 'alert-rigel' }]);
    });

    it('remove drops one by id', () => {
        expect(removeLimitAlert([alert50, alert90], 'l2')).toEqual([alert90]);
    });

    it('survives a round trip through the setting string, ordered', () => {
        const raw = serializeLimitAlerts([alert90, alert50]);
        expect(parseLimitAlerts(raw)).toEqual([alert50, alert90]);
    });

    it('reads forgivingly: junk is empty, a broken row is dropped, a bad window or sound is made usable', () => {
        expect(parseLimitAlerts(undefined)).toEqual([]);
        expect(parseLimitAlerts('not json')).toEqual([]);
        expect(parseLimitAlerts('{"a":1}')).toEqual([]);
        const raw = JSON.stringify([
            { id: 'ok', thresholdPct: 80, window: 'weekly?', sound: 'no-such-sound' },
            { id: 'low', thresholdPct: 0, window: 'any', sound: 'synth' },
            { id: 'high', thresholdPct: 101, window: 'any', sound: 'synth' },
            { id: 'nan', thresholdPct: 'x', window: 'any', sound: 'synth' },
            { thresholdPct: 50, window: 'any', sound: 'synth' },
            { id: 'ok', thresholdPct: 60, window: 'any', sound: 'synth' },
        ]);
        expect(parseLimitAlerts(raw)).toEqual([{ id: 'ok', thresholdPct: 80, window: 'any', sound: 'synth' }]);
    });
});

describe('the host service', () => {
    const reset = T0 + 2 * HOUR;
    const make = (accounts: () => AccountHeadroom[], alerts: () => RateLimitAlert[], disk: { state: unknown }) => {
        const said: LimitAlertSignal[] = [];
        const service = new LimitAlertService({ load: () => disk.state, accounts, alerts, nameOf: () => 'Work account', save: (s) => { disk.state = JSON.parse(JSON.stringify(s)); }, emit: (s) => said.push(s) });
        return { service, said };
    };

    it('emits the alert own sound and the words once, then keeps quiet while above', () => {
        const disk = { state: {} as unknown };
        const { service, said } = make(() => [account(A, live('5h', 95, reset))], () => [alert90], disk);
        service.check();
        service.check();
        expect(said).toHaveLength(1);
        expect(said[0]).toMatchObject({ kind: 'limit-alert', alertId: 'l1', sound: 'alert-vega', title: 'Work account: 95% of the 5-hour window used' });
    });

    it('with no alerts set it reads nothing and says nothing (the default)', () => {
        const disk = { state: {} as unknown };
        let read = 0;
        const { service, said } = make(() => { read++; return [account(A, live('5h', 99, reset))]; }, () => [], disk);
        service.check();
        expect(said).toEqual([]);
        expect(read).toBe(0);
    });

    it('a restarted service loads what the last one saved and does not tell it again', () => {
        const disk = { state: {} as unknown };
        const first = make(() => [account(A, live('5h', 95, reset))], () => [alert90], disk);
        first.service.check();
        expect(first.said).toHaveLength(1);
        const second = make(() => [account(A, live('5h', 96, reset))], () => [alert90], disk);
        second.service.check();
        expect(second.said).toEqual([]);
    });

    it('a state file that cannot be read starts empty', () => {
        const said: LimitAlertSignal[] = [];
        const service = new LimitAlertService({ load: () => { throw new Error('unreadable'); }, accounts: () => [account(A, live('5h', 95, reset))], alerts: () => [alert90], nameOf: () => 'Work account', save: () => {}, emit: (s) => said.push(s) });
        service.check();
        expect(said).toHaveLength(1);
    });
});

describe('with no window open the notice is not lost', () => {
    const reset = T0 + 2 * HOUR;
    const fire = (book: LimitNoticeBook) => {
        const service = new LimitAlertService({
            load: () => ({}), accounts: () => [account(A, live('5h', 95, reset))], alerts: () => [alert90], nameOf: () => 'Work account', save: () => {},
            emit: (signal) => book.record(signal), now: () => T0,
        });
        service.check();
    };
    const empty = () => ({ disk: [] as unknown, saved: [] as unknown[] });

    it('a fired alert is kept as a Deck item naming the account, the window and the reset', () => {
        const d = empty();
        const book = new LimitNoticeBook(() => d.disk, (n) => { d.disk = JSON.parse(JSON.stringify(n)); });
        fire(book);
        const items = book.items(T0 + 1);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ source: 'genie', agentId: null, workspaceId: null, blocking: false, title: 'Work account: 95% of the 5-hour window used', at: T0 });
        expect(items[0]!.id.startsWith(LIMIT_NOTICE_DECK_PREFIX)).toBe(true);
        expect(items[0]!.detail).toMatch(/Resets .*(AM|PM)/);
    });

    it('it is still there when a window opens later: a book made from what was saved lists it', () => {
        const d = empty();
        fire(new LimitNoticeBook(() => d.disk, (n) => { d.disk = JSON.parse(JSON.stringify(n)); }));
        const later = new LimitNoticeBook(() => d.disk, () => {});
        expect(later.items(T0 + HOUR)).toHaveLength(1);
    });

    it('the sound is never kept: the item carries no sound, and opening a window emits nothing', () => {
        const d = empty();
        fire(new LimitNoticeBook(() => d.disk, (n) => { d.disk = JSON.parse(JSON.stringify(n)); }));
        expect(JSON.stringify(d.disk)).not.toContain('alert-vega');
        const later = new LimitNoticeBook(() => d.disk, () => {});
        let heard = 0;
        later.onChange(() => { heard++; });
        later.items(T0 + HOUR);
        expect(heard).toBe(0);
        expect(Object.keys(later.items(T0 + HOUR)[0]!)).not.toContain('sound');
    });

    it('the same firing recorded twice is one notice', () => {
        const d = empty();
        const book = new LimitNoticeBook(() => d.disk, (n) => { d.disk = n; });
        fire(book);
        fire(book);
        expect(book.items(T0 + 1)).toHaveLength(1);
    });

    it('Dismiss answers it: the deck command forgets it, and says so when it is gone', () => {
        const d = empty();
        const book = new LimitNoticeBook(() => d.disk, (n) => { d.disk = n; });
        fire(book);
        const item = book.items(T0 + 1)[0]!;
        expect(resolveDeckAnswer(item, 'dismiss', '')).toEqual({ kind: 'dismiss-limit-alert', id: item.id });
        expect(book.dismiss(item.id)).toBe(true);
        expect(book.items(T0 + 1)).toEqual([]);
        expect(book.dismiss(item.id)).toBe(false);
    });

    it('a notice about a window that has reset is no longer shown', () => {
        const d = empty();
        const book = new LimitNoticeBook(() => d.disk, (n) => { d.disk = n; });
        fire(book);
        expect(book.items(reset - 1)).toHaveLength(1);
        expect(book.items(reset)).toEqual([]);
    });

    it('a notice file that cannot be read starts empty, and a junk row is dropped', () => {
        expect(new LimitNoticeBook(() => { throw new Error('unreadable'); }, () => {}).items(T0)).toEqual([]);
        expect(new LimitNoticeBook(() => [{ id: 'x' }, 7, null], () => {}).items(T0)).toEqual([]);
    });
});
