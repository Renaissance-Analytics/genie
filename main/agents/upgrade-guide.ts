/**
 * PURE. What `agentUpgrade` should say to the agent that called it (genie#372).
 *
 * The tool used to answer with one frozen five-step guide for every caller. The
 * upgrade notice points every pre-AMS terminal at it on every upgrade, and for
 * the WORKSTATION OPERATOR step 1 — `registerAgent` — cannot succeed and must
 * not: `GENIE_OS_AGENT` is *"intentionally not persisted as a workspace agent"*
 * so that deleting a project or rebuilding workspace state cannot delete,
 * rename or re-parent it (`os-agent.ts`), and its stable name `genie` is on the
 * reserved list with no `sacred_name` grant on the `__system__` row. Steps 2 and
 * 5 hang off step 1, so the operator was handed an unreachable guide — the one
 * agent that takes the upgrade notice most often, since every Genie upgrade
 * restarts it.
 *
 * That is the defect beta.297 set out to remove: a surface CLAIMING a path
 * without establishing the caller can walk it. So the tool now establishes it,
 * and the four answers are a pure function of three facts about the caller —
 * separate from the database read that gathers them, so each claim is asserted
 * without an MCP server or a live operator terminal.
 */

/** What `agentUpgrade` knows about the terminal that called it. */
export interface UpgradeCaller {
    /** The workspace this terminal is attached to, or null for none. */
    workspaceId: string | null;
    /** True when this terminal is Genie's built-in workstation operator. */
    isWorkstationOperator: boolean;
    /** The agent name this terminal is ALREADY registered under, or null. */
    registeredAs: string | null;
}

export type UpgradeGuideStatus = 'migrate' | 'operator' | 'unattached' | 'registered';

export interface UpgradeGuide {
    /** Which answer this is — for callers that branch, and for tests. */
    status: UpgradeGuideStatus;
    /** The markdown handed back to the agent verbatim. */
    text: string;
}

/** The ordered migration, for the callers who can actually run it. */
const MIGRATION_STEPS = `# Upgrade this agent to AMS

This terminal predates Genie's Agent Management System. Preserve the conversation; do not create a replacement chat.

1. Call \`registerAgent\` with this agent's stable name, purpose, provider, and boot folder.
2. Call \`agentinbox\` with \`action: "registerSession"\` to bind the current harness session to that durable agent.
3. Verify the native transport: Claude Code must report \`claude-channel\`; Codex must report \`codex-app-server\`. Never deliver through terminal input.
4. Call \`thumbsUp\` with \`reason: "boot"\`. Genie refuses readiness until the required transport is verified.
5. Future starts use \`runAgent start\` and resume this registered agent.

If registration reports an existing name, list agents first and bind this session to the matching identity; do not mint a duplicate.`;

/**
 * The operator's answer.
 *
 * It says what the operator IS rather than what it failed to do, because the
 * upgrade notice will point it here again on the next upgrade and an agent that
 * reads "you are not migratable, by design" stops trying. `thumbsUp` is named
 * because it is the one step of the five that genuinely applies — #321 made it
 * stop gating a system-scope agent on a persisted channel row — and leaving it
 * out would trade one incomplete answer for another.
 */
const OPERATOR_ANSWER = `# Nothing to migrate — you are the workstation operator

You are Genie's built-in workstation operator (\`genie:workstation\`). You are deliberately **never registered as a workspace agent**: no \`workspace_agents\` row is ever written for you, so that deleting a project or rebuilding workspace state cannot delete, rename or re-parent this identity. Your name \`genie\` is also a reserved term, refused to every workspace that has not been granted it.

So the AMS migration does not apply to you, and \`registerAgent\` would refuse it if you tried (genie#372).

What DOES apply:

- Call \`thumbsUp\` with \`reason: "boot"\` to signal readiness after a restart. It works for you.
- Your durable memory is the workstation knowledge graph (the \`knowledge\` tool) and your own \`~/.gosa\` envelope — not an AMS registration.
- \`imDone\` files your handoff at \`.ai/handoff/<agent>.md\` under \`~/.gosa\`, so the next run of you starts with your note.`;

/** No workspace, no registration — say so instead of handing over steps. */
const UNATTACHED_ANSWER = `# Nothing to migrate yet — this terminal has no workspace

This terminal is not attached to a Genie workspace, so it has no authority to act on one and \`registerAgent\` — step 1 of the migration — would be refused. Every later step hangs off it, so the guide is not runnable from here.

Attach this terminal to a workspace first (open it from that workspace, or have that workspace's agent create it), then call \`agentUpgrade\` again.`;

/**
 * Already in AMS.
 *
 * Worth its own answer rather than falling through to the steps: re-running them
 * is how a DUPLICATE agent gets minted under a second name, which the last line
 * of the guide itself warns about.
 */
function registeredAnswer(name: string): string {
    return `# Already migrated — nothing to do

This terminal is already bound to the registered agent **${name}**, so it is in AMS and the migration does not apply.

Do NOT run the registration steps again: registering under a second name would mint a duplicate agent rather than move this one. If this session is not reaching AgentInbox, bind it with \`agentinbox\` \`action: "registerSession"\` and confirm the native transport, rather than registering anew.`;
}

/** The answer `agentUpgrade` should hand this caller. */
export function agentUpgradeGuide(caller: UpgradeCaller): UpgradeGuide {
    // FIRST, and ahead of every other fact: this is a statement about what the
    // caller IS. The operator is unmigratable whether or not it has a workspace
    // row (it has one now, `__system__`) and whether or not some other surface
    // reports a name for it.
    if (caller.isWorkstationOperator) return { status: 'operator', text: OPERATOR_ANSWER };

    const registered = String(caller.registeredAs ?? '').trim();
    if (registered) return { status: 'registered', text: registeredAnswer(registered) };

    if (!caller.workspaceId) return { status: 'unattached', text: UNATTACHED_ANSWER };

    return { status: 'migrate', text: MIGRATION_STEPS };
}
