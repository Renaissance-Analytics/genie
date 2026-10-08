/**
 * "HERE IS WHAT I FOUND" — the derived half of first run.
 *
 * Owner direction, 2026-10-08: *"on a fresh workstation with no workspaces, genie is just making
 * sure the toolchain and environment is ready for development."* And, separately: *"Tynn MUST be
 * optional — but that also gates all of the tynn provided services."*
 *
 * ## Why this is a REPORT and not a set of gates
 *
 * First run was seven gates, with Tynn sign-in and GitHub connect in front of ever seeing an agent
 * work. Paperclip — read at the owner's request — asks ONE question and derives the rest, then says
 * what it used and what it ignored, with reasons, and gates on nothing: a failed database
 * connection prints *"you can fix this later with `paperclipai doctor`"* and carries on.
 *
 * So every line here carries a STATE and a route, and nothing blocks. The one thing that genuinely
 * stops a first agent — no agent CLI on the machine at all — is reported as `missing` with the
 * place to fix it, which is still not a gate: you can close the window and come back.
 *
 * Pure, because the renderer's test environment has no DOM and a decision made inside a component
 * is a decision nobody checks.
 */

export type ReadinessState =
    /** Present and usable. */
    | 'ready'
    /** Needed, and not there. The only state that costs you something today. */
    | 'missing'
    /** Optional, and not connected. NOT a problem — it gates its own services and nothing else. */
    | 'off';

export interface ReadinessLine {
    id: 'driver' | 'git' | 'tynn' | 'github';
    /** What it says. Written as a FACT, not as an instruction. */
    label: string;
    state: ReadinessState;
    /**
     * Where to fix it, when it is worth fixing. Absent for `ready`.
     *
     * A ⌘K feature id or a Settings route — never a modal of its own, because a first run that
     * spawns a second wizard is the thing being removed.
     */
    fix?: string;
}

export interface ReadinessInput {
    /** Agent CLIs this machine actually has, by provider id. From `toolchainInspect`. */
    installedDrivers: readonly string[];
    /** `git` on PATH. Agents commit; a workspace is a repository. */
    gitPresent: boolean;
    /** The signed-in Tynn account, or null. OPTIONAL by owner decision. */
    tynnUser: string | null;
    githubConnected: boolean;
}

/**
 * The lines to show, in the order they matter.
 *
 * Ordered by what stops you soonest: no driver means no agent at all; no git means an agent cannot
 * commit what it writes; Tynn and GitHub are services whose absence costs only their own features.
 */
export function workstationReadiness(input: ReadinessInput): ReadinessLine[] {
    const driverCount = input.installedDrivers.length;

    return [
        driverCount > 0
            ? {
                  id: 'driver',
                  label:
                      driverCount === 1
                          ? `${input.installedDrivers[0]} is installed`
                          : `${driverCount} agent CLIs installed`,
                  state: 'ready',
              }
            : {
                  id: 'driver',
                  // The ONE thing that genuinely blocks a first agent — and it says what it costs
                  // rather than what is absent, because "no CLI found" is a fact nobody can act on
                  // and "no agent can start" is.
                  label: 'No agent CLI found — nothing can run an agent yet',
                  state: 'missing',
                  fix: 'toolchain',
              },

        input.gitPresent
            ? { id: 'git', label: 'git is installed', state: 'ready' }
            : {
                  id: 'git',
                  // Not fatal: an agent can read and reason without git. It cannot keep anything.
                  label: 'git is missing — agents can work but cannot commit',
                  state: 'missing',
                  fix: 'toolchain',
              },

        input.tynnUser
            ? { id: 'tynn', label: `Tynn connected as ${input.tynnUser}`, state: 'ready' }
            : {
                  id: 'tynn',
                  // OPTIONAL, and it says so. The owner's rule: Tynn gates the services Tynn
                  // provides and nothing else, so this line must not read as a fault.
                  label: 'Tynn not connected — hosting, sharing and IssueWatch are off',
                  state: 'off',
                  fix: 'tynn-signin',
              },

        input.githubConnected
            ? { id: 'github', label: 'GitHub connected', state: 'ready' }
            : {
                  id: 'github',
                  label: 'GitHub not connected — private repos and PRs are off',
                  state: 'off',
                  fix: 'github-caps',
              },
    ];
}

/**
 * Can a first agent START at all?
 *
 * The only question on this screen with a yes-or-no answer. Everything else is information, which
 * is why nothing else appears in it — a readiness check that refuses on a missing GitHub would be
 * the gate this screen replaces, wearing a report's clothes.
 */
export function canStartFirstAgent(lines: readonly ReadinessLine[]): boolean {
    return lines.find((l) => l.id === 'driver')?.state === 'ready';
}

/**
 * Everything that is NOT ready, for the one-line summary.
 *
 * Empty means "nothing to mention", and then the screen says nothing about readiness at all rather
 * than four green ticks — the same rule the Deck's signal strip follows, for the same reason.
 */
export function readinessNotes(lines: readonly ReadinessLine[]): ReadinessLine[] {
    return lines.filter((l) => l.state !== 'ready');
}
