import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSwitchSteps } from '../src/core/provider-login.js';
import { startAccountSwitch, type AccountSwitchLoginPorts } from '../src/main/account-switch-host.js';
import { loginRoute, loginTerminalOf, LoginHost } from '../src/main/login-host.js';

/**
 * ACCOUNTS R2 (Tynn #753): SWITCHING = THE PROVIDER'S OWN LOGIN, IN THE SAME HOME. Genie opens a terminal running the
 * provider's own unmodified CLI with the steps on screen; it never types for the person and never handles a code or token. No
 * agent is stopped or started again: they keep their threads. Fixtures use no real person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

describe('R2: what the person is told to do', () => {
    it('Claude Code: log out, then log in and choose a different account', () => {
        const words = accountSwitchSteps('claude').join('\n');
        expect(words).toContain('/logout');
        expect(words).toContain('/login');
    });
    it('Codex: codex logout, then codex login', () => {
        const words = accountSwitchSteps('codex').join('\n');
        expect(words).toContain('codex logout');
        expect(words).toContain('codex login');
    });
});

describe('R2: starting a switch opens the provider login and nothing else', () => {
    const ports = (answer: { ok: true; terminalId: string } | { ok: false; reason: string } = { ok: true, terminalId: 't1' }) => {
        const start = vi.fn((_provider: string) => answer);
        const p: AccountSwitchLoginPorts = { login: { startSwitch: start } };
        return { p, start };
    };
    it.each(['claude', 'codex'] as const)('%s: one login terminal, with the steps', provider => {
        const f = ports();
        expect(startAccountSwitch(f.p, provider)).toEqual({ ok: true, terminalId: 't1', instructions: accountSwitchSteps(provider) });
        expect(accountSwitchSteps(provider).length).toBeGreaterThan(0);
        expect(f.start).toHaveBeenCalledTimes(1);
        expect(f.start).toHaveBeenCalledWith(provider);
    });
    it('a login that cannot start says why', () => {
        expect(startAccountSwitch(ports({ ok: false, reason: 'no pty' }).p, 'claude')).toEqual({ ok: false, reason: 'no pty' });
    });
    it('a provider Genie has no login for is refused before a terminal opens', () => {
        const f = ports();
        expect(startAccountSwitch(f.p, 'nope')).toMatchObject({ ok: false, reason: expect.stringMatching(/provider/i) });
        expect(f.start).not.toHaveBeenCalled();
    });
    it('no agent is stopped, started again or messaged by a switch', () => {
        expect(source('src/main/account-switch-host.ts')).not.toMatch(/stop\(|ended\(|deliverOwed|startedIds/);
        expect(source('src/main/genie-host.ts')).not.toContain('switchActiveAccount');
    });
});

describe('R2: the login window for a switch', () => {
    const roots: string[] = [];
    afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
    function fakes(statusExit = 0) {
        const scratch = mkdtempSync(join(tmpdir(), 'genie-switch-753-'));
        roots.push(scratch);
        const opened: Array<{ cwd: string; command?: string; env?: unknown }> = [];
        const closed: string[] = [];
        const windows: string[] = [];
        const signedIn: Array<[string, string | undefined]> = [];
        const listeners: Array<(id: string, code: number) => void> = [];
        const host = new LoginHost({ scratch: () => scratch, openWindow: route => windows.push(route),
            terminals: { open: (o: { cwd: string; command?: string }) => { opened.push(o); return { id: `t${opened.length}`, pid: 1, shell: 'sh' }; },
                close: (id: string) => { closed.push(id); return true; }, onExit: (l: (id: string, code: number) => void) => { listeners.push(l); return () => {}; } } as never,
            runStatus: async () => statusExit, onSignedIn: (provider, accountId) => { signedIn.push([provider, accountId]); } });
        return { host, scratch, opened, closed, windows, signedIn, exit: (id: string) => { for (const l of listeners) l(id, 0); } };
    }

    it('the route says it is a switch, and still names its terminal', () => {
        const route = loginRoute('t1', 'claude', true);
        expect(route).toContain('switch=1');
        expect(loginTerminalOf(route)).toBe('t1');
    });
    it('Claude: no terminal any more (Tynn #1011, the owner: "I should not see any terminals"): its switch is the browser sign-in', () => {
        const f = fakes();
        expect(f.host.startSwitch('claude').ok).toBe(false);
        expect(f.opened).toEqual([]);
        expect(f.windows).toEqual([]);
    });
    it('Codex opens its own CLI in a scratch folder, with no home variable, in a window that says it is a switch', () => {
        const f = fakes();
        expect(f.host.startSwitch('codex')).toEqual({ ok: true, terminalId: 't1' });
        expect(f.opened[0]!.cwd.startsWith(f.scratch)).toBe(true);
        expect(f.opened[0]!.env).toBeUndefined();
        expect(f.windows).toEqual([loginRoute('t1', 'codex', true)]);
    });
    it('Codex runs its own logout, then its own login', () => {
        const f = fakes();
        expect(f.host.startSwitch('codex')).toMatchObject({ ok: true });
        expect(f.opened[0]!.command).toMatch(/codex"?\s+logout\b.*&&.*codex"?\s+login\b/);
    });
    it('a second click joins the open switch', () => {
        const f = fakes();
        f.host.startSwitch('codex');
        expect(f.host.startSwitch('codex')).toEqual({ ok: true, terminalId: 't1' });
        expect(f.opened).toHaveLength(1);
    });
    it('when the terminal ends signed in, the provider is told; the terminal and folder are removed', async () => {
        const f = fakes(0);
        expect(f.host.startSwitch('codex')).toMatchObject({ ok: true });
        f.exit('t1');
        await vi.waitFor(() => expect(f.signedIn).toHaveLength(1));
        expect(f.signedIn[0]![0]).toBe('codex');
        expect(f.closed).toEqual(['t1']);
    });
    it('when the terminal ends signed out, nobody is told', async () => {
        const f = fakes(1);
        expect(f.host.startSwitch('codex')).toMatchObject({ ok: true });
        f.exit('t1');
        await vi.waitFor(() => expect(f.closed).toEqual(['t1']));
        expect(f.signedIn).toEqual([]);
    });
});
