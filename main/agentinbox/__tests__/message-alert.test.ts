import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AGENTINBOX_SYSTEM, machineSenderId } from '../types';
import type { AgentInboxBrokerEvent, AgentInboxMessagePreview } from '../types';

/**
 * "I want to know when agents are talking to each other" — genie#546.
 *
 * The owner's first named event. A message landing in an agent's inbox is an
 * INTERRUPT for that agent (it can glow a terminal and nudge a pty), so it is
 * one of the few moments in Genie that already means "something changed and a
 * person might want to know".
 *
 * Wired HERE — in the fan-out that already turns every broker event into
 * Genie's own surfaces — rather than in `broker.ts`, which owns no I/O and
 * should keep owning none.
 *
 * ## Telling a machine from an agent
 *
 * genie#543 landed while this was in review, and it is what makes
 * `automatedNotice` a real alert rather than an aspiration: a scheduled task now
 * arrives as `genie:cron:<spec id>` instead of borrowing the HUMAN's identity,
 * which is what it used to do (so "your job reported in" was byte-identical to
 * "a person typed you a message").
 *
 * The sender ids below are built with `machineSenderId` and classified through
 * `readMachineSender` — the one reader that owns that format — so these cannot
 * drift from what the inbox actually sends. A human sender stays silent.
 */

const emitter = vi.hoisted(() => ({ fn: null as null | ((e: AgentInboxBrokerEvent) => void) }));
vi.mock('../broker', () => ({
    agentInboxBroker: {
        setEmitter: (fn: (e: AgentInboxBrokerEvent) => void) => {
            emitter.fn = fn;
        },
    },
}));
vi.mock('../../remote', () => ({ broadcastLocal: () => 0 }));
vi.mock('../../mobile/server', () => ({ mobileEmit: () => 0 }));
vi.mock('../../terminal/ipc', () => ({ broadcastTerminalAttention: () => 0 }));
vi.mock('../../terminal/agent-pulse', () => ({ agentPulse: { mark: () => {} } }));

const alerts = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../../notify-sound', () => ({
    playAlert: (kind: string) => {
        alerts.played.push(kind);
        return true;
    },
}));

import { installAgentInboxPresence } from '../presence';

function preview(from: string): AgentInboxMessagePreview {
    return {
        kind: 'dm',
        from,
        fromLabel: from,
        seq: 1,
        ts: Date.now(),
        preview: 'hello',
    };
}

/** Push one broker event through the installed fan-out. */
function emit(ev: AgentInboxBrokerEvent): void {
    if (!emitter.fn) throw new Error('presence never installed an emitter');
    emitter.fn(ev);
}

beforeEach(() => {
    alerts.played.length = 0;
    emitter.fn = null;
    installAgentInboxPresence();
});

describe('an agent messaging another agent', () => {
    it('raises agentMessage', () => {
        emit({ type: 'message', preview: preview('claude-reviewer-7') });
        expect(alerts.played).toEqual(['agentMessage']);
    });
});

describe('a machine reporting in', () => {
    it('raises automatedNotice for a Genie system announcement', () => {
        emit({ type: 'message', preview: preview(AGENTINBOX_SYSTEM) });
        expect(alerts.played).toEqual(['automatedNotice']);
    });

    it('raises automatedNotice for a real cron sender, built by genie#543 itself', () => {
        // `machineSenderId` rather than a hand-typed string: this is the id a
        // scheduled task actually arrives under now that genie#543 has landed
        // (`process-scheduler.ts` hands the broker `{kind:'cron', id, label}`),
        // so this cannot pass against a format the inbox stopped using.
        emit({
            type: 'message',
            preview: preview(machineSenderId({ kind: 'cron', id: 'spec-1', label: 'nightly' })),
        });
        expect(alerts.played).toEqual(['automatedNotice']);
    });

    it('would raise it for a `process` source too — SHAPE ONLY, nothing emits one yet', () => {
        // genie#543 DECLARES the `process` machine kind, but no production code
        // sends one: the only machine source emitted today is the scheduler's
        // `cron`. So this is the classifier being ready, NOT evidence that such
        // a notice exists — labelled as such deliberately, because a green test
        // is the easiest place to read coverage that was never built.
        emit({
            type: 'message',
            preview: preview(machineSenderId({ kind: 'process', id: 'proc-9' })),
        });
        expect(alerts.played).toEqual(['automatedNotice']);
    });

    it('treats an unrecognised `genie:` kind as ordinary mail, exactly as the reader does', () => {
        // POSITIVE CONTROL for the two above: they would hold just as well if
        // every `genie:` prefix were called automated. `readMachineSender` is
        // strict about which kinds exist — a kind this build has no behaviour
        // for is not a source it can claim to have understood — and the alert
        // follows it rather than matching the prefix itself.
        emit({ type: 'message', preview: preview('genie:teapot:1') });
        expect(alerts.played).toEqual(['agentMessage']);
    });
});

describe('what does NOT chime', () => {
    it('stays silent for a message the person at the keyboard sent', () => {
        // You do not need a chime for the message you just typed. It is also
        // the identity a cron currently borrows, so guessing here would label a
        // scheduled job as "you".
        emit({ type: 'message', preview: preview('human') });
        expect(alerts.played).toEqual([]);
    });

    it('POSITIVE CONTROL: the same fan-out DOES chime for an agent sender', () => {
        // Without this, a wiring that never fired at all would pass the
        // assertion above.
        emit({ type: 'message', preview: preview('human') });
        emit({ type: 'message', preview: preview('some-agent') });
        expect(alerts.played).toEqual(['agentMessage']);
    });

    it('stays silent for presence, lag and lifecycle events', () => {
        // Only a MESSAGE is an event a person might want announced. Presence
        // churns constantly as terminals come and go.
        emit({ type: 'lag', count: 3 } as AgentInboxBrokerEvent);
        emit({ type: 'offline', agentId: 'a1' });
        emit({ type: 'interrupt', terminalId: 't1' });
        expect(alerts.played).toEqual([]);
    });
});
