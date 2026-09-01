import { describe, expect, it } from 'vitest';
import { forceQuestionRefusal } from '../force-question';

/**
 * A question whose answer cannot be delivered must be REFUSED, not accepted.
 *
 * `ForceTheQuestion` accepted a question from a caller with no inbox and told it:
 *
 *   "the answer will be delivered to your AgentInbox ...
 *    call agentinbox(action:"receive") to pull it"
 *
 * promising delivery over a transport that caller demonstrably does not have.
 * The user then answered, the question cleared from their flyout, `ask_drafts`
 * went back to `{}` — and NO message was ever created. The answer was taken
 * from the human and dropped (genie#321).
 *
 * Two callers hit this in one session:
 *   - the Genie OS agent, whose terminal has `workspace_id = NULL`, so every
 *     inbox-shaped surface already refuses it — `agentinbox` and
 *     `submitFeedback` both say so plainly. `ForceTheQuestion` was the one that
 *     did not, which is why it is the one that lost data.
 *   - a terminal a human started by hand and attached an agent to, which has a
 *     workspace but no agent identity to deliver to.
 *
 * From the user's side a dropped answer looks like the agent ignoring them.
 * A hard error at ASK time is strictly better: the agent finds out immediately,
 * while it still has the option to ask some other way.
 */

describe('ForceTheQuestion refuses what it cannot deliver (#321)', () => {
    it('refuses a caller whose terminal is not in a workspace', () => {
        const why = forceQuestionRefusal({ workspaceId: null, hasInboxIdentity: true });

        expect(why).toBeTruthy();
        expect(why).toMatch(/workspace/i);
    });

    it('refuses a caller with a workspace but no inbox identity to answer to', () => {
        // The hand-started terminal case: the workspace check alone would have
        // let this through, and the answer would still have been discarded.
        const why = forceQuestionRefusal({ workspaceId: 'ws-1', hasInboxIdentity: false });

        expect(why).toBeTruthy();
        expect(why).toMatch(/deliver|inbox/i);
    });

    it('allows a caller that can actually be answered', () => {
        // POSITIVE CONTROL: without this the refusal could be unconditional and
        // every question would break.
        expect(forceQuestionRefusal({ workspaceId: 'ws-1', hasInboxIdentity: true })).toBeUndefined();
    });

    it('says what to do instead, rather than only refusing', () => {
        // A refusal an agent cannot act on just moves the dead end.
        const why = forceQuestionRefusal({ workspaceId: null, hasInboxIdentity: false }) ?? '';

        expect(why.length).toBeGreaterThan(40);
    });
});
