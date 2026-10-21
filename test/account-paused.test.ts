import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PauseAlerts, accountPauseOf } from '../src/core/account-pause.js';
import { headerActions, statePill } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { statusOf, type AgentRow } from '../src/core/dashboard-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { trayMenuTemplate, trayTooltip } from '../src/main/tray.js';

/**
 * A PAUSED ACCOUNT IS CAUGHT, AND THE PERSON IS TOLD (the owner, 2026-10-21: "you may have just experienced an account
 * pause due to a payment failure on my subscription. we need to be able to capture those and alert the user").
 *
 * MEASURED that night, prism's Claude session at 02:56:28Z: the turn failed with the assistant error
 * `oauth_org_not_allowed` — "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic
 * API key instead, or ask your admin to enable access". prism-acp classifies that one as `auth`, and `billing_error`,
 * `account_on_hold` and `verification_required` as `billing`. Genie read the first as Signed out ("Use Log in" — logging
 * in does not unpause an account) and the rest as Broken. Each is now ACCOUNT PAUSED: not the agent's fault, not a login,
 * said in words with what to do, ONE alert per login however many agents it stops, and `Try again` for all of them.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-paused-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree });
    session.start();
    const endFailing = (kind: string, reason: string) => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind, reason } } as never);
    const endOk = () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
    const notices = async () => (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; level?: string; message?: string }).filter((m) => m.kind === 'notice');
    return { session, endFailing, endOk, notices };
}

describe('which failures pause the account', () => {
    it('the provider’s billing reasons, and the org refusing subscription access — each in words', () => {
        for (const [kind, reason] of [['billing', 'billing_error'], ['billing', 'account_on_hold'], ['billing', 'verification_required'], ['auth', 'oauth_org_not_allowed']] as const) {
            const p = accountPauseOf({ kind, reason });
            expect(p, reason).not.toBeNull();
            expect(p!.reason).toBe(reason);
            expect(p!.words.length, reason).toBeGreaterThan(10);
        }
        expect(accountPauseOf({ kind: 'auth', reason: 'oauth_org_not_allowed' })!.words).toMatch(/subscription access/);
        expect(accountPauseOf({ kind: 'billing', reason: 'account_on_hold' })!.words).toMatch(/on hold/);
    });

    it('CONTROL: a plain login failure, a limit, an overload and no failure at all are not a paused account', () => {
        expect(accountPauseOf({ kind: 'auth', reason: 'authentication_failed' })).toBeNull();
        expect(accountPauseOf({ kind: 'rate_limit', reason: 'rate_limit' })).toBeNull();
        expect(accountPauseOf({ kind: 'overloaded', reason: 'overloaded_error' })).toBeNull();
        expect(accountPauseOf(undefined)).toBeNull();
    });
});

describe('the session', () => {
    it('oauth_org_not_allowed PAUSES the account — not Signed out, not Broken — and says so in the chat', async () => {
        const { session, endFailing, notices } = open();
        session.prompt('go', 'you');
        endFailing('auth', 'oauth_org_not_allowed');
        expect(session.accountPaused?.reason).toBe('oauth_org_not_allowed');
        expect(session.signedOut).toBe(false);
        expect(session.turnState).toBe('idle');
        expect(session.failure).toBeNull();
        await session.settled();
        const last = (await notices()).at(-1);
        expect(last?.level).toBe('warning');
        expect(last?.message).toMatch(/^Account paused: /);
        expect(last?.message).toMatch(/Try again/);
    });

    it('a billing failure pauses it too, and a turn that goes through clears it', () => {
        const { session, endFailing, endOk } = open();
        session.prompt('go', 'you');
        endFailing('billing', 'billing_error');
        expect(session.accountPaused?.reason).toBe('billing_error');
        expect(session.turnState).toBe('idle');
        session.prompt('again', 'you');
        endOk();
        expect(session.accountPaused).toBeNull();
    });

    it('CONTROL: a plain auth failure is still Signed out, and nothing is paused', () => {
        const { session, endFailing } = open();
        session.prompt('go', 'you');
        endFailing('auth', 'authentication_failed');
        expect(session.signedOut).toBe(true);
        expect(session.accountPaused).toBeNull();
    });
});

const live = (over: Partial<LiveSession>): LiveSession => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over } as LiveSession);
const record = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws' } as never;
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
const PAUSE = { reason: 'account_on_hold', words: 'the account is on hold' };

describe('wherever the agent is seen', () => {
    it('the Dashboard row, the Agent view and the chat say Account paused and why; the header offers Try again', () => {
        expect(agentRowFor(record, live({ accountPaused: PAUSE }), () => 2).accountPaused).toEqual(PAUSE);
        expect(statusOf(row({ accountPaused: PAUSE }))).toEqual({ word: 'Account paused', detail: 'the account is on hold', tone: 'bad' });
        expect(statePill(live({ accountPaused: PAUSE }), () => 0).word).toBe('Account paused · the account is on hold');
        expect(chatContext({ agent: { fidelity: 'declared', provider: 'claude' }, session: live({ accountPaused: PAUSE }), rows: [] } as never)).toEqual({ text: 'Account paused · the account is on hold', tone: 'bad' });
        expect(headerActions(live({ accountPaused: PAUSE }), 'declared').retryAccount).toBe(true);
    });

    it('CONTROL: an agent whose account is fine is Idle, offers no Try again, and a waiting question still comes first', () => {
        expect(statusOf(row({})).word).toBe('Idle');
        expect(headerActions(live({}), 'declared').retryAccount).toBe(false);
        expect(statusOf(row({ accountPaused: PAUSE, state: 'waiting', ask: 'Run it?' })).word).toBe('Waiting on you');
    });
});

describe('the tray', () => {
    const handlers = { onOpen: () => {}, onSettings: () => {}, onCheckUpdates: () => {}, onQuit: () => {} };
    it('names each paused login and offers Try again for it; the click asks for that login (COUNTED: two)', () => {
        const asked: string[] = [];
        const menu = trayMenuTemplate({ ...handlers, onAccountRetry: (p) => asked.push(p) }, [], null, [], ['claude', 'codex']);
        expect(menu.find((i) => i.label === 'Claude: account paused')?.enabled).toBe(false);
        const retries = menu.filter((i) => i.label?.startsWith('Try ') && i.label.endsWith(' again'));
        expect(retries.map((i) => i.label)).toEqual(['Try Claude again', 'Try Codex again']);
        for (const item of retries) item.click!();
        expect(asked).toEqual(['claude', 'codex']);
        expect(trayTooltip([], [], ['claude'])).toBe('Genie — Claude: account paused');
    });

    it('CONTROL: nothing paused — no such lines', () => {
        const menu = trayMenuTemplate({ ...handlers, onAccountRetry: () => {} }, [], null, [], []);
        expect(menu.some((i) => i.label?.endsWith('account paused'))).toBe(false);
    });
});

describe('the alert', () => {
    it('ONE per login however many of its agents stop, again only after it was cleared (COUNTED)', () => {
        const alerts = new PauseAlerts();
        expect(alerts.update(['claude'])).toEqual(['claude']);
        // Nine more of its agents pause: no second alert.
        for (let i = 0; i < 9; i += 1) expect(alerts.update(['claude'])).toEqual([]);
        // Another login pauses: it gets its own.
        expect(alerts.update(['claude', 'codex'])).toEqual(['codex']);
        // Cleared (Try again went through), then paused again: alerted again.
        expect(alerts.update(['codex'])).toEqual([]);
        expect(alerts.update(['codex', 'claude'])).toEqual(['claude']);
    });
});

describe('the chat’s context line', () => {
    it('offers Try again, once, when the account is paused; absent otherwise (CONTROL)', async () => {
        const { renderToStaticMarkup } = await import('react-dom/server');
        const { createElement } = await import('react');
        const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
        const thread = { agentId: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', context: { text: 'Account paused · the account is on hold', tone: 'bad' }, messages: [] } as never;
        const tried: string[] = [];
        const html = renderToStaticMarkup(createElement(ChatFlyout, { thread, onSend: () => {}, onClose: () => {}, onAccountRetry: () => { tried.push('a1'); } } as never));
        expect(html.split('data-action="account-retry"').length - 1).toBe(1);
        expect(renderToStaticMarkup(createElement(ChatFlyout, { thread, onSend: () => {}, onClose: () => {} } as never))).not.toContain('account-retry');
    });
});
