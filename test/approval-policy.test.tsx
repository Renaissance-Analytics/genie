import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { approvalPolicySentence } from '../src/core/agent-view.js';
import { approvalFrom } from '../src/core/approval.js';
import { ApprovalCard } from '../src/renderer/components/ApprovalCard.js';
import { raisesApprovals } from '../src/main/session-host.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE APPROVAL POLICY SENTENCE (`genie-2-dashboard-design.md` §2.3 / §8.3: "claude proceeds without asking — this
 * provider raises no approvals, so these edits were not gated by you."). Whether a provider raises approvals is the
 * DRIVER's published claim — prism-acp's `CLAUDE_DRIVER_CAPABILITIES.permissionRequests` is `false`, codex's is
 * `true` — read from that declaration, never branched on a provider name. Without it, an empty approvals history on
 * a claude agent reads as "nothing needed approval" when the truth is "nothing could ask".
 */
describe('the capability', () => {
    it('comes from the driver\'s declaration; an unknown provider is unknown, not "no"', () => {
        expect(raisesApprovals('claude')).toBe(false);
        expect(raisesApprovals('codex')).toBe(true);
        expect(raisesApprovals('kimi')).toBeNull();
    });

    it('the sentence names the agent and the provider, and exists only for a provider that cannot ask', () => {
        expect(approvalPolicySentence('kai', 'claude', false)).toBe('kai proceeds without asking — claude raises no approvals, so its edits are not gated by you.');
        expect(approvalPolicySentence('wren', 'codex', true)).toBeNull();
        expect(approvalPolicySentence('x', 'kimi', null)).toBeNull();
    });
});

describe('the rail', () => {
    const session = { running: true, turnState: 'idle' as const, startedAt: null, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null };
    const render = (raises: boolean | null) => renderToStaticMarkup(
        <AgentView agent={{ id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared', cwd: 'repos/genie2', raisesApprovals: raises }} session={session} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1} />,
    );

    it('says it for a provider that raises none; not for one that asks, nor when unknown (positive control first)', () => {
        expect(render(false)).toMatch(/data-approval-policy[^>]*>kai proceeds without asking — claude raises no approvals, so its edits are not gated by you\.</);
        expect(render(true)).not.toContain('data-approval-policy');
        expect(render(null)).not.toContain('data-approval-policy');
    });
});

describe("codex's own options reach the card (the board's `Allow composer for this session`)", () => {
    it('every option the driver offers is a button with its own words and id — session and remember included', () => {
        // The four options prism-acp's CodexDriver builds for a command approval (driver.js), verbatim.
        const approval = approvalFrom({
            toolCall: { toolCallId: 'call_7f3a', title: 'composer require web-auth/webauthn-lib:^5.0', name: 'Bash', rawInput: { command: 'composer require web-auth/webauthn-lib:^5.0' } },
            options: [
                { optionId: 'codex-accept', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'codex-accept-session', name: 'Allow for this session', kind: 'allow_always' },
                { optionId: 'codex-accept-amendment', name: 'Allow and remember this command', kind: 'allow_always' },
                { optionId: 'codex-decline', name: 'Deny', kind: 'reject_once' },
            ],
        })!;
        const html = renderToStaticMarkup(<ApprovalCard approval={approval} answering={null} onAnswer={() => {}} agentName="wren" />);
        for (const [id, label] of [['codex-accept', 'Allow once'], ['codex-accept-session', 'Allow for this session'], ['codex-accept-amendment', 'Allow and remember this command'], ['codex-decline', 'Deny']]) {
            expect(html).toMatch(new RegExp(`data-approval-option="${id}"[^>]*>${label}`));
        }
    });
});
