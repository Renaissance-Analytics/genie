import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSwitchToast, accountSwitchWords, switchOutcome, type AccountSwitchOutcome } from '../src/core/account-switch.js';
import { AccountSwitchFlow, type AccountSwitchFlowPorts } from '../src/main/account-switch-host.js';
import { LoginHost } from '../src/main/login-host.js';

/**
 * ACCOUNTS S9 (Tynn #482): THE GUIDED SWITCH, on the same-home model (Tynn #753). One click opens the provider's own login in
 * its one home, with the steps. When that terminal ends (or its window is closed: the steps say to close it) Genie asks the
 * provider's status and reads who is signed in. Success says which account is active now; a sign-in that did not finish, or
 * the same account still signed in, leaves the active account as it was and offers Retry. No agent is stopped, started again
 * or messaged. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const WORK = { id: `account_${'a'.repeat(32)}`, label: 'Work Max' };
const HOME = { id: `account_${'b'.repeat(32)}`, label: 'ada@example.invalid' };

describe('S9: what a finished switch says', () => {
    it('another account read afterwards = switched: it names the account now active, and the agents keep going', () => {
        const o = switchOutcome({ provider: 'claude', before: WORK, after: HOME, signedIn: true });
        expect(o).toEqual({ kind: 'switched', provider: 'claude', accountId: HOME.id, label: HOME.label, fromAccountId: WORK.id, fromLabel: WORK.label });
        const words = accountSwitchWords(o);
        expect(words.title).toContain(HOME.label);
        expect(words.body).toMatch(/agents keep going/i);
        expect(words.retry).toBe(false);
    });
    it('the same account still signed in = unchanged: it says so, and offers Retry', () => {
        const o = switchOutcome({ provider: 'claude', before: WORK, after: WORK, signedIn: true });
        expect(o).toEqual({ kind: 'unchanged', provider: 'claude', accountId: WORK.id, label: WORK.label });
        const words = accountSwitchWords(o);
        expect(words.title).toContain(WORK.label);
        expect(words.retry).toBe(true);
    });
    it('not signed in afterwards = signed out: the active account is still the one before, and Retry is offered', () => {
        const o = switchOutcome({ provider: 'codex', before: WORK, after: WORK, signedIn: false });
        expect(o).toEqual({ kind: 'signed-out', provider: 'codex', accountId: WORK.id, label: WORK.label });
        const words = accountSwitchWords(o);
        expect(words.title).toMatch(/Codex/);
        expect(words.body).toContain(WORK.label);
        expect(words.retry).toBe(true);
    });
    it('the toast a window shows: Retry runs the switch again for that provider; a switched one has no button', () => {
        const again = vi.fn();
        const failed = accountSwitchToast(switchOutcome({ provider: 'claude', before: WORK, after: WORK, signedIn: false }), again);
        expect(failed.action?.label).toBe('Retry');
        failed.action!.run();
        expect(again).toHaveBeenCalledWith('claude');
        expect(accountSwitchToast(switchOutcome({ provider: 'claude', before: WORK, after: HOME, signedIn: true }), again).action).toBeUndefined();
    });
});

describe('S9: the flow in the host', () => {
    function ports(opts: { start?: { ok: true; terminalId: string } | { ok: false; reason: string } } = {}) {
        let active = WORK;
        const order: string[] = [];
        const emitted: AccountSwitchOutcome[] = [];
        const p: AccountSwitchFlowPorts = {
            login: { startSwitch: vi.fn(() => opts.start ?? { ok: true as const, terminalId: 't1' }) },
            active: () => active,
            readIdentity: vi.fn(async () => { order.push('read'); }),
            emit: (o) => { order.push('emit'); emitted.push(o); },
        };
        return { p, order, emitted, become: (a: typeof WORK) => { active = a; } };
    }
    it('start opens the provider\'s own login once and returns its steps', () => {
        const f = ports();
        const flow = new AccountSwitchFlow(f.p);
        expect(flow.start('claude')).toMatchObject({ ok: true, terminalId: 't1', instructions: expect.arrayContaining([expect.stringContaining('/logout')]) });
        expect(f.p.login.startSwitch).toHaveBeenCalledTimes(1);
    });
    it('signed in afterwards: identity is read FIRST, then the outcome names the account now active', async () => {
        const f = ports();
        const flow = new AccountSwitchFlow(f.p);
        flow.start('claude');
        (f.p.readIdentity as ReturnType<typeof vi.fn>).mockImplementation(async () => { f.order.push('read'); f.become(HOME); });
        expect(await flow.settle('claude', true)).toMatchObject({ kind: 'switched', accountId: HOME.id, fromAccountId: WORK.id });
        expect(f.order).toEqual(['read', 'emit']);
        expect(f.emitted).toHaveLength(1);
    });
    it('the same account read back: unchanged, told once', async () => {
        const f = ports();
        const flow = new AccountSwitchFlow(f.p);
        flow.start('claude');
        expect(await flow.settle('claude', true)).toMatchObject({ kind: 'unchanged', accountId: WORK.id });
        expect(f.emitted.map((o) => o.kind)).toEqual(['unchanged']);
    });
    it('signed out afterwards: no identity read, the active account untouched, signed-out told', async () => {
        const f = ports();
        const flow = new AccountSwitchFlow(f.p);
        flow.start('codex');
        expect(await flow.settle('codex', false)).toMatchObject({ kind: 'signed-out', accountId: WORK.id });
        expect(f.p.readIdentity).not.toHaveBeenCalled();
    });
    it('CONTROL: a login that cannot start says why, and nothing is told later', async () => {
        const f = ports({ start: { ok: false, reason: 'no pty' } });
        const flow = new AccountSwitchFlow(f.p);
        expect(flow.start('claude')).toEqual({ ok: false, reason: 'no pty' });
        expect(await flow.settle('claude', true)).toBeNull();
        expect(f.emitted).toEqual([]);
    });
    it('CONTROL: an ordinary sign-in ending (no switch started) is not reported as a switch', async () => {
        const f = ports();
        const flow = new AccountSwitchFlow(f.p);
        expect(await flow.settle('claude', true)).toBeNull();
        expect(f.emitted).toEqual([]);
    });
    it('Retry after a failed switch opens the login again and is reported again', async () => {
        const f = ports();
        const flow = new AccountSwitchFlow(f.p);
        flow.start('claude');
        await flow.settle('claude', false);
        flow.start('claude');
        expect(await flow.settle('claude', false)).toMatchObject({ kind: 'signed-out' });
        expect(f.emitted).toHaveLength(2);
        expect(f.p.login.startSwitch).toHaveBeenCalledTimes(2);
    });
    it('CONTROL: the flow has no way to touch an agent: its only ports are the login, the active account, the identity read and the notice', () => {
        expect(source('src/main/account-switch-host.ts')).not.toMatch(/stop\(|ended\(|deliverOwed|startedIds|restart|prompt\(/);
    });
});

describe('S9: the login host tells a switch how it ended', () => {
    const roots: string[] = [];
    afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
    function fakes(statusExit = 0) {
        const scratch = mkdtempSync(join(tmpdir(), 'genie-switch-482-'));
        roots.push(scratch);
        const closed: string[] = [];
        const statuses: string[] = [];
        const ended: Array<[string, boolean]> = [];
        const signedIn: string[] = [];
        const listeners: Array<(id: string, code: number) => void> = [];
        let n = 0;
        const host = new LoginHost({ scratch: () => scratch, openWindow: () => {},
            terminals: { open: () => ({ id: `t${++n}`, pid: 1, shell: 'sh' }), close: (id: string) => { closed.push(id); return true; },
                onExit: (l: (id: string, code: number) => void) => { listeners.push(l); return () => {}; } } as never,
            runStatus: async (command) => { statuses.push(command); return statusExit; }, onSignedIn: (provider) => { signedIn.push(provider); },
            onSwitchEnded: (provider, ok) => { ended.push([provider, ok]); } });
        return { host, closed, statuses, ended, signedIn, exit: (id: string) => { for (const l of listeners) l(id, 0); } };
    }
    it('the switch terminal ends signed in: the switch is told signed in (and the sign-in still brings signed-out agents back)', async () => {
        const f = fakes(0);
        f.host.startSwitch('claude');
        f.exit('t1');
        await vi.waitFor(() => expect(f.ended).toEqual([['claude', true]]));
        expect(f.signedIn).toEqual(['claude']);
        expect(f.closed).toEqual(['t1']);
    });
    it('the switch terminal ends signed out: the switch is told signed out', async () => {
        const f = fakes(1);
        f.host.startSwitch('codex');
        f.exit('t1');
        await vi.waitFor(() => expect(f.ended).toEqual([['codex', false]]));
        expect(f.signedIn).toEqual([]);
    });
    it('closing the switch window IS its end: the status is asked, the switch is told, the terminal and folder go', async () => {
        const f = fakes(0);
        f.host.startSwitch('claude');
        f.host.cancel('t1');
        await vi.waitFor(() => expect(f.ended).toEqual([['claude', true]]));
        expect(f.statuses).toHaveLength(1);
        expect(f.closed).toEqual(['t1']);
    });
    it('CONTROL: cancelling an ordinary sign-in asks no status and signs nobody in', async () => {
        const f = fakes(0);
        f.host.start('claude');
        f.host.cancel('t1');
        await new Promise((r) => setTimeout(r, 10));
        expect(f.statuses).toEqual([]);
        expect(f.signedIn).toEqual([]);
        expect(f.ended).toEqual([]);
        expect(f.closed).toEqual(['t1']);
    });
});

describe('S9: one click from a window, and the outcome back to it', () => {
    it('genie-host composes the flow: the switch starts through it, and the login host settles it', () => {
        const host = source('src/main/genie-host.ts');
        expect(host).toMatch(/new AccountSwitchFlow\(/);
        expect(host).toMatch(/onSwitchEnded: \(provider, signedIn\) => \{ void switchFlow\?\.settle\(provider, signedIn\)/);
        expect(host).toMatch(/kind: 'account-switch'/);
    });
    it('main opens the switch window from the bridge and hands the outcome to every window', () => {
        const main = source('src/main/main.ts');
        expect(main).toMatch(/ipcMain\.handle\('genie:account-switch'/);
        expect(main).toMatch(/signal\.kind === 'account-switch'/);
        expect(source('src/main/preload.ts')).toMatch(/switchAccount: \(provider\) => ipcRenderer\.invoke\('genie:account-switch', provider\)/);
    });
    it('the window shows the outcome with accountSwitchToast, Retry calling the bridge\'s switch', () => {
        expect(source('src/renderer/App.tsx')).toMatch(/accountSwitchToast\([^)]*\(provider\) => \{ void resolvedBridge\?\.switchAccount\?\.\(provider\)/);
    });
});
