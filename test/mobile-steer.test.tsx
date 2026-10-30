import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { mobileView } from '../src/core/mobile.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { MobileAgent, MobileShell } from '../src/renderer/components/MobileShell.js';

/**
 * THE PHONE STEERS AGENTS AND NOTHING ELSE (owner, 2026-10-11: "mobile does not need panel support and no
 * terminals at all. only the minimum needed to respond to agents and keep them going and setup new work.
 * stuff like dashboards and agent chats and activity etc"). So the shell is: what needs you, the agents
 * with their state, and one agent at a time — its activity ledger and a composer. No terminal section
 * exists any more, not hidden: absent. The agent on screen rides the hash so the phone's back button
 * works.
 */

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
    id: 'agent_kai', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '12m', ask: null, reason: null, fixes: [], step: '4/7', target: 'tests green',
    delivery: null, comms: null, context: null, ...over,
} as AgentRow);

const base = { host: 'alphar', locked: false, refusal: null, items: [], answering: null, onAnswer: () => {}, onDisconnect: () => {} };

describe('MobileShell agents', () => {
    it('lists every agent with its status word and detail, the summary chips above; tapping opens it', () => {
        const rows = [row(), row({ id: 'agent_wren', name: 'wren', provider: 'codex', workspaceId: 'fancy', state: 'waiting', ask: 'Allow migrate?', duration: null })];
        const html = renderToStaticMarkup(<MobileShell {...base} agents={{ rows, onOpen: () => {} }} />);
        expect(html).toContain('data-mobile-chips');
        expect(html).toMatch(/1 waiting on you/);
        expect(html).toMatch(/1 working/);
        expect(html).toContain('data-mobile-agent="agent_kai"');
        expect(html).toMatch(/data-mobile-agent="agent_kai"[^>]*data-state="working"/);
        expect(html).toMatch(/Working[\s\S]*?12m/);
        expect(html).toContain('data-mobile-agent="agent_wren"');
        expect(html).toMatch(/Waiting on you[\s\S]*?Allow migrate\?/);
        expect(html).toMatch(/<span[^>]*>fancy<\/span>/);
    });

    it('null rows is a skeleton; no agents is a sentence', () => {
        expect(renderToStaticMarkup(<MobileShell {...base} agents={{ rows: null, onOpen: () => {} }} />)).toContain('data-mobile-agents="loading"');
        const none = renderToStaticMarkup(<MobileShell {...base} agents={{ rows: [], onOpen: () => {} }} />);
        expect(none).toContain('data-mobile-agents="none"');
        expect(none).toMatch(/No agents yet/);
    });

    it('has NO terminal section — not hidden, absent', () => {
        const html = renderToStaticMarkup(<MobileShell {...base} agents={{ rows: [row()], onOpen: () => {} }} />);
        expect(html).not.toContain('data-mobile-terminal');
        expect(html).not.toMatch(/Rotate to landscape/);
        expect(html).not.toMatch(/Open a shell/);
    });
});

// Genie's OWN ledger shape (`StreamEvent`), not ACP's update kinds: the phone draws what the desktop Stream draws.
const event = (id: string, kind: 'message' | 'tool', at: number): TimedEvent => ({
    id,
    at,
    event: kind === 'tool'
        ? { kind: 'tool', toolCallId: id, name: 'Bash', title: 'npm test', status: 'completed', toolKind: 'execute', rawInput: null }
        : { kind: 'message', speaker: 'agent', peerName: null, text: 'done with the migration' },
});

const detail = (over: Partial<AgentDetail> = {}): AgentDetail => ({
    agent: { id: 'agent_kai', name: 'kai', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' } as AgentDetail['agent'],
    session: { running: true, state: 'thinking' } as unknown as AgentDetail['session'],
    rows: [event('e1', 'tool', 1_760_000_000_000), event('e2', 'message', 1_760_000_001_000)],
    turns: 3,
    cost: null,
    refusal: null,
    ...over,
});

describe('MobileAgent', () => {
    const render = (over: Partial<Parameters<typeof MobileAgent>[0]> = {}) =>
        renderToStaticMarkup(<MobileAgent detail={detail()} sending={false} onBack={() => {}} onSend={() => {}} onStart={() => {}} onResumeLimit={() => {}} {...over} />);

    it('names the agent, shows its activity as a ledger (newest last) and a composer to keep it going', () => {
        const html = render();
        expect(html).toContain('data-mobile-agent-view="agent_kai"');
        expect(html).toContain('data-action="back"');
        expect(html).toMatch(/>kai</);
        expect(html).toContain('data-mobile-activity');
        expect(html).toContain('data-mobile-row="e1"');
        expect(html).toContain('data-mobile-row="e2"');
        expect(html.indexOf('data-mobile-row="e1"')).toBeLessThan(html.indexOf('data-mobile-row="e2"'));
        expect(html).toMatch(/npm test/);
        expect(html).toContain('data-mobile-composer');
        expect(html).toMatch(/<textarea[^>]*name="text"/);
        expect(html).toContain('data-action="send-prompt"');
    });

    it('not running: the composer is replaced by Start; a refusal is said; no rows is a sentence; null detail is a skeleton', () => {
        const stopped = render({ detail: detail({ session: null, rows: [], refusal: 'tynn is hibernating; wake it before starting kai' }) });
        expect(stopped).toContain('data-action="start-agent"');
        expect(stopped).not.toContain('data-action="send-prompt"');
        expect(stopped).toMatch(/hibernating/);
        expect(stopped).toMatch(/Nothing yet/);
        expect(render({ detail: null })).toContain('data-mobile-agent-view="loading"');
    });

    it('sending disables the button', () => {
        expect(render({ sending: true })).toMatch(/data-action="send-prompt"[^>]*disabled/);
    });
});

describe('mobileView', () => {
    it('the agent on screen rides the hash so the back button works; anything else is home', () => {
        expect(mobileView('#agent=agent_kai')).toEqual({ kind: 'agent', agentId: 'agent_kai' });
        expect(mobileView('')).toEqual({ kind: 'home', workspaceId: null });
        expect(mobileView('#pin=482913')).toEqual({ kind: 'home', workspaceId: null });
        expect(mobileView('#agent=')).toEqual({ kind: 'home', workspaceId: null });
    });
});
