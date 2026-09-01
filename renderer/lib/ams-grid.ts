import type { TerminalSpec } from './genie';

export function splitAmsSpecs(specs: TerminalSpec[]): {
    agents: TerminalSpec[];
    panels: TerminalSpec[];
} {
    return specs.reduce(
        (result, spec) => {
            result[spec.meta?.agent ? 'agents' : 'panels'].push(spec);
            return result;
        },
        { agents: [], panels: [] } as { agents: TerminalSpec[]; panels: TerminalSpec[] },
    );
}

export function amsAgentCard(
    spec: TerminalSpec,
    state: { running: boolean; active: boolean },
) {
    const purpose = typeof spec.meta?.whisper_purpose === 'string'
        ? spec.meta.whisper_purpose.trim()
        : '';
    return {
        name: purpose || spec.label,
        provider: spec.meta?.agent ?? 'custom',
        running: state.running,
        active: state.active,
    };
}

/* ── The grid, driven by the agent RECORD ──────────────────────────────────── */

/** One registered agent, as the renderer receives it from main. */
export interface AgentRecordSpec {
    id: string;
    name: string;
    purpose: string;
    avatar: string | null;
    role: 'workspace' | 'specialized' | 'gapp';
    /** Set when this workspace holds more than one agent under this name and a
     *  human has not yet said which survives. */
    collisionGroup: string | null;
}

/** One TUI an agent may run under. */
export interface AgentRuntimeSpec {
    id: string;
    agentId: string;
    /** The TUI this runtime drives. Renamed from `provider` with the schema
     *  (genie v63) — main sends `tui`, and a renderer still reading `provider`
     *  got `undefined`, which is how the agent panel started throwing. */
    tui: string;
    terminalSpecId: string | null;
    /** The visible one. At most one per agent. */
    fronted: boolean;
}

export interface AgentGridRow {
    kind: 'agent' | 'orphan';
    /** Agent rows: the record id. Orphan rows: the spec id, which is all there is. */
    id: string;
    name: string;
    purpose: string;
    avatar: string | null;
    role: 'workspace' | 'specialized' | 'gapp';
    /** The fronted TUI, or null for an agent that has never been started. */
    provider: string | null;
    /** Every TUI this agent may run under — the fronted one and its sidecars. */
    tuis: Array<{ runtimeId: string; provider: string; fronted: boolean; running: boolean }>;
    /** True when ANY of its TUIs is live. */
    running: boolean;
    collisionGroup: string | null;
    /** Orphan rows only: the spec nothing owns. */
    specId?: string;
}

/**
 * What the AMS grid draws: REGISTERED AGENTS, not agent-stamped terminal specs.
 *
 * This is the phantom-square fix at its source. `main` has always held a durable
 * agent record; the renderer had none of it and read `TerminalSpec.meta`
 * instead — `host-tools.ts` said so outright: "a saved agent IS a terminal spec
 * carrying `meta.agent`". Two consequences, both seen in the wild:
 *
 *  - a leftover spec WAS an agent as far as the UI was concerned, so one
 *    registered `claude:tynn` drew three "tynn" squares;
 *  - a registered agent that was not running was INVISIBLE, so every
 *    `role: 'workspace'` agent seeded since v50 has never been shown to anyone.
 *
 * Reading the record inverts both. A dormant agent appears, with no TUI yet. And
 * a spec no runtime owns can no longer masquerade as an agent — it is surfaced
 * AS orphaned, which is what makes it repairable instead of merely confusing.
 */
export function agentGridRows(input: {
    agents: readonly AgentRecordSpec[];
    runtimes: readonly AgentRuntimeSpec[];
    specs: readonly TerminalSpec[];
    isLive: (terminalSpecId: string) => boolean;
}): AgentGridRow[] {
    const { agents, runtimes, specs, isLive } = input;

    const byAgent = new Map<string, AgentRuntimeSpec[]>();
    for (const runtime of runtimes) {
        const list = byAgent.get(runtime.agentId);
        if (list) list.push(runtime);
        else byAgent.set(runtime.agentId, [runtime]);
    }

    const rows: AgentGridRow[] = agents.map((agent) => {
        const mine = byAgent.get(agent.id) ?? [];
        const tuis = mine.map((runtime) => ({
            runtimeId: runtime.id,
            // `AgentGridRow.provider` is a DISPLAY field fed from runtimes AND
            // from `spec.meta.agent`, so it keeps its name; only the runtime's
            // own field moved to `tui` (genie v63).
            provider: runtime.tui,
            fronted: runtime.fronted,
            running: !!runtime.terminalSpecId && isLive(runtime.terminalSpecId),
        }));
        return {
            kind: 'agent' as const,
            id: agent.id,
            name: agent.name,
            purpose: agent.purpose,
            avatar: agent.avatar,
            role: agent.role,
            provider: tuis.find((t) => t.fronted)?.provider ?? null,
            tuis,
            // ANY live TUI. A fronted one that exited while a sidecar keeps
            // working is still a working agent, and drawing it as stopped would
            // be a lie about what is running.
            running: tuis.some((t) => t.running),
            collisionGroup: agent.collisionGroup,
        };
    });

    // The workspace's own agent leads: it is the default target for most
    // actions, so it should not sort by whatever its name happens to be.
    rows.sort((a, b) => Number(b.role === 'workspace') - Number(a.role === 'workspace'));

    // Anything agent-stamped that no runtime claims. Surfaced rather than drawn
    // as an agent, because that is precisely what produced the phantom squares.
    const owned = new Set(
        runtimes.map((r) => r.terminalSpecId).filter((id): id is string => !!id),
    );
    for (const spec of specs) {
        if (!spec.meta?.agent || owned.has(spec.id)) continue;
        const purpose =
            typeof spec.meta?.whisper_purpose === 'string' ? spec.meta.whisper_purpose.trim() : '';
        rows.push({
            kind: 'orphan',
            id: spec.id,
            specId: spec.id,
            name: purpose || spec.label,
            purpose: '',
            avatar: null,
            role: 'specialized',
            provider: typeof spec.meta.agent === 'string' ? spec.meta.agent : null,
            tuis: [],
            running: isLive(spec.id),
            collisionGroup: null,
        });
    }

    return rows;
}
