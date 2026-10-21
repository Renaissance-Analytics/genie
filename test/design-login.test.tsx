import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { headerActions, statePill } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { statusOf, type AgentRow } from '../src/core/dashboard-view.js';
import { DESIGN_LOGIN, DESIGN_LOGIN_RAN, designLoginRefused, tellDesignLoginRan } from '../src/core/design-login.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { parseRoute } from '../src/core/route.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { LoginHost } from '../src/main/login-host.js';
import { trayMenuTemplate, trayTooltip } from '../src/main/tray.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';
import { TakeOverWindow } from '../src/renderer/components/TakeOverWindow.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';

/**
 * CLAUDE DESIGN'S OWN LOGIN, ONE CLICK AWAY (#1081; the owner, 2026-10-21: "it needs a better UX for handling that just
 * like our initial login trap so users don't have to figure out what to do").
 *
 * MEASURED in a real ledger that day: a session agent's DesignSync call ended as a failed tool row — `name: null`,
 * `status: 'failed'` — whose output is the refusal below. The authorization is per machine: once `/design-login` runs in
 * any interactive Claude Code session, headless and SDK runs reuse it. So:
 *  - the refusal is recognised from its own words, on a FAILED tool row only;
 *  - the agent says so ONCE per login, however many calls fail, wherever a signed-out agent is seen, with one action:
 *    `Log in to Claude Design`;
 *  - that opens the interactive `claude` in a scratch folder in the login window, whose notice says to type `/design-login`
 *    (Genie has no tested way to type into a terminal once it is ready, and `/design-login` as an argument is undocumented);
 *  - there is no status command for it, so when that terminal ends every agent that waited is told to retry. A retry that
 *    is refused again raises the prompt again: that is the check.
 */
const MEASURED = 'DesignSync needs design-system authorization, and /design-login cannot run in this non-interactive session. Ask the user to run /design-login once from an interactive Claude Code session on this machine — headless and SDK runs here then reuse that authorization.';

const failedTool = (output: string, status: 'failed' | 'completed' | 'in_progress' = 'failed'): StreamEvent => ({ kind: 'tool', toolCallId: 'c1', name: null, title: null, status, toolKind: null, rawInput: null, output });

describe('the refusal, recognised', () => {
    it('the measured DesignSync refusal on a failed tool row', () => {
        expect(designLoginRefused(failedTool(MEASURED))).toBe(true);
    });

    it('CONTROL: another failed tool, the same words on a tool that did not fail, a row without output, a message', () => {
        expect(designLoginRefused(failedTool('Error: ENOENT: no such file or directory'))).toBe(false);
        expect(designLoginRefused(failedTool(MEASURED, 'completed'))).toBe(false);
        expect(designLoginRefused(failedTool(MEASURED, 'in_progress'))).toBe(false);
        expect(designLoginRefused({ kind: 'tool', toolCallId: 'c1', name: null, title: null, status: 'failed', toolKind: null, rawInput: null })).toBe(false);
        expect(designLoginRefused({ kind: 'message', speaker: 'agent', peerName: null, text: MEASURED })).toBe(false);
    });
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = tempDir('genie2-design-');
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree, turnsBefore: 0 });
    session.start();
    const toolFails = (output: string) => events.onUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: `c${Math.random()}`, status: 'failed', rawOutput: output });
    const notices = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; message?: string }).filter((m) => m.kind === 'notice' && /Claude Design/.test(m.message ?? ''));
    };
    return { session, toolFails, notices };
}

describe('the session', () => {
    it('a refused DesignSync marks the agent as needing the Claude Design login, and the chat says what to do', async () => {
        const { session, toolFails, notices } = open();
        session.prompt('sync the design', 'you');
        toolFails(MEASURED);
        await session.settled();
        expect(session.designLogin).toBe(true);
        const said = await notices();
        expect(said).toHaveLength(1);
        expect(said[0]!.message).toMatch(/Log in to Claude Design/);
    });

    it('ONE prompt per login: three refused calls are one notice (COUNTED)', async () => {
        const { session, toolFails, notices } = open();
        session.prompt('sync the design', 'you');
        toolFails(MEASURED);
        toolFails(MEASURED);
        toolFails(MEASURED);
        expect(await notices()).toHaveLength(1);
    });

    it('the login ran: cleared; refused again after it: raised again, with a second notice (COUNTED)', async () => {
        const { session, toolFails, notices } = open();
        session.prompt('sync the design', 'you');
        toolFails(MEASURED);
        session.designLoginRan();
        expect(session.designLogin).toBe(false);
        toolFails(MEASURED);
        expect(session.designLogin).toBe(true);
        expect(await notices()).toHaveLength(2);
    });

    it('CONTROL: any other failed tool does not', async () => {
        const { session, toolFails, notices } = open();
        session.prompt('go', 'you');
        toolFails('Error: permission denied');
        expect(session.designLogin).toBe(false);
        expect(await notices()).toHaveLength(0);
    });
});

const live = (over: Partial<LiveSession>): LiveSession => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over } as LiveSession);
const record = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws' } as never;
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}

describe('wherever the agent is seen', () => {
    it('the header offers Log in to Claude Design; the pill, the chat line and the Dashboard row say it is needed', () => {
        expect(headerActions(live({ designLogin: true }), 'declared').designLogin).toBe(true);
        expect(statePill(live({ designLogin: true }), () => 2)).toMatchObject({ word: 'Claude Design login needed', tone: 'warn' });
        expect(chatContext({ agent: { fidelity: 'declared', provider: 'claude' }, session: live({ designLogin: true }), rows: [] } as never)).toEqual({ text: 'Claude Design login needed', tone: 'warn' });
        expect(agentRowFor(record, live({ designLogin: true }), () => 2).designLogin).toBe(true);
        expect(statusOf(row({ designLogin: true }))).toEqual({ word: 'Login needed', detail: 'Claude Design', tone: 'warn' });
    });

    it('CONTROL: not needed — no button, the ordinary word; and an agent still WORKING reads Working (the button stays)', () => {
        expect(headerActions(live({}), 'declared').designLogin).toBe(false);
        // The same session without the flag: the pill's ordinary word for a session with no turns yet.
        expect(statePill(live({}), () => 2).word).toBe('No turns yet');
        expect(agentRowFor(record, live({}), () => 2).designLogin).toBe(false);
        expect(statusOf(row({})).word).toBe('Idle');
        expect(statusOf(row({ designLogin: true, state: 'working' })).word).toBe('Working');
        expect(statePill(live({ designLogin: true, turnState: 'working' }), () => 2).word).toMatch(/running/);
        expect(headerActions(live({ designLogin: true, turnState: 'working' }), 'declared').designLogin).toBe(true);
    });

    it('the chat’s context line offers Log in to Claude Design, once; absent without it (CONTROL)', () => {
        const thread = { agentId: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', context: { text: 'Claude Design login needed', tone: 'warn' }, messages: [] } as never;
        const html = renderToStaticMarkup(createElement(ChatFlyout, { thread, onSend: () => {}, onClose: () => {}, onDesignLogin: () => {} } as never));
        expect(html.split('data-action="design-login"').length - 1).toBe(1);
        expect(html).toContain('Log in to Claude Design');
        expect(renderToStaticMarkup(createElement(ChatFlyout, { thread, onSend: () => {}, onClose: () => {} } as never))).not.toContain('design-login');
    });

    it('the tray names it once for the machine and offers the login; the click opens it', () => {
        const handlers = { onOpen: () => {}, onSettings: () => {}, onCheckUpdates: () => {}, onQuit: () => {} };
        let opened = 0;
        const menu = trayMenuTemplate({ ...handlers, onDesignLogin: () => { opened += 1; } }, [], null, [], [], true);
        expect(menu.find((i) => i.label === 'Claude Design: login needed')?.enabled).toBe(false);
        const logins = menu.filter((i) => i.label === 'Log in to Claude Design');
        expect(logins).toHaveLength(1);
        logins[0]!.click!();
        expect(opened).toBe(1);
        expect(trayTooltip([], [], [], true)).toBe('Genie — Claude Design: login needed');
        // CONTROL: not needed.
        expect(trayMenuTemplate({ ...handlers, onDesignLogin: () => {} }, [], null, [], [], false).some((i) => i.label?.includes('Claude Design'))).toBe(false);
        expect(trayTooltip([], [], [], false)).toBe('Genie');
    });
});

describe('the login window', () => {
    function fakes() {
        const opened: Array<{ workspaceId: string; cwd: string; command?: string | undefined; shell?: boolean | undefined }> = [];
        const windows: string[] = [];
        const statusRan: string[] = [];
        let ended = 0;
        let exit: ((id: string, code: number) => void) | null = null;
        const terminals = {
            open: (o: { workspaceId: string; cwd: string; command?: string; shell?: boolean }) => { opened.push(o); return { id: `t${opened.length}`, pid: 1, shell: 'sh' }; },
            onExit: (l: (id: string, code: number) => void) => { exit = l; return () => {}; },
        };
        const host = new LoginHost({
            terminals: terminals as never,
            openWindow: (route) => windows.push(route),
            runStatus: async (command) => { statusRan.push(command); return 0; },
            onSignedIn: () => {},
            onDesignLoginEnded: () => { ended += 1; },
        });
        return { host, opened, windows, statusRan, ended: () => ended, exit: (id: string, code: number) => exit!(id, code) };
    }

    it('runs the interactive claude, no arguments, in a fresh scratch folder, in a window that carries the design notice', () => {
        const f = fakes();
        expect(f.host.start(DESIGN_LOGIN)).toEqual({ ok: true, terminalId: 't1' });
        expect(f.opened).toHaveLength(1);
        expect(f.opened[0]!.command).toBe('claude');
        expect(basename(f.opened[0]!.cwd)).toMatch(/^genie-login-claude-design-/);
        expect(dirname(f.opened[0]!.cwd)).toBe(tmpdir());
        expect(f.windows).toEqual([`genie://takeover/t1?login=${DESIGN_LOGIN}`]);
        expect(parseRoute(f.windows[0]!)).toMatchObject({ surface: 'takeover', terminalId: 't1', login: DESIGN_LOGIN });
    });

    it('a second click brings the same window back (COUNTED: one terminal)', () => {
        const f = fakes();
        f.host.start(DESIGN_LOGIN);
        f.host.start(DESIGN_LOGIN);
        expect(f.opened).toHaveLength(1);
    });

    it('when it ends: no status command (there is none), the waiting agents are told, the folder is gone', async () => {
        const f = fakes();
        f.host.start(DESIGN_LOGIN);
        const scratch = f.opened[0]!.cwd;
        f.exit('t1', 0);
        await new Promise((r) => setTimeout(r, 10));
        expect(f.statusRan).toEqual([]);
        expect(f.ended()).toBe(1);
        expect(existsSync(scratch)).toBe(false);
    });

    it('CONTROL: another terminal ending is not the login; the provider login still runs its own command', async () => {
        const f = fakes();
        f.host.start(DESIGN_LOGIN);
        f.exit('t99', 0);
        await new Promise((r) => setTimeout(r, 10));
        expect(f.ended()).toBe(0);
        f.host.start('claude');
        expect(f.opened[1]!.command).toBe('claude auth login');
    });

    it('the notice: Log in to Claude Design, type /design-login and follow it, then close this window', () => {
        const html = renderToStaticMarkup(<TakeOverWindow terminalId="t1" terminals={NO_TERMINALS} login={DESIGN_LOGIN} />);
        expect(html).toContain(`data-login-notice="${DESIGN_LOGIN}"`);
        expect(html).toContain('Log in to Claude Design');
        expect(html).toContain('/design-login');
        expect(html).toMatch(/close this window/i);
        // CONTROL: not the provider login's steps.
        expect(html).not.toContain('claude auth login');
    });
});

describe('telling the agents that waited', () => {
    it('every agent waiting on the login is cleared and told to retry, by Genie (COUNTED: two told)', () => {
        const told: Array<{ id: string; text: string; by: string | null }> = [];
        const cleared: string[] = [];
        const ids = tellDesignLoginRan({
            designLoginAgents: () => ['a1', 'a2'],
            clearDesignLogin: (id) => { cleared.push(id); },
            prompt: (id, text, by) => { told.push({ id, text, by }); return true; },
        });
        expect(ids).toEqual(['a1', 'a2']);
        expect(cleared).toEqual(['a1', 'a2']);
        expect(told).toEqual([{ id: 'a1', text: DESIGN_LOGIN_RAN, by: 'genie' }, { id: 'a2', text: DESIGN_LOGIN_RAN, by: 'genie' }]);
        expect(DESIGN_LOGIN_RAN).toMatch(/Claude Design login was run/);
        expect(DESIGN_LOGIN_RAN).toMatch(/retry/i);
    });

    it('CONTROL: nobody waiting, nobody told', () => {
        const told: string[] = [];
        expect(tellDesignLoginRan({ designLoginAgents: () => [], clearDesignLogin: () => {}, prompt: (id) => { told.push(id); return true; } })).toEqual([]);
        expect(told).toEqual([]);
    });
});
