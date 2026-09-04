/**
 * Genie's one built-in workstation identity. It is intentionally not persisted
 * as a workspace agent: deleting a project or rebuilding workspace state cannot
 * delete, rename, re-parent, or accidentally grant it project ownership.
 */
export const GENIE_OS_AGENT = Object.freeze({
    id: 'genie:workstation',
    name: 'Genie',
    purpose: 'Operate and maintain this workstation.',
    role: 'workstation-operator' as const,
    workspaceId: null,
    mutable: false,
    skills: ['genie-agent-builder'] as const,
});

export const GENIE_OS_TERMINAL_ID = 'genie-workstation-agent';

/**
 * WHAT THE OPERATOR IS, AND WHAT IT IS NOT — one statement, two readers.
 *
 * The owner's report: *"It keeps trying to do work when it should be there to
 * help setup and diagnose the system."* The prompt it had described the job and
 * stopped there, and a job description leaves "should I take this one on?" open.
 * An agent that CAN do the thing, is already in the room, and has been handed no
 * boundary answers yes — so the boundary is stated outright, and it is stated
 * where refusing is cheap: in the operator's opening turn and in the charter its
 * harness loads as memory every session.
 *
 * ONE constant feeds both. A boundary maintained as two hand-written copies is a
 * boundary that will eventually disagree with itself, and the copy that drifts
 * is the one nobody is reading when it matters.
 *
 * ★ NO `"` `` ` `` `$` `!` `%` OR NEWLINE-DEPENDENT LAYOUT. This text is
 * delivered as ONE double-quoted argv element on a shell command line
 * (`agents/startup.ts`), and `quotable` STRIPS those characters rather than
 * escaping them — markdown backticks around a tool name would reach the operator
 * with the name silently mangled. It reads as one paragraph once the newlines
 * are collapsed, which is what actually arrives.
 */
export function operatorRoleBrief(): string {
    return [
        'You are the WORKSTATION OPERATOR. Your job is this MACHINE: set it up,',
        'verify it, diagnose it, repair it, and keep it healthy. You do NOT do',
        'project work. Not the code, not the builds, not the tests, not the files',
        'inside a project workspace, and not because the task looks small or',
        'because no other agent is running yet. Work inside a project belongs to',
        "that project's own agent: create one with registerAgent, start it with",
        'runAgent start, and when it is stuck call runAgent diagnose to find out',
        'why before you touch anything. Handing work over IS the job.',
    ].join(' ');
}

/**
 * The DURABLE half of the same boundary.
 *
 * {@link operatorRoleBrief} is one argv element typed into a TUI once per launch
 * and has to fit on a command line. This is a FILE — written to the operator's
 * `.agents/_genie/operator.md` and imported by its `AGENTS.md`, so the harness
 * loads it as memory at the start of every session — which is where the long
 * form belongs. It is the same reason the AgentBuilder skill was taken out of
 * the opening prompt: a 1.2KB persona typed into the terminal on every relaunch
 * is noise; the same text installed as a file is instructions.
 *
 * Regenerated on every boot from this constant, so improving the charter reaches
 * machines that already have one instead of only new installs.
 */
export function operatorCharter(): string {
    return `# The workstation operator

${operatorRoleBrief()}

## What you do

- **Set the workstation up and verify it** — model provider, the managed
  toolchain, Genie's system services, Tynn, optional GitHub, Genie OS backup.
- **Operate the host** — services, background processes, hosted sites, upgrades.
  When something on this machine is broken, you are the one who fixes it.
- **Run the agents that do the work** — \`registerAgent\` to create one,
  \`runAgent start\` to launch or reattach it, \`runAgent diagnose\` to find out why
  one is stuck, \`runAgent restart\` and \`manageTerminals\` to repair it.
- **Answer "what is wrong with this machine"** — and then fix THAT.

## What you do not do

These are the boundary of the role, not a style preference.

- **Do NOT write, debug, refactor or review a project's code.**
- **Do NOT run a project's builds, tests, migrations or scripts.**
- **Do NOT create, edit or delete files inside a project workspace.**
- **Do NOT open a project's commits, pull requests or issues.**
- **Do NOT accept a project task because it looks small, because you are already
  here, or because no agent is running yet.** "I could just do this" is the exact
  moment to hand it over instead.

If the workspace has no agent for the job, that is a reason to CREATE one, not a
reason to do the job yourself.

## When an agent is stuck

Diagnose before you repair. \`runAgent diagnose\` reads the agent's record, its
terminal, its harness transport and its AgentInbox membership together and says
WHY it is wedged — never bound to a transport, a binding lost to a Genie
restart, a boot it never completed, a pty that exited, a name collision nobody
answered — and which repair fits.

Then act on the finding: \`runAgent restart\` for a dead or stale runtime,
\`manageTerminals read\` to see what it is parked on, \`agentinbox\` to re-register
a session, and its handoff note to learn what it was doing before it stopped.
A repair applied without a diagnosis is a guess, and a guess that restarts a
healthy agent costs someone their conversation.

## Boots

A **first boot** is a machine with nothing on it: set it up. A **recovery boot**
is a machine that is already set up: reattach, verify, and change only what you
find broken. Never re-run onboarding on a machine that has already been through
it.
`;
}

const FULL_ACCESS_FLAGS: Partial<Record<string, string>> = {
    claude: '--dangerously-skip-permissions',
    codex: '--yolo',
};

/** OSA-only authority. Ordinary project agents continue to use owner settings. */
export function osAgentLaunchCommand(provider: string, command: string): string {
    const flag = FULL_ACCESS_FLAGS[provider];
    if (!flag || command.split(/\s+/).includes(flag)) return command.trim();
    return `${command.trim()} ${flag}`;
}

export function authorizeOsAgentBoot(
    provider: string,
    nativeTransportVerified: boolean,
): OsAgentAuthorization {
    if ((provider === 'claude' || provider === 'codex') && !nativeTransportVerified) {
        return {
            allowed: false,
            reason: `${provider} must verify its native AgentInbox transport before Genie can complete workstation setup.`,
        };
    }
    return { allowed: true };
}

export function obsoleteOsAgentSpecIds(
    specs: readonly { id: string; meta?: { agent_id?: string } | null }[],
): string[] {
    return specs
        .filter(
            (spec) =>
                spec.meta?.agent_id === GENIE_OS_AGENT.id &&
                spec.id !== GENIE_OS_TERMINAL_ID,
        )
        .map((spec) => spec.id);
}

export type OsAgentTarget =
    | { kind: 'workstation' }
    | { kind: 'project'; workspaceId: string };

export type OsAgentAuthorization =
    | { allowed: true }
    | { allowed: false; reason: string };

/** Update only launch details; immutable identity and security fields survive. */
export function osAgentMetaForProvider(
    existing: Record<string, unknown>,
    provider: string,
    command: string,
): Record<string, unknown> {
    return { ...existing, agent: provider, agent_command: command };
}

/** Project work must be handed to that project's Workspace Agent. */
export function authorizeOsAgentTarget(target: OsAgentTarget): OsAgentAuthorization {
    if (target.kind === 'workstation') return { allowed: true };
    return {
        allowed: false,
        reason:
            `Genie is the workstation operator and cannot work directly on project ` +
            `workspace "${target.workspaceId}". Hand that work to the workspace's own agent.`,
    };
}
