import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import {
    AGENTINBOX_HUMAN,
    AGENTINBOX_SYSTEM,
    AGENTINBOX_SYSTEM_LABEL,
    machineSenderId,
    machineSenderLabel,
    readMachineSender,
} from '../types';
import type { AgentInboxJoinInput } from '../types';

/**
 * MACHINE SENDERS (genie#543).
 *
 * The owner's report: *"the AgentInbox is something that agents can use when
 * setting up crons and stuff like that so they can get notifications. Make sure
 * those kind of notices that get sent to the agents have distinctive sources.
 * right now when agents do this it looks like they are sending themselves a
 * msg."*
 *
 * An inbox notice is an INTERRUPT — it glows a terminal and can nudge a pty — so
 * the first thing an agent reads is the sender. Before this, `send` could resolve
 * exactly three senders (`genie:system`, the human, the sending agent), and every
 * machine-originated notice had to borrow one of them. A scheduled task nudging an
 * agent borrowed the HUMAN's identity, so a cron the agent set up for itself
 * arrived labelled "You".
 *
 * These tests pin BOTH directions: the new machine sources are distinct and carry
 * the job's identity, AND the three pre-existing senders are byte-for-byte
 * unchanged. A change that relabels everything would pass a one-sided test.
 */

function input(over: Partial<AgentInboxJoinInput> & { agentId: string }): AgentInboxJoinInput {
    return {
        terminalId: `t-${over.agentId}`,
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: `Agent ${over.agentId}`,
        purpose: 'general',
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

function fresh(): AgentInboxBroker {
    return new AgentInboxBroker();
}

describe('machine sender identity — construction and read-back', () => {
    it('names the KIND and the JOB, so two crons are tellable apart', () => {
        const nightly = { kind: 'cron', id: 'spec-1', label: 'nightly-backup' } as const;
        const hourly = { kind: 'cron', id: 'spec-2', label: 'hourly-sync' } as const;

        expect(machineSenderId(nightly)).toBe('genie:cron:spec-1');
        expect(machineSenderId(hourly)).toBe('genie:cron:spec-2');
        expect(machineSenderLabel(nightly)).toBe('Cron: nightly-backup');
        expect(machineSenderLabel(hourly)).toBe('Cron: hourly-sync');
    });

    it('keeps two same-NAMED jobs distinct, because the id is what identifies them', () => {
        const a = { kind: 'cron', id: 'spec-1', label: 'sweep' } as const;
        const b = { kind: 'cron', id: 'spec-2', label: 'sweep' } as const;
        expect(machineSenderId(a)).not.toBe(machineSenderId(b));
    });

    it('a watched process is its own kind, not a cron', () => {
        const p = { kind: 'process', id: 'proc-9', label: 'queue-worker' } as const;
        expect(machineSenderId(p)).toBe('genie:process:proc-9');
        expect(machineSenderLabel(p)).toBe('Process: queue-worker');
    });

    it('falls back to the job id when the job has no label, never to a bare kind', () => {
        expect(machineSenderLabel({ kind: 'cron', id: 'spec-7' })).toBe('Cron: spec-7');
    });

    it('reads the origin back off `from` — kind AND job, no body parsing', () => {
        expect(readMachineSender('genie:cron:spec-1')).toEqual({ kind: 'cron', id: 'spec-1' });
        expect(readMachineSender('genie:process:proc-9')).toEqual({
            kind: 'process',
            id: 'proc-9',
        });
    });

    it('reports the Genie announcement channel as a machine origin too, with no job id', () => {
        // One question — "is this machine-originated, and what KIND" — with one
        // answer covering all three, so a consumer never string-matches a label.
        expect(readMachineSender(AGENTINBOX_SYSTEM)).toEqual({ kind: 'system', id: null });
    });

    it('reports NOTHING for a person or an agent — they are not machine origins', () => {
        expect(readMachineSender(AGENTINBOX_HUMAN)).toBeNull();
        expect(readMachineSender('4f0d0f3e-0000-4000-8000-000000000001')).toBeNull();
        // A near-miss must not be read as a source: an unknown kind is not a
        // machine sender this build knows how to act on.
        expect(readMachineSender('genie:webhook:x')).toBeNull();
        expect(readMachineSender('genie:cron:')).toBeNull();
    });
});

describe('AgentInboxBroker.send — a machine source is its own sender', () => {
    it('delivers a scheduled-job notice as the JOB, not as the human and not as an agent', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));

        expect(
            b.send({
                source: { kind: 'cron', id: 'spec-1', label: 'nightly-backup' },
                toAgentId: 'A',
                text: 'Backup finished: 3 repos, 0 errors.',
            }).ok,
        ).toBe(true);

        const received = await b.receive('A');
        expect(received.messages).toEqual([
            expect.objectContaining({
                from: 'genie:cron:spec-1',
                fromLabel: 'Cron: nightly-backup',
                text: 'Backup finished: 3 repos, 0 errors.',
            }),
        ]);
        // The reported symptom, pinned: it must not read as the agent's own mail,
        // nor as the human's.
        expect(received.messages[0].from).not.toBe('A');
        expect(received.messages[0].from).not.toBe(AGENTINBOX_HUMAN);
        expect(received.messages[0].fromLabel).not.toBe('You');
    });

    it('delivers a watched-process notice under a source distinct from cron', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.send({
            source: { kind: 'process', id: 'proc-9', label: 'queue-worker' },
            toAgentId: 'A',
            text: 'queue-worker exited 1.',
        });
        const received = await b.receive('A');
        expect(received.messages[0]).toEqual(
            expect.objectContaining({
                from: 'genie:process:proc-9',
                fromLabel: 'Process: queue-worker',
            }),
        );
    });

    it('does NOT file a job notice in the human panel thread', async () => {
        // The concrete shape of the old bug: a cron nudge went out as the human,
        // so it landed in the human↔agent DM history as a message nobody sent.
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.send({
            source: { kind: 'cron', id: 'spec-1', label: 'nightly' },
            toAgentId: 'A',
            text: 'x',
        });

        const threads = b.dmThreads();
        expect(threads).toHaveLength(1);
        expect(threads[0].withHuman).toBe(false);
        // The thread names the job even though no agent by that id has ever joined.
        expect([threads[0].aLabel, threads[0].bLabel]).toContain('Cron: nightly');
    });

    it('refuses a machine source with no job id — an unidentifiable job is the bug', () => {
        // Named refusal, not the generic "Unknown sender." a missing branch gives:
        // a job that cannot say WHICH job it is delivers the same uselessness this
        // issue is about, so it must not be accepted and quietly flattened.
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        const r = b.send({ source: { kind: 'cron', id: '  ' }, toAgentId: 'A', text: 'x' });
        if (r.ok) throw new Error('expected an unidentifiable job to be refused');
        expect(r.error).toMatch(/id/i);
    });
});

describe('replying to a machine source — a capability, not a label', () => {
    it('cannot be replied to, and is REFUSED rather than merely labelled "no reply"', () => {
        // "Genie (no reply)" has never been enforced by its text: `send` requires a
        // registered agent to address, and no machine origin has one. A job source
        // inherits exactly that, so the label and the behaviour cannot drift apart.
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        // The notice must actually LAND first, or "you cannot reply to it" is a
        // statement about a message that was never delivered.
        expect(
            b.send({
                source: { kind: 'cron', id: 'spec-1', label: 'nightly' },
                toAgentId: 'A',
                text: 'x',
            }).ok,
        ).toBe(true);

        expect(b.send({ fromAgentId: 'A', toAgentId: 'genie:cron:spec-1', text: 'ack' }).ok).toBe(
            false,
        );
        // The positive control for that negative: the same agent CAN reach a real peer,
        // so the refusal above is about the machine source and not a dead broker.
        b.join(input({ agentId: 'B' }));
        expect(b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'ack' }).ok).toBe(true);
    });

    it('refuses a reply to the Genie announcement channel the same way', () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        expect(b.send({ fromAgentId: 'A', toAgentId: AGENTINBOX_SYSTEM, text: 'ack' }).ok).toBe(
            false,
        );
        // Positive control for that negative: A can reach a real peer, so the
        // refusal is about the unaddressable sender and not a broker that refuses
        // everything.
        expect(b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'ack' }).ok).toBe(true);
    });
});

describe('POSITIVE CONTROLS — the three original senders are untouched', () => {
    it('a Genie announcement is still `genie:system` / "Genie (no reply)"', async () => {
        // The four system call sites (drain, shutdown readiness, the upgrade
        // notice) must not be absorbed into a generic machine bucket: that
        // identity is correct for them, and a regression here is worse than #543.
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        expect(b.send({ system: true, toAgentId: 'A', text: 'Prepare for shutdown.' }).ok).toBe(
            true,
        );
        const received = await b.receive('A');
        expect(received.messages[0]).toEqual(
            expect.objectContaining({ from: 'genie:system', fromLabel: 'Genie (no reply)' }),
        );
        // The constants the branch now reads from are the same bytes it hardcoded.
        expect(AGENTINBOX_SYSTEM).toBe('genie:system');
        expect(AGENTINBOX_SYSTEM_LABEL).toBe('Genie (no reply)');
    });

    it('the human panel is still `human` / "You"', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        expect(b.send({ human: true, toAgentId: 'A', text: 'hello' }).ok).toBe(true);
        const received = await b.receive('A');
        expect(received.messages[0]).toEqual(
            expect.objectContaining({ from: 'human', fromLabel: 'You' }),
        );
    });

    it('a genuine agent-to-agent DM still carries the SENDING agent label', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A', label: 'Ops Agent' }));
        b.join(input({ agentId: 'B' }));
        expect(b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'peer mail' }).ok).toBe(true);
        const received = await b.receive('B');
        expect(received.messages[0]).toEqual(
            expect.objectContaining({ from: 'A', fromLabel: 'Ops Agent' }),
        );
    });

    it('a DELIBERATE self-DM still works and still arrives as the agent itself', async () => {
        // A note-to-self across a restart is legitimate. #543 is about a notice
        // that only LOOKS like one; the real thing must survive the fix.
        const b = fresh();
        b.join(input({ agentId: 'A', label: 'Ops Agent' }));
        expect(b.send({ fromAgentId: 'A', toAgentId: 'A', text: 'resume the migration' }).ok).toBe(
            true,
        );
        const received = await b.receive('A');
        expect(received.messages[0]).toEqual(
            expect.objectContaining({
                from: 'A',
                fromLabel: 'Ops Agent',
                text: 'resume the migration',
            }),
        );
        expect(readMachineSender(received.messages[0].from)).toBeNull();
    });
});

describe('deliverMachineMessageToTerminal — the wiring a scheduled job uses', () => {
    it('resolves the terminal to its agent and posts under the JOB source', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A', terminalId: 'term-7' }));

        expect(
            b.deliverMachineMessageToTerminal('term-7', 'Sweep the feed.', {
                kind: 'cron',
                id: 'spec-1',
                label: 'issuewatch-sweep',
            }),
        ).toBe(true);

        const received = await b.receive('A');
        expect(received.messages[0]).toEqual(
            expect.objectContaining({
                from: 'genie:cron:spec-1',
                fromLabel: 'Cron: issuewatch-sweep',
                text: 'Sweep the feed.',
                // Same urgency the human-borrowed path had: a scheduled fire is
                // still a nudge, and the wake gate is unchanged.
                interrupt: true,
            }),
        );
    });

    it('reports false when the terminal has no registered agent, so the task records a failure', () => {
        const b = fresh();
        expect(
            b.deliverMachineMessageToTerminal('term-gone', 'x', { kind: 'cron', id: 'spec-1' }),
        ).toBe(false);
    });
});
