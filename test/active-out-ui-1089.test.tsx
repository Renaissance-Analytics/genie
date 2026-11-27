// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsAction, AccountsActResult } from '../src/core/account-settings.js';
import { accountsView } from '../src/core/accounts-view.js';
import { AccountsChip } from '../src/renderer/components/AccountsChip.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * "ASK ME" ON SCREEN (Tynn #1089). The active account ran out and another has room: where the held agent is (its chat's
 * context line) and on the Accounts chip, one line says so — "<active> is out until <reset> · <other> has room." — with one
 * click, "Switch to <other>", which is the normal switch (`accounts.act` switch). Nothing switches without that click.
 */

const NOW = new Date(2026, 10, 27, 11, 0).getTime();
const A = `account_${'a'.repeat(32)}`;
const C = `account_${'c'.repeat(32)}`;
const WORDS = 'Account 1 is out until Dec 3, 7:00 AM · Account 3 has room.';
const OUT = { words: WORDS, switchTo: { id: C, label: 'Account 3' } };

describe('the held agent\'s chat line', () => {
    const thread = (activeOut?: typeof OUT): ChatThread => ({
        agentId: 'a1', name: 'tynn', fidelity: 'declared', unread: null,
        context: { text: 'Held · the weekly limit resets Dec 3, 7:00 AM', tone: 'warn' } as never,
        messages: [], ...(activeOut ? { activeOut } : {}),
    } as ChatThread);

    it('says the active account is out and which has room, with one "Switch to" for it', () => {
        const onSwitchAccount = vi.fn();
        const html = renderToStaticMarkup(<ChatFlyout thread={thread(OUT)} onSend={() => {}} onClose={() => {}} onSwitchAccount={onSwitchAccount} />);
        expect(html).toContain('data-chat-active-out');
        expect(html).toContain(WORDS);
        expect(html).toMatch(/data-action="switch-account"[^>]*>(?:<[^>]+>)*Switch to Account 3</);
    });

    it('CONTROL: nothing out, no line and no switch', () => {
        const html = renderToStaticMarkup(<ChatFlyout thread={thread()} onSend={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />);
        expect(html).not.toContain('data-chat-active-out');
        expect(html).not.toContain('data-action="switch-account"');
    });
});

describe('the Accounts chip', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    const KNOWN = [
        { id: A, provider: 'claude', label: 'Account 1', identity: { email: null, plan: null }, configDir: '/g/a', method: 'subscription' as const },
        { id: C, provider: 'claude', label: 'Account 3', identity: { email: null, plan: null }, configDir: '/g/c', method: 'subscription' as const },
    ];

    it('shows the same line, and its Switch is the normal switch to that account', async () => {
        const view = { ...accountsView(KNOWN, [], { claude: A }, {})[0]!, activeOut: OUT };
        const onAct = vi.fn<(action: AccountsAction) => Promise<AccountsActResult>>(async () => ({ ok: true }));
        act(() => root.render(<AccountsChip view={view} offer={null} now={NOW} onSwitch={() => {}} onAccountsAct={onAct} />));
        const line = host.querySelector('[data-accounts-active-out]');
        expect(line?.textContent).toContain(WORDS);
        const button = host.querySelector<HTMLButtonElement>('[data-accounts-active-out] [data-action="switch-account"]');
        expect(button?.textContent).toContain('Switch to Account 3');
        await act(async () => { button!.click(); });
        expect(onAct).toHaveBeenCalledWith({ kind: 'switch', id: C });
    });

    it('CONTROL: nothing out, no line', () => {
        const view = accountsView(KNOWN, [], { claude: A }, {})[0]!;
        act(() => root.render(<AccountsChip view={view} offer={null} now={NOW} onSwitch={() => {}} onAccountsAct={vi.fn(async () => ({ ok: true as const }))} />));
        expect(host.querySelector('[data-accounts-active-out]')).toBeNull();
    });
});
