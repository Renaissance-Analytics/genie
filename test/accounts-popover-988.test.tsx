// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClaudeAuthStatus } from '../src/core/account-identity.js';
import { accountsView, type AccountsSnapshot, type AccountWindowRow } from '../src/core/accounts-view.js';
import type { AccountHeadroom } from '../src/core/headroom-board.js';
import type { WindowReading } from '../src/core/headroom.js';
import { CLOSE_CALL_PCT, rankSwitchNext } from '../src/core/switch-next.js';
import { AccountsChip } from '../src/renderer/components/AccountsChip.js';

/**
 * THE ACCOUNTS POPOVER, WIDE (Tynn #988; the owner, 2026-11-20: "the accounts popover should be wider with the active account
 * being the main view on the left with active stats and account info. additional account are to the right of that stacking in
 * a column, sorted by the account I should switch to next based on remaining amount and reset date on rate limits."). And the
 * plan chip that read "unknown" on every Claude account: `claude auth status` reports `subscriptionType` / `planTier`, never
 * `plan`. Fixtures name no person.
 */
const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 20, 9, 30).getTime();
const live = (window: string, leftPct: number, resetsAtMs: number, over = false): WindowReading => ({ refreshed: false, window, leftPct, over, resetsAtMs });
const acct = (id: string, windows: AccountWindowRow[]) => ({ id, windows });

describe('rankSwitchNext: which account to switch to next (pure)', () => {
    it('the most headroom first: an account\'s headroom is its tightest window', () => {
        const ranked = rankSwitchNext([
            acct('low', [live('5h', 30, NOW + HOUR), live('7d', 90, NOW + 90 * HOUR)]),
            acct('high', [live('5h', 80, NOW + 4 * HOUR), live('7d', 70, NOW + 100 * HOUR)]),
            acct('mid', [live('5h', 95, NOW + 2 * HOUR), live('7d', 50, NOW + 30 * HOUR)]),
        ], NOW);
        expect(ranked.map((a) => a.id)).toEqual(['high', 'mid', 'low']);
    });

    it('a close call (within CLOSE_CALL_PCT of the leader) goes to the earliest reset', () => {
        expect(CLOSE_CALL_PCT).toBe(10);
        const ranked = rankSwitchNext([
            acct('more-late', [live('5h', 72, NOW + 4 * HOUR)]),
            acct('less-soon', [live('5h', 65, NOW + HOUR)]),
            acct('far-behind', [live('5h', 40, NOW + 10 * 60_000)]),
        ], NOW);
        expect(ranked.map((a) => a.id)).toEqual(['less-soon', 'more-late', 'far-behind']);
    });

    it('CONTROL: outside a close call, more headroom wins even with a later reset', () => {
        const ranked = rankSwitchNext([acct('soon', [live('5h', 60, NOW + HOUR)]), acct('late', [live('5h', 75, NOW + 4 * HOUR)])], NOW);
        expect(ranked.map((a) => a.id)).toEqual(['late', 'soon']);
    });

    it('a window past its reset (Refreshed, or its reset time gone by) counts as full', () => {
        const ranked = rankSwitchNext([
            acct('reported', [live('5h', 85, NOW + HOUR)]),
            acct('refreshed', [{ refreshed: true, window: '5h' }]),
            acct('stale', [live('5h', 2, NOW - HOUR)]),
        ], NOW);
        expect(ranked.map((a) => a.id).slice(0, 2).sort()).toEqual(['refreshed', 'stale']);
        expect(ranked[2]!.id).toBe('reported');
    });

    it('an account with no figure at all comes after those with room, and a spent one last, the soonest back first', () => {
        const ranked = rankSwitchNext([
            acct('spent-late', [live('5h', 0, NOW + 3 * HOUR, true)]),
            acct('unknown', [{ unknown: true, window: '5h' }, { unknown: true, window: '7d' }]),
            acct('spent-soon', [live('5h', 40, NOW + HOUR), live('7d', 0, NOW + 2 * HOUR, true)]),
            acct('some', [live('5h', 12, NOW + HOUR)]),
        ], NOW);
        expect(ranked.map((a) => a.id)).toEqual(['some', 'unknown', 'spent-soon', 'spent-late']);
    });

    it('is pure: the input is not reordered, and an empty list is empty', () => {
        const input = [acct('b', [live('5h', 10, NOW + HOUR)]), acct('a', [live('5h', 90, NOW + HOUR)])];
        rankSwitchNext(input, NOW);
        expect(input.map((a) => a.id)).toEqual(['b', 'a']);
        expect(rankSwitchNext([], NOW)).toEqual([]);
    });
});

describe('the Claude plan, as `claude auth status` reports it', () => {
    const status = (extra: Record<string, unknown>) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'work@example.invalid', ...extra });
    it('subscriptionType is the plan; planTier names a Max tier', () => {
        expect(parseClaudeAuthStatus(status({ subscriptionType: 'pro', planTier: 'pro' })).plan).toBe('pro');
        expect(parseClaudeAuthStatus(status({ subscriptionType: 'max', planTier: 'max_20x' })).plan).toBe('max 20x');
        expect(parseClaudeAuthStatus(status({ subscriptionType: 'max', planTier: 'max_5x' })).plan).toBe('max 5x');
        expect(parseClaudeAuthStatus(status({ subscriptionType: 'max', planTier: 'max_other' })).plan).toBe('max');
        expect(parseClaudeAuthStatus(status({ subscriptionType: 'team', planTier: 'other' })).plan).toBe('team');
    });
    it('CONTROL: no subscription reported (an API key sign-in) stays unknown', () => {
        expect(parseClaudeAuthStatus(status({ subscriptionType: null })).plan).toBeNull();
        expect(parseClaudeAuthStatus(status({})).plan).toBeNull();
    });
});

const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const C = `account_${'c'.repeat(32)}`;
const D = `account_${'d'.repeat(32)}`;
const reading = (accountId: string, windows: WindowReading[]): AccountHeadroom => ({
    provider: 'claude', accountId, runId: 'run_1', windows, room: { plan: null, window: '5h', leftPct: 0, resetsAtMs: 0, over: false, windows: [] },
});
const KNOWN = [
    { id: A, provider: 'claude', label: 'Work Max', identity: { email: 'work@example.invalid', plan: 'max 20x' } },
    { id: B, provider: 'claude', label: 'Spare', identity: { email: 'spare@example.invalid', plan: null } },
    { id: C, provider: 'claude', label: 'Lab', identity: { email: 'lab@example.invalid', plan: 'pro' } },
    { id: D, provider: 'claude', label: 'Old', identity: { email: 'old@example.invalid', plan: 'pro' } },
];
const READINGS = [
    reading(A, [live('5h', 20, NOW + HOUR), live('7d', 55, NOW + 40 * HOUR)]),
    reading(B, [live('5h', 30, NOW + 3 * HOUR)]),
    reading(C, [live('5h', 90, NOW + 2 * HOUR), live('7d', 88, NOW + 60 * HOUR)]),
    reading(D, [live('5h', 0, NOW + HOUR, true)]),
];
const VIEW = accountsView(KNOWN, READINGS, { claude: A })[0]!;

describe('the popover: the active account large on the left, the others in a ranked column on the right', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    const open = (onSwitch = vi.fn(), design?: AccountsSnapshot['design']) => {
        act(() => root.render(<AccountsChip view={VIEW} offer={null} now={NOW} onSwitch={onSwitch} design={design} onDesignSignIn={() => {}} />));
        act(() => { host.querySelector('[data-account-chip="claude"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        return document.querySelector('[data-account-popover="claude"]') as HTMLElement;
    };

    it('is wide, with two panes: the active pane first, the others beside it', () => {
        const pop = open();
        expect(pop.getAttribute('data-layout')).toBe('two-pane');
        expect(pop.className).not.toContain('w-72');
        const panes = [...pop.querySelectorAll('[data-accounts-pane]')].map((p) => p.getAttribute('data-accounts-pane'));
        expect(panes).toEqual(['active', 'others']);
    });

    it('the left pane is the active account: its email, plan, signed-in state and every window with its bar and reset', () => {
        const left = open().querySelector('[data-accounts-pane="active"]')!;
        expect([...left.querySelectorAll('[data-account]')].map((s) => s.getAttribute('data-account'))).toEqual([A]);
        expect(left.textContent).toContain('work@example.invalid');
        expect(left.querySelector('[data-account-plan]')!.textContent).toBe('max 20x');
        expect(left.querySelector('[data-account-active]')).not.toBeNull();
        expect(left.querySelectorAll('[data-account-window] [role="progressbar"]')).toHaveLength(2);
        expect(left.querySelector('[data-action="account-switch"]')).toBeNull();
    });

    it('the right column lists the other accounts in switch-next order, each with a Switch', () => {
        const onSwitch = vi.fn();
        const right = open(onSwitch).querySelector('[data-accounts-pane="others"]')!;
        const rows = [...right.querySelectorAll('[data-account]')];
        expect(rows.map((r) => r.getAttribute('data-account'))).toEqual([C, B, D]);
        expect(rows.map((r) => r.getAttribute('data-switch-rank'))).toEqual(['1', '2', '3']);
        act(() => { rows[0]!.querySelector('[data-action="account-switch"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(onSwitch).toHaveBeenCalledWith('claude', 'lab@example.invalid');
    });

    it('an unknown plan draws no chip; a known one does', () => {
        const pop = open();
        expect(pop.querySelector(`[data-account="${B}"] [data-account-plan]`)).toBeNull();
        expect(pop.querySelector(`[data-account="${C}"] [data-account-plan]`)!.textContent).toBe('pro');
    });

    it('Use another account and the Claude Design section stay reachable', () => {
        const pop = open(vi.fn(), { state: 'needed', authorized: false, words: 'Needs sign-in' });
        expect(pop.querySelector('[data-accounts-pane="others"] [data-action="account-use-another"]')).not.toBeNull();
        // Outside the column's scrolling list, so it never scrolls out of view (the real-app proof caught it at 640 px).
        expect(pop.querySelector('[data-accounts-others-list] [data-action="account-use-another"]')).toBeNull();
        expect(pop.querySelector('[data-accounts-others-list] [data-account]')).not.toBeNull();
        expect(pop.querySelector('[data-design-auth]')).not.toBeNull();
    });
});
