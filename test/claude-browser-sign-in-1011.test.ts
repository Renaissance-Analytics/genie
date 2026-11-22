import { describe, expect, it, vi } from 'vitest';
import { accountsActionOf } from '../src/core/account-settings.js';
import type { AccountRecord } from '../src/core/accounts.js';
import { isClaudeSignInUrl } from '../src/core/claude-accounts.js';
import { ClaudeSignIns, type ClaudeLoginOptions, type ClaudeSignInPorts } from '../src/main/claude-sign-ins.js';
import { hostSignIns } from '../src/main/host-sign-ins.js';
import { LoginHost } from '../src/main/login-host.js';

/**
 * SIGN IN IN THE BROWSER, NEVER A TERMINAL (Tynn #1011; the owner: "I should not see any terminals nor do we store login keys").
 * Every Claude sign-in goes through prism-acp's hidden `claudeAccounts.login(configDir, { onUrl, onCodeRequested, signal })`:
 * Genie opens Anthropic's page in the person's browser (only an https URL on Anthropic's sign-in hosts), shows a code field
 * ONLY if the CLI asks for a pasted code, passes that code straight through and keeps it nowhere. One sign-in per account
 * folder at a time; nothing is prepared or launched in that folder while it runs. Sign out is prism-acp's `logout()`.
 * Fixtures name no person.
 */
const ctx = { connectionId: 'c1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'x' } as const;
const rec = (id: string, extra: Partial<AccountRecord> = {}): AccountRecord => ({ id, provider: 'claude', label: 'Team API', labelEdited: true, home: '/home/.claude', legacy: false,
    identity: { name: null, email: 'team@example.invalid', plan: null }, createdAt: '2026-11-21T00:00:00Z', configDir: `/g/accounts/claude/${id}`, method: 'console', ...extra });
const OWN = rec(`account_${'1'.repeat(32)}`);
const { configDir: _homeDir, method: _homeMethod, ...HOME_BASE } = rec(`account_${'2'.repeat(32)}`, { label: 'Home', identity: { name: null, email: 'home@example.invalid', plan: null } });
const HOME: AccountRecord = HOME_BASE;
const ADDED = rec(`account_${'3'.repeat(32)}`, { label: 'Account 3', identity: { name: null, email: null, plan: null }, method: 'subscription' });
const URL_OK = 'https://claude.ai/oauth/authorize?code=true&state=abc';

function world(over: Partial<ClaudeSignInPorts> = {}) {
    const book = new Map<string, AccountRecord>([[OWN.id, OWN], [HOME.id, HOME]]);
    let active = 'account_legacy_claude';
    const calls: string[] = [];
    const opened: string[] = [];
    const notices: string[] = [];
    let login: { configDir: string; options: ClaudeLoginOptions; resolve: (s: { signedIn: boolean; email?: string }) => void; reject: (e: unknown) => void } | null = null;
    const ports: ClaudeSignInPorts = {
        get: (id) => book.get(id) ?? null,
        activeId: () => active,
        addClaude: async (input) => { calls.push(`add ${input.method}${input.label ? ` ${input.label}` : ''}`); const a = { ...ADDED, method: input.method, ...(input.label ? { label: input.label } : {}) }; book.set(a.id, a); return a; },
        setActive: async (id) => { calls.push(`active ${id}`); active = id; },
        activated: (provider, id) => { calls.push(`activated ${provider} ${id}`); },
        recordIdentity: async (id, identity) => { calls.push(`identity ${id} ${identity.email}`); },
        forget: async (id) => { calls.push(`forget ${id}`); book.delete(id); },
        removeDir: (dir) => { calls.push(`remove ${dir}`); return { ok: true }; },
        open: async (url, c) => { opened.push(`${url} @${c?.connectionId ?? 'none'}`); },
        changed: () => { calls.push('changed'); },
        tell: (words) => { notices.push(words); },
        platform: 'linux',
        login: (configDir, options) => new Promise((resolve, reject) => { login = { configDir, options, resolve, reject }; }),
        logout: async (configDir) => { calls.push(`logout ${configDir}`); },
        describe: async () => ({ signedIn: false }),
        ...over,
    };
    const s = new ClaudeSignIns(ports);
    return { s, ports, calls, opened, notices, book, current: () => login!, setActive: (id: string) => { active = id; } };
}

describe('a sign-in: prism-acp login() for the account\'s own folder, Anthropic\'s page in the browser', () => {
    it('runs login() in the account\'s folder with its method and email, and opens the URL it gives on the window that asked', async () => {
        const w = world();
        expect(await w.s.signIn(OWN.id, ctx)).toEqual({ ok: true });
        expect(w.current().configDir).toBe(OWN.configDir);
        expect(w.current().options).toMatchObject({ method: 'console', email: 'team@example.invalid' });
        w.current().options.onUrl(URL_OK);
        await vi.waitFor(() => expect(w.opened).toEqual([`${URL_OK} @c1`]));
        expect(w.s.view()).toEqual([{ accountId: OWN.id, label: 'Team API', state: 'browser' }]);
    });

    it('opens ONLY an https URL on Anthropic\'s sign-in hosts', () => {
        for (const ok of [URL_OK, 'https://claude.com/x', 'https://platform.claude.com/x', 'https://console.anthropic.com/x']) expect(isClaudeSignInUrl(ok), ok).toBe(true);
        for (const bad of ['http://claude.ai/x', 'https://claude.ai.evil.example/x', 'https://evil.example/?claude.ai', 'file:///etc/passwd', 'javascript:alert(1)', 'https://anthropic.com.evil/x']) expect(isClaudeSignInUrl(bad), bad).toBe(false);
    });

    it('a URL that is not Anthropic\'s is never opened', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        w.current().options.onUrl('https://evil.example/login');
        await new Promise((r) => setTimeout(r, 10));
        expect(w.opened).toEqual([]);
    });

    it('signed in: what the CLI reports is recorded, and nothing becomes active that was not asked to', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        w.current().resolve({ signedIn: true, email: 'team@example.invalid' });
        await vi.waitFor(() => expect(w.s.view()).toEqual([]));
        expect(w.calls).toContain(`identity ${OWN.id} team@example.invalid`);
        expect(w.calls.some((c) => c.startsWith('active'))).toBe(false);
        expect(w.notices.at(-1)).toMatch(/Team API is signed in/);
    });

    it('the code field shows ONLY when the CLI asks; the code goes straight to it and is kept nowhere', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        expect(w.s.view()[0]!.state).not.toBe('code');
        const asked = w.current().options.onCodeRequested!(new AbortController().signal);
        const code = w.s.view()[0];
        expect(code).toMatchObject({ accountId: OWN.id, state: 'code' });
        expect(typeof code!.requestId).toBe('string');
        expect(w.s.submitCode(code!.requestId!, 'SECRET-CODE-123')).toBe(true);
        await expect(asked).resolves.toBe('SECRET-CODE-123');
        // Nowhere: not in the view, not in what was said, not in what was recorded.
        expect(JSON.stringify(w.s.view())).not.toContain('SECRET-CODE');
        expect(JSON.stringify([w.notices, w.calls])).not.toContain('SECRET-CODE');
        expect(w.s.submitCode(code!.requestId!, 'again')).toBe(false);
    });

    it('Cancel stops it: the signal aborts, nothing is recorded or made active, and it says so', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        expect(w.s.cancel(OWN.id)).toBe(true);
        expect(w.current().options.signal?.aborted).toBe(true);
        w.current().reject(Object.assign(new Error('cancelled'), { name: 'ClaudeLoginError', code: 'cancelled' }));
        await vi.waitFor(() => expect(w.s.view()).toEqual([]));
        expect(w.calls.filter((c) => c.startsWith('identity') || c.startsWith('active'))).toEqual([]);
        expect(w.notices.at(-1)).toMatch(/cancelled/i);
    });

    it('ONE sign-in per folder: a second click joins it, and the folder is busy (nothing prepared or launched there) while it runs', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        const first = w.current();
        expect(await w.s.signIn(OWN.id, ctx)).toEqual({ ok: true });
        expect(w.current()).toBe(first);
        expect(w.s.busy(OWN.configDir!)).toBe(true);
        first.resolve({ signedIn: true, email: 'team@example.invalid' });
        await vi.waitFor(() => expect(w.s.busy(OWN.configDir!)).toBe(false));
    });

    it('macOS is not supported: refused, nothing runs', async () => {
        const w = world({ platform: 'darwin' });
        const r = await w.s.signIn(OWN.id, ctx);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/macOS/);
    });
});

describe('Use another account, and a default-home account: a folder of their own, signed in in the browser, then active', () => {
    it('Use another account adds an account and signs it in; once signed in it is the active one, and agents are told', async () => {
        const w = world();
        expect(await w.s.useAnother('subscription', ctx)).toEqual({ ok: true });
        expect(w.calls).toContain('add subscription');
        expect(w.current().configDir).toBe(ADDED.configDir);
        w.current().resolve({ signedIn: true, email: 'new@example.invalid' });
        await vi.waitFor(() => expect(w.calls).toContain(`active ${ADDED.id}`));
        expect(w.calls).toContain(`activated claude ${ADDED.id}`);
    });

    it('a default-home account not signed in now is signed in in a folder of its own (email prefilled); once in, it replaces the old entry', async () => {
        const w = world();
        await w.s.signIn(HOME.id, ctx);
        expect(w.calls).toContain('add subscription Home');
        expect(w.current().options).toMatchObject({ email: 'home@example.invalid' });
        w.current().resolve({ signedIn: true, email: 'home@example.invalid' });
        await vi.waitFor(() => expect(w.calls).toContain(`active ${ADDED.id}`));
        expect(w.calls).toContain(`forget ${HOME.id}`);
    });

    it('a sign-in that ends signed out (the person gave up) leaves the added account waiting, and nothing active changes', async () => {
        const w = world();
        await w.s.useAnother('console', ctx);
        w.current().resolve({ signedIn: false });
        await vi.waitFor(() => expect(w.s.view()).toEqual([]));
        expect(w.calls.some((c) => c.startsWith('active'))).toBe(false);
    });
});

describe('Sign out and remove: prism-acp logout(), then the folder (its shared-history link removed as a link)', () => {
    it('signed out: forgotten, then its folder removed', async () => {
        const w = world({ describe: async () => ({ signedIn: false }) });
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(w.calls).toEqual([`logout ${OWN.configDir}`, `forget ${OWN.id}`, `remove ${OWN.configDir}`, 'changed']);
        expect(w.notices.at(-1)).toMatch(/signed out and removed/);
    });
    it('still signed in after logout: kept, and said', async () => {
        const w = world({ describe: async () => ({ signedIn: true }) });
        await w.s.signOut(OWN.id);
        expect(w.calls.filter((c) => c.startsWith('forget') || c.startsWith('remove'))).toEqual([]);
        expect(w.notices.at(-1)).toMatch(/still signed in/);
    });
    it('the ACTIVE account, or one with no folder of its own, is refused before anything runs', async () => {
        const w = world();
        w.setActive(OWN.id);
        expect((await w.s.signOut(OWN.id)).ok).toBe(false);
        expect((await w.s.signOut(HOME.id)).ok).toBe(false);
        expect(w.calls).toEqual([]);
    });
    it('not while that folder is signing in', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        expect((await w.s.signOut(OWN.id)).ok).toBe(false);
    });
});

describe('no terminal for Claude anywhere', () => {
    it('the login host refuses a Claude terminal login (the default account\'s too); Claude Design keeps its own', () => {
        const opened: unknown[] = [];
        const login = new LoginHost({ terminals: { open: (o: unknown) => { opened.push(o); return { id: 't' } as never; }, onExit: () => () => {}, close: () => {} } as never,
            openWindow: () => {}, runStatus: async () => 0, onSignedIn: () => {}, scratch: () => '/tmp' });
        expect(login.start('claude').ok).toBe(false);
        expect(login.startSwitch('claude').ok).toBe(false);
        expect(opened).toEqual([]);
    });

    it('an agent\'s Log in, Use another account and a switch by signing in again all go to the browser sign-in for Claude', async () => {
        const browser = vi.fn(async () => ({ ok: true as const }));
        const terminal = vi.fn(() => ({ ok: true as const, terminalId: 't' }));
        const api = hostSignIns({ login: terminal, switchLogin: terminal, providerOf: () => 'claude', cancel: () => {}, openWindow: () => true, claudeBrowser: browser });
        for (const r of [await api.providerLogin('agent_a', ctx as never), await api.loginFor('claude', ctx as never), await api.switchAccount('claude', 'someone@example.invalid', ctx as never)]) expect(r).toEqual({ ok: true, browser: true });
        expect(terminal).not.toHaveBeenCalled();
        expect(browser.mock.calls.map((c) => (c as unknown[])[0])).toEqual([undefined, undefined, 'someone@example.invalid']);
    });
});

describe('the actions, checked', () => {
    it('sign-in, cancel, a code, sign-out and use-another are actions; nothing else rides along', () => {
        expect(accountsActionOf({ kind: 'sign-in', id: 'a' })).toEqual({ kind: 'sign-in', id: 'a' });
        expect(accountsActionOf({ kind: 'cancel-sign-in', id: 'a' })).toEqual({ kind: 'cancel-sign-in', id: 'a' });
        expect(accountsActionOf({ kind: 'sign-out', id: 'a' })).toEqual({ kind: 'sign-out', id: 'a' });
        expect(accountsActionOf({ kind: 'use-another', method: 'console' })).toEqual({ kind: 'use-another', method: 'console' });
        expect(accountsActionOf({ kind: 'submit-code', requestId: 'r1', code: ' abc-123 ' })).toEqual({ kind: 'submit-code', requestId: 'r1', code: 'abc-123' });
        expect(accountsActionOf({ kind: 'submit-code', requestId: 'r1', code: 'x'.repeat(5000) })).toBeNull();
        expect(accountsActionOf({ kind: 'submit-code', requestId: 'r1', code: 'line\nbreak' })).toBeNull();
    });
});
