// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSwitchWords, type AccountSwitchOutcome } from '../src/core/account-switch.js';
import { accountsView } from '../src/core/accounts-view.js';
import type { AcpProvider } from '../src/core/engine.js';
import { accountSwitchSteps } from '../src/core/provider-login.js';
import { AccountSwitchFlow } from '../src/main/account-switch-host.js';
import { AccountsHost } from '../src/main/accounts-host.js';
import { AccountsSettings } from '../src/renderer/components/AccountsSettings.js';
import { RateLimitPills } from '../src/renderer/components/Dashboard.js';

/**
 * USE ANOTHER ACCOUNT (Tynn #850; the owner: "where is my button to switch to a new account? all I see is the ui for the one I
 * am in now but no way to switch to a new one."). Switch only showed on OTHER known accounts, so with one known account there
 * was no way to sign in with a new one. Each provider now has an always-present "Use another account" in the header popover
 * and in Settings → Providers → Accounts. It opens the same provider login a Switch does, naming no account, and its steps say
 * to pick or create a DIFFERENT one. After the login Genie reads who is signed in: a new email becomes a known account and the
 * active one, and the toast names it; the same account again is reported as that. One active account per provider (#751);
 * Genie never touches a subscription's credentials. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const NOW = new Date(2026, 10, 17, 9, 30).getTime();
const A = `account_${'a'.repeat(32)}`;
const X = `account_${'d'.repeat(32)}`;
/** ONE known account per provider: the case the owner hit. */
const ONE_EACH = [
    { id: A, provider: 'claude', label: 'Work Max', identity: { email: 'work@example.invalid', plan: 'max' } },
    { id: X, provider: 'codex', label: 'Account 1', identity: { email: null, plan: null } },
];

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

describe('the header popover', () => {
    it('with ONE known account, the popover has "Use another account": it opens the provider login naming no account', () => {
        const onSwitchAccount = vi.fn();
        act(() => root.render(<RateLimitPills limits={{}} accounts={{ providers: accountsView(ONE_EACH, [], { claude: A, codex: X }), offers: [] }} now={NOW} onSwitchAccount={onSwitchAccount} />));
        click(host.querySelector('[data-account-chip="claude"]')!);
        const pop = document.querySelector('[data-account-popover="claude"]')!;
        // CONTROL: the only account is the signed-in one, so it has no Switch (the gap the owner hit).
        expect(pop.querySelectorAll('[data-action="account-switch"]')).toHaveLength(0);
        const another = pop.querySelectorAll('[data-action="account-use-another"]');
        expect(another).toHaveLength(1);
        expect(another[0]!.tagName).toBe('BUTTON');
        expect(another[0]!.textContent).toContain('Use another account');
        click(another[0]!);
        expect(onSwitchAccount.mock.calls.map(([p, choose]) => [p, choose ?? null])).toEqual([['claude', null]]);
    });
    it('it stays there beside Switch when there are other known accounts too', () => {
        const B = `account_${'b'.repeat(32)}`;
        const two = [...ONE_EACH, { id: B, provider: 'claude', label: 'Home', identity: { email: 'home@example.invalid', plan: null } }];
        act(() => root.render(<RateLimitPills limits={{}} accounts={{ providers: accountsView(two, [], { claude: A, codex: X }), offers: [] }} now={NOW} onSwitchAccount={vi.fn()} />));
        click(host.querySelector('[data-account-chip="claude"]')!);
        const pop = document.querySelector('[data-account-popover="claude"]')!;
        expect(pop.querySelectorAll('[data-action="account-switch"]')).toHaveLength(1);
        expect(pop.querySelectorAll('[data-action="account-use-another"]')).toHaveLength(1);
    });
});

describe('Settings → Providers → Accounts', () => {
    it('each provider has one "Use another account", even with one known account; it names no account', () => {
        const onSwitch = vi.fn();
        act(() => root.render(<AccountsSettings snapshot={{ providers: accountsView(ONE_EACH, [], { claude: A, codex: X }), offers: [] }} offerWindows="both" onSetOfferWindows={vi.fn()} onSwitch={onSwitch} now={NOW} />));
        for (const provider of ['claude', 'codex']) {
            const block = host.querySelector(`[data-settings-accounts-provider="${provider}"]`)!;
            expect(block.querySelectorAll('[data-action="account-switch"]')).toHaveLength(0);
            const another = block.querySelectorAll('[data-action="account-use-another"]');
            expect(another).toHaveLength(1);
            click(another[0]!);
        }
        expect(onSwitch.mock.calls.map(([p, choose]) => [p, choose ?? null])).toEqual([['claude', null], ['codex', null]]);
    });
    it('both are react-fancy Buttons with an icon (source guard)', () => {
        for (const file of ['src/renderer/components/AccountsChip.tsx', 'src/renderer/components/AccountsSettings.tsx']) {
            expect(source(file)).toMatch(/<Button[^>]*icon="user-plus"[^>]*data-action="account-use-another"/);
        }
    });
});

describe('the steps, with no account named', () => {
    it.each(['claude', 'codex'] as const)('%s: pick or create a DIFFERENT account; never "the other account"', (provider) => {
        const steps = accountSwitchSteps(provider).join('\n');
        expect(steps).toMatch(/a different account/);
        expect(steps).toMatch(/create/);
        expect(steps).not.toContain('the other account');
    });
    it('CONTROL: a Switch on a known account still names it', () => {
        expect(accountSwitchSteps('claude', 'home@example.invalid').join('\n')).toContain('choose home@example.invalid');
    });
});

describe('after the login: the host reads who is signed in', () => {
    let dir: string;
    afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

    /** The real account book and the real switch flow; only the provider's terminal and its identity answer are stand-ins. */
    async function rig() {
        dir = await mkdtemp(join(tmpdir(), 'genie-850-'));
        const book = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'claude-home'), codex: join(dir, 'codex-home') } });
        await book.recordSignedIn('claude', { name: null, email: 'work@example.invalid', plan: 'max' });
        let signedInAs = 'work@example.invalid';
        const emitted: AccountSwitchOutcome[] = [];
        const flow = new AccountSwitchFlow({
            login: { startSwitch: () => ({ ok: true as const, terminalId: 't1' }) },
            active: (p) => { const a = book.activeFor(p as AcpProvider); return { id: a.id, label: a.label }; },
            readIdentity: async (p) => { await book.recordSignedIn(p as AcpProvider, { name: null, email: signedInAs, plan: null }); },
            emit: (o) => emitted.push(o),
        });
        return { book, flow, emitted, signIn: (email: string) => { signedInAs = email; } };
    }

    it('a NEW account: it becomes known and active, and the toast names it', async () => {
        const { book, flow, signIn } = await rig();
        const before = book.activeFor('claude');
        expect(flow.start('claude').ok).toBe(true);
        signIn('new@example.invalid');
        const outcome = await flow.settle('claude', true);
        const known = book.list().filter((a) => a.provider === 'claude');
        expect(known.map((a) => a.identity.email)).toEqual(['work@example.invalid', 'new@example.invalid']);
        const now = book.activeFor('claude');
        expect(now.identity.email).toBe('new@example.invalid');
        expect(now.id).not.toBe(before.id);
        expect(outcome).toMatchObject({ kind: 'switched', accountId: now.id, label: 'new@example.invalid', fromAccountId: before.id });
        expect(accountSwitchWords(outcome!).title).toContain('new@example.invalid');
    });
    it('the SAME account again: reported as that, and no new account is made', async () => {
        const { book, flow } = await rig();
        flow.start('claude');
        const outcome = await flow.settle('claude', true);
        expect(book.list().filter((a) => a.provider === 'claude')).toHaveLength(1);
        expect(outcome).toMatchObject({ kind: 'unchanged', label: 'work@example.invalid' });
        const words = accountSwitchWords(outcome!);
        expect(words.title).toBe('Still on work@example.invalid');
        expect(words.body).toMatch(/still signed in as work@example\.invalid/);
    });
});
