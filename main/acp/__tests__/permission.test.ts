import { describe, expect, it } from 'vitest';
import { approvalFromRequest, cancelledOutcome, permissionOutcome } from '../permission';

/**
 * Mid-turn tool approval.
 *
 * The hazard here is **granting more than the human chose.** The agent offers a list of
 * options whose ids it invents and whose order it decides, so picking one by position is
 * a coin flip, and falling back from "allow once" to "allow always" because the first is
 * not on offer would hand over a standing permission somebody never gave.
 *
 * So selection is by KIND, and a kind that is not offered is a REFUSAL rather than a
 * substitution.
 */

const options = [
    { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'o-always', name: 'Always allow', kind: 'allow_always' as const },
    { optionId: 'o-deny', name: 'Deny', kind: 'reject_once' as const },
    { optionId: 'o-never', name: 'Never', kind: 'reject_always' as const },
];

describe('approvalFromRequest', () => {
    it('describes the tool call so a human can decide', () => {
        const a = approvalFromRequest({
            sessionId: 's1',
            toolCall: { toolCallId: 'tc1', title: 'Write main/ipc.ts', kind: 'edit' },
            options,
        });
        expect(a).toEqual({ id: 'tc1', name: 'Write main/ipc.ts', args: { kind: 'edit' } });
    });

    it('falls back to the tool call id when there is no title', () => {
        // A row reading "approve?" with no subject is unanswerable. The id is poor but
        // it is at least a handle.
        const a = approvalFromRequest({ sessionId: 's1', toolCall: { toolCallId: 'tc1' }, options });
        expect(a.name).toBe('tc1');
    });

    it('survives a request with no tool call at all', () => {
        const a = approvalFromRequest({ sessionId: 's1', options });
        expect(a.id).toBeTruthy();
        expect(a.name).toBeTruthy();
    });
});

describe('permissionOutcome — selection is by KIND', () => {
    it('picks allow_once for a plain allow', () => {
        // By kind, never by position: the agent decides the order and the ids.
        expect(permissionOutcome('allow-once', options)).toEqual({
            outcome: { outcome: 'selected', optionId: 'o-allow' },
        });
    });

    it('picks reject_once for a deny', () => {
        expect(permissionOutcome('deny-once', options)).toEqual({
            outcome: { outcome: 'selected', optionId: 'o-deny' },
        });
    });

    it('picks allow_always only when the human asked for always', () => {
        expect(permissionOutcome('allow-always', options)).toEqual({
            outcome: { outcome: 'selected', optionId: 'o-always' },
        });
    });

    it('picks reject_always for a never', () => {
        expect(permissionOutcome('deny-always', options)).toEqual({
            outcome: { outcome: 'selected', optionId: 'o-never' },
        });
    });

    it('is not fooled by order', () => {
        // The same four, reversed. A position-based pick would now grant the opposite of
        // what was chosen, and nothing would report it.
        expect(permissionOutcome('allow-once', [...options].reverse())).toEqual({
            outcome: { outcome: 'selected', optionId: 'o-allow' },
        });
    });
});

describe('permissionOutcome — it never grants more than was chosen', () => {
    it('REFUSES rather than upgrading "allow once" to "allow always"', () => {
        // THE hazard. If the agent offers no allow_once, substituting allow_always would
        // hand over a standing permission the human never gave — and it would look like
        // the request simply succeeded.
        const noOnce = options.filter((o) => o.kind !== 'allow_once');
        expect(permissionOutcome('allow-once', noOnce)).toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('refuses rather than downgrading "deny always" to "deny once"', () => {
        // The mirror. Weakening a refusal is also not the human's decision — they said
        // never, and "just this once" lets it be asked again immediately.
        const noAlways = options.filter((o) => o.kind !== 'reject_always');
        expect(permissionOutcome('deny-always', noAlways)).toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('refuses when the agent offers no options at all', () => {
        expect(permissionOutcome('allow-once', [])).toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('ignores an option whose kind it does not recognise', () => {
        // A protocol version that adds a kind must not have it chosen by accident.
        const odd = [{ optionId: 'o-weird', name: 'Hmm', kind: 'allow_if_tuesday' as never }];
        expect(permissionOutcome('allow-once', odd)).toEqual({ outcome: { outcome: 'cancelled' } });
    });
});

describe('cancelledOutcome', () => {
    it('is the shape the protocol REQUIRES after a cancel', () => {
        // From the schema's own words: when a client sends session/cancel it "MUST
        // respond to all pending session/request_permission requests with cancelled".
        // An unanswered one parks the agent's turn forever.
        expect(cancelledOutcome()).toEqual({ outcome: { outcome: 'cancelled' } });
    });
});
