// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView } from '../src/core/accounts-view.js';
import type { ClaudeAccountLive, ClaudeSignInView } from '../src/core/claude-accounts.js';
import type { AccountsAction, AccountsActResult } from '../src/core/account-settings.js';
import { AccountsChip } from '../src/renderer/components/AccountsChip.js';
import { AccountsSettings } from '../src/renderer/components/AccountsSettings.js';

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
    const open = (handlers: { onSwitch?: (provider: string, choose?: string) => void; onAct?: Act; signIns?: readonly ClaudeSignInView[] } = {}) => {
        act(() => root.render(<AccountsChip view={VIEW} offer={null} now={NOW} onSwitch={handlers.onSwitch ?? (() => {})} onAccountsAct={handlers.onAct ?? vi.fn<Act>(async () => ({ ok: true }))} signIns={handlers.signIns} />));
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

    it('an account not signed in offers Sign in: the browser sign-in (an action), never a terminal or the login window', () => {
        // The owner: "I should not see any terminals nor do we store login keys."
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        const row = open({ onAct, onSwitch }).querySelector(`[data-account="${B}"]`)!;
        expect(row.querySelector('[data-action="account-switch"]')).toBeNull();
        const button = row.querySelector('[data-action="account-sign-in"]') as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        click(button);
        expect(onAct).toHaveBeenCalledWith({ kind: 'sign-in', id: B });
        expect(onSwitch).not.toHaveBeenCalled();
    });

    it('a sign-in in progress says to finish it in the browser, with Cancel; no code field unless the CLI asked', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const pop = open({ onAct, signIns: [{ accountId: B, label: 'Team API', state: 'browser' }] });
        const pending = pop.querySelector(`[data-sign-in-pending="${B}"]`)!;
        expect(pending.textContent).toMatch(/Finish signing in to Team API in your browser/);
        expect(pending.querySelector('[data-sign-in-code]')).toBeNull();
        click(pending.querySelector('[data-action="sign-in-cancel"]'));
        expect(onAct).toHaveBeenCalledWith({ kind: 'cancel-sign-in', id: B });
    });

    it('when the CLI asks for a code: a field, and Send hands the code to it, once', async () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const pop = open({ onAct, signIns: [{ accountId: B, label: 'Team API', state: 'code', requestId: 'req-1' }] });
        const field = pop.querySelector(`[data-sign-in-pending="${B}"] [data-sign-in-code] input`) as HTMLInputElement;
        expect(field).not.toBeNull();
        act(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(field, 'abc-123'); field.dispatchEvent(new Event('input', { bubbles: true })); });
        click(pop.querySelector('[data-action="sign-in-send-code"]'));
        expect(onAct).toHaveBeenCalledWith({ kind: 'submit-code', requestId: 'req-1', code: 'abc-123' });
    });

    it('Use another account (Claude) is the browser sign-in of a new account, not the provider\'s login window', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        click(open({ onAct, onSwitch }).querySelector('[data-action="account-use-another"]'));
        expect(onAct).toHaveBeenCalledWith({ kind: 'use-another', method: 'subscription' });
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

describe('Settings → Accounts: "Sign out and remove" (prism-acp logout(), no window)', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });
    const HOME = `account_${'d'.repeat(32)}`;
    const snapshot = { providers: accountsView([...KNOWN, { id: HOME, provider: 'claude', label: 'Home', identity: { email: 'home@example.invalid', plan: null } }], [], { claude: A }, LIVE), offers: [] };

    it('beside Forget on an account with its own folder that is not active; never on the active one or a default-home one', () => {
        const onAct = vi.fn(async (_a: AccountsAction): Promise<AccountsActResult> => ({ ok: true }));
        act(() => root.render(<AccountsSettings snapshot={snapshot} offerWindows="both" onSetOfferWindows={() => {}} onAct={onAct} />));
        const row = (id: string) => host.querySelector(`[data-settings-account="${id}"]`)!;
        expect(row(A).querySelector('[data-action="account-sign-out"]')).toBeNull();
        expect(row(HOME).querySelector('[data-action="account-sign-out"]')).toBeNull();
        const button = row(C).querySelector('[data-action="account-sign-out"]')!;
        expect(button.textContent).toBe('Sign out and remove');
        act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(onAct).toHaveBeenCalledWith({ kind: 'sign-out', id: C });
    });
});

/**
 * THE REVIEW OF #2139, findings 2 and 7e. Switch acts on the account's ID: the host is asked to switch to THAT account, and it
 * is the host that makes it active when Claude Code says it is signed in, and signs it in only when it is not. Sign in is
 * offered only for an account Claude Code SAID is signed out; while its state is not known yet, the button is Switch.
 */
describe('Switch names the account by its id; Sign in only for an account known to be signed out', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    type Act = (action: AccountsAction) => Promise<AccountsActResult>;
    const click = (el: Element | null) => { act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
    // C's state has not been read yet (a describe still running, or one that failed): no `live` for it.
    const UNKNOWN_C = accountsView(KNOWN, [], { claude: A }, { [A]: LIVE[A]!, [B]: LIVE[B]! })[0]!;
    const D = `account_${'d'.repeat(32)}`;
    // Two accounts with ONE email: the default-home one and one with a folder of its own.
    const TWINS = [...KNOWN, { id: D, provider: 'claude', label: 'Lab (home)', identity: { email: 'lab@example.invalid', plan: 'pro' } }];

    it('the chip: an account whose state is not known yet offers Switch, never Sign in, and Switch asks the host for THAT account', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        act(() => root.render(<AccountsChip view={UNKNOWN_C} offer={null} now={NOW} onSwitch={onSwitch} onAccountsAct={onAct} />));
        click(host.querySelector('[data-account-chip="claude"]'));
        const row = document.querySelector(`[data-account-popover="claude"] [data-account="${C}"]`)!;
        expect(row.querySelector('[data-action="account-sign-in"]')).toBeNull();
        click(row.querySelector('[data-action="account-switch"]'));
        expect(onAct.mock.calls).toEqual([[{ kind: 'switch', id: C }]]);
        expect(onSwitch).not.toHaveBeenCalled();
        // CONTROL, same popover: the one Claude Code said is signed out still offers Sign in.
        expect(document.querySelector(`[data-account-popover="claude"] [data-account="${B}"] [data-action="account-sign-in"]`)).not.toBeNull();
    });

    it('the chip: the offer\'s Switch asks the host for the account it suggests, by id', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        const offer = { id: 'switch-offer:a:5h:1', provider: 'claude', accountId: A, label: 'Work', window: '5h' as const, leftPct: 8, over: false, resetsAtMs: NOW + 3_600_000,
            targets: [{ accountId: C, label: 'Lab', room: 'unknown' as const, leftPct: null, resetsAtMs: null }] };
        act(() => root.render(<AccountsChip view={VIEW} offer={offer} now={NOW} onSwitch={onSwitch} onAccountsAct={onAct} />));
        click(host.querySelector('[data-account-chip="claude"]'));
        click(document.querySelector('[data-action="switch-offer-switch"]'));
        expect(onAct.mock.calls).toEqual([[{ kind: 'switch', id: C }]]);
        expect(onSwitch).not.toHaveBeenCalled();
    });

    it('Settings: Switch on a Claude account asks the host for that account by id (never a login by its email), also when two share an email', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        const snapshot = { providers: accountsView(TWINS, [], { claude: A }, LIVE), offers: [] };
        act(() => root.render(<AccountsSettings snapshot={snapshot} offerWindows="both" onSetOfferWindows={() => {}} onSwitch={onSwitch} onAct={onAct} />));
        const row = (id: string) => host.querySelector(`[data-settings-account="${id}"]`)!;
        click(row(C).querySelector('[data-action="account-switch"]'));
        click(row(D).querySelector('[data-action="account-switch"]'));
        click(row(B).querySelector('[data-action="account-switch"]'));
        expect(onAct.mock.calls).toEqual([[{ kind: 'switch', id: C }], [{ kind: 'switch', id: D }], [{ kind: 'switch', id: B }]]);
        expect(onSwitch).not.toHaveBeenCalled();
    });

    it('Settings: what the host refuses is said on that account\'s row', async () => {
        const onAct = vi.fn<Act>(async () => ({ ok: false, reason: 'Genie could not ask Claude Code whether Lab is signed in. Try again in a moment.' }));
        const snapshot = { providers: accountsView(KNOWN, [], { claude: A }, LIVE), offers: [] };
        act(() => root.render(<AccountsSettings snapshot={snapshot} offerWindows="both" onSetOfferWindows={() => {}} onSwitch={() => {}} onAct={onAct} />));
        await act(async () => { host.querySelector(`[data-settings-account="${C}"] [data-action="account-switch"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(host.querySelector(`[data-settings-account="${C}"]`)!.textContent).toContain('Genie could not ask Claude Code whether Lab is signed in.');
    });

    it('CONTROL: another provider\'s Switch is still its own login, naming the account', () => {
        const onAct = vi.fn<Act>(async () => ({ ok: true }));
        const onSwitch = vi.fn<(provider: string, choose?: string) => void>();
        const X = `account_${'e'.repeat(32)}`, Y = `account_${'f'.repeat(32)}`;
        const snapshot = { providers: accountsView([
            { id: X, provider: 'codex', label: 'First', identity: { email: 'first@example.invalid', plan: null } },
            { id: Y, provider: 'codex', label: 'Second', identity: { email: 'second@example.invalid', plan: null } },
        ], [], { codex: X }), offers: [] };
        act(() => root.render(<AccountsSettings snapshot={snapshot} offerWindows="both" onSetOfferWindows={() => {}} onSwitch={onSwitch} onAct={onAct} />));
        click(host.querySelector(`[data-settings-account="${Y}"] [data-action="account-switch"]`));
        expect(onSwitch.mock.calls).toEqual([['codex', 'second@example.invalid']]);
        expect(onAct).not.toHaveBeenCalled();
    });
});
