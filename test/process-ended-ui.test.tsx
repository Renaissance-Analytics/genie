import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * THE PROCESS-ENDED BLOCK IN THE RIGHT COLUMN (the board's error state): heading, the engine's words in mono, the
 * last tool call, `Open terminal` and `Copy log`. Only when the session failed. Its Restart is the header's: one per view
 * (genie#1238 — it was a second, "Restart and resume", that called the same refused restart).
 */
const agent = { id: 'a1', name: 'sable', provider: 'codex', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 9, by: 'you' }),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'php artisan test --parallel', status: 'in_progress', toolKind: 'execute', rawInput: null }),
];
const failed: LiveSession = { running: false, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'codex: acp: transport closed (EOF)', fixes: ['restart'] }, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const working: LiveSession = { ...failed, running: true, turnState: 'working', failure: null } as LiveSession;
const log = ['PHP Fatal error: Allowed memory size exhausted', '[worker 6] killed'];
// The operations: the header's Restart is the graceful restart.
const ops: AgentOpsProps = { mode: 'manual', accessScope: 'self', budgetUsd: null, deletePreview: null, diagnosis: null, lastOutcome: null, onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetMode: () => {}, onSetAccessScope: () => {}, onSetBudget: () => {} };
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={failed} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={9} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} log={log} ops={ops} {...props} />);

describe('the process-ended block', () => {
    it('heading, the engine’s words, the last tool, Copy log — and the view’s ONE Restart is the header’s (genie#1238)', () => {
        const html = render();
        expect(html).toContain('data-rail="process-ended"');
        expect(html).toContain('Process ended');
        expect(html).toContain('codex: acp: transport closed (EOF)');
        expect(html).toMatch(/data-process-log[^>]*>[^<]*PHP Fatal error: Allowed memory size exhausted/);
        expect(html).toContain('[worker 6] killed');
        expect(html).toMatch(/data-last-tool[^>]*>[^<]*Bash/);
        expect(html).not.toContain('data-action="restart-resume"');
        expect(html.split('data-action="restart"').length - 1).toBe(1);
        expect(html).toContain('data-action="copy-log"');
    });

    it('absent while the session is working — and with no log the block still names the reason', () => {
        expect(render({ session: working })).not.toContain('data-rail="process-ended"');
        const bare = render({ log: [] });
        expect(bare).toContain('data-rail="process-ended"');
        expect(bare).not.toContain('data-process-log');
    });
});
