/**
 * Turn Genie's collections into one {@link FloorInputs} per agent.
 *
 * `project-floor.ts` decides what a single agent's session LOOKS like; this decides
 * WHICH AGENT each fact belongs to. They are separate because attribution is where
 * the damage is: "kai is blocked" when kai is fine sends a person to the wrong
 * terminal, and a workspace with four agents gives three wrong answers for every
 * right one.
 *
 * Pure. The reads it is built on — the agent roster, `workingAgentTerminals()`,
 * `listPendingQuestions()`, the handoff files, AgentInbox threads, triage — all
 * happen in the caller, so every decision here is testable without a database, a
 * filesystem or a timer.
 *
 * ## The trap this module exists to avoid
 *
 * **Two absences must never match each other.** A dormant agent has `specId: null`;
 * a question nobody asked has no asker. Matching those would hand every internal
 * approval gate to whichever agent happens to be asleep and report it as blocked.
 *
 * Strict equality already refuses `undefined === null`, so the `undefined` case is
 * safe for free — and an earlier version of this comment wrongly claimed otherwise.
 * The case that is NOT safe is a source yielding **`null`**: `null === null` is true,
 * and absent-becomes-null is exactly what a JSON/IPC round-trip and a database read
 * both produce. `listPendingQuestions()` crosses IPC to reach the renderer, so that
 * path is real rather than hypothetical. Hence {@link GatherQuestion.askerTerminalId}
 * admits `null` and the match tests for a non-nullish asker explicitly.
 *
 * The same shape appears on the working set, where it is genuinely unfalsifiable: a
 * `Set<string>` can never contain `null`, so `has(null)` is always false. The guard
 * there is kept for intent, not because a test can break it — said plainly rather
 * than dressed up as a caught bug.
 */

import type { FloorHandoff, FloorInputs, FloorMessage, FloorQuestion } from './project-floor';

/** A registered agent, already joined to its fronted runtime by the caller. */
export interface GatherAgent {
    /** `workspace_agents.id` — the durable key. */
    agentId: string;
    name: string;
    /** The fronted runtime's terminal, or null when the agent is dormant. */
    specId: string | null;
    provider: string | null;
    cwd: string;
    workspaceId: string | null;
}

/** A pending question, as much of one as attribution needs. */
export interface GatherQuestion {
    id: string;
    /** ms epoch. **Absent** for a question forwarded from a host on an older build —
     *  the host's own note says consumers must "degrade (show nothing) rather than
     *  assume epoch 0". */
    createdAt?: number;
    /**
     * The terminal of the agent parked on it. Absent for an internal approval gate
     * and for a forwarded question.
     *
     * `null` is admitted as well as `undefined` because absent-becomes-null is what a
     * JSON/IPC round-trip and a database read produce, and `null === null` would
     * match a dormant agent's own null terminal. Accepting the shape is what lets the
     * match guard against it instead of hoping callers only ever omit the field.
     */
    askerTerminalId?: string | null;
}

export interface GatherSources {
    /** Registered agents. The output has one entry per agent, in this order. */
    agents: readonly GatherAgent[];
    /** `agentPulse.workingAgentTerminals()` — terminal ids currently mid-turn. */
    workingTerminalIds: readonly string[];
    /** Every pending question, unattributed. */
    questions: readonly GatherQuestion[];
    /** Parsed handoff per AGENT id. Keyed on the agent because a dormant one still
     *  has a handoff — and is the agent whose handoff matters most. */
    handoffs: ReadonlyMap<string, FloorHandoff>;
    /** Visible mail per AGENT id. */
    mail: ReadonlyMap<string, readonly FloorMessage[]>;
    /** Triage ailment per AGENT id. */
    ailments: ReadonlyMap<string, string>;
}

const NO_MAIL: readonly FloorMessage[] = [];

export function gatherFloorInputs(src: GatherSources, now = Date.now()): FloorInputs[] {
    const working = new Set(src.workingTerminalIds);

    return src.agents.map((a) => ({
        identity: {
            agentId: a.agentId,
            specId: a.specId,
            provider: a.provider,
            name: a.name,
            cwd: a.cwd,
            workspaceId: a.workspaceId,
        },
        // The null check is for intent, not for a bug a test can expose: a
        // `Set<string>` never contains `null`, so `has(null)` is already false.
        working: a.specId !== null && working.has(a.specId),
        questions: questionsFor(a, src.questions),
        handoff: src.handoffs.get(a.agentId) ?? null,
        mail: src.mail.get(a.agentId) ?? NO_MAIL,
        ailment: src.ailments.get(a.agentId) ?? null,
        now,
    }));
}

/**
 * The questions this agent is parked on.
 *
 * Matched ONLY on an explicit asker. A question with no asker belongs to nobody and
 * must stay that way: it is an internal approval gate, and handing it to the only
 * agent in the workspace would report a healthy agent as blocked. There is
 * deliberately no workspace-level fallback.
 */
function questionsFor(a: GatherAgent, questions: readonly GatherQuestion[]): FloorQuestion[] {
    return questions
        // `!= null` (loose, deliberately) rejects BOTH undefined and null, so a
        // question nobody asked cannot pair with a dormant agent's null terminal.
        //
        // ONE guard, not two. An early `if (a.specId === null) return []` was here as
        // well, and the pair were redundant: either alone covered the case, so no
        // single mutation could expose either, and the protection was unverifiable
        // while looking doubly safe. A guard a test cannot break is a guard that
        // cannot be trusted, so the redundant one is gone and this one is exposed by
        // removing exactly it.
        .filter((q) => q.askerTerminalId != null && q.askerTerminalId === a.specId)
        .map((q) => ({ id: q.id, createdAt: q.createdAt ?? null }));
}
