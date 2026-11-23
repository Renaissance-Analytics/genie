import { describe, expect, it, vi } from 'vitest';
import { accountsActionOf } from '../src/core/account-settings.js';
import type { AccountRecord } from '../src/core/accounts.js';
import { isClaudeSignInUrl } from '../src/core/claude-accounts.js';
import { claudeAccountNamed, claudeSignedInActive, ClaudeSignIns, type ClaudeLoginOptions, type ClaudeSignInPorts } from '../src/main/claude-sign-ins.js';
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
    type Login = { configDir: string; options: ClaudeLoginOptions; resolve: (s: { signedIn: boolean; email?: string }) => void; reject: (e: unknown) => void };
    const logins: Login[] = [];
    let added = 0;
    const made: { s?: ClaudeSignIns } = {};
    const ports: ClaudeSignInPorts = {
        get: (id) => book.get(id) ?? null,
        activeId: () => active,
        addClaude: async (input) => {
            calls.push(`add ${input.method}${input.label ? ` ${input.label}` : ''}`);
            // The first one added is ADDED; each one after it has an id and a folder of its own, as the book gives them.
            const id = added === 0 ? ADDED.id : `account_${'3'.repeat(31)}${3 + added}`;
            added += 1;
            const a = { ...ADDED, id, configDir: `/g/accounts/claude/${id}`, method: input.method, ...(input.label ? { label: input.label } : {}) };
            book.set(a.id, a);
            return a;
        },
        setActive: async (id) => { calls.push(`active ${id}`); active = id; },
        activated: (provider, id) => { calls.push(`activated ${provider} ${id}`); },
        recordIdentity: async (id, identity) => { calls.push(`identity ${id} ${identity.email}`); },
        forget: async (id) => { calls.push(`forget ${id}`); book.delete(id); },
        removeDir: (dir) => { calls.push(`remove ${dir}`); return { ok: true }; },
        open: async (url, c) => { opened.push(`${url} @${c?.connectionId ?? 'none'}`); },
        changed: () => { calls.push('changed'); },
        tell: (words) => { notices.push(words); },
        platform: 'linux',
        login: (configDir, options) => new Promise((resolve, reject) => { logins.push({ configDir, options, resolve, reject }); }),
        logout: async (configDir) => { calls.push(`logout ${configDir}`); },
        describe: async () => ({ signedIn: false }),
        inUse: () => 0,
        signedInNow: async () => false,
        prepare: (configDir) => { calls.push(`prepare ${configDir}`); },
        // What the launcher would see at that moment: a start the block refused is retried from here.
        ended: (configDir) => { calls.push(`ended ${configDir} busy=${made.s!.busy(configDir)}`); },
        signedInActive: (provider, id) => { calls.push(`signed-in-active ${provider} ${id}`); },
        ...over,
    };
    const s = made.s = new ClaudeSignIns(ports);
    return { s, ports, calls, opened, notices, book, logins, current: () => logins.at(-1)!, setActive: (id: string) => { active = id; } };
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

    it('a sign-in that ends signed out (the person gave up) takes the account it added away again, folder and all; nothing active changes', async () => {
        const w = world();
        await w.s.useAnother('console', ctx);
        expect(w.book.has(ADDED.id)).toBe(true);
        w.current().resolve({ signedIn: false });
        await vi.waitFor(() => expect(w.s.view()).toEqual([]));
        expect(w.calls.some((c) => c.startsWith('active'))).toBe(false);
        expect(w.calls).toContain(`remove ${ADDED.configDir}`);
        expect(w.calls).toContain(`forget ${ADDED.id}`);
        expect(w.book.has(ADDED.id)).toBe(false);
    });
});

describe('Sign out and remove: prism-acp logout(), then the folder (its shared-history link removed as a link)', () => {
    it('signed out: forgotten, then its folder removed', async () => {
        const w = world({ describe: async () => ({ signedIn: false }) });
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(w.calls).toEqual([`logout ${OWN.configDir}`, `remove ${OWN.configDir}`, `forget ${OWN.id}`, 'changed']);
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
        // Switch names the account by its id, and nothing else rides along (review of #2139, finding 2).
        expect(accountsActionOf({ kind: 'switch', id: 'a', email: 'x@example.invalid' })).toEqual({ kind: 'switch', id: 'a' });
        expect(accountsActionOf({ kind: 'switch' })).toBeNull();
        expect(accountsActionOf({ kind: 'submit-code', requestId: 'r1', code: ' abc-123 ' })).toEqual({ kind: 'submit-code', requestId: 'r1', code: 'abc-123' });
        expect(accountsActionOf({ kind: 'submit-code', requestId: 'r1', code: 'x'.repeat(5000) })).toBeNull();
        expect(accountsActionOf({ kind: 'submit-code', requestId: 'r1', code: 'line\nbreak' })).toBeNull();
    });
});

/**
 * THE REVIEW OF #2139 (Tynn #1035/#1011). The owner's rules these hold to: one ACTIVE account per provider and every agent on
 * it; agents KEEP RUNNING when the account is switched and move at a turn boundary; Genie keeps a label, an email and a folder
 * path and never a key; the person never sees a terminal for a sign-in.
 */
const failed = (code: string) => Object.assign(new Error(code), { name: 'ClaudeLoginError', code });
const SAME_EMAIL_HOME: AccountRecord = { ...HOME, identity: { name: null, email: 'team@example.invalid', plan: null } };

describe('Sign out and remove never pulls a folder from under a running agent (review finding 1)', () => {
    it('agents still running in that account\'s folder: refused in words, with how many, and nothing runs', async () => {
        const asked: string[] = [];
        const w = world({ inUse: (dir) => { asked.push(dir); return 2; } });
        const r = await w.s.signOut(OWN.id);
        expect(r).toEqual({ ok: false, reason: '2 agents are still using this account; it can be removed when they finish their turn.' });
        expect(asked).toEqual([OWN.configDir]);
        expect(w.calls).toEqual([]);
        expect(w.book.has(OWN.id)).toBe(true);
    });

    it('one agent is said as one', async () => {
        const r = await world({ inUse: () => 1 }).s.signOut(OWN.id);
        expect(r).toEqual({ ok: false, reason: '1 agent is still using this account; it can be removed when it finishes its turn.' });
    });

    it('CONTROL: with nobody in the folder it is signed out and removed', async () => {
        const w = world({ inUse: () => 0 });
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(w.book.has(OWN.id)).toBe(false);
    });

    it('a folder that will not go completely: the account is KEPT (never forgotten first), said, and the same button finishes it', async () => {
        let tries = 0;
        const calls: string[] = [];
        const w = world({ removeDir: (dir) => { tries += 1; calls.push(`remove ${dir}`); return tries === 1 ? { ok: false, reason: 'The account\'s folder could not be removed completely: EBUSY' } : { ok: true }; } });
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(calls).toEqual([`remove ${OWN.configDir}`]);
        expect(w.calls.filter((c) => c.startsWith('forget'))).toEqual([]);
        expect(w.book.has(OWN.id)).toBe(true);
        expect(w.notices.at(-1)).toMatch(/signed out/);
        expect(w.notices.at(-1)).toMatch(/could not be removed completely: EBUSY/);
        expect(w.notices.at(-1)).toMatch(/Sign out and remove again/);
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(w.calls.filter((c) => c.startsWith('forget'))).toEqual([`forget ${OWN.id}`]);
        expect(w.book.has(OWN.id)).toBe(false);
        expect(w.notices.at(-1)).toMatch(/signed out and removed/);
    });

    it('a folder already gone is a signed-out one: the account is forgotten, not stuck', async () => {
        const w = world({ logout: async () => { throw failed('missingDirectory'); }, describe: async () => { throw new Error('no such folder'); } });
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(w.calls).toEqual([`remove ${OWN.configDir}`, `forget ${OWN.id}`, 'changed']);
    });

    it('CONTROL: any other logout failure is said and nothing is removed', async () => {
        const w = world({ logout: async () => { throw failed('failed'); } });
        const r = await w.s.signOut(OWN.id);
        expect(r.ok).toBe(false);
        expect(w.calls).toEqual([]);
    });

    it('logout went through but Claude Code cannot be asked: said as it is, never "still signed in"; the account and folder are kept (finding 7c)', async () => {
        const w = world({ describe: async () => { throw new Error('the CLI did not answer'); } });
        expect(await w.s.signOut(OWN.id)).toEqual({ ok: true });
        expect(w.calls).toEqual([`logout ${OWN.configDir}`]);
        expect(w.notices.at(-1)).not.toMatch(/still signed in/);
        expect(w.notices.at(-1)).toMatch(/was signed out, but Genie could not confirm it/);
    });
});

describe('Switch acts on the account\'s ID, and signs in only an account that is not signed in (review finding 2)', () => {
    it('an account Claude Code says is signed in becomes the active one: no login, no new folder', async () => {
        const asked: string[] = [];
        const w = world({ signedInNow: async (a) => { asked.push(a.id); return true; } });
        expect(await w.s.switchTo(OWN.id, ctx)).toEqual({ ok: true });
        expect(asked).toEqual([OWN.id]);
        expect(w.calls).toEqual([`active ${OWN.id}`, `activated claude ${OWN.id}`]);
        expect(w.logins).toEqual([]);
    });

    it('one that is not signed in is signed in in the browser, in ITS folder, and is active once it is', async () => {
        const w = world({ signedInNow: async () => false });
        expect(await w.s.switchTo(OWN.id, ctx)).toEqual({ ok: true });
        expect(w.calls.some((c) => c.startsWith('add') || c.startsWith('active'))).toBe(false);
        expect(w.logins.map((l) => l.configDir)).toEqual([OWN.configDir]);
        w.current().resolve({ signedIn: true, email: 'team@example.invalid' });
        await vi.waitFor(() => expect(w.calls).toContain(`activated claude ${OWN.id}`));
    });

    it('when Claude Code cannot be asked, nothing is guessed: refused in words, no login, nothing active', async () => {
        const w = world({ signedInNow: async () => null });
        const r = await w.s.switchTo(OWN.id, ctx);
        expect(r).toEqual({ ok: false, reason: 'Genie could not ask Claude Code whether Team API is signed in. Try again in a moment.' });
        expect(w.calls).toEqual([]);
        expect(w.logins).toEqual([]);
    });

    it('the account already active, and one Genie does not know', async () => {
        const w = world();
        w.setActive(OWN.id);
        expect(await w.s.switchTo(OWN.id, ctx)).toEqual({ ok: true });
        expect((await w.s.switchTo('account_nobody', ctx)).ok).toBe(false);
        expect(w.calls).toEqual([]);
    });

    it('two accounts with one email: the id names the one meant, and it is the one switched to', async () => {
        const w = world({ signedInNow: async () => true });
        w.book.set(SAME_EMAIL_HOME.id, SAME_EMAIL_HOME);
        await w.s.switchTo(SAME_EMAIL_HOME.id, ctx);
        expect(w.calls).toContain(`active ${SAME_EMAIL_HOME.id}`);
        expect(w.calls.some((c) => c.startsWith('add'))).toBe(false);
    });

    it('by words (an older caller): one match is that account; several is said, never the first; none is none', () => {
        const all = [OWN, SAME_EMAIL_HOME, ADDED];
        expect(claudeAccountNamed(all, 'Home')).toBe(SAME_EMAIL_HOME);
        expect(claudeAccountNamed(all, 'TEAM@example.invalid')).toBe('several');
        expect(claudeAccountNamed([OWN, HOME], 'team@example.invalid')).toBe(OWN);
        expect(claudeAccountNamed(all, 'nobody@example.invalid')).toBeNull();
        expect(claudeAccountNamed([{ ...OWN, provider: 'codex' }], 'Team API')).toBeNull();
    });
});

describe('ONE sign-in per intent: a second click joins the one in flight (review finding 3)', () => {
    it('Use another account clicked twice at once: one account, one folder, one CLI, one browser tab', async () => {
        const w = world();
        const [a, b] = await Promise.all([w.s.useAnother('subscription', ctx), w.s.useAnother('subscription', ctx)]);
        expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
        expect(w.calls.filter((c) => c.startsWith('add'))).toEqual(['add subscription']);
        expect(w.logins).toHaveLength(1);
        // ...and a click later, while it still runs, joins it too.
        expect(await w.s.useAnother('subscription', ctx)).toEqual({ ok: true });
        expect(w.calls.filter((c) => c.startsWith('add'))).toEqual(['add subscription']);
        expect(w.logins).toHaveLength(1);
        expect(w.s.view()).toHaveLength(1);
    });

    it('a default-home account clicked twice at once: one folder made for it, one sign-in', async () => {
        const w = world();
        await Promise.all([w.s.signIn(HOME.id, ctx), w.s.signIn(HOME.id, ctx)]);
        expect(await w.s.signIn(HOME.id, ctx)).toEqual({ ok: true });
        expect(w.calls.filter((c) => c.startsWith('add'))).toEqual(['add subscription Home']);
        expect(w.logins).toHaveLength(1);
    });

    it('CONTROL: once it has ended, Use another account starts a new one', async () => {
        const w = world();
        await w.s.useAnother('subscription', ctx);
        w.current().resolve({ signedIn: true, email: 'new@example.invalid' });
        await vi.waitFor(() => expect(w.s.view()).toEqual([]));
        await w.s.useAnother('subscription', ctx);
        expect(w.calls.filter((c) => c.startsWith('add'))).toHaveLength(2);
        expect(w.logins).toHaveLength(2);
    });

    it('an account that could not be added is said, and the next click is a fresh try', async () => {
        let fail = true;
        const w = world();
        const add = w.ports.addClaude;
        const s = new ClaudeSignIns({ ...w.ports, addClaude: async (input) => { if (fail) { fail = false; throw new Error('The folder for this account could not be made ready.'); } return add(input); } });
        expect(await s.useAnother('subscription', ctx)).toEqual({ ok: false, reason: 'The folder for this account could not be made ready.' });
        expect(await s.useAnother('subscription', ctx)).toEqual({ ok: true });
        expect(w.logins).toHaveLength(1);
    });

    it.each([
        ['cancelled', (w: ReturnType<typeof world>) => { w.s.cancel(ADDED.id); w.current().reject(failed('cancelled')); }],
        ['timed out', (w: ReturnType<typeof world>) => { w.current().reject(failed('timeout')); }],
        ['failed', (w: ReturnType<typeof world>) => { w.current().reject(failed('failed')); }],
        ['not signed in', (w: ReturnType<typeof world>) => { w.current().resolve({ signedIn: false }); }],
    ])('an account ADDED for a sign-in that ends %s is taken away again, its folder first', async (_, end) => {
        const w = world();
        await w.s.useAnother('subscription', ctx);
        end(w);
        await vi.waitFor(() => expect(w.s.view()).toEqual([]));
        await vi.waitFor(() => expect(w.book.has(ADDED.id)).toBe(false));
        expect(w.calls.filter((c) => c.startsWith('remove') || c.startsWith('forget'))).toEqual([`remove ${ADDED.configDir}`, `forget ${ADDED.id}`]);
    });

    it('the folder made for a default-home account goes the same way, and the account it was for is kept', async () => {
        const w = world();
        await w.s.signIn(HOME.id, ctx);
        w.current().reject(failed('timeout'));
        await vi.waitFor(() => expect(w.book.has(ADDED.id)).toBe(false));
        expect(w.book.has(HOME.id)).toBe(true);
        expect(w.calls).not.toContain(`forget ${HOME.id}`);
    });

    it('CONTROL: an account that was there BEFORE the sign-in is never removed by its end', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        w.s.cancel(OWN.id);
        w.current().reject(failed('cancelled'));
        await vi.waitFor(() => expect(w.calls.some((c) => c.startsWith('ended'))).toBe(true));
        expect(w.calls.filter((c) => c.startsWith('remove') || c.startsWith('forget'))).toEqual([]);
        expect(w.book.has(OWN.id)).toBe(true);
    });

    it('an added account whose folder will not go stays in the book, and it is said', async () => {
        const w = world({ removeDir: () => ({ ok: false, reason: 'The account\'s folder could not be removed completely: EBUSY' }) });
        await w.s.useAnother('subscription', ctx);
        w.current().resolve({ signedIn: false });
        await vi.waitFor(() => expect(w.notices.join('\n')).toMatch(/could not be removed completely: EBUSY/));
        expect(w.book.has(ADDED.id)).toBe(true);
    });
});

describe('when a sign-in is over, what waited on it goes (review finding 4)', () => {
    it.each([
        ['signed in', (w: ReturnType<typeof world>) => { w.current().resolve({ signedIn: true, email: 'team@example.invalid' }); }],
        ['not signed in', (w: ReturnType<typeof world>) => { w.current().resolve({ signedIn: false }); }],
        ['cancelled', (w: ReturnType<typeof world>) => { w.s.cancel(OWN.id); w.current().reject(failed('cancelled')); }],
        ['timed out', (w: ReturnType<typeof world>) => { w.current().reject(failed('timeout')); }],
    ])('ended %s: the launcher is told once, for that folder, when the folder is no longer busy', async (_, end) => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        expect(w.calls.filter((c) => c.startsWith('ended'))).toEqual([]);
        end(w);
        await vi.waitFor(() => expect(w.calls.filter((c) => c.startsWith('ended'))).toEqual([`ended ${OWN.configDir} busy=false`]));
    });

    it('the ACTIVE account signs itself in (an agent\'s Log in): health, attribution and its signed-out agents hear of it', async () => {
        const w = world();
        w.setActive(OWN.id);
        await w.s.signIn(OWN.id, ctx);
        w.current().resolve({ signedIn: true, email: 'team@example.invalid' });
        await vi.waitFor(() => expect(w.calls).toContain(`signed-in-active claude ${OWN.id}`));
        // Nothing was switched: no agent is told of a new account.
        expect(w.calls.some((c) => c.startsWith('activated') || c.startsWith('active '))).toBe(false);
    });

    it('a sign-in that makes its account active says so too (after the switch)', async () => {
        const w = world();
        await w.s.useAnother('subscription', ctx);
        w.current().resolve({ signedIn: true, email: 'new@example.invalid' });
        await vi.waitFor(() => expect(w.calls).toContain(`signed-in-active claude ${ADDED.id}`));
        expect(w.calls.indexOf(`activated claude ${ADDED.id}`)).toBeGreaterThan(-1);
        expect(w.calls.indexOf(`activated claude ${ADDED.id}`)).toBeLessThan(w.calls.indexOf(`signed-in-active claude ${ADDED.id}`));
    });

    it('CONTROL: another account signing in, or the active one NOT getting in, says nothing of the kind', async () => {
        const w = world();
        await w.s.signIn(OWN.id, ctx);
        w.current().resolve({ signedIn: true, email: 'team@example.invalid' });
        await vi.waitFor(() => expect(w.calls.filter((c) => c.startsWith('ended'))).toHaveLength(1));
        w.setActive(OWN.id);
        await w.s.signIn(OWN.id, ctx);
        w.current().resolve({ signedIn: false });
        await vi.waitFor(() => expect(w.calls.filter((c) => c.startsWith('ended'))).toHaveLength(2));
        expect(w.calls.filter((c) => c.startsWith('signed-in-active'))).toEqual([]);
    });

    it('signed in on the active account: attribution, health and live state are read again, and ONLY the agents it had signed out are started again', () => {
        const done: string[] = [];
        const signedOut: Record<string, readonly string[]> = { claude: ['agent_signed_out'] };
        const run = claudeSignedInActive({
            attribution: (p) => { done.push(`attribution ${p}`); }, refreshHealth: (p) => { done.push(`health ${p}`); }, refreshLive: () => { done.push('live'); },
            signedOutAgents: (p, id) => { done.push(`asked ${p} ${id}`); return signedOut[p] ?? []; },
            restart: (id) => { done.push(`restart ${id}`); }, resumeLimit: (p, id) => { done.push(`resume ${p} ${id}`); },
        });
        run('claude', OWN.id);
        // An agent stopped for another reason is not in what the host calls signed out, so nothing starts it
        // (test/claude-launch-block-1011.test.ts holds that against the real SessionHost).
        expect(done).toEqual(['attribution claude', 'health claude', 'live', `asked claude ${OWN.id}`, 'restart agent_signed_out', `resume claude ${OWN.id}`]);
    });
});

describe('every sign-in in an account\'s folder first makes sure its history is still the shared one (a removal that stopped half-way)', () => {
    it('the folder is prepared before the CLI runs in it, an existing account\'s too', async () => {
        const order: string[] = [];
        const w = world({ prepare: (configDir) => { order.push(`prepare ${configDir}`); }, login: (configDir) => { order.push(`login ${configDir}`); return new Promise(() => {}); } });
        await w.s.signIn(OWN.id, ctx);
        expect(order).toEqual([`prepare ${OWN.configDir}`, `login ${OWN.configDir}`]);
    });

    it('a folder that cannot be made ready is not signed in to: said, and no CLI runs', async () => {
        const w = world({ prepare: () => { throw new Error('The system refused to link this account\'s conversation history to the shared one.'); } });
        const r = await w.s.signIn(OWN.id, ctx);
        expect(r).toEqual({ ok: false, reason: 'The system refused to link this account\'s conversation history to the shared one.' });
        expect(w.logins).toEqual([]);
        expect(w.s.busy(OWN.configDir!)).toBe(false);
        expect(w.s.view()).toEqual([]);
    });
});

describe('a sign-in that worked is never left half told (review finding 7)', () => {
    it('(a) the account cannot be made active: said, it stays signed in and in the book, nothing is announced as switched', async () => {
        const w = world({ setActive: async () => { throw new Error('the account book could not be written'); } });
        await w.s.useAnother('subscription', ctx);
        w.current().resolve({ signedIn: true, email: 'new@example.invalid' });
        await vi.waitFor(() => expect(w.calls.filter((c) => c.startsWith('ended'))).toHaveLength(1));
        expect(w.notices.at(-1)).toMatch(/is signed in, but Genie could not make it the active account: the account book could not be written/);
        expect(w.calls.some((c) => c.startsWith('activated') || c.startsWith('signed-in-active'))).toBe(false);
        // It IS signed in: never removed as a sign-in that did not finish.
        expect(w.book.has(ADDED.id)).toBe(true);
        expect(w.calls.some((c) => c.startsWith('remove') || c.startsWith('forget'))).toBe(false);
    });

    it('(a) who it is cannot be saved: it is still made active and said to be signed in (the next read of its state saves it)', async () => {
        const w = world({ recordIdentity: async () => { throw new Error('the account book could not be written'); } });
        await w.s.useAnother('subscription', ctx);
        w.current().resolve({ signedIn: true, email: 'new@example.invalid' });
        await vi.waitFor(() => expect(w.calls).toContain(`activated claude ${ADDED.id}`));
        await vi.waitFor(() => expect(w.notices.at(-1)).toMatch(/Account 3 is signed in\./));
    });

    it.each(['it\'s@example.invalid', 'a&b@example.invalid', 'x!y@example.invalid', '50%@example.invalid', 'two words@example.invalid', `${'a'.repeat(250)}@example.invalid`])(
        '(b) an email prism-acp would refuse (%s) is not sent: the sign-in runs without the hint', async (email) => {
            const w = world();
            w.book.set(OWN.id, { ...OWN, identity: { name: null, email, plan: null } });
            expect(await w.s.signIn(OWN.id, ctx)).toEqual({ ok: true });
            expect(w.logins).toHaveLength(1);
            expect('email' in w.current().options).toBe(false);
        });

    it('(b) CONTROL: a plain email is still sent as the hint', async () => {
        const w = world();
        w.book.set(OWN.id, { ...OWN, identity: { name: null, email: 'first.last+tag@sub.example.invalid', plan: null } });
        await w.s.signIn(OWN.id, ctx);
        expect(w.current().options.email).toBe('first.last+tag@sub.example.invalid');
    });
});
