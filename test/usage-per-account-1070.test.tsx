// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import { accountsView, type AccountsSnapshot, type KnownAccountRecord } from '../src/core/accounts-view.js';
import { HeadroomFeed, type AccountHeadroom } from '../src/core/headroom-board.js';
import { limitRows, usedWords, type Headroom, type WindowReading } from '../src/core/headroom.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { ReadingAttribution } from '../src/core/reading-attribution.js';
import type { DriverEvents, SessionDriver } from '../src/core/session.js';
import { offerWords, SwitchOfferService, switchTargets, targetWords, type SwitchOffer } from '../src/core/switch-offer.js';
import type { IdentityReadHooks } from '../src/main/account-identity.js';
import { headroomArrival, IdentityWatch, identityReadHooks } from '../src/main/identity-watch.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { RateLimitPills } from '../src/renderer/components/Dashboard.js';

/**
 * EVERY ACCOUNT'S USAGE IS ITS OWN (Tynn #1070; the owner, 2026-11-26: "ALL FUCKING ACCOUNTS ARE SHARING THE SAME FUCKING 5 HR
 * RATE counter"). Three accounts showed one 5 h 0 % / 7 d 36 %: a run still in the spent account's own directory kept reading,
 * each reading started a read of who is signed in, and that read handed the reading back under the ACTIVE account; the board
 * then kept the copied 5 h window forever, because the new account reports no 5 h window of its own to replace it, and saved
 * it to disk. And accounts are not one shape: some have no 5 h window, some a per-model weekly cap. An account shows the
 * windows ITS reading has, an account never read shows unknown, and a limit stops only the account it is on.
 *
 * Fixtures name no person.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const THREAD_1 = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c51';
const THREAD_2 = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c52';
const acct = (suffix: string, configDir: string): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider: 'claude', label: `Account ${suffix}`, labelEdited: false, home: '/home/.claude', legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', configDir, method: 'subscription',
});
const A = acct('1', '/genie/accounts/claude/a');
const B = acct('2', '/genie/accounts/claude/b');
const C = acct('3', '/genie/accounts/claude/c');
const known = (a: AccountRecord): KnownAccountRecord => ({ id: a.id, provider: a.provider, label: a.label, identity: { email: a.identity.email, plan: a.identity.plan }, configDir: a.configDir! });

/** A Claude rate-limit frame as prism-acp carries it: the windows THIS account's provider reported, nothing else. */
const frame = (status: 'allowed' | 'rejected', binding: string, windows: Record<string, { utilization: number; resetsAtMs: number }>) => ({
    sessionUpdate: 'notice', notice: { level: 'info', message: status === 'rejected' ? 'You have hit your limit' : 'usage' },
    _meta: { 'particle.academy/rate_limit': { status, rateLimitType: binding, resetsAtMs: windows[binding]!.resetsAtMs, windows, raw: {} } },
});

interface Driver { readonly events: DriverEvents; readonly account: AccountRecord | undefined; prompts: unknown[] }

function world(dir: string, hosts: SessionHost[]) {
    let active: AccountRecord = A;
    const drivers: Driver[] = [];
    const actions: Array<[string, string]> = [];
    let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
    const tree: ProcessTree = {
        snapshot: () => [...processes],
        killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
    };
    const driverFor: DriverFor = (agent, _cwd, _resume, extras) => ({ events }) => {
        const pid = process.pid + 3_000_000 + drivers.length + 1;
        let running = false;
        const d: Driver = { events, account: extras?.account, prompts: [] };
        drivers.push(d);
        const driver: SessionDriver = {
            start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
            prompt: (content) => { d.prompts.push(content); },
            cancel: () => Promise.resolve(),
            kill: () => { running = false; processes = processes.filter((p) => p.pid !== pid); },
            get running() { return running; },
            get cliSessionId() { return agent.threadId ?? null; },
        };
        return driver;
    };
    // genie-host's own wiring: a reading may start a read of who is signed in (#854), held meanwhile (#753), then the board.
    const feed = new HeadroomFeed(() => 0);
    const attribution = new ReadingAttribution();
    let hooks: IdentityReadHooks | null = null;
    const watch = new IdentityWatch({
        refresh: async (provider) => { hooks!.readStart(provider); await new Promise((r) => setTimeout(r, 5)); hooks!.readEnd(provider); },
        now: () => Date.now(),
    });
    hooks = identityReadHooks({ attribution, activeId: () => active.id, offer: (p, room, stamp) => feed.offer(p, room, stamp), changed: () => {}, read: (p) => watch.read(p) });
    const host = new SessionHost({
        userData: dir, driverFor, processTree: tree, stopGraceMs: 0,
        activeAccount: () => active,
        threadInAccount: () => 'present',
        onHeadroom: headroomArrival({ watch, attribution, offer: (p, room, stamp) => feed.offer(p, room, stamp) }),
        onAction: (id, kind) => { actions.push([id, kind]); },
    });
    hosts.push(host);
    const agent = (name: string, threadId: string): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name }), threadId });
    const switchTo = (a: AccountRecord) => { active = a; host.accountChanged('claude'); host.accountSwitched('claude', { account: a, headroom: null }); };
    const view = () => accountsView([A, B, C].map(known), feed.accounts(), { claude: active.id }).find((p) => p.provider === 'claude')!;
    return { host, drivers, actions, feed, agent, switchTo, view };
}

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 10)); };
const windowsOf = (v: ReturnType<ReturnType<typeof world>['view']>, id: string) => v.accounts.find((a) => a.id === id)!.windows;

describe('each account\'s windows come from that account (the host, end to end)', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-usage-1070-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    /** Agent 1 is in a turn on A when the person switches to B; agent 2 starts on B. Each run reports its own account. */
    async function twoAccounts() {
        const w = world(dir, hosts);
        const one = w.agent('atlas', THREAD_1);
        expect(w.host.start(one, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        w.host.prompt(one.id, 'work', 'you'); // a turn in hand: it stays on A's process past the switch
        w.switchTo(B);
        const two = w.agent('vega', THREAD_2);
        expect(w.host.start(two, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        expect(w.drivers[1]!.account?.id).toBe(B.id);
        return { ...w, one, two };
    }

    it('two accounts with different usage show different bars: A its 5 h and week, B only its week and its per-model weekly cap', async () => {
        const w = await twoAccounts();
        const now = Date.now();
        // A: spent in its 5 h window. B: an account with NO 5 h window at all, a week mostly free, and a per-model cap at half.
        w.drivers[0]!.events.onUpdate?.(frame('allowed', 'five_hour', { five_hour: { utilization: 1, resetsAtMs: now + 72 * MIN }, seven_day: { utilization: 0.36, resetsAtMs: now + 116 * HOUR } }));
        await settle();
        w.drivers[1]!.events.onUpdate?.(frame('allowed', 'seven_day', { seven_day: { utilization: 0.05, resetsAtMs: now + 140 * HOUR }, seven_day_fable: { utilization: 0.5, resetsAtMs: now + 140 * HOUR } }));
        await settle();
        const v = w.view();
        const left = (id: string) => Object.fromEntries(windowsOf(v, id).map((r) => [r.window, 'leftPct' in r ? r.leftPct : r]));
        expect(left(A.id)).toEqual({ '5h': 0, '7d': 64 });
        // B has exactly the windows B reported: no 5 h bar (never A's 0 %), its own week, and its per-model weekly cap.
        expect(left(B.id)).toEqual({ '7d': 95, '7d fable': 50 });
    });

    it('an account never read shows unknown: no windows of anyone else\'s, and no made-up 5 h or weekly rows', async () => {
        const w = await twoAccounts();
        const now = Date.now();
        w.drivers[0]!.events.onUpdate?.(frame('allowed', 'five_hour', { five_hour: { utilization: 1, resetsAtMs: now + 72 * MIN } }));
        await settle();
        const c = w.view().accounts.find((a) => a.id === C.id)!;
        expect(c.read).toBe(false);
        expect(c.windows).toEqual([]);
        // CONTROL: an account that was read says so.
        expect(w.view().accounts.find((a) => a.id === A.id)!.read).toBe(true);
    });

    it('after a switch the limit follows the NEW account: a 5 h refusal from the run still on A never stops the agent on B', async () => {
        const w = await twoAccounts();
        const now = Date.now();
        w.drivers[0]!.events.onUpdate?.(frame('rejected', 'five_hour', { five_hour: { utilization: 1, resetsAtMs: now + 72 * MIN } }));
        await settle();
        // B has no 5 h window; A's refusal is A's. The agent on B is open and its prompt goes through.
        expect(w.host.probe(w.two.id)?.limit).toEqual({ state: 'open' });
        expect(w.host.heldLogins().map((l) => l.account)).not.toContain(B.id);
        w.host.prompt(w.two.id, 'go on', 'you');
        await vi.waitFor(() => expect(w.drivers[1]!.prompts.map(String).join('\n')).toContain('go on'));
        // CONTROL: the refusal did land, on A's agent: it was held (the one 'limited' for A's login), and only it.
        expect(w.actions.filter(([, k]) => k === 'limited').map(([id]) => id)).toEqual([w.one.id]);
    });

    it('the agent the OLD account refused after the switch moves to the new account at once, and is not left held on A', async () => {
        const w = await twoAccounts();
        w.drivers[0]!.events.onUpdate?.(frame('rejected', 'five_hour', { five_hour: { utilization: 1, resetsAtMs: Date.now() + 72 * MIN } }));
        // CONTROL: it was held by A's refusal.
        await vi.waitFor(() => expect(w.actions.filter(([, k]) => k === 'limited').map(([id]) => id)).toEqual([w.one.id]));
        // Then it moves: a new run on B, its limit open, and A's login holds nobody.
        await vi.waitFor(() => expect(w.drivers).toHaveLength(3));
        expect(w.drivers[2]!.account?.id).toBe(B.id);
        await vi.waitFor(() => expect(w.host.probe(w.one.id)?.limit).toEqual({ state: 'open' }));
        expect(w.host.heldLogins()).toEqual([]);
    });
});

describe('the saved board (Tynn #485) brings back no reading written before #1070', () => {
    const room: Headroom = { plan: null, window: '5h', leftPct: 0, resetsAtMs: 9_999_999_999_999, over: true, windows: [{ window: '5h', usedPct: 100, leftPct: 0, resetsAtMs: 9_999_999_999_999, over: true }] };
    it('an old board (a bare list) may hold one account\'s figure under another\'s name: it is dropped, and those accounts read unknown', () => {
        const feed = new HeadroomFeed(() => 0);
        feed.restore([{ source: { provider: 'claude', accountId: B.id }, runId: 'r', room }]);
        expect(feed.accounts()).toEqual([]);
    });
    it('CONTROL: a board saved now comes back whole', () => {
        const saved = new HeadroomFeed(() => 0);
        saved.offer('claude', room, { accountId: A.id, runId: 'r' });
        const back = new HeadroomFeed(() => 0);
        back.restore(JSON.parse(JSON.stringify(saved.snapshot())));
        expect(back.accounts().map((r) => [r.accountId, r.room.leftPct])).toEqual([[A.id, 0]]);
    });
});

describe('the Dashboard\'s limit popover lists the windows the account has', () => {
    it('no 5 h row for an account with no 5 h window; its per-model cap is listed', () => {
        const h: Headroom = { plan: null, window: '7d', leftPct: 95, resetsAtMs: 2e12, over: false, windows: [
            { window: '7d', usedPct: 5, leftPct: 95, resetsAtMs: 2e12, over: false }, { window: '7d fable', usedPct: 50, leftPct: 50, resetsAtMs: 2e12, over: false },
        ] };
        expect(limitRows(h).map((r) => r.window)).toEqual(['7d', '7d fable']);
    });
});

const NOW = new Date(2026, 10, 26, 15, 0).getTime();
const live = (window: string, leftPct: number, resetsAtMs = NOW + 10 * HOUR, over = false): WindowReading => ({ refreshed: false, window, leftPct, over, resetsAtMs });
const reading = (accountId: string, windows: WindowReading[]): AccountHeadroom => ({ provider: 'claude', accountId, runId: 'r', windows, room: { plan: null, window: windows[0]!.window, leftPct: 0, resetsAtMs: 0, over: false, windows: [] } });
const D = acct('4', '/genie/accounts/claude/d');

describe('the switch offer\'s numbers are the bars\', and its words read', () => {
    it('a target is judged by ALL its own windows: B with no 5 h window but a free week has room; D whose model cap is spent has none', () => {
        const readings = [reading(A.id, [live('5h', 3)]), reading(B.id, [live('7d', 95), live('7d fable', 50)]), reading(D.id, [live('7d', 80), live('7d fable', 0, NOW + 10 * HOUR, true)])];
        const targets = switchTargets({ provider: 'claude', accountId: A.id, window: '5h', leftPct: 3 }, readings, [A, B, C, D]);
        // B: its tightest window is the fable cap at 50 %; C was never read; D's spent cap would stop it at once.
        expect(targets.map((t) => [t.accountId, t.room, t.leftPct, t.window])).toEqual([[B.id, 'reported', 50, '7d fable'], [C.id, 'unknown', null, null]]);
    });

    it('a standing offer says the figure the bar says now, not the one it was made with', () => {
        let readings = [reading(A.id, [live('5h', 8)])];
        const service = new SwitchOfferService({ readings: () => readings, known: () => [A, B], active: () => ({ claude: A.id }), choice: () => 'both', now: () => NOW });
        service.check();
        expect(service.offers()[0]!.leftPct).toBe(8);
        readings = [reading(A.id, [live('5h', 2)])];
        expect(service.offers()[0]).toMatchObject({ leftPct: 2, over: false });
    });

    it('the words, the provider's own: "N% used in the 5-hour window", "spent this week"; a target with its own window; one never read is said so', () => {
        const offer = (window: string, leftPct: number, over: boolean): SwitchOffer => ({ id: 'o', provider: 'claude', accountId: A.id, label: 'Account 1', window, leftPct, over, resetsAtMs: NOW + HOUR, targets: [] });
        expect(offerWords(offer('5h', 0, false))).toBe('Account 1: 100% used in the 5-hour window.');
        expect(offerWords(offer('7d', 0, true))).toBe('Account 1: spent this week.');
        expect(offerWords(offer('7d fable', 4, false))).toBe('Account 1: 96% used in the 7d fable window.');
        expect(targetWords({ accountId: B.id, label: 'Account 2', room: 'reported', leftPct: 95, resetsAtMs: NOW + HOUR, window: '7d' })).toBe('Account 2 (5% used this week)');
        expect(targetWords({ accountId: C.id, label: 'Account 3', room: 'unknown', leftPct: null, resetsAtMs: null, window: null })).toBe('Account 3 (room not known yet)');
    });
});

describe('the Accounts popover draws each account\'s own windows', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let el: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
    afterEach(() => { act(() => root.unmount()); el.remove(); document.body.innerHTML = ''; });

    it('A shows 5 h and week; B shows its week and its model cap and no 5 h; C, never read, says unknown; the offer reads', () => {
        const readings = [reading(A.id, [live('5h', 0), live('7d', 64)]), reading(B.id, [live('7d', 95), live('7d fable', 50)])];
        const offers: SwitchOffer[] = [{ id: 'o', provider: 'claude', accountId: A.id, label: 'Account 1', window: '5h', leftPct: 0, over: false, resetsAtMs: NOW + HOUR,
            targets: switchTargets({ provider: 'claude', accountId: A.id, window: '5h', leftPct: 0 }, readings, [A, B, C]) }];
        const snapshot: AccountsSnapshot = { providers: accountsView([A, B, C].map(known), readings, { claude: A.id }), offers };
        act(() => root.render(<RateLimitPills limits={{}} accounts={snapshot} now={NOW} />));
        act(() => { el.querySelector('[data-account-chip="claude"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const pop = document.querySelector('[data-account-popover="claude"]')!;
        const windows = (id: string) => [...pop.querySelectorAll(`[data-account="${id}"] [data-account-window]`)].map((x) => x.getAttribute('data-account-window'));
        expect(windows(A.id)).toEqual(['5h', '7d']);
        expect(windows(B.id)).toEqual(['7d', '7d fable']);
        expect(windows(C.id)).toEqual([]);
        expect(pop.querySelector(`[data-account="${C.id}"] [data-account-usage-unknown]`)!.textContent).toContain('unknown');
        const callout = pop.querySelector('[data-switch-offer]')!.textContent!;
        expect(callout).toContain('Account 1: 100% used in the 5-hour window.');
        expect(callout).not.toMatch(/window window|of its/);
        expect(callout).toContain('Account 2 (50% used in the 7d fable window)');
    });
});

describe('ONE meaning of a figure, said on screen, the provider's own: the share USED (Tynn #1070 review; Claude's page says "95% used")', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let el: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
    afterEach(() => { act(() => root.unmount()); el.remove(); document.body.innerHTML = ''; });

    it('the words: "N% used", "over" when spent past the allowance', () => {
        expect(usedWords({ leftPct: 64, over: false })).toBe('36% used');
        expect(usedWords({ leftPct: 0, over: false })).toBe('100% used');
        expect(usedWords({ leftPct: 0, over: true })).toBe('over');
    });

    it('every bar in the popover says "% used" beside a fill of that share; the chip says it too', () => {
        const readings = [reading(A.id, [live('5h', 0), live('7d', 64)]), reading(B.id, [live('7d', 95), live('7d fable', 50)])];
        const snapshot: AccountsSnapshot = { providers: accountsView([A, B, C].map(known), readings, { claude: A.id }), offers: [] };
        act(() => root.render(<RateLimitPills limits={{}} accounts={snapshot} now={NOW} />));
        const chip = el.querySelector('[data-account-chip="claude"]')!;
        expect(chip.textContent).toContain('100% used');
        act(() => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const pop = document.querySelector('[data-account-popover="claude"]')!;
        const said = (id: string, w: string) => pop.querySelector(`[data-account="${id}"] [data-account-window="${w}"]`)!;
        expect(said(A.id, '7d').textContent).toContain('36% used');
        expect(said(A.id, '5h').textContent).toContain('100% used');
        expect(said(B.id, '7d').textContent).toContain('5% used');
        expect(said(B.id, '7d fable').textContent).toContain('50% used');
        // The fill is the share used: 36 of 100.
        expect(said(A.id, '7d').querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('36');
    });

    it('the headline is the TIGHTEST window: 95 % used on 7d (5 % left) and 50 % on the model cap headlines 7d', () => {
        const readings = [reading(B.id, [live('7d', 5), live('7d fable', 50)])];
        const snapshot: AccountsSnapshot = { providers: accountsView([B].map(known), readings, { claude: B.id }), offers: [] };
        act(() => root.render(<RateLimitPills limits={{}} accounts={snapshot} now={NOW} />));
        const chip = el.querySelector('[data-account-chip="claude"]')!;
        expect(chip.textContent).toBe('Account 295% used7d');
        // And the offer's suggestion names it: B's room is its 7d at 5 % left, too near to suggest at all.
        expect(switchTargets({ provider: 'claude', accountId: A.id, window: '5h', leftPct: 0 }, readings, [A, B])).toEqual([]);
    });
});
