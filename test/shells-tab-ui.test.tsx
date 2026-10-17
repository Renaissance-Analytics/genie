import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE SHELLS TAB IN THE AGENT VIEW (the owner, 2026-10-14: "I should have some kind of indicator if you have any
 * shells running" — "this should be an extra tab after Changes"). The count rides the tab on every tab; the panel lists
 * what runs with its command, and a background command with no report is listed as such, never claimed running.
 * The data's own rules are in agent-shells.test.tsx.
 */

let n = 0;
const wire = (update: Record<string, unknown>, at: number): TimedEvent => ({ id: `r${++n}`, event: toStreamEvent(update) as StreamEvent, at });
const bash = (id: string, command: string, background: boolean, at: number) =>
    wire({ sessionUpdate: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: 'completed', rawInput: { command, description: `run ${command}`, ...(background ? { run_in_background: true } : {}) } }, at);
const task = (payload: Record<string, unknown>, at: number) =>
    wire({ sessionUpdate: 'notice', notice: { level: 'debug', message: `task ${String(payload.event)}` }, _meta: { 'particle.academy/task': payload } }, at);
const live = (tasks: readonly Record<string, unknown>[], at: number) =>
    wire({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'background tasks' }, _meta: { 'particle.academy/background_tasks': tasks } }, at);

const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const view = (rows: TimedEvent[], tab: 'stream' | 'shells') =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab={tab} lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} />);

describe('the Shells tab', () => {
    const twoRunning = [
        bash('tu1', 'npm run dev', true, 1000),
        task({ event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'dev server' }, 1001),
        task({ event: 'started', taskId: 'a7', taskType: 'local_agent', description: 'research' }, 1002),
        live([{ taskId: 'b1', taskType: 'local_bash', description: 'dev server' }, { taskId: 'a7', taskType: 'local_agent', description: 'research' }], 1003),
    ];

    it('sits right after Changes, and carries the running count on EVERY tab — the indicator', () => {
        const html = view(twoRunning, 'stream');
        const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
        expect(tabs).toEqual(['stream', 'files', 'changes', 'shells', 'settings']);
        expect(html.match(/data-shells-count="2"/g) ?? []).toHaveLength(1);
    });

    it('no count when nothing runs (the positive control above is the same view with two)', () => {
        expect(view([bash('tu2', 'ls', false, 1)], 'stream')).not.toContain('data-shells-count');
    });

    it('lists what runs, with its command, and what it ran in the background without a report — never claimed running', () => {
        const html = view([...twoRunning, bash('tu5', 'php artisan queue:work', true, 1500)], 'shells');
        expect(html).toContain('data-agent-shells="2"');
        expect(html.match(/data-shell-state="running"/g) ?? []).toHaveLength(2);
        expect(html).toContain('npm run dev');
        expect(html).toMatch(/data-shell-state="unreported"[\s\S]*php artisan queue:work/);
    });

    it('with no task reports at all, says why the state is unknown instead of guessing', () => {
        const html = view([bash('tu1', 'npm run dev', true, 1)], 'shells');
        expect(html).toContain('data-shells-unreported-why');
        expect(html).not.toContain('data-shell-state="running"');
    });
});
