// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView } from '../src/core/accounts-view.js';
import type { ClaudeAccountLive } from '../src/core/claude-accounts.js';
import type { AccountsAction, AccountsActResult } from '../src/core/account-settings.js';
import { AccountsChip } from '../src/renderer/components/AccountsChip.js';

/**
 * THE POPOVER FOR CLAUDE ACCOUNTS OF THEIR OWN (Tynn #1011), on the two panes of Tynn #988. Each account's live state is what
 * Claude Code reports now (prism-acp `describe`), and a mismatch is prism's typed comparison (`check`): never text parsed.
 * An account with its own directory is switched to with ONE click (no terminal, no login TUI); one not signed in yet offers
 * Sign in (Claude Code's own login, in a window the person sees). Add account: subscription or Console. Every action is a
 * react-fancy Button. Fixtures name no person.
 */
const NOW = new Date(2026, 10, 21, 18, 0).getTime();
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const C = `account_${'c'.repeat(32)}`;
const ready = (over: Partial<ClaudeAccountLive> = {}): ClaudeAccountLive => ({ signedIn: true, method: 'subscription', billing: 'subscription', email: 'work@example.invalid', org: 'Example Org', plan: 'max', loginExpiresAt: '2026-12-01T00:00:00Z', directoryMatched: true, check: { state: 'ready', differences: [] }, ...over });
const KNOWN = [
    { id: A, provider: 'claude', label: 'Work', identity: { email: 'work@example.invalid', plan: 'max' }, configDir: '/g/a', method: 'subscription' as const },
    { id: B, provider: 'claude', label: 'Team API', identity: { email: null, plan: null }, configDir: '/g/b', method: 'console' as const },
    { id: C, provider: 'claude', label: 'Lab', identity: { email: 'lab@example.invalid', plan: 'pro' }, configDir: '/g/c', method: 'subscription' as const },
];
const LIVE: Record<string, ClaudeAccountLive> = {
    [A]: ready(),
    [B]: ready({ signedIn: false, method: 'none', billing: 'none', email: null, org: null, plan: null, loginExpiresAt: null, check: { state: 'signedOut', differences: [] } }),
    [C]: ready({ email: 'lab@example.invalid', method: 'console', billing: 'apiUsage', check: { state: 'mismatch', differences: ['method'] } }),
};
const VIEW = accountsView(KNOWN, [], { claude: A }, LIVE)[0]!;

describe('the view carries each account\'s live state and whether it has its own directory', () => {
    it('an added account waiting for its sign-in is listed; its method and live state travel with it', () => {
        expect(VIEW.accounts.map((a) => a.id)).toEqual([A, B, C]);
        expect(VIEW.accounts.find((a) => a.id === B)).toMatchObject({ ownDirectory: true, method: 'console', live: { signedIn: false } });
    });
});

describe('the popover: live state, one-click switch, sign in, add', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    type Act = (action: AccountsAction) => Promise<AccountsActResult>;
    const open = (handlers: { onSwitch?: (provider: string, choose?: string) => void; onAct?: Act } = {}) => {
        act(() => root.render(<AccountsChip view={VIEW} offer={null} now={NOW} onSwitch={handlers.onSwitch ?? (() => {})} onAccountsAct={handlers.onAct ?? vi.fn<Act>(async () => ({ ok: true }))} />));
        act(() => { host.querySelector('[data-account-chip="claude"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        return document.querySelector('[data-account-popover="claude"]') as HTMLElement;
    };
    const click = (el: Element | null) => { act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

    it('the active account shows its live state, its billing and its org, from describe', () => {
        const left = open().querySelector('[data-accounts-pane="active"]')!;
        expect(left.querySelector('[data-account-live]')!.getAttribute('data-account-live')).toBe('ready');
        expect(left.querySelector('[data-account-billing]')!.textContent).toBe('Subscription');
        expect(left.textContent).toContain('Example Org');
    });

    it('the left pane IS the active account: with a live state, one pill (Signed in), never "Active" beside it', () => {
        const left = open().querySelector('[data-accounts-pane="active"]')!;
        expect(left.querySelectorAll('[data-account-live]')).toHaveLength(1);
        expect(left.querySelector('[data-account-active]')).toBeNull();
        expect(left.textContent).not.toMatch(/\bActive\b/);
    });

    it('the footer\'s three rows (Add subscription, Add Console, Use another account) line up from the left edge', () => {
        const pop = open();
        const rows = ['account-add-subscription', 'account-add-console', 'account-use-another'].map((a) => pop.querySelector(`[data-action="${a}"]`)!);
        for (const row of rows) { expect(row).not.toBeNull(); expect(row.className).toContain('justify-start'); expect(row.className).toContain('w-full'); }
    });

    it('a mismatch is a badge saying which typed difference it is', () => {
        const row = open().querySelector(`[data-account="${C}"]`)!;
        const badge = row.querySelector('[data-account-live="mismatch"]')!;
        expect(badge).not.toBeNull();
        expect(badge.getAttribute('data-differences')).toBe('method');
        expect(badge.getAttribute('title')).toMatch(/billed another way/);
    });

    it('Switch on an account with its own directory makes it active: one click, no login terminal', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        const pop = open({ onAct, onSwitch });
        click(pop.querySelector(`[data-account="${C}"] [data-action="account-switch"]`));
        expect(onAct).toHaveBeenCalledWith({ kind: 'set-active', id: C });
        expect(onSwitch).not.toHaveBeenCalled();
    });

    it('an account not signed in shows Sign in DISABLED, saying it comes with prism-acp (never a terminal), not Switch', () => {
        // The owner: "I should not see any terminals nor do we store login keys."
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        const row = open({ onAct, onSwitch }).querySelector(`[data-account="${B}"]`)!;
        expect(row.querySelector('[data-action="account-switch"]')).toBeNull();
        const button = row.querySelector('[data-action="account-sign-in"]') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('title')).toMatch(/no terminal/);
        expect(row.textContent).toContain('Coming with the next prism-acp');
        click(button);
        expect(onAct).not.toHaveBeenCalled();
        expect(onSwitch).not.toHaveBeenCalled();
    });

    it('Add account offers a subscription or a Console (API-billed) account', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const pop = open({ onAct });
        click(pop.querySelector('[data-action="account-add-subscription"]'));
        click(pop.querySelector('[data-action="account-add-console"]'));
        expect(onAct.mock.calls.map((c) => c[0])).toEqual([{ kind: 'add-claude', method: 'subscription' }, { kind: 'add-claude', method: 'console' }]);
    });

    it('every action in the chip is a react-fancy Button (source guard)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/renderer/components/AccountsChip.tsx'), 'utf8');
        expect(src).not.toMatch(/<button[\s>]/);
        expect(src).not.toMatch(/<(a|div|span|section|li)\b[^>]*onClick=/);
        // The positive control: the guard can see the Buttons that are there.
        expect(src.match(/<Button\b/g)?.length ?? 0).toBeGreaterThan(5);
    });
});
