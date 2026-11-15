import { SOUND_CHOICES, soundFile, type AlertSound } from './alerts.js';
import { clockAmPm } from './clock-words.js';
import type { DeckItem } from './deck.js';
import type { AccountHeadroom } from './headroom-board.js';

/**
 * RATE-LIMIT ALERTS THE PERSON ADDS (Tynn #748; the owner, 2026-11-15: "I want to add a new sound event for Rate limit
 * Alerts. These alerts are added by the user at the threshold they want and each can have a separate sound."). Each alert
 * is a threshold (percent of a window used), the window it watches (5-hour, weekly, any) and its own sound. The list is
 * JSON in the `rate_limit_alerts` setting, ordered by threshold, and EMPTY by default: nothing new is heard until one is
 * added. Read forgivingly, as the saved-prompt library is: a broken row is dropped, the rest survive.
 */
export type LimitWindowChoice = '5h' | '7d' | 'any';

export interface RateLimitAlert {
    readonly id: string;
    /** 1 to 100: the share of the window used at which this alert fires. */
    readonly thresholdPct: number;
    readonly window: LimitWindowChoice;
    /** One of SOUND_CHOICES (`off` = a notice with no sound). */
    readonly sound: string;
}

export const LIMIT_ALERTS_SETTING = 'rate_limit_alerts' as const;

export const LIMIT_WINDOW_CHOICES: ReadonlyArray<{ value: LimitWindowChoice; label: string }> = [
    { value: '5h', label: '5-hour window' },
    { value: '7d', label: 'Weekly window' },
    { value: 'any', label: 'Any window' },
];

const WINDOWS: ReadonlySet<string> = new Set(['5h', '7d', 'any']);
/** A sound an alert may carry: any shipped one but Custom file (an alert has no file of its own). */
const SOUND_VALUES: ReadonlySet<string> = new Set(SOUND_CHOICES.map((c) => c.value).filter((v) => v !== 'custom'));

const byThreshold = (a: RateLimitAlert, b: RateLimitAlert): number => a.thresholdPct - b.thresholdPct || a.id.localeCompare(b.id);

export function parseLimitAlerts(raw: unknown): RateLimitAlert[] {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: RateLimitAlert[] = [];
    for (const row of parsed) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;
        if (typeof r['id'] !== 'string' || r['id'].trim() === '' || seen.has(r['id'])) continue;
        const pct = r['thresholdPct'];
        if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 1 || pct > 100) continue;
        seen.add(r['id']);
        out.push({
            id: r['id'],
            thresholdPct: pct,
            window: typeof r['window'] === 'string' && WINDOWS.has(r['window']) ? (r['window'] as LimitWindowChoice) : 'any',
            sound: typeof r['sound'] === 'string' && SOUND_VALUES.has(r['sound']) ? r['sound'] : 'synth',
        });
    }
    return out.sort(byThreshold);
}

export function serializeLimitAlerts(alerts: readonly RateLimitAlert[]): string {
    return JSON.stringify([...alerts].sort(byThreshold));
}

/** Add or replace an alert by id; the list stays ordered by threshold. */
export function upsertLimitAlert(alerts: readonly RateLimitAlert[], alert: RateLimitAlert): RateLimitAlert[] {
    return [...alerts.filter((a) => a.id !== alert.id), alert].sort(byThreshold);
}

export function removeLimitAlert(alerts: readonly RateLimitAlert[], id: string): RateLimitAlert[] {
    return alerts.filter((a) => a.id !== id);
}

export function newLimitAlertId(now: number, random: number): string {
    return `la-${now.toString(36)}-${Math.floor(random * 1e6).toString(36)}`;
}

/** Whether an alert set to `choice` watches the window the provider labels `label` (`5h`, `7d`, `7d opus`). */
export function windowMatches(choice: LimitWindowChoice, label: string): boolean {
    return choice === 'any' || choice === label;
}

/** The sound an alert plays: the master switch and Do Not Disturb hold it (no exception, as no question is asked), None is silent. */
export function limitAlertSound(choice: string, settings: Readonly<Record<string, boolean | string | undefined>>): AlertSound | null {
    if (settings['notification_sounds'] === false || settings['do_not_disturb'] === true) return null;
    if (choice === 'off') return null;
    const file = soundFile(choice);
    return file !== null ? { kind: 'wav', file } : { kind: 'synth', motif: 'attention' };
}

/** One alert that crossed, for one account's window. */
export interface LimitAlertFiring {
    readonly alert: RateLimitAlert;
    readonly provider: string;
    readonly accountId: string;
    readonly window: string;
    readonly usedPct: number;
    readonly resetsAtMs: number;
}

const WINDOW_WORDS: Readonly<Record<string, string>> = { '5h': '5-hour', '7d': 'weekly' };

/** The notice for a firing, naming the account, the window and when it resets. */
export function limitAlertWords(f: LimitAlertFiring, accountName: string): { title: string; body: string } {
    const window = WINDOW_WORDS[f.window] ?? f.window;
    return { title: `${accountName}: ${f.usedPct}% of the ${window} window used`, body: `Passed your ${f.alert.thresholdPct}% alert. Resets ${clockAmPm(f.resetsAtMs)}.` };
}

/** What is armed: for each `account|window|alert`, the reset time of the window it fired in. */
export type ArmedState = Record<string, number>;

/**
 * Providers re-report a window's reset time with a little jitter; within this it is the same window. The shortest window
 * is hours long, so a reset that is a new window is always further off than this.
 */
const SAME_WINDOW_MS = 10 * 60_000;

/**
 * WHEN AN ALERT FIRES: when an account's window reading is at or above the alert's threshold and the alert has not already
 * fired in this window. It then stays quiet while the reading stays above; a reading below the threshold, a window read
 * Refreshed after its reset, or a window with a new reset time re-arms it. Per account and per window, so one account's
 * crossing never spends another's. The state is plain JSON (`snapshot`) so a restart does not tell it again.
 */
export class LimitAlertWatcher {
    #armed = new Map<string, number>();

    constructor(saved: ArmedState = {}) {
        if (typeof saved !== 'object' || saved === null) return;
        for (const [key, at] of Object.entries(saved)) if (typeof at === 'number' && Number.isFinite(at)) this.#armed.set(key, at);
    }

    check(accounts: readonly AccountHeadroom[], alerts: readonly RateLimitAlert[]): LimitAlertFiring[] {
        const fired: LimitAlertFiring[] = [];
        const ordered = [...alerts].sort(byThreshold);
        const known = new Set(alerts.map((a) => a.id));
        for (const key of [...this.#armed.keys()]) if (!known.has(key.slice(key.lastIndexOf('|') + 1))) this.#armed.delete(key);
        for (const account of accounts) {
            for (const reading of account.windows) {
                for (const alert of ordered) {
                    if (!windowMatches(alert.window, reading.window)) continue;
                    const key = `${account.accountId}|${reading.window}|${alert.id}`;
                    if (reading.refreshed) { this.#armed.delete(key); continue; }
                    const usedPct = reading.over ? 100 : 100 - reading.leftPct;
                    if (usedPct < alert.thresholdPct) { this.#armed.delete(key); continue; }
                    const before = this.#armed.get(key);
                    if (before !== undefined && Math.abs(before - reading.resetsAtMs) < SAME_WINDOW_MS) continue;
                    this.#armed.set(key, reading.resetsAtMs);
                    fired.push({ alert, provider: account.provider, accountId: account.accountId, window: reading.window, usedPct, resetsAtMs: reading.resetsAtMs });
                }
            }
        }
        return fired;
    }

    snapshot(): ArmedState {
        return Object.fromEntries(this.#armed);
    }
}

/** What the host tells its windows when an alert fires: the words, and the alert's own sound by name. */
export interface LimitAlertSignal {
    readonly kind: 'limit-alert';
    /** Unique per firing (alert, account, window, window instance): the key of its kept notice. */
    readonly id: string;
    readonly at: number;
    readonly expiresAtMs: number;
    readonly alertId: string;
    readonly sound: string;
    readonly title: string;
    readonly body: string;
}

/**
 * THE HOST'S HALF: read the accounts and the alerts, fire what crossed, and keep what is armed across a restart. Runs on
 * every reading (a comparison and nothing else when no alert is set), so it costs an agent nothing.
 */
export interface LimitAlertServiceOptions {
    readonly load: () => unknown;
    readonly accounts: () => readonly AccountHeadroom[];
    readonly alerts: () => readonly RateLimitAlert[];
    readonly nameOf: (accountId: string, provider: string) => string;
    readonly save: (state: ArmedState) => void;
    readonly emit: (signal: LimitAlertSignal) => void;
    readonly now?: () => number;
}

export class LimitAlertService {
    readonly #watcher: LimitAlertWatcher;
    #saved: string;
    readonly #o: LimitAlertServiceOptions;

    constructor(options: LimitAlertServiceOptions) {
        this.#o = options;
        const state = ((): ArmedState => { try { return (options.load() as ArmedState) ?? {}; } catch { return {}; } })();
        this.#watcher = new LimitAlertWatcher(state);
        this.#saved = JSON.stringify(this.#watcher.snapshot());
    }

    check(): void {
        const alerts = this.#o.alerts();
        const fired = this.#watcher.check(alerts.length === 0 ? [] : this.#o.accounts(), alerts);
        const now = JSON.stringify(this.#watcher.snapshot());
        if (now !== this.#saved) { this.#saved = now; this.#o.save(this.#watcher.snapshot()); }
        for (const f of fired) {
            const words = limitAlertWords(f, this.#o.nameOf(f.accountId, f.provider));
            this.#o.emit({ kind: 'limit-alert', id: `${LIMIT_NOTICE_DECK_PREFIX}${f.alert.id}:${f.accountId}:${f.window}:${f.resetsAtMs}`, at: (this.#o.now ?? Date.now)(), expiresAtMs: f.resetsAtMs, alertId: f.alert.id, sound: f.alert.sound, ...words });
        }
    }
}

/** Ids of the Deck items a fired alert leaves (source `genie`): answered by Dismiss, never alerting a second time. */
export const LIMIT_NOTICE_DECK_PREFIX = 'genie:limit-alert:';

/**
 * WHAT A FIRED ALERT LEAVES FOR A WINDOW THAT IS NOT OPEN (Tynn #748). The sound is a moment: it plays only in a window
 * open when the alert fires, and is never replayed on open. The NOTICE is kept, as a Deck item, until the person dismisses
 * it or its window resets (after which it is about a limit that no longer holds).
 */
export interface LimitNotice {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly at: number;
    /** When the window it names resets; the notice is dropped from then on. */
    readonly expiresAtMs: number;
}

/** The notices kept at most: the oldest go first. */
export const LIMIT_NOTICE_CAP = 20;

export function limitNoticeDeckItem(n: LimitNotice): DeckItem {
    return {
        id: n.id,
        source: 'genie',
        agentId: null,
        agentName: null,
        workspaceId: null,
        title: n.title,
        blocking: false,
        priority: 'normal',
        at: n.at,
        answer: { kind: 'inline', options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] },
        forwardedFrom: null,
        detail: n.body,
    };
}

function isNotice(v: unknown): v is LimitNotice {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    return typeof r['id'] === 'string' && r['id'].startsWith(LIMIT_NOTICE_DECK_PREFIX) && typeof r['title'] === 'string' && typeof r['body'] === 'string'
        && typeof r['at'] === 'number' && typeof r['expiresAtMs'] === 'number';
}

export class LimitNoticeBook {
    #notices: LimitNotice[];
    readonly #save: (notices: readonly LimitNotice[]) => void;
    readonly #listeners = new Set<() => void>();

    constructor(load: () => unknown, save: (notices: readonly LimitNotice[]) => void) {
        this.#save = save;
        const saved = ((): unknown => { try { return load(); } catch { return []; } })();
        this.#notices = Array.isArray(saved) ? saved.filter(isNotice) : [];
    }

    /** Keep a fired alert's notice (one per id; a repeat of the same id is the same notice). */
    record(signal: LimitAlertSignal): void {
        if (this.#notices.some((n) => n.id === signal.id)) return;
        this.#notices = [...this.#notices, { id: signal.id, title: signal.title, body: signal.body, at: signal.at, expiresAtMs: signal.expiresAtMs }].slice(-LIMIT_NOTICE_CAP);
        this.#changed();
    }

    dismiss(id: string): boolean {
        const next = this.#notices.filter((n) => n.id !== id);
        if (next.length === this.#notices.length) return false;
        this.#notices = next;
        this.#changed();
        return true;
    }

    /** The Deck items now: a notice whose window has reset is not one. */
    items(nowMs: number): DeckItem[] {
        return this.#notices.filter((n) => n.expiresAtMs > nowMs).map(limitNoticeDeckItem);
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        this.#save(this.#notices);
        for (const l of [...this.#listeners]) l();
    }
}
