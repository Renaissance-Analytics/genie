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
 * GENIE ASKING, AND WAITING ON THE ANSWER (genie#606).
 *
 * genie#602 made the drain's urgency a value the caller had to carry with the
 * body. It left one gap: `urgency` was still a SEVERITY a caller could assert.
 * Nothing stopped a message declaring itself a showstopper while holding
 * nothing at all, and nothing let the quit-time barrier — which genuinely asks
 * an agent to act, but on a thirty-second clock — say what it is.
 *
 * So the thing that travels is the FACT, and the rung is derived from it. An
 * ask differs from mail in one way and from another ask in one way:
 *
 *  - `deadlineSeconds: null` — nothing proceeds until this agent answers. The
 *    upgrade drain, whose promise does not resolve until the last row is green.
 *  - `deadlineSeconds: n`    — Genie goes ahead in about `n` seconds either way.
 *    The full-shutdown readiness barrier. The answer is the agent's chance to
 *    checkpoint, NOT a gate it is holding — and saying so is the difference
 *    between an agent that saves its work and one that finishes its thought.
 *
 * Overstating is the same defect as understating, pointed the other way: a
 * clocked ask that claimed `showstopper` would assert a hold that does not
 * exist, and would spend the meaning genie#602 just bought.
 */
export interface AgentAsk {
    /** Seconds until Genie proceeds regardless, or `null` when nothing does. */
    deadlineSeconds: number | null;
}

/**
 * The rung an ask announces itself at.
 *
 * Not a judgement. `showstopper` means *nothing proceeds until you answer*, so
 * it belongs to exactly the asks where that is true and to no others.
 */
export function askUrgency(ask: AgentAsk): InboxUrgency {
    return ask.deadlineSeconds === null ? 'showstopper' : 'urgent';
}

/**
 * The urgency of a message, from the message itself.
 *
 * ONE derivation, shared by every producer of a notice, so the announcement an
 * agent gets cannot depend on which code path delivered it. There is no
 * `urgency` field to read: a rung is something a message EARNS by being an ask
 * or by being marked urgent, never something it simply claims (genie#606).
 *
 * `interrupt` is the older, coarser half of the same fact and is still what the
 * durable store keeps, so a message that has been round-tripped through the
 * database reads back as `urgent` rather than `showstopper`. That degrade is
 * deliberate and it degrades DOWNWARD-BUT-LOUD: a showstopper asserts something
 * is held RIGHT NOW, and a copy rehydrated on the other side of a restart would
 * be asserting a wait that has already ended. What it must never do is fall
 * back to `normal`, which is the bug this file exists to make impossible.
 */
export function messageUrgency(msg: { ask?: AgentAsk; interrupt?: boolean }): InboxUrgency {
    return msg.ask ? askUrgency(msg.ask) : msg.interrupt ? 'urgent' : 'normal';
}


/**
 * How loud a notice is, and WHY — the two halves that must never be picked
 * separately (genie#602, genie#606).
 *
 * genie#602 made `urgency` a required field so no caller could forget it. That
 * was necessary and not sufficient: it was still a severity a caller could
 * simply assert, and asserting `showstopper` over a message that held nothing
 * would have been the same bug pointed the other way. It also left the
 * quit-time barrier no way to say what it is — a real ask, on a clock.
 *
 * A union, so the two cases are the only two that can be written down:
 *
 *  - {@link AgentAsk} — Genie is asking and waiting. The rung DERIVES
 *    ({@link askUrgency}), and so does the mode clause, so an ask can neither
 *    announce itself gently nor claim a hold it does not have.
 *  - a rung on its own — ordinary mail, where there is nothing to derive from
 *    and the sender's `interrupt` is the whole of it.
 */
export type NoticeLoudness =
    | { ask: AgentAsk; urgency?: never }
    | { ask?: never; urgency: InboxUrgency };

/**
 * A message's loudness half, ready to spread into a notice.
 *
 * The ONE place that maps a message onto {@link NoticeLoudness}. Inlining it at
 * the delivery site is how the mail arm gets chosen for an ask by accident —
 * which type-checks perfectly, because both arms are valid notices, and lands
 * an ask wearing an ordinary envelope. That is genie#602's bug wearing the
 * union that was supposed to prevent it.
 */
export function noticeLoudness(msg: { ask?: AgentAsk; interrupt?: boolean }): NoticeLoudness {
    return msg.ask ? { ask: msg.ask } : { urgency: messageUrgency(msg) };
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
