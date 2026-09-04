/**
 * WHY an agent is wedged — the step that comes before any repair.
 *
 * Genie already had the repair verbs. `runAgent restart` relaunches an agent
 * without losing its conversation, `manageTerminals` reads and kills, the
 * AgentInbox re-joins itself, the handoff reader recovers what an agent was
 * doing. What it had no answer for was the question those verbs presuppose:
 * which of them is the right one HERE. From outside, a silent agent looks
 * identical whatever is wrong with it, so the operator could only guess — and a
 * guess that restarts a healthy agent costs someone their conversation.
 *
 * Four real cases in a single day set the bar, and no two shared a repair:
 *
 *   | an agent never joined to the inbox | mail was accepted and delivered to nobody |
 *   | a boot marker never written        | it was running and never reported ready   |
 *   | a transport that never verified    | its harness never finished the handshake  |
 *   | a binding lost to a restart        | the DB says verified; memory says nothing |
 *
 * The last one is the reason this module joins sources instead of reading one.
 * `harnessTransportRegistry` is in-memory and EMPTY after every Genie restart;
 * `workspace_agents.transport_verified_at` is durable. Neither alone can tell a
 * live channel from a stale record — the disagreement between them IS the
 * finding, and no single surface could ever have reported it.
 *
 * ★ PURE. Every fact arrives in {@link AgentObservation}: the agent row, the
 * runtime row, the pty, the registry, the broker, the provider cache. The states
 * worth diagnosing are miserable to reproduce for real — a machine mid-restart
 * holding a stale binding, an agent two seconds into its boot — so the reasoning
 * has to be testable without producing them. The gathering lives at the call
 * site (`runAgentForMcp`), which is where the I/O belongs.
 */

/**
 * How long after its terminal was bound an agent is allowed to have verified
 * nothing yet.
 *
 * Without a window, `diagnose` reports the machine broken during every normal
 * boot: an agent launched two seconds ago has no verified transport and no
 * `ready_at`, which is the same observation as one stuck for an hour. An
 * operator that learns to ignore the tool is worse off than one that never had
 * it — so the two things a boot legitimately has not done yet are excused, and
 * nothing else is.
 */
export const AGENT_SETTLING_MS = 90_000;

export type AgentAilment =
    /** Its provider cannot launch on this machine, so it cannot be started. */
    | 'provider-unavailable'
    /** The terminal it is bound to no longer exists. */
    | 'terminal-gone'
    /** The terminal exists; its pty is not running. */
    | 'pty-exited'
    /** The harness reported a transport failure and said why. */
    | 'transport-failed'
    /** The harness never completed `registerTransport`. */
    | 'transport-never-verified'
    /** Verified in an earlier Genie run; nothing is bound now. A stale session. */
    | 'transport-binding-lost'
    /** It has an AgentInbox identity but the broker has no entry for it. */
    | 'not-joined-to-inbox'
    /** Running, and it never called `thumbsUp` with reason `boot`. */
    | 'boot-never-completed'
    /** The runtime and the cached mirror name different terminals. */
    | 'runtime-mirror-mismatch'
    /** Two agents share a name and nobody has said which survives. */
    | 'name-collision';

/**
 * `wedged` means SOMETHING NEEDS THE OPERATOR — not necessarily that a pty is
 * hung. A registered agent whose provider cannot launch is wedged with nothing
 * running at all.
 */
export type AgentCondition = 'healthy' | 'dormant' | 'starting' | 'wedged';

export interface AgentFinding {
    ailment: AgentAilment;
    /** What is wrong, in the words a report should show. */
    detail: string;
    /** The EXISTING verb that addresses it. This module invents no repairs. */
    repair: string;
}

/** Everything the diagnosis reads. Gathered by the caller; never fetched here. */
export interface AgentObservation {
    agentId: string;
    name: string;
    workspaceId: string;
    workspaceName: string;
    /** The TUI its record says it runs under. */
    tui: string | null;
    /** `workspace_agents.terminal_spec_id` — the CACHED mirror. */
    recordTerminalId: string | null;
    /** The fronted `agent_runtimes` row's terminal — the AUTHORITY. */
    runtimeTerminalId: string | null;
    /** Whether that terminal spec is still in the database. */
    terminalSpecExists: boolean;
    /** Whether its pty is running right now (`isTerminalLive`). */
    ptyLive: boolean;
    /** What its harness MUST verify, or null when its provider requires nothing. */
    requiredTransport: string | null;
    /** `workspace_agents.transport_verified_at` — durable, survives a restart. */
    transportVerifiedAt: number | null;
    transportError: string | null;
    /** `harnessTransportRegistry.isVerified(...)` — a LIVE binding, right now. */
    transportBoundNow: boolean;
    /** `workspace_agents.ready_at` — written only by `thumbsUp(reason:'boot')`. */
    readyAt: number | null;
    /** Whether the AgentInbox broker holds an entry for this agent. */
    joinedInbox: boolean;
    collisionGroup: string | null;
    /** `launchBlockReason(tui)` — why a launch would refuse, when it would. */
    launchBlocked: string | null;
    /** Its handoff note, when it left one. */
    handoffPath: string | null;
    /**
     * Why a GRACEFUL restart would be refused right now, when it would
     * (`resolveRestartCommand`), else null.
     *
     * Most repairs here are `runAgent restart`, and that call REFUSES when a
     * terminal has no captured session to resume — deliberately, so a restart can
     * never silently drop a conversation into a fresh, context-less one
     * (genie#364, where a relaunch replayed the one-shot `--session-id` CREATE
     * flag instead of the resume grammar). A diagnosis that recommends a restart
     * without knowing that sends the operator to a refusal, or worse, to a
     * stop-and-recreate that loses the work.
     */
    restartRefusal: string | null;
    /** When its terminal binding was last written. Null when never bound. */
    boundAt: number | null;
    observedAt: number;
}

export interface AgentDiagnosis {
    agentId: string;
    name: string;
    workspaceId: string;
    workspaceName: string;
    tui: string | null;
    /** The AUTHORITY's terminal — what a repair should act on. */
    terminalId: string | null;
    condition: AgentCondition;
    /** One line: the condition, and the primary finding when there is one. */
    summary: string;
    /** Causal order — the first is the thing to fix. */
    findings: AgentFinding[];
    handoffPath: string | null;
}

/** PURE. One agent's observation → what is wrong with it and what fixes that. */
export function diagnoseAgent(obs: AgentObservation): AgentDiagnosis {
    // The runtime row owns the binding; `workspace_agents.terminal_spec_id` is a
    // mirror of it. Prefer the authority so a repair acts on the terminal that
    // actually exists rather than the one a stale mirror remembers.
    const terminalId = obs.runtimeTerminalId ?? obs.recordTerminalId;
    const settling =
        obs.boundAt !== null && obs.observedAt - obs.boundAt < AGENT_SETTLING_MS;
    const findings: AgentFinding[] = [];

    const shell = {
        agentId: obs.agentId,
        name: obs.name,
        workspaceId: obs.workspaceId,
        workspaceName: obs.workspaceName,
        tui: obs.tui,
        terminalId,
        handoffPath: obs.handoffPath,
    };

    // --- not running at all -------------------------------------------------
    // A registered agent with no terminal has not failed at anything. Saying it
    // is broken would have the operator restart it for no reason at all.
    if (!terminalId) {
        if (obs.launchBlocked) {
            findings.push({
                ailment: 'provider-unavailable',
                detail:
                    `Its provider cannot launch on this machine: ${obs.launchBlocked}. ` +
                    'Starting it would fail before the agent ever ran.',
                repair:
                    'Install or configure the provider (Settings, or the toolchain wizard). ' +
                    '`runAgent start` will keep refusing until it can launch.',
            });
        }
        pushCollision(findings, obs);
        const condition: AgentCondition = findings.length ? 'wedged' : 'dormant';
        return {
            ...shell,
            condition,
            findings,
            summary:
                condition === 'dormant'
                    ? `${obs.name} — registered and not running. Nothing is wrong with it.`
                    : `${obs.name} — ${findings[0]!.detail}`,
        };
    }

    // --- the terminal is the fault ------------------------------------------
    // Everything downstream (transport, inbox presence, boot) is a CONSEQUENCE
    // of a missing pty, not a separate fault. Listing all four turns one problem
    // into four, each pointing at a different repair, and the operator picks the
    // wrong one.
    if (!obs.terminalSpecExists) {
        findings.push({
            ailment: 'terminal-gone',
            detail:
                `Bound to terminal "${terminalId}", which no longer exists — the spec was ` +
                'deleted while the agent record kept pointing at it.',
            repair: '`runAgent start` — it creates a fresh terminal for this agent.',
        });
    } else if (!obs.ptyLive) {
        findings.push({
            ailment: 'pty-exited',
            detail:
                `Its terminal "${terminalId}" still exists but the pty is not running: the TUI ` +
                'exited, or the terminal backend dropped it.',
            repair:
                '`runAgent start` reattaches and revives the SAME terminal, so the conversation ' +
                'survives. Read the last output first (`manageTerminals read`) — the exit tail is ' +
                'the only evidence of why it went.',
        });
    }

    if (findings.length === 0) {
        pushTransport(findings, obs, settling);
        pushInbox(findings, obs);
        pushBoot(findings, obs, settling);
        pushMirror(findings, obs);
    }
    pushCollision(findings, obs);

    if (findings.length > 0) {
        return { ...shell, condition: 'wedged', findings, summary: `${obs.name} — ${findings[0]!.detail}` };
    }
    // Nothing found, but the two grace-able facts are still outstanding: it is
    // coming up, and saying "healthy" would be a claim Genie cannot support yet.
    if (settling && (obs.readyAt === null || (!!obs.requiredTransport && !obs.transportBoundNow))) {
        return {
            ...shell,
            condition: 'starting',
            findings,
            summary: `${obs.name} — started recently and still coming up. Nothing to repair yet.`,
        };
    }
    return {
        ...shell,
        condition: 'healthy',
        findings,
        summary: `${obs.name} — healthy: running, transport bound, in the inbox, boot reported.`,
    };
}

/**
 * A repair that says "restart it", carrying the refusal a restart would give.
 *
 * Applied at the point the advice is written rather than post-hoc over the
 * findings, so a repair that does NOT involve a restart cannot pick the caveat up
 * by accident — reviving a dormant spec through `runAgent start` is a different
 * path and is not governed by this refusal.
 */
function restartRepair(obs: AgentObservation, lead: string): string {
    if (!obs.restartRefusal) return lead;
    return (
        `${lead} FIRST, though — a graceful restart would be refused right now: ` +
        `${obs.restartRefusal} Recover what it was doing (its handoff note, or ` +
        '`manageTerminals read` on its terminal) before stopping it: from here a ' +
        'relaunch starts a fresh, context-less session.'
    );
}

function pushTransport(out: AgentFinding[], obs: AgentObservation, settling: boolean): void {
    // A provider with no native adapter has nothing to verify. Faulting those
    // would mark every kiwi, genie and custom agent on the machine broken for
    // doing exactly what they are supposed to.
    if (!obs.requiredTransport || obs.transportBoundNow) return;

    if (obs.transportError) {
        out.push({
            ailment: 'transport-failed',
            detail:
                `Its ${obs.requiredTransport} transport failed and the harness said why: ` +
                `${obs.transportError}`,
            repair: restartRepair(obs, '`runAgent restart` — the harness reopens its channel on relaunch.'),
        });
        return;
    }
    if (obs.transportVerifiedAt !== null) {
        // THE stale session, and the one finding no single surface could report.
        out.push({
            ailment: 'transport-binding-lost',
            detail:
                `Its ${obs.requiredTransport} transport verified in an earlier Genie run and is ` +
                'not bound now — the registry is in memory and does not survive a Genie restart, ' +
                'so the database says connected while nothing is listening.',
            repair: restartRepair(
                obs,
                '`runAgent restart` — relaunching makes the harness redo the handshake and rebind.',
            ),
        });
        return;
    }
    if (settling) return;
    out.push({
        ailment: 'transport-never-verified',
        detail:
            `Its harness never completed the ${obs.requiredTransport} handshake, so Genie has no ` +
            'native channel to it and it can never be marked ready.',
        repair: restartRepair(
            obs,
            '`manageTerminals read` on its terminal to see what the harness printed, then ' +
                '`runAgent restart`.',
        ),
    });
}

function pushInbox(out: AgentFinding[], obs: AgentObservation): void {
    if (obs.joinedInbox) return;
    // No grace window: the join happens when the terminal is created, not after
    // the TUI comes up, so an unjoined agent is unjoined immediately.
    out.push({
        ailment: 'not-joined-to-inbox',
        detail:
            'It has an AgentInbox identity but the broker holds no entry for it, so messages ' +
            'addressed to it are accepted and delivered to nobody.',
        repair: restartRepair(
            obs,
            '`runAgent restart` — the relaunch re-joins it. (An agent re-joins itself on its own ' +
                'next `agentinbox` call, but that only helps if it is running and calling.)',
        ),
    });
}

function pushBoot(out: AgentFinding[], obs: AgentObservation, settling: boolean): void {
    if (obs.readyAt !== null || settling) return;
    // `markWorkspaceAgentReadyByTerminal` sets `ready_at` only WHERE
    // `transport_verified_at IS NOT NULL` — the gate is in SQL. When the
    // transport is unverified, "never completed boot" is a SYMPTOM, and
    // reporting it as the fault sends the operator to the wrong place.
    const blockedByTransport = !!obs.requiredTransport && obs.transportVerifiedAt === null;
    out.push({
        ailment: 'boot-never-completed',
        detail: blockedByTransport
            ? 'It has never called thumbsUp with reason boot — and it cannot, because readiness ' +
              'is gated on a verified transport. Fix the transport first; this clears with it.'
            : 'It is running but has never called thumbsUp with reason boot, so Genie has no ' +
              'confirmation it finished starting.',
        repair: blockedByTransport
            ? 'Repair the transport above; nothing here needs a separate fix.'
            : '`manageTerminals read` on its terminal — it may be parked on a prompt waiting for ' +
              'an answer nobody is giving it.',
    });
}

function pushMirror(out: AgentFinding[], obs: AgentObservation): void {
    if (!obs.recordTerminalId || !obs.runtimeTerminalId) return;
    if (obs.recordTerminalId === obs.runtimeTerminalId) return;
    out.push({
        ailment: 'runtime-mirror-mismatch',
        detail:
            `Its runtime is bound to "${obs.runtimeTerminalId}" but the agent record still names ` +
            `"${obs.recordTerminalId}" — something wrote one and not the other, and every surface ` +
            'reading the record is looking at the wrong terminal.',
        repair: restartRepair(obs, '`runAgent restart` rebinds both records to one terminal.'),
    });
}

function pushCollision(out: AgentFinding[], obs: AgentObservation): void {
    if (!obs.collisionGroup) return;
    // Last, always: a collision is a question for a person, not a fault that
    // explains why an agent is unreachable.
    out.push({
        ailment: 'name-collision',
        detail:
            `Another agent in this workspace shares the name "${obs.name}" and the collision has ` +
            'not been answered, so both rows coexist under a partial index.',
        repair:
            'A human must choose which one survives — `runAgent list` shows both. Do not pick for ' +
            'them; the loser takes its conversation with it.',
    });
}

/**
 * The one line an operator reads first.
 *
 * Names the agents that need attention and NOT the ones that do not. A summary
 * that lists every healthy agent buries the one finding it exists to surface.
 */
export function triageSummary(diagnoses: readonly AgentDiagnosis[]): string {
    if (diagnoses.length === 0) {
        return 'No agents to triage — no registered agents in the workspaces you can act on.';
    }
    const counted: AgentCondition[] = ['healthy', 'starting', 'dormant', 'wedged'];
    const parts = counted
        .map((condition) => ({
            condition,
            n: diagnoses.filter((d) => d.condition === condition).length,
        }))
        .filter((c) => c.n > 0)
        .map((c) => `${c.n} ${c.condition}`);

    const noun = diagnoses.length === 1 ? 'agent' : 'agents';
    const head = `${diagnoses.length} ${noun}: ${parts.join(', ')}.`;
    const wedged = diagnoses.filter((d) => d.condition === 'wedged');
    if (wedged.length === 0) return head;
    return `${head} ${wedged.map((d) => `${d.workspaceName}/${d.name} — ${d.findings[0]?.ailment ?? 'unknown'}`).join('; ')}.`;
}
