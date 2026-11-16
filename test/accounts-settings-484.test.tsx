// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView, type AccountsSnapshot } from '../src/core/accounts-view.js';
import { forgetRefusal, SWITCH_OFFER_WINDOW_CHOICES } from '../src/core/account-settings.js';
import { HeadroomFeed } from '../src/core/headroom-board.js';
import type { Headroom } from '../src/core/headroom.js';
import { memoryPair } from '../src/core/line-transport.js';
import { AccountsHost, type AccountsOptions } from '../src/main/accounts-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { AccountsSettings } from '../src/renderer/components/AccountsSettings.js';

/**
 * ACCOUNTS S11 (Tynn #484): SETTINGS → PROVIDERS → ACCOUNTS, on the same-home model (Tynn #751/#753). Every known account with
 * its usage; Switch (S9, naming the account), Rename, Forget (refused for the signed-in one, saying so) and the offer-window
 * choice (5 h / Weekly / Both). There is no per-agent account picker. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const NOW = new Date(2026, 10, 16, 9, 30).getTime();
const ADA = { name: null, email: 'ada@example.invalid', plan: 'pro' };
const WORK = { name: null, email: 'work@example.invalid', plan: 'max' };

describe('S11: forgetting an account, in the host', () => {
    let dir: string;
    let options: AccountsOptions;
    let n = 0;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-accounts-484-'));
        options = { root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'claude'), codex: join(dir, 'codex') }, now: () => '2026-11-16T09:30:00.000Z',
            mintId: () => `account_${String(++n).padStart(32, '0')}` };
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the signed-in account is refused, saying so, and the book is unchanged', async () => {
        const book = await AccountsHost.open(options);
        const work = (await book.recordSignedIn('claude', WORK))!;
        await expect(book.forget(work.id)).rejects.toThrow(/signed in/i);
        expect((await AccountsHost.open(options)).get(work.id)).not.toBeNull();
    });
    it('another known account is forgotten, and stays gone after a reopen', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', WORK);
        const ada = (await book.recordSignedIn('claude', ADA))!;
        await book.recordSignedIn('claude', WORK);
        await book.forget(ada.id);
        expect(book.get(ada.id)).toBeNull();
        expect((await AccountsHost.open(options)).get(ada.id)).toBeNull();
    });
    it('the first account (the book\'s placeholder) is reset, never removed: the next new sign-in claims it', async () => {
        const book = await AccountsHost.open(options);
        const first = (await book.recordSignedIn('claude', WORK))!;
        await book.recordSignedIn('claude', ADA);
        await book.forget(first.id);
        expect(book.get(first.id)).toMatchObject({ identity: { email: null, plan: null }, labelEdited: false });
        const back = (await book.recordSignedIn('claude', { name: null, email: 'third@example.invalid', plan: null }))!;
        expect(back.id).toBe(first.id);
    });
    it('CONTROL: a rename sticks across a reopen, and a later identity read keeps it', async () => {
        const book = await AccountsHost.open(options);
        const work = (await book.recordSignedIn('claude', WORK))!;
        await book.rename(work.id, 'Work Max');
        await book.recordSignedIn('claude', WORK);
        expect((await AccountsHost.open(options)).get(work.id)!.label).toBe('Work Max');
    });
    it('a forgotten account\'s readings leave the board', () => {
        const feed = new HeadroomFeed(() => 0, () => NOW);
        const room: Headroom = { plan: null, window: '5h', leftPct: 40, resetsAtMs: NOW + 3_600_000, over: false, windows: [{ window: '5h', usedPct: 60, leftPct: 40, resetsAtMs: NOW + 3_600_000, over: false }] };
        feed.offer('claude', room, { accountId: 'account_x', runId: 'r' });
        expect(feed.accounts().map((a) => a.accountId)).toEqual(['account_x']);
        feed.forget('account_x');
        expect(feed.accounts()).toEqual([]);
    });
});

describe('S11: a window renames and forgets through the host', () => {
    const close: Array<() => void> = [];
    afterEach(() => { for (const fn of close.splice(0)) fn(); });
    async function connection(act: (a: unknown) => Promise<unknown>, local = true) {
        const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', accountsAct: act as never });
        const client = new SessionEngineClient(), [h, w] = memoryPair();
        server.accept(h, { local }); close.push(() => w.close());
        expect(await client.connect(w, 'fixture')).toMatchObject({ ok: true });
        return client;
    }
    it('this machine\'s window: rename and forget reach the host; a refusal comes back as its reason', async () => {
        const seen: unknown[] = [];
        const client = await connection(async (a) => { seen.push(a); return (a as { kind: string }).kind === 'forget' ? { ok: false, reason: 'Work Max is signed in.' } : { ok: true }; });
        expect(await client.accountsAct({ kind: 'rename', id: 'account_a', label: 'Work Max' })).toEqual({ ok: true });
        expect(await client.accountsAct({ kind: 'forget', id: 'account_a' })).toEqual({ ok: false, reason: 'Work Max is signed in.' });
        expect(seen).toEqual([{ kind: 'rename', id: 'account_a', label: 'Work Max' }, { kind: 'forget', id: 'account_a' }]);
    });
    it('CONTROL: another connection is refused', async () => {
        const client = await connection(async () => { throw new Error('must not run'); }, false);
        expect(await client.call('engine.accountsAct', [{ kind: 'forget', id: 'x' }])).toMatchObject({ ok: false });
    });
});

const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const SNAP: AccountsSnapshot = {
    providers: accountsView([
        { id: A, provider: 'claude', label: 'Work Max', identity: { email: 'work@example.invalid', plan: 'max' } },
        { id: B, provider: 'claude', label: 'Home', identity: { email: 'ada@example.invalid', plan: null } },
    ], [{ provider: 'claude', accountId: A, runId: 'r', windows: [{ refreshed: false, window: '5h', leftPct: 40, over: false, resetsAtMs: NOW + 3_600_000 }], room: { plan: null, window: '5h', leftPct: 40, resetsAtMs: 0, over: false, windows: [] } }], { claude: A }),
    offers: [],
};

describe('S11: the Accounts block in Settings → Providers', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
    const render = (h: Partial<Parameters<typeof AccountsSettings>[0]> = {}) => {
        const props = { snapshot: SNAP, offerWindows: 'both', onSetOfferWindows: vi.fn(), onSwitch: vi.fn(), onAct: vi.fn(async () => ({ ok: true as const })), now: NOW, ...h };
        act(() => root.render(<AccountsSettings {...props} />));
        return props;
    };
    const row = (id: string) => host.querySelector(`[data-settings-account="${id}"]`) as HTMLElement;

    it('lists every known account with its usage: name, plan or unknown, and its windows', () => {
        render();
        expect([...host.querySelectorAll('[data-settings-account]')].map((r) => r.getAttribute('data-settings-account'))).toEqual([A, B]);
        expect(row(A).textContent).toContain('Work Max');
        expect(row(A).querySelector('[data-account-plan]')!.textContent).toBe('max');
        expect(row(B).querySelector('[data-account-plan]')!.textContent).toBe('unknown');
        expect(row(A).querySelector('[data-account-usage="5h"]')!.textContent).toContain('40%');
        expect(row(B).querySelector('[data-account-usage="5h"]')!.textContent).toContain('unknown');
    });
    it('Forget on the signed-in account is refused, says so, and never asks the host', async () => {
        const p = render();
        await click(row(A).querySelector('[data-action="account-forget"]')!);
        expect(row(A).querySelector('[data-account-refused]')!.textContent).toBe(forgetRefusal(SNAP.providers[0]!.accounts[0]!));
        expect(row(A).querySelector('[data-account-refused]')!.textContent).toMatch(/signed in/i);
        expect(p.onAct).not.toHaveBeenCalled();
    });
    it('Forget on another account asks the host; Rename saves the typed name', async () => {
        const p = render();
        await click(row(B).querySelector('[data-action="account-forget"]')!);
        expect(p.onAct).toHaveBeenCalledWith({ kind: 'forget', id: B });
        await click(row(B).querySelector('[data-action="account-rename"]')!);
        const input = row(B).querySelector('input[data-account-rename-input]') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Personal Pro');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(row(B).querySelector('[data-action="account-rename-save"]')!);
        expect(p.onAct).toHaveBeenCalledWith({ kind: 'rename', id: B, label: 'Personal Pro' });
    });
    it('Switch on another account is one click and names it; the signed-in one has none', async () => {
        const p = render();
        expect(row(A).querySelector('[data-action="account-switch"]')).toBeNull();
        await click(row(B).querySelector('[data-action="account-switch"]')!);
        expect(p.onSwitch).toHaveBeenCalledWith('claude', 'ada@example.invalid');
    });
    it('the offer-window choice offers 5 h / Weekly / Both and saves it', async () => {
        expect(SWITCH_OFFER_WINDOW_CHOICES.map((c) => c.value)).toEqual(['5h', 'weekly', 'both']);
        const p = render({ offerWindows: 'both' });
        const choice = host.querySelector('[data-switch-offer-windows]')!;
        expect(choice).not.toBeNull();
        const weekly = [...choice.querySelectorAll('button, [role="radio"]')].find((b) => b.textContent?.trim() === 'Weekly')!;
        await click(weekly);
        expect(p.onSetOfferWindows).toHaveBeenCalledWith('weekly');
    });
    it('every action is a react-fancy Button, the choice a MultiSwitch, and no raw <button>', () => {
        const s = source('src/renderer/components/AccountsSettings.tsx');
        expect(s).not.toMatch(/<button\b/);
        for (const c of ['Button', 'MultiSwitch', 'Badge', 'Input']) expect(s).toMatch(new RegExp(`import \\{[^}]*\\b${c}\\b[^}]*\\} from '@particle-academy/react-fancy'`));
    });
    it('CONTROL: there is no per-agent account picker anywhere in the window', () => {
        const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []; });
        for (const f of files(join(__dirname, '..', 'src/renderer'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/data-agent-account|agent-account-picker|setAgentAccount/);
    });
});

describe('S11: a reset placeholder is not a blank row (the coordinator, 2026-11-16)', () => {
    const P = `account_legacy_claude`;
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    it('an account with no email, no reading and not signed in is listed nowhere until a sign-in claims it', () => {
        const view = accountsView([
            { id: P, provider: 'claude', label: 'Account 1', identity: { email: null, plan: null } },
            { id: B, provider: 'claude', label: 'Home', identity: { email: 'ada@example.invalid', plan: null } },
        ], [], { claude: B });
        expect(view.find((v) => v.provider === 'claude')!.accounts.map((a) => a.id)).toEqual([B]);
        act(() => root.render(<AccountsSettings snapshot={{ providers: view, offers: [] }} offerWindows="both" onSetOfferWindows={() => {}} now={NOW} />));
        expect([...host.querySelectorAll('[data-settings-account]')].map((r) => r.getAttribute('data-settings-account'))).toEqual([B]);
    });
    it('CONTROL: the signed-in account is listed even before its identity is read, and one with a reading is too', () => {
        const reading = { provider: 'claude', accountId: B, runId: 'r', windows: [], room: { plan: null, window: '5h', leftPct: 40, resetsAtMs: 0, over: false, windows: [] } };
        const view = accountsView([
            { id: P, provider: 'claude', label: 'Account 1', identity: { email: null, plan: null } },
            { id: B, provider: 'claude', label: 'Account 2', identity: { email: null, plan: null } },
        ], [reading], { claude: P });
        expect(view.find((v) => v.provider === 'claude')!.accounts.map((a) => a.id)).toEqual([P, B]);
    });
});

describe('S11: wired through', () => {
    it('genie-host acts on the book and the board; main and the preload carry it; Shell hands the accounts to Settings', () => {
        expect(source('src/main/genie-host.ts')).toMatch(/accountsAct: \(action\) => accountsAct\(/);
        expect(source('src/main/main.ts')).toMatch(/ipcMain\.handle\('genie:accounts-act'/);
        expect(source('src/main/preload.ts')).toMatch(/accountsAct: \(action\) => ipcRenderer\.invoke\('genie:accounts-act', action\)/);
        expect(source('src/renderer/Shell.tsx')).toMatch(/<AccountsSettings|accountsSettings=\{/);
    });
});
