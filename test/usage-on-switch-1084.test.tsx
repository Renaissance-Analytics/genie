// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsAction } from '../src/core/account-settings.js';
import { accountsActionOf } from '../src/core/account-settings.js';
import { accountsView, type KnownAccountRecord } from '../src/core/accounts-view.js';
import { headerActions } from '../src/core/agent-view.js';
import { chatThreadFrom } from '../src/core/chat-view.js';
import { headroomLine, type Headroom } from '../src/core/headroom.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { PANEL_RECHECK_MS } from '../src/core/usage-probe.js';
import { AccountsChip } from '../src/renderer/components/AccountsChip.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';

/**
 * WHAT THE PERSON SEES ABOUT USAGE AND ACCOUNTS AFTER A SWITCH (Tynn #1084; the owner, beta.66.1). The active account read
 * "Usage unknown: not read yet" for good while his agent's stream said "67% of 7d window left" (that agent was still on the
 * OLD account), so it looked as if Genie ignored the reading. Now: the panel asks for readings when it opens and every
 * 5 min while open; an account being read says "Reading usage…", one that could not be read says why; every card has
 * "Check usage now"; the panel says how many agents are still on another account, with "Restart on <active> now"; and the
 * stream's limit line, the agent header, the chat and the Dashboard row name the account the agent is really on.
 */
const NOW = new Date(2026, 10, 27, 9, 30).getTime();
const HOUR = 3_600_000;
const NEW = 'account_new', OLD = 'account_old';
const KNOWN: KnownAccountRecord[] = [
    { id: NEW, provider: 'claude', label: 'wish@', identity: { email: 'wish@example.invalid', plan: 'max 20x' } },
    { id: OLD, provider: 'claude', label: 'wish+ai@', identity: { email: 'wish+ai@example.invalid', plan: 'max 20x' } },
];
const OLD_READING = { provider: 'claude', accountId: OLD, runId: 'r', room: {} as Headroom, windows: [{ window: '7d', usedPct: 32, leftPct: 68, resetsAtMs: NOW + 40 * HOUR, over: false, refreshed: false as const }] };
const viewWith = (extras: Parameters<typeof accountsView>[4] = {}) => accountsView(KNOWN, [OLD_READING], { claude: NEW }, {}, extras)[0]!;

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.useRealTimers(); });
const click = (el: Element | null) => { expect(el).not.toBeNull(); act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
function openChip(view = viewWith()) {
    const acts: AccountsAction[] = [];
    act(() => root.render(<AccountsChip view={view} offer={null} now={NOW} onAccountsAct={(a) => { acts.push(a); return Promise.resolve({ ok: true }); }} />));
    click(host.querySelector('[data-account-chip="claude"]'));
    return acts;
}

describe('the Accounts panel reads usage when it opens, and while it stays open', () => {
    it('opening it asks once; every 5 min while open it asks again; closed, it asks no more', () => {
        vi.useFakeTimers();
        const acts = openChip();
        expect(acts.filter((a) => a.kind === 'read-usage')).toEqual([{ kind: 'read-usage', provider: 'claude' }]);
        act(() => { vi.advanceTimersByTime(PANEL_RECHECK_MS); });
        expect(acts.filter((a) => a.kind === 'read-usage')).toHaveLength(2);
        click(host.querySelector('[data-account-chip="claude"]'));
        act(() => { vi.advanceTimersByTime(3 * PANEL_RECHECK_MS); });
        expect(acts.filter((a) => a.kind === 'read-usage')).toHaveLength(2);
    });

    it('CONTROL: a closed chip asks nothing', () => {
        const acts: AccountsAction[] = [];
        act(() => root.render(<AccountsChip view={viewWith()} offer={null} now={NOW} onAccountsAct={(a) => { acts.push(a); }} />));
        expect(acts).toEqual([]);
    });

    it('an account being read says "Reading usage…", not "not read yet"', () => {
        openChip(viewWith({ usage: { [NEW]: { state: 'reading' } } }));
        const card = document.querySelector(`[data-account="${NEW}"]`)!;
        expect(card.textContent).toContain('Reading usage…');
        expect(card.textContent).not.toContain('not read yet');
    });

    it('an account that could not be read says why', () => {
        openChip(viewWith({ usage: { [NEW]: { state: 'failed', reason: 'Claude Code reported no usage for this account', at: NOW } } }));
        expect(document.querySelector(`[data-account="${NEW}"]`)!.textContent).toContain('Could not read usage: Claude Code reported no usage for this account');
    });

    it('every account card has "Check usage now", which asks for THAT account at once', () => {
        const acts = openChip();
        const buttons = [...document.querySelectorAll('[data-action="check-usage"]')];
        expect(buttons.map((b) => b.closest('[data-account]')?.getAttribute('data-account')).sort()).toEqual([NEW, OLD].sort());
        expect(buttons[0]!.textContent).toContain('Check usage now');
        click(document.querySelector(`[data-account="${NEW}"] [data-action="check-usage"]`));
        expect(acts.at(-1)).toEqual({ kind: 'read-usage', provider: 'claude', id: NEW, manual: true });
    });

    it('says how many agents are still on another account until idle, and offers Restart on the active one now', () => {
        const acts = openChip(viewWith({ stillOn: { claude: [{ accountId: OLD, label: 'wish+ai@', count: 2 }] } }));
        const banner = document.querySelector('[data-accounts-still-on]')!;
        expect(banner.textContent).toContain('2 agents still on wish+ai@ until idle');
        click(banner.querySelector('[data-action="move-now"]'));
        expect(banner.querySelector('[data-action="move-now"]')!.textContent).toContain('Restart on wish@ now');
        expect(acts.at(-1)).toEqual({ kind: 'move-now', provider: 'claude' });
    });

    it('CONTROL: with every agent on the active account there is no banner', () => {
        openChip();
        expect(document.querySelector('[data-accounts-still-on]')).toBeNull();
    });

    it('the host accepts only these fields of the new actions', () => {
        expect(accountsActionOf({ kind: 'read-usage', provider: 'claude', id: NEW, manual: true, token: 'x' })).toEqual({ kind: 'read-usage', provider: 'claude', id: NEW, manual: true });
        expect(accountsActionOf({ kind: 'read-usage', provider: 'claude' })).toEqual({ kind: 'read-usage', provider: 'claude' });
        expect(accountsActionOf({ kind: 'move-now', provider: 'claude', agentId: 'a1', extra: 1 })).toEqual({ kind: 'move-now', provider: 'claude', agentId: 'a1' });
        expect(accountsActionOf({ kind: 'read-usage' })).toBeNull();
    });
});

const room: Headroom = { plan: 'max', window: '7d', leftPct: 67, resetsAtMs: NOW + 40 * HOUR, over: false, windows: [] };
const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null, ...over }) as LiveSession;
const moving = { id: OLD, label: 'wish+ai@', movesTo: { id: NEW, label: 'wish@' } };
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
const ops = { mode: 'manual', accessScope: 'self', budgetUsd: null, deletePreview: null, diagnosis: null, lastOutcome: null } as unknown as AgentOpsProps;
const renderAgent = (s: LiveSession, onMoveNow?: () => void) => renderToStaticMarkup(<AgentView agent={agent} session={s} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={3} cost={null} onNavigate={() => {}} onSelect={() => {}} onStart={() => {}} onStop={() => {}} onTakeOver={() => {}} now={() => NOW} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} log={[]} ops={ops} {...(onMoveNow ? { onMoveNow } : {})} />);

describe('the account an agent and its readings are really on is named', () => {
    it('the stream\'s rate-limit line names the account the reading came from', () => {
        expect(headroomLine(room, 'wish+ai@')).toMatch(/67% of 7d window left on wish\+ai@ · resets /);
        // CONTROL: with no account named, the line is as before.
        expect(headroomLine(room)).toMatch(/^max · 67% of 7d window left · resets /);
    });

    it('the agent header names its account; one still on the old account says where it moves, with Restart on <new> now', () => {
        const html = renderAgent(session({ account: moving }), () => {});
        expect(html).toContain('data-agent-runs-on');
        expect(html).toMatch(/On wish\+ai@ · moves to wish@ at next idle/);
        expect(html).toMatch(/data-action="move-now"[^>]*>[\s\S]*?Restart on wish@ now/);
        expect(headerActions(session({ account: moving }), 'declared').moveNow).toBe(true);
    });

    it('CONTROL: an agent on the active account is named, with no move and no button', () => {
        const html = renderAgent(session({ account: { id: NEW, label: 'wish@' } }), () => {});
        expect(html).toMatch(/On wish@/);
        expect(html).not.toContain('moves to');
        expect(html).not.toContain('data-action="move-now"');
        expect(headerActions(session({ account: { id: NEW, label: 'wish@' } }), 'declared').moveNow).toBe(false);
    });

    it('the chat names the account, and the move with its button', () => {
        const detail = { agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared', workspaceId: 'tynn' }, session: session({ account: moving }), rows: [] } as never;
        const thread = chatThreadFrom(detail, 'a1', [], () => NOW);
        expect(thread.account).toEqual({ label: 'wish+ai@', movesTo: 'wish@' });
        const html = renderToStaticMarkup(<ChatFlyout thread={thread as never} onSend={() => {}} onClose={() => {}} onMoveNow={() => {}} />);
        expect(html).toMatch(/data-chat-account[^>]*>[\s\S]*?on wish\+ai@/);
        expect(html).toMatch(/Restart on wish@ now/);
    });

    it('the Dashboard row carries the account it is on and where it moves', () => {
        const row = agentRowFor({ id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws' } as never, session({ account: moving }), () => NOW);
        expect(row.account).toEqual({ label: 'wish+ai@', movesTo: 'wish@' });
    });
});
