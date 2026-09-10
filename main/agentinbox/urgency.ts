/**
 * HOW LOUD A NOTICE IS — one ladder, one home (genie#602).
 *
 * ## Why this is a type and not a boolean
 *
 * The drain nudge — the one message Genie HOLDS AN UPGRADE waiting for — was
 * announced to agents as *"It is not urgent — check it when you are not busy"*,
 * while its own body said *"Stop work now"*. Two things caused that, and only
 * one of them was the missing flag:
 *
 *  1. urgency was an OPTIONAL argument at the call site, so forgetting it chose
 *     the weakest wording there is; and
 *  2. there were only two rungs — `normal` and "the sender ticked urgent" — so
 *     even the correct flag would have produced *"check it immediately"*, which
 *     is still not *"stop, an upgrade for this workstation is waiting on you"*.
 *
 * Three rungs, each meaning something a sender can actually be held to:
 *
 *  - `normal`      — mail. Read it when you are free.
 *  - `urgent`      — the sender ticked urgent (an `interrupt` DM). Read it now.
 *  - `showstopper` — WORK STOPS. Something in Genie is blocked until this agent
 *                    answers, and it is blocked for everyone, not just for the
 *                    recipient. The upgrade drain is the only thing that says
 *                    this today, and it says it because it is literally true:
 *                    {@link AgentDrain} does not resolve until the last row is
 *                    green.
 *
 * `showstopper` is worth guarding jealously. A level that gets used for things
 * that are merely important stops meaning anything, and the rung underneath it
 * already exists for those.
 */

export type InboxUrgency = 'normal' | 'urgent' | 'showstopper';

/**
 * The urgency of a message, from the message itself.
 *
 * ONE derivation, shared by every producer of a notice, so the announcement an
 * agent gets cannot depend on which code path delivered it.
 *
 * `interrupt` is the older, coarser half of the same fact and is still what the
 * durable store keeps, so a message that has been round-tripped through the
 * database reads back as `urgent` rather than `showstopper`. That degrade is
 * deliberate and it degrades DOWNWARD-BUT-LOUD: a showstopper asserts something
 * is blocked RIGHT NOW, and a copy rehydrated on the other side of a restart
 * would be asserting a hold that has already ended. What it must never do is
 * fall back to `normal`, which is the bug this file exists to make impossible.
 */
export function messageUrgency(msg: { urgency?: InboxUrgency; interrupt?: boolean }): InboxUrgency {
    return msg.urgency ?? (msg.interrupt ? 'urgent' : 'normal');
}

/**
 * Does this urgency interrupt the recipient?
 *
 * `interrupt` is a CONSEQUENCE of urgency, not a second dial beside it — it is
 * what glows the target's terminal and what arms the unACKed escalation to the
 * human. Deriving it here is what stops a caller declaring a showstopper that
 * then arrives without the attention mechanism behind it.
 */
export function urgencyInterrupts(urgency: InboxUrgency): boolean {
    return urgency !== 'normal';
}
