import type { AgentTui } from '../agents/identity';
import { noticeSubject, noticeTitle } from './imdone-notice';

/**
 * PURE. What the AgentInbox "a message came in" toast SAYS.
 *
 * ## The toast this replaces
 *
 * A message delivered to an agent whose input box Genie would not touch is
 * APPENDED to that box without being submitted (see agentinbox/draft.ts), and a
 * toast tells the person it is sitting there. That toast used to be a fixed,
 * app-level string: *"A message just came in for **this** agent … press Enter to
 * deliver it"*. The payload naming the terminal was thrown away at the renderer.
 *
 * Two things are wrong with "this agent", and the owner hit both at once:
 *
 *  - **It is scoped to FOCUS while the delivery is scoped to the ADDRESSEE.**
 *    The notice went to whichever terminal the message was addressed to, which
 *    is very often not the one being looked at. So the toast pointed at the
 *    wrong prompt, and Enter went into a genuinely empty box — reported as
 *    *"I think it confused focus with content"*, which is exactly what it did.
 *  - **"Press Enter" was asserted, never checked.** The pty write can fail (a
 *    retained spec whose pty has exited still has a registered agent), and the
 *    toast fired regardless — announcing text that was never typed.
 *
 * So a notice here names the workspace and the agent the way `imDone` does — it
 * imports that vocabulary rather than growing a second one — and its instruction
 * follows {@link InboxIncomingFacts.landed}: press Enter only when there is
 * something in that box to submit.
 */

export interface InboxIncomingFacts {
    /** The workspace's display name, or the System Workspace. */
    workspace?: string | null;
    /** The agent the message was addressed to. */
    agent?: { tui: AgentTui; name: string } | null;
    /** The terminal spec's own label. */
    terminal?: string | null;
    /**
     * Whether the notice ACTUALLY reached that terminal's input box — every pty
     * write of the nudge sequence reported success. False means the message is
     * in the inbox and nowhere else, and the toast must not claim otherwise.
     */
    landed: boolean;
}

export interface InboxIncomingNotice {
    title: string;
    body: string;
}

export function planInboxIncomingNotice(facts: InboxIncomingFacts): InboxIncomingNotice {
    const subject = noticeSubject(facts);
    const title = noticeTitle(subject, 'got a message');

    // The notice is in the box, behind a draft Genie deliberately did not cut.
    // Enter submits both — which is true HERE and only here.
    if (facts.landed) {
        return {
            title,
            body:
                `The notice is waiting in the prompt${subject.where}, unsent, ` +
                `so the draft is untouched. Click to open it, then press Enter to ` +
                `deliver it — or delete the line to dismiss.`,
        };
    }

    // Nothing was typed. Say so, and point at the place the message really is —
    // telling someone to press Enter into an empty box is the reported bug.
    return {
        title,
        body:
            `Genie could not put the notice in the prompt${subject.where}, ` +
            `so the message is waiting in the AgentInbox instead. Click to open ` +
            `the terminal.`,
    };
}
