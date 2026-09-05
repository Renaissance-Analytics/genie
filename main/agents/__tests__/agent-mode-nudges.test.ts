import { describe, expect, it, vi } from 'vitest';
import {
    attentionNudgeMode,
    bootPromptMode,
    drainNudgeMode,
    inboxNoticeMode,
    upgradeNoticeMode,
    type AgentMode,
} from '../agent-mode';
import { drainNudgeText } from '../drain';
import { announceAgentUpgrade, formatAgentUpgradeMessage } from '../upgrade-announcement';
import { MANUAL_RECOVERY } from '../mcp-reconnect';
import { agentBootPrompt } from '../boot-prompt';
import { inboxNoticeText } from '../../agentinbox/notify';
import { wakeNudgeText } from '../../agentinbox/wake';
import { issueWatchWakeText } from '../../issue-watch/ping';

/**
 * genie#408 — ONE mode, consulted EVERYWHERE Genie speaks to an agent in an
 * imperative voice.
 *
 * The upgrade notice is the case the issue was filed about, but it is not the
 * only one: an agent that is told *"check it immediately"* by the inbox and
 * *"open the IssueWatch panel"* by a ping has been given three imperatives from
 * three files, and fixing one of them leaves the mis-inference intact. So every
 * surface is enumerated here, and each is asserted to carry the clause for the
 * mode it was given.
 */

/** Every Genie-authored nudge an agent receives, and the clause each must carry. */
const SURFACES: readonly {
    name: string;
    render: (mode: AgentMode) => string;
    clause: (mode: AgentMode) => string;
}[] = [
    {
        name: 'the upgrade announcement',
        render: (mode) => formatAgentUpgradeMessage('0.8.0', ['A change'], MANUAL_RECOVERY, mode),
        clause: upgradeNoticeMode,
    },
    {
        name: 'an AgentInbox notice',
        render: (mode) => inboxNoticeText({ from: 'moic', priority: 'normal', mode }),
        clause: inboxNoticeMode,
    },
    {
        name: 'an AgentInbox attention nudge',
        render: (mode) => wakeNudgeText(3, mode),
        clause: attentionNudgeMode,
    },
    {
        name: 'an IssueWatch ping',
        render: (mode) => issueWatchWakeText(mode),
        clause: attentionNudgeMode,
    },
    {
        name: 'the boot prompt',
        render: (mode) => agentBootPrompt({ genieAvailable: true, mode }),
        clause: bootPromptMode,
    },
    {
        // genie#389. The SIXTH surface, and the one where the Manual clause is
        // an ask rather than a disclaimer — the upgrade is held until this
        // agent answers, so silence is the failure. The mode still changes the
        // wording; what it changes here is the SCOPE.
        name: 'the upgrade drain nudge',
        render: drainNudgeText,
        clause: drainNudgeMode,
    },
];

describe('every Genie-authored nudge is worded for the agent’s mode', () => {
    it.each(SURFACES)('$name says which mode it is speaking to', ({ render, clause }) => {
        expect(render('manual')).toContain(clause('manual'));
        expect(render('automated')).toContain(clause('automated'));
        // The two must actually DIFFER — a surface that ignored the argument
        // would satisfy a one-sided assertion and change nothing.
        expect(render('manual')).not.toBe(render('automated'));
    });

    it.each(SURFACES)('$name never gives a Manual agent the Automated clause', ({
        render,
        clause,
    }) => {
        expect(render('manual')).not.toContain(clause('automated'));
        expect(render('automated')).not.toContain(clause('manual'));
    });
});

describe('the upgrade announcement resolves the mode per AGENT', () => {
    const target = (agentId: string) => ({ agentId, name: agentId });

    it('asks for each agent’s own mode, not the fleet’s', () => {
        // The mode belongs to the AGENT: one workspace can hold a supervising
        // Automated agent and a Manual one a person drives, and they are woken
        // by the same announcement.
        const sent: Record<string, string> = {};
        const modes: Record<string, AgentMode> = { supervisor: 'automated', hand: 'manual' };
        announceAgentUpgrade({
            currentVersion: '0.8.0',
            agents: [target('supervisor'), target('hand')],
            changes: [],
            send: (agentId, text) => {
                sent[agentId] = text;
                return true;
            },
            mode: (agentId) => modes[agentId] ?? 'manual',
            persist: () => {},
            schedule: (run) => run(),
        });

        expect(sent.supervisor).toContain(upgradeNoticeMode('automated'));
        expect(sent.hand).toContain(upgradeNoticeMode('manual'));
    });

    it('falls back to manual when the caller cannot say', () => {
        // A caller with no way to resolve a mode must not have one invented for
        // it — and the invention that is safe is the default.
        const send = vi.fn().mockReturnValue(true);
        announceAgentUpgrade({
            currentVersion: '0.8.0',
            agents: [target('unknown')],
            changes: [],
            send,
            persist: () => {},
            schedule: (run) => run(),
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(String(send.mock.calls[0]![1])).toContain(upgradeNoticeMode('manual'));
    });

    it('degrades to manual when the resolver throws', () => {
        // Reading a mode means touching the database and a file on disk. Neither
        // may be able to cost an agent its upgrade notice.
        const send = vi.fn().mockReturnValue(true);
        announceAgentUpgrade({
            currentVersion: '0.8.0',
            agents: [target('boom')],
            changes: [],
            send,
            mode: () => {
                throw new Error('no such agent');
            },
            persist: () => {},
            schedule: (run) => run(),
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(String(send.mock.calls[0]![1])).toContain(upgradeNoticeMode('manual'));
    });
});
