import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { afterSignedIn, LoginHost } from '../src/main/login-host.js';

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
    const statuses: Array<{ cwd: string }> = [];
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
        runStatus: async (_command, cwd) => {
            statuses.push({ cwd });
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

    it('different accounts of one provider sign in at once, each in its own terminal, in the one normal provider home (Tynn #753)', () => {
        const f = fakes();
        expect(f.host.start('claude', A.id)).toEqual({ ok: true, terminalId: 't1' });
        expect(f.host.start('claude', B.id)).toEqual({ ok: true, terminalId: 't2' });
        expect(f.opened).toHaveLength(2);
        expect(f.opened[0]!.env).toBeUndefined();
        expect(f.opened[1]!.env).toBeUndefined();
    });

    it('an account Genie does not have opens nothing', () => {
        const f = fakes();
        const r = f.host.start('claude', `account_${'f'.repeat(32)}`);
        expect(r.ok).toBe(false);
        expect(f.opened).toHaveLength(0);
        expect(readdirSync(f.scratch)).toEqual([]);
    });

    it('B finishing signs B in while A’s sign-in stays open', async () => {
        const f = fakes();
        f.host.start('claude', A.id);
        f.host.start('claude', B.id);
        f.exit('t2');
        await flush();
        expect(f.statuses).toHaveLength(1);
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

// The window no longer asks the host over the engine link to sign an account in: every client asks over the one protocol
// (logins.provider and the other sign-ins, Tynn #896), and engine.login / engine.cancelLogin are retired (2b-3).
