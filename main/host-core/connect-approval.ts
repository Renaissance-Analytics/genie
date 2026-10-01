/**
 * EASY-CONNECT — does an arriving guest need the owner's say-so?
 *
 * The owner's words, listing it among the controls on a share link: *"Easy-Connect
 * (needs machine user approval to connect or not)"*. There is no gate today —
 * anyone holding a share connects straight through, and the first the owner knows
 * of it is a name appearing on the connected-users list.
 *
 * TWO INPUTS, and the relationship between them is why this is a tested function
 * rather than an `if` at the socket:
 *
 *  - the MACHINE's standing answer — "ask me before anyone connects";
 *  - the LINK's own flag, chosen when it was minted.
 *
 * **The machine wins when it is stricter, and never when it is laxer.** A link
 * minted with Easy-Connect on must not be a way past a machine that asked to be
 * asked; otherwise the setting is advice, and the person it fails to protect is
 * whoever did not mint the link. That asymmetry is the security property here,
 * and it is the one a boolean `||` gets right by accident and a boolean `&&` gets
 * wrong silently — so it is pinned by its own test.
 *
 * The OWNER is never gated. A prompt the owner must answer to reach their own
 * computer is a lockout, and the approval UI lives on that computer.
 *
 * Pure: the decision is the whole of the interesting part, and the socket layer
 * should only have to act on it.
 */
export interface ConnectApprovalInput {
    /** Who is arriving. `owner` is this machine's own user. */
    principalType: 'owner' | 'device' | 'tynn-user';
    /** This computer's standing requirement. */
    machineRequiresApproval: boolean;
    /** What the link they came through asked for. */
    linkRequiresApproval: boolean;
    /** Whether this guest has already been let in once.
     *
     *  Approval is per GUEST, not per socket: a dashboard that opens a second
     *  connection must not raise a second prompt, and nor must a reconnect after
     *  a dropped network. That is how an approval gate becomes a thing people
     *  turn off. */
    alreadyApproved: boolean;
}

export interface ConnectApprovalDecision {
    decision: 'allow' | 'ask';
    /** Why, in words the prompt can show. "Someone wants to connect" with no
     *  reason is a dialog people learn to dismiss without reading. */
    reason?: string;
}

export function connectApproval(input: ConnectApprovalInput): ConnectApprovalDecision {
    if (input.principalType === 'owner') return { decision: 'allow' };
    if (input.alreadyApproved) return { decision: 'allow' };

    // Checked FIRST, so the machine's own requirement is the reason shown when
    // both are set — it is the one the owner can change from here.
    if (input.machineRequiresApproval) {
        return {
            decision: 'ask',
            reason: 'This computer asks you before anyone connects.',
        };
    }
    if (input.linkRequiresApproval) {
        return {
            decision: 'ask',
            reason: 'The link they used was created with approval required.',
        };
    }
    return { decision: 'allow' };
}
