import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { headerActions, statePill } from '../src/core/agent-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { providerLogin } from '../src/core/provider-login.js';
import type { LiveSession } from '../src/core/roster.js';
import { formatRoute, parseRoute } from '../src/core/route.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { LoginHost } from '../src/main/login-host.js';
import { TakeOverWindow } from '../src/renderer/components/TakeOverWindow.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';

/**
 * A PROVIDER SIGNED OUT IS SAID SO, WITH A BUTTON THAT FIXES IT (the owner, 2026-10-18: "the next release also needs to
 * include provider login issues and with a button to help resolve it. If this means a tui login is needed it should open
 * this in a throwaway window that auto loads the tui in a scratch folder and then prompts the login command if possible.
 * if not, make sure the window this tui is opening includes a loud notice that tells the user what to do").
 *
 * - prism-acp 0.18.0 sorts a turn's failure into `kind: 'auth'` (Claude `authentication_failed`, Codex `unauthorized`):
 *   that agent is SIGNED OUT — not Broken — and its header offers `Log in to <provider>`;
 * - the button runs the provider's own documented login (`claude auth login`, `codex login`) in a terminal in a fresh
 *   scratch folder, in its own window, under a loud notice saying what to do;
 * - when that ends, Genie asks the provider's documented status command (`claude auth status`, `codex login status`:
 *   exit 0 = signed in); signed in, the provider's signed-out agents are brought back. The scratch folder is removed.
 * - a provider with no known login command gets its own CLI in that window, and the notice says what to type.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'genie2-login-test-')); dirs.push(d); return d; };
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

describe('the provider’s own login', () => {
    it('Claude Code and Codex: their documented login and status commands; anything else has none (COUNTED)', () => {
        expect(providerLogin('claude')).toEqual({ name: 'Claude Code', login: 'claude auth login', status: 'claude auth status' });
        expect(providerLogin('codex')).toEqual({ name: 'Codex', login: 'codex login', status: 'codex login status' });
        expect(providerLogin('aider')).toBeNull();
    });
});

function fakeDriver() {
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null };
        return driver;
    };
    return { factory, fail: (kind: string, reason: string) => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind, reason } } as never) };
}

describe('a turn that failed on the login', () => {
    const run = (kind: string, reason: string) => {
        const rows: StreamEvent[] = [];
        const d = fakeDriver();
        const session = new AgentSession({ agentId: mintAgentId(), cwd: tempDir(), store: openDurableStore(tempDir()), driverFactory: d.factory, processTree: noProcessTree, onEvent: (e) => rows.push(e), turnsBefore: 0 });
        session.start();
        session.prompt('hello', 'you');
        d.fail(kind, reason);
        return { session, rows };
    };

    it('is SIGNED OUT, not Broken: idle, no failure, and the chat says so', () => {
        const { session, rows } = run('auth', 'authentication_failed');
        expect(session.signedOut).toBe(true);
        expect(session.turnState).toBe('idle');
        expect(session.failure).toBeNull();
        expect(rows.some((r) => r.kind === 'notice' && /Signed out/.test(r.message))).toBe(true);
    });

    it('CONTROL: any other failure is still Broken, and not signed out', () => {
        const { session } = run('other', 'something_else');
        expect(session.signedOut).toBe(false);
        expect(session.turnState).toBe('failed');
    });
});

describe('what the person sees', () => {
    const live = (over: Partial<LiveSession>): LiveSession => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over } as LiveSession);

    it('the pill says Signed out and what to do; the header offers the login (positive control: not without it)', () => {
        expect(statePill(live({ signedOut: true }), () => 2)).toMatchObject({ word: 'Signed out · log in to continue', tone: 'warn' });
        expect(headerActions(live({ signedOut: true }), 'declared').login).toBe(true);
        expect(headerActions(live({}), 'declared').login).toBe(false);
    });
});

describe('the login window', () => {
    function fakes(statusExit: number) {
        const opened: Array<{ workspaceId: string; cwd: string; command?: string | undefined; shell?: boolean | undefined }> = [];
        const windows: string[] = [];
        const signedIn: string[] = [];
        const statusRan: Array<{ command: string; cwd: string }> = [];
        let exit: ((id: string, code: number) => void) | null = null;
        const terminals = {
            open: (o: { workspaceId: string; cwd: string; command?: string; shell?: boolean }) => { opened.push(o); return { id: `t${opened.length}`, pid: 1, shell: 'sh' }; },
            onExit: (l: (id: string, code: number) => void) => { exit = l; return () => {}; },
        };
        const host = new LoginHost({
            terminals: terminals as never,
            openWindow: (route) => windows.push(route),
            runStatus: async (command, cwd) => { statusRan.push({ command, cwd }); return statusExit; },
            onSignedIn: (provider) => signedIn.push(provider),
        });
        return { host, opened, windows, signedIn, statusRan, exit: (id: string, code: number) => exit!(id, code) };
    }

    it('runs the provider’s login in a fresh scratch folder, in its own window that carries the notice', () => {
        const f = fakes(0);
        expect(f.host.start('claude')).toEqual({ ok: true, terminalId: 't1' });
        expect(f.opened).toHaveLength(1);
        expect(f.opened[0]!.command).toBe('claude auth login');
        expect(f.opened[0]!.shell).toBe(true);
        expect(basename(f.opened[0]!.cwd)).toMatch(/^genie-login-claude-/);
        expect(dirname(f.opened[0]!.cwd)).toBe(tmpdir());
        expect(existsSync(f.opened[0]!.cwd)).toBe(true);
        expect(f.windows).toEqual(['genie://takeover/t1?login=claude']);
    });

    it('a second click brings the same window back: one login per provider (COUNTED: one terminal)', () => {
        const f = fakes(0);
        f.host.start('claude');
        f.host.start('claude');
        expect(f.opened).toHaveLength(1);
        expect(f.windows).toEqual(['genie://takeover/t1?login=claude', 'genie://takeover/t1?login=claude']);
    });

    it('when the login ends: asks the status command; signed in, the provider’s agents come back; the folder is gone', async () => {
        const f = fakes(0);
        f.host.start('codex');
        const scratch = f.opened[0]!.cwd;
        f.exit('t1', 0);
        await new Promise((r) => setTimeout(r, 10));
        expect(f.statusRan).toEqual([{ command: 'codex login status', cwd: scratch }]);
        expect(f.signedIn).toEqual(['codex']);
        expect(existsSync(scratch)).toBe(false);
        // Ended, so a new click opens a new login.
        f.host.start('codex');
        expect(f.opened).toHaveLength(2);
    });

    it('CONTROL: still signed out (status exit 1) — nobody is brought back, and the folder is still removed', async () => {
        const f = fakes(1);
        f.host.start('claude');
        const scratch = f.opened[0]!.cwd;
        f.exit('t1', 0);
        await new Promise((r) => setTimeout(r, 10));
        expect(f.signedIn).toEqual([]);
        expect(existsSync(scratch)).toBe(false);
    });

    it('CONTROL: another terminal ending is not the login', async () => {
        const f = fakes(0);
        f.host.start('claude');
        f.exit('t99', 0);
        await new Promise((r) => setTimeout(r, 10));
        expect(f.statusRan).toEqual([]);
        expect(existsSync(f.opened[0]!.cwd)).toBe(true);
    });

    it('a provider with no known login: its own CLI opens there, and the notice says what to type', () => {
        const f = fakes(0);
        expect(f.host.start('aider')).toEqual({ ok: true, terminalId: 't1' });
        expect(f.opened[0]!.command).toBe('aider');
        expect(f.windows).toEqual(['genie://takeover/t1?login=aider']);
    });
});

describe('the window’s notice', () => {
    it('the route carries which login it is', () => {
        const r = parseRoute('genie://takeover/t1?login=claude');
        expect(r).toMatchObject({ surface: 'takeover', terminalId: 't1', login: 'claude' });
        expect(formatRoute(r)).toBe('genie://takeover/t1?login=claude');
        expect(parseRoute('genie://takeover/t1')).not.toHaveProperty('login', expect.anything());
    });

    it('LOUD: what is running, and every step, for a known provider', () => {
        const html = renderToStaticMarkup(<TakeOverWindow terminalId="t1" terminals={NO_TERMINALS} login="claude" />);
        expect(html).toContain('data-login-notice="claude"');
        expect(html).toContain('Log in to Claude Code');
        expect(html).toContain('claude auth login');
        expect(html).toMatch(/browser/i);
        expect(html).toMatch(/close this window/i);
    });

    it('for a provider Genie has no login for: the steps to do it by hand in its own CLI', () => {
        const html = renderToStaticMarkup(<TakeOverWindow terminalId="t1" terminals={NO_TERMINALS} login="aider" />);
        expect(html).toContain('data-login-notice="aider"');
        expect(html).toMatch(/Log in to aider/);
        expect(html).toMatch(/login command/i);
    });

    it('CONTROL: an ordinary Take Over window has no notice', () => {
        expect(renderToStaticMarkup(<TakeOverWindow terminalId="t1" terminals={NO_TERMINALS} />)).not.toContain('data-login-notice');
    });
});
