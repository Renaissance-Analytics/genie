/**
 * How many agent terminals a workspace may run, and who decides (Tynn #117).
 *
 * The decision is pure and lives apart from the spawn paths because there are
 * several of them — the `runAgent` MCP tool, `manageTerminals`, and the button a
 * person clicks — and a limit enforced in three places is three limits. Callers
 * bring the count and the actor; this file owns what those mean.
 *
 * The rule that matters is not the number. An agent that can raise its own cap
 * has no cap, so `actor` is a parameter rather than something the caller is
 * trusted to have already checked, and the enforcement of "only a person sets
 * this" lives where it can be structural: the column is absent from
 * `updateWorkspace`'s allowlist and the setter is never imported into `main/mcp/`.
 */

/** Who is asking for the terminal. A person is the authority over the limit. */
export type SpawnActor = 'human' | 'agent';

/**
 * An explicit "no cap". Deliberately not the same as an absent setting: unset
 * means "nobody has chosen", which resolves to a real default, whereas this means
 * someone looked at the limit and turned it off.
 */
export const UNLIMITED = 'unlimited';

export type AgentCapValue = number | typeof UNLIMITED | null | undefined;

/**
 * The cap a workspace gets when nothing is configured.
 *
 * Eight is chosen against the incident rather than from theory: six concurrent
 * agents was already past what one person could follow, and the failure mode was
 * unbounded. It has to be a real number — resolving an unset setting to
 * "unlimited" is how a safety feature quietly stops existing on every machine
 * that never visited Settings.
 */
export const DEFAULT_AGENT_TERMINAL_CAP = 8;

export interface AgentCapSettings {
    /** The workstation-wide default. */
    workstation: AgentCapValue;
    /** The workspace's override, if it has one. Absent means inherit. */
    workspace: AgentCapValue;
}

export type AgentCapSource = 'workspace' | 'workstation' | 'default';

export interface EffectiveAgentCap {
    /** The maximum, or `null` for unlimited. */
    limit: number | null;
    /** Which level supplied it — named in the message so the right knob gets turned. */
    source: AgentCapSource;
}

/**
 * A stored cap, or `null` if the value is unusable.
 *
 * These arrive from SQLite and from IPC, so "cannot happen" is not on the table.
 * Rejecting rather than coercing is the safe direction in both senses: a corrupt
 * value must not read as unlimited (the cap vanishes) or as zero (nothing ever
 * starts again). It falls back to the next level up instead.
 */
export function normaliseCap(value: unknown): number | null {
    if (typeof value !== 'number') return null;
    if (!Number.isInteger(value)) return null;
    if (value < 1) return null;
    return value;
}

/** `'inherit'` when this level has nothing usable to say. */
function readLevel(value: AgentCapValue): number | null | 'inherit' {
    if (value === UNLIMITED) return null;
    const cap = normaliseCap(value);
    return cap === null ? 'inherit' : cap;
}

export function effectiveAgentCap(settings: AgentCapSettings): EffectiveAgentCap {
    const workspace = readLevel(settings.workspace);
    if (workspace !== 'inherit') return { limit: workspace, source: 'workspace' };

    const workstation = readLevel(settings.workstation);
    if (workstation !== 'inherit') return { limit: workstation, source: 'workstation' };

    return { limit: DEFAULT_AGENT_TERMINAL_CAP, source: 'default' };
}

/** The parts of a terminal spec the count cares about. */
export interface CountableTerminal {
    id: string;
    /** Nullable in the table. A null never matches a real id, so it never counts. */
    workspace_id: string | null;
    /** `'process'` is a background job, not a terminal. */
    type?: string | null;
    meta?: {
        /** Present when the terminal is an AgentInbox agent — it runs an agent. */
        agent_id?: string;
        /** Who asked for it. Absent on terminals that predate the field. */
        created_by?: string;
    } | null;
}

/**
 * How many terminals in this workspace count against the cap.
 *
 * Two kinds count: one that RUNS an agent, and a plain shell an AGENT opened.
 * The second matters because `manageTerminals create` makes a terminal with no
 * agent in it — uncounted, it would be an unbounded side door for exactly the
 * runaway this exists to stop.
 *
 * Liveness comes from the pty, not the row. Specs are deliberately retained after
 * their process exits so a terminal can be revived, so counting rows would make
 * the cap a ratchet that only ever tightens.
 */
export function countAgentTerminals(
    specs: readonly CountableTerminal[],
    workspaceId: string,
    isLive: (id: string) => boolean,
): number {
    let count = 0;
    for (const spec of specs) {
        if (spec.workspace_id !== workspaceId) continue;
        if (spec.type === 'process') continue;

        const runsAgent = Boolean(spec.meta?.agent_id);
        const openedByAgent = spec.meta?.created_by === 'agent';
        if (!runsAgent && !openedByAgent) continue;

        if (!isLive(spec.id)) continue;
        count += 1;
    }
    return count;
}

export interface AgentSpawnRequest {
    actor: SpawnActor;
    /** Agent terminals currently ALIVE in the workspace, so an exit frees a slot. */
    live: number;
    settings: AgentCapSettings;
    /**
     * How many are being started AT ONCE. Defaults to 1 — the shape every
     * one-at-a-time spawn path has.
     *
     * A GApp seeds its whole declared roster in one go (genie#245), and asking
     * "may I start one more" N times would let it in whenever the first slot was
     * free and then refuse partway, leaving the user with fewer agents than the
     * consent screen named and nothing said about it. The batch is one question.
     */
    want?: number;
}

export interface AgentSpawnDecision {
    allowed: boolean;
    limit: number | null;
    live: number;
    source: AgentCapSource;
    /** True once the limit is reached, whether or not the request was allowed. */
    atLimit: boolean;
    /** Why. Present on a refusal, and on a person's over-limit spawn as a notice. */
    reason?: string;
}

/** Where a person goes to change the limit that was actually applied. */
function whereToChange(source: AgentCapSource): string {
    if (source === 'workspace') {
        return "this workspace's own limit, set in Workspace settings › Agent behavior";
    }
    return 'the workstation default, set in Settings › Workspaces › Defaults (a workspace can override it in Workspace settings › Agent behavior)';
}

function countPhrase(live: number, limit: number, want: number): string {
    const over = live > limit ? 'over' : 'at';
    const at = `${over} its limit of ${limit} agent terminal${limit === 1 ? '' : 's'} (${live} running)`;
    // Only a BATCH says how many it wanted. A one-at-a-time spawn reads exactly as
    // it always has — the sentence is the thing agents and users actually see.
    return want > 1 ? `${at}, and cannot start ${want} more` : at;
}

export function decideAgentSpawn(request: AgentSpawnRequest): AgentSpawnDecision {
    const { limit, source } = effectiveAgentCap(request.settings);
    const live = request.live;
    const human = request.actor === 'human';
    // A batch of zero or a nonsense count is one spawn — the safe direction, and
    // the shape every caller that doesn't ask for a batch already has.
    const want = Number.isInteger(request.want) && request.want! > 1 ? request.want! : 1;

    // A count the caller could not determine. Granting one more would be a guess
    // in the unsafe direction, so an agent is refused — but a person is not held
    // up by Genie's own bookkeeping failing.
    if (!Number.isInteger(live) || live < 0) {
        return {
            allowed: human,
            limit,
            live: Number.isInteger(live) ? live : 0,
            source,
            atLimit: false,
            reason: human
                ? undefined
                : 'Genie could not determine how many agent terminals are running in this workspace, so it is not starting another. Retrying will not change this — tell the user.',
        };
    }

    if (limit === null) {
        return { allowed: true, limit, live, source, atLimit: false };
    }

    const atLimit = live + want > limit;
    if (!atLimit) {
        return { allowed: true, limit, live, source, atLimit: false };
    }

    if (human) {
        // Refusing the person who owns the limit would make the cap a limit on its
        // own author, and the workaround — raise it, add the terminal, lower it —
        // costs three actions and teaches nothing. They are told, not stopped.
        return {
            allowed: true,
            limit,
            live,
            source,
            atLimit: true,
            reason: `This workspace is ${countPhrase(live, limit, want)}. That is ${whereToChange(source)}.`,
        };
    }

    return {
        allowed: false,
        limit,
        live,
        source,
        atLimit: true,
        reason:
            `This workspace is ${countPhrase(live, limit, want)}, so Genie did not start another. ` +
            `That is ${whereToChange(source)}. ` +
            'You cannot raise it yourself — only the person at this machine can. ' +
            'Wait for a running agent to finish and free a slot, or ask them to raise the limit.',
    };
}
