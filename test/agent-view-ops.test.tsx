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
    deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self',
    onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {}, onSetMode: () => {}, onSetAccessScope: () => {},
    ...over,
});
const broken = { running: false, turnState: 'failed', startedAt: null, pendingApproval: null, failure: { reason: 'ACP stream closed · exit 137', fixes: ['Restart'] }, contextUsed: null, contextSize: null, plan: null } as unknown as Parameters<typeof AgentView>[0]['session'];
const render = (o?: AgentOpsProps, s: Parameters<typeof AgentView>[0]['session'] = null) =>
    renderToStaticMarkup(<AgentView agent={agent} session={s} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={o} />);

describe('the header', () => {
    it('without ops: no restart, no overflow, no confirm card; with ops: the overflow trigger, and Restart ONLY when broken (the board)', () => {
        const none = render();
        expect(none).not.toContain('data-action="restart-graceful"');
        expect(none).not.toContain('data-action="agent-more"');
        const html = render(ops());
        expect(html).not.toContain('data-action="restart-graceful"');
        expect(render(ops(), broken)).toContain('data-action="restart-graceful"');
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

    it('a RUNNING agent is offered "Ask for a handoff first", ticked by default (Genie 1’s AgentDeleteModal); a stopped one is told why not', () => {
        const live = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as Parameters<typeof AgentView>[0]['session'];
        const plan = { outcome: 'delete' as const, removes: [], keeps: [], external: [] };
        const html = render(ops({ deletePreview: plan }), live);
        expect(html).toMatch(/<input type="checkbox" name="handoff" checked=""/);
        expect(html).toMatch(/Ask for a handoff first/);
        expect(html).toMatch(/survives even though its \.agents\/ files do not/);
        expect(render(ops({ deletePreview: { ...plan, outcome: 'unmount' } }), live)).toMatch(/next run picks up where it left off/);
        // Control: not running — no checkbox, and the reason instead of a mute greyed box.
        const stopped = render(ops({ deletePreview: plan }));
        expect(stopped).not.toMatch(/name="handoff"/);
        expect(stopped).toMatch(/not running, so there is nothing to ask/);
    });
});

describe('the provider rail', () => {
    it('says a new provider starts a NEW conversation — the old one does not come along', () => {
        expect(render(ops())).toMatch(/starts a new conversation on the new provider/);
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
