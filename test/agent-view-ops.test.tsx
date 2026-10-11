import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * AGENT OPERATIONS IN THE AGENT VIEW (§6.2). The header gains Restart and an overflow; a delete is
 * CONFIRMED on a card that shows the plan — what goes, what stays, each linked system with its
 * opt-in as a checkbox in the same card — before anything happens; a diagnosis is a line with the
 * cause and the repair; the last outcome (a refusal most of all) is shown where it was caused. The
 * budget rail shows a daily limit and says plainly when it cannot be enforced. Without `ops` none of
 * it is drawn — an Observed agent, or a window that cannot operate agents, has no dead controls.
 */

const agent = { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
const ops = (over: Partial<AgentOpsProps> = {}): AgentOpsProps => ({
    deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null,
    onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
    ...over,
});
const render = (o?: AgentOpsProps) =>
    renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={o} />);

describe('the header', () => {
    it('without ops: no restart, no overflow, no confirm card; with ops: Restart and the overflow trigger', () => {
        const none = render();
        expect(none).not.toContain('data-action="restart-graceful"');
        expect(none).not.toContain('data-action="agent-more"');
        const html = render(ops());
        expect(html).toContain('data-action="restart-graceful"');
        expect(html).toContain('data-action="agent-more"');
        expect(html).not.toContain('data-delete-confirm');
        expect(html).not.toContain('data-diagnosis');
    });
});

describe('the delete confirm card', () => {
    it('shows what goes and what stays, one checkbox per linked system with its opt-in, the named outcome as the confirm, and Cancel — before anything happens', () => {
        const html = render(ops({ deletePreview: { outcome: 'delete', removes: ['the agent record in Genie', '.agents/atlas/ (every file)'], keeps: ['its thread history on the provider'], external: [{ system: 'tynn', action: 'kept', optIn: 'alsoRemoveFrom: ["tynn"]' }] } }));
        expect(html).toContain('data-delete-confirm="delete"');
        expect(html).toMatch(/\.agents\/atlas\/ \(every file\)/);
        expect(html).toMatch(/its thread history on the provider/);
        expect(html).toMatch(/name="also-tynn"/);
        expect(html).toMatch(/also remove from tynn/i);
        expect(html).toContain('data-action="confirm-delete"');
        expect(html).toMatch(/>Delete atlas</);
        expect(html).toMatch(/>Cancel</);
        expect(render(ops({ deletePreview: { outcome: 'unmount', removes: [], keeps: [], external: [] } }))).toMatch(/>Unmount atlas</);
    });
});

describe('diagnosis, outcome, budget', () => {
    it('a diagnosis is a line with state, cause and the repair; a refusal outcome is shown where it was caused', () => {
        const html = render(ops({ diagnosis: { state: 'broken', fault: true, cause: 'claude is not installed', repair: { action: 'install-provider' } }, lastOutcome: 'this agent has no conversation to resume; a graceful restart would silently start a new chat — use a fresh restart if that is what you want' }));
        expect(html).toContain('data-diagnosis="broken"');
        expect(html).toMatch(/claude is not installed/);
        expect(html).toMatch(/install the provider/i);
        expect(html).toContain('data-ops-outcome');
        expect(html).toMatch(/no conversation to resume/);
        const dormant = render(ops({ diagnosis: { state: 'dormant', fault: false, cause: 'registered, never started', repair: null } }));
        expect(dormant).toContain('data-diagnosis="dormant"');
        expect(dormant).not.toMatch(/data-diagnosis-fault/);
    });

    it('a daily budget shows on the rail with the plain word that it cannot be enforced today; no limit, no row', () => {
        const html = render(ops({ budgetUsd: 5 }));
        expect(html).toContain('data-rail="budget"');
        expect(html).toContain('data-budget-limit="5"');
        expect(html).toMatch(/unenforceable/);
        expect(render(ops({ budgetUsd: null }))).not.toContain('data-budget-limit');
    });
});
