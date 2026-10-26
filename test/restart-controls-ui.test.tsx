import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentOpsMenu } from '../src/core/agent-ops-menu.js';
import { runControls } from '../src/core/agent-settings-view.js';
import { headerActions } from '../src/core/agent-view.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * ONE RESTART PER SURFACE (genie#1238; the owner, 2026-10-26: "We have so many restart buttons across so many views and
 * some of them don't even work at all"). The Agent view had a header Restart (drawn ONLY when Broken, where the graceful
 * restart it called always refused), "Restart gracefully" in the ⋯ menu and again in Settings → Run, and "Restart and
 * resume" in the process-ended block; the chat had a "Restart <agent> and send" on every undelivered message. Now:
 *
 * - the Agent view's header carries ONE `Restart` whenever the agent has a session (running, idle, Broken), and `Start`
 *   when it has none — both the same action (`agents.restart(id, 'graceful')`, main/agent-ops-host.ts);
 * - "Restart fresh" stays in the ⋯ menu and Settings → Run: a different operation (it drops the conversation);
 * - the process-ended block says what ended and offers Open terminal and Copy log — its Restart is the header's;
 * - the chat carries ONE `Restart`, on its latest undelivered message: the restart delivers every owed message, in order.
 */

const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null, ...over }) as LiveSession;
const STATES: ReadonlyArray<{ name: string; session: LiveSession | null; control: 'restart' | 'start' }> = [
    { name: 'running, mid-turn', session: session({ turnState: 'working', cancelTurn: true }), control: 'restart' },
    { name: 'idle', session: session(), control: 'restart' },
    { name: 'Broken', session: session({ running: false, turnState: 'failed', failure: { reason: 'ACP stream closed · exit 137', fixes: ['Restart'] } as never }), control: 'restart' },
    { name: 'Broken in preparation', session: session({ turnState: 'failed', failure: { reason: 'Preparation failed', fixes: ['Restart'] } as never }), control: 'restart' },
    { name: 'account paused', session: session({ accountPaused: { reason: 'billing', words: 'paused' } as never }), control: 'restart' },
    { name: 'its run ended (exited, kept in the host)', session: session({ running: false, turnState: 'stopped' }), control: 'start' },
    { name: 'stopped / never started', session: null, control: 'start' },
];
const ops: AgentOpsProps = { mode: 'manual', accessScope: 'self', budgetUsd: null, deletePreview: null, diagnosis: null, lastOutcome: null, onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetMode: () => {}, onSetAccessScope: () => {}, onSetBudget: () => {} } as unknown as AgentOpsProps;
const render = (s: LiveSession | null, tab: 'stream' | 'settings' = 'stream') =>
    renderToStaticMarkup(<AgentView agent={agent} session={s} rows={[]} tab={tab} lanes={null} at={null} selectedId={null} turns={3} cost={null} onNavigate={() => {}} onSelect={() => {}} onStart={() => {}} onStop={() => {}} onTakeOver={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} log={['last words']} ops={ops} />);
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('the Agent view: one Restart (or Start) in every state', () => {
    for (const s of STATES) {
        it(`${s.name}: exactly one ${s.control === 'restart' ? 'Restart' : 'Start'}, and no other restart control`, () => {
            const actions = headerActions(s.session, 'declared');
            expect({ restart: actions.restart, start: actions.start }).toEqual({ restart: s.control === 'restart', start: s.control === 'start' });
            for (const tab of ['stream', 'settings'] as const) {
                const html = render(s.session, tab);
                expect(count(html, /data-action="restart"/g)).toBe(s.control === 'restart' ? 1 : 0);
                expect(count(html, /data-action="start"/g)).toBe(s.control === 'start' ? 1 : 0);
                // The duplicates that are gone: the menu's and Run's "Restart gracefully", the process-ended block's own.
                expect(html).not.toContain('restart-graceful');
                expect(html).not.toContain('restart-resume');
            }
            // Labelled `Restart` — the one word every surface uses.
            if (s.control === 'restart') expect(render(s.session)).toMatch(/data-action="restart"[^>]*>(?:(?!<\/button>)[\s\S])*Restart<\/button>/);
        });
    }

    it('the operations menu and Settings → Run keep only the different operation: Restart fresh', () => {
        const ids = agentOpsMenu(agent, undefined, { running: true }).map((i) => i.id);
        expect(ids).toContain('restart-fresh');
        expect(ids).not.toContain('restart-graceful');
        expect(runControls(agent, true).map((i) => i.id)).toEqual(['stop-agent', 'restart-fresh', 'diagnose']);
    });

    it('an observed (Take Over) agent is not Genie’s to restart: neither control', () => {
        expect(headerActions(null, 'observed')).toMatchObject({ restart: false, start: false });
    });
});

describe('the chat: one Restart, on the latest undelivered message', () => {
    const thread = (messages: ChatThread['messages']): ChatThread => ({ agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context: null, messages });
    const undelivered = (id: string, at: number) => ({ id, who: 'you' as const, from: 'you', text: `message ${id}`, delivered: false, at, resend: 'restart' as const });

    it('two undelivered messages to an agent that is not running: one Restart, labelled Restart, on the latest', () => {
        const html = renderToStaticMarkup(<ChatFlyout thread={thread([undelivered('d1', 1_000), undelivered('d2', 2_000)])} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} onDiscardDraft={() => {}} />);
        expect(count(html, /data-action="restart"/g)).toBe(1);
        expect(html).toMatch(/<button[^>]*data-action="restart"[^>]*data-draft="d2"[^>]*>Restart<\/button>/);
        expect(html).not.toContain('restart-and-send');
        // Each is still said to be undelivered, and each can still be discarded.
        expect(count(html, /data-chat-undelivered=/g)).toBe(2);
        expect(count(html, /data-action="discard-draft"/g)).toBe(2);
    });
});

describe('every Start and Restart control in the window calls the ONE restart', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    it('no Start or Restart control starts an agent another way (`openAgent` was Start, the Dashboard lane, the phone and the chat)', () => {
        // Red on main: five calls — four controls whose `openAgent` did nothing for an agent whose run had ended. The one
        // left is NAVIGATION (opening an agent starts or reattaches it, and never restarts a Broken one you came to read).
        expect(app.match(/\.openAgent\(/g) ?? []).toHaveLength(1);
        expect(app).toMatch(/onOpenAgent=\{\(id\) => \{[\s\S]{0,600}?resolvedBridge\?\.openAgent\(id\);/);
        expect(app).toMatch(/onStartAgent=\{\(agentId\) => \{ void restartOne\(agentId\)/);
        expect(app).toMatch(/onRestartAgent=\{\(agentId\) => \{ void restartOne\(agentId\)/);
    });
    it('the graceful restart is asked for in one place, which every control goes through', () => {
        expect(app.match(/agents\.restart\([^)]*'graceful'\)/g) ?? []).toHaveLength(2); // the window's, and the phone's
    });
});
