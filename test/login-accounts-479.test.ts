import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { afterSignedIn, LoginHost } from '../src/main/login-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer, type EngineServerOptions } from '../src/main/session-engine-server.js';

/*
 * TYNN #479 (Accounts S6): a sign-in belongs to ONE ACCOUNT. It was keyed by provider, so signing in B joined A's open
 * window, signing in B resumed every agent the provider had signed out (A's too), and nothing killed the sign-in terminal
 * when the person closed or cancelled the step. Every account here is a fixture; there are no real people in them.
 */
const A = { id: `account_${'a'.repeat(32)}`, provider: 'claude', home: '/profiles/a', legacy: false } as const;
const B = { id: `account_${'b'.repeat(32)}`, provider: 'claude', home: '/profiles/b', legacy: false } as const;
const roots: string[] = [];
const close: Array<() => void> = [];
afterEach(() => {
    for (const fn of close.splice(0)) fn();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function fakes(options: { statusExit?: number; statusThrows?: boolean; openThrows?: boolean } = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'genie-login-479-'));
    roots.push(scratch);
    const opened: Array<{ cwd: string; env?: Record<string, string> | undefined }> = [];
    const closed: string[] = [];
    const windows: string[] = [];
    const signedIn: Array<[string, string | undefined]> = [];
    const statuses: Array<{ cwd: string; env?: Readonly<Record<string, string>> | undefined }> = [];
    const listeners: Array<(id: string, code: number) => void> = [];
    const terminals = {
        open: (o: { cwd: string; env?: Record<string, string> }) => {
            if (options.openThrows) throw new Error('no pty');
            opened.push(o);
            return { id: `t${opened.length}`, pid: 1, shell: 'sh' };
        },
        close: (id: string) => { closed.push(id); return true; },
        onExit: (l: (id: string, code: number) => void) => { listeners.push(l); return () => {}; },
    };
    const host = new LoginHost({
        terminals: terminals as never,
        scratch: () => scratch,
        accountFor: (provider, id) => [A, B].find((a) => a.provider === provider && a.id === (id ?? A.id)) ?? null,
        openWindow: (route) => windows.push(route),
        runStatus: async (_command, cwd, env) => {
            statuses.push({ cwd, env });
            if (options.statusThrows) throw new Error('status blew up');
            return options.statusExit ?? 0;
        },
        onSignedIn: (provider, accountId) => { signedIn.push([provider, accountId]); },
    });
    return { host, scratch, opened, closed, windows, signedIn, statuses, exit: (id: string, code = 0) => { for (const l of listeners) l(id, code); } };
}

describe('a sign-in is keyed by the ACCOUNT', () => {
    it('CONTROL: a second click on the same account joins the one sign-in', () => {
        const f = fakes();
        const first = f.host.start('claude', A.id);
        const second = f.host.start('claude', A.id);
        expect(first).toEqual({ ok: true, terminalId: 't1' });
        expect(second).toEqual(first);
        expect(f.opened).toHaveLength(1);
        expect(f.windows).toEqual(['genie://takeover/t1?login=claude', 'genie://takeover/t1?login=claude']);
    });

    it('different accounts of one provider sign in at once, each in its own terminal and home', () => {
        const f = fakes();
        expect(f.host.start('claude', A.id)).toEqual({ ok: true, terminalId: 't1' });
        expect(f.host.start('claude', B.id)).toEqual({ ok: true, terminalId: 't2' });
        expect(f.opened).toHaveLength(2);
        expect(f.opened[0]!.env?.CLAUDE_CONFIG_DIR).toBe('/profiles/a');
        expect(f.opened[1]!.env?.CLAUDE_CONFIG_DIR).toBe('/profiles/b');
    });

    it('an account Genie does not have opens nothing', () => {
        const f = fakes();
        const r = f.host.start('claude', `account_${'f'.repeat(32)}`);
        expect(r.ok).toBe(false);
        expect(f.opened).toHaveLength(0);
        expect(readdirSync(f.scratch)).toEqual([]);
    });

    it('B finishing signs B in, with B’s home read, while A’s sign-in stays open', async () => {
        const f = fakes();
        f.host.start('claude', A.id);
        f.host.start('claude', B.id);
        f.exit('t2');
        await flush();
        expect(f.statuses).toHaveLength(1);
        expect(f.statuses[0]!.env?.CLAUDE_CONFIG_DIR).toBe('/profiles/b');
        expect(f.signedIn).toEqual([['claude', B.id]]);
        expect(f.closed).toEqual(['t2']);
    });
});

describe('cancelling leaves the agent on its old account', () => {
    it('cancel kills the terminal and removes the folder; its exit signs nobody in; the next click starts afresh', async () => {
        const f = fakes();
        f.host.start('claude', A.id);
        f.host.cancel(A.id);
        expect(f.closed).toEqual(['t1']);
        expect(readdirSync(f.scratch)).toEqual([]);
        f.exit('t1', 1);
        await flush();
        expect(f.statuses).toEqual([]);
        expect(f.signedIn).toEqual([]);
        expect(f.host.start('claude', A.id)).toEqual({ ok: true, terminalId: 't2' });
    });
});

describe('no sign-in terminal outlives the step', () => {
    it.each([
        ['signed in', {}],
        ['the status says not signed in', { statusExit: 1 }],
        ['the status command fails', { statusThrows: true }],
    ] as const)('%s: the terminal is closed and its folder removed', async (_name, options) => {
        const f = fakes(options);
        f.host.start('claude', A.id);
        f.exit('t1');
        await flush();
        expect(f.closed).toEqual(['t1']);
        expect(readdirSync(f.scratch)).toEqual([]);
    });

    it('closing Genie’s host closes every sign-in that is open', () => {
        const f = fakes();
        f.host.start('claude', A.id);
        f.host.start('claude', B.id);
        f.host.dispose();
        expect([...f.closed].sort()).toEqual(['t1', 't2']);
        expect(readdirSync(f.scratch)).toEqual([]);
    });

    it('CONTROL: a terminal that would not open leaves no folder and nothing live', () => {
        const f = fakes({ openThrows: true });
        expect(f.host.start('claude', A.id).ok).toBe(false);
        expect(readdirSync(f.scratch)).toEqual([]);
        expect(existsSync(f.scratch)).toBe(true);
    });
});

describe('what a sign-in resumes', () => {
    const run = (accountId: string | undefined) => {
        const restarted: string[] = [], resumed: Array<[string, string | undefined]> = [];
        afterSignedIn('claude', {
            signedOutAgents: (_provider, id) => id === A.id ? ['a1', 'a2'] : id === B.id ? ['b1'] : [],
            restart: (id) => restarted.push(id),
            resumeLimit: (provider, id) => resumed.push([provider, id]),
        }, accountId);
        return { restarted, resumed };
    };
    it('B’s sign-in resumes B’s signed-out agents and B’s hold, none of A’s', () => {
        expect(run(B.id)).toEqual({ restarted: ['b1'], resumed: [['claude', B.id]] });
    });
    it('CONTROL: with no account named, the provider’s agents are asked for as before', () => {
        const restarted: string[] = [];
        afterSignedIn('claude', { signedOutAgents: () => ['x1'], restart: (id) => restarted.push(id), resumeLimit: () => {} });
        expect(restarted).toEqual(['x1']);
    });
});

describe('the window asks the host to sign an account in', () => {
    async function connection(extra: Partial<EngineServerOptions>, local = true) {
        const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', ...extra });
        const client = new SessionEngineClient(), [host, window] = memoryPair();
        server.accept(host, { local });
        close.push(() => window.close());
        expect(await client.connect(window, 'fixture')).toMatchObject({ ok: true });
        return client;
    }
    it('login carries the provider and the account to the host and returns its terminal', async () => {
        const seen: Array<[string, string | undefined]> = [];
        const client = await connection({ login: (provider, accountId) => { seen.push([provider, accountId]); return { ok: true, terminalId: 't9' }; } });
        expect(await client.login('claude', B.id)).toEqual({ ok: true, terminalId: 't9' });
        expect(seen).toEqual([['claude', B.id]]);
    });
    it('cancelLogin names the account', async () => {
        const seen: string[] = [];
        const client = await connection({ cancelLogin: (accountId) => { seen.push(accountId); } });
        await client.cancelLogin(B.id);
        expect(seen).toEqual([B.id]);
    });
    it('another connection than this machine’s own window is refused, in words', async () => {
        const client = await connection({ login: () => { throw new Error('must not start'); } }, false);
        expect(await client.call('engine.login', ['claude', A.id])).toEqual({ ok: false, reason: 'Sign-in needs this machine’s own window.' });
    });
});
