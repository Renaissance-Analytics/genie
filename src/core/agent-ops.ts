/**
 * AGENT OPERATIONS (§6.2) — the pure half.
 *
 * - RESTART is two named operations. GRACEFUL resumes the same thread and REFUSES when it cannot
 *   — a graceful restart that quietly started a new conversation is an agent that forgot
 *   everything while the user believes it remembers. FRESH discards the conversation on purpose,
 *   and is the only operation offered for a wedged agent.
 * - DELETE is two named outcomes: UNMOUNT keeps every `.agents/*` file and forgets the record;
 *   DELETE removes the folder too. Linked systems are LISTED and kept unless the same prompt opts
 *   in by name — a deletion that reached into Tynn because a checkbox defaulted on is not a
 *   deletion anyone asked for.
 * - SWITCH DRIVER carries identity, inbox, history and prompt; an `AGENT.md` with a `tuis:` list is
 *   the agent's own word on which providers may run it, and the same code refuses the user and an
 *   agent alike.
 * - A daily BUDGET parks the NEXT turn and asks; it never kills a turn in flight; and when the
 *   provider reports no cost it says `unenforceable` instead of silently never firing.
 */

const RESUMABLE = /^[A-Za-z0-9._:-]{1,200}$/;

export type RestartPlan =
    | { ok: true; kind: 'graceful'; resume: string }
    | { ok: true; kind: 'fresh'; resume: null; discards: string | null }
    | { ok: false; reason: string };

export function restartPlan(kind: 'graceful' | 'fresh', agent: { threadId: string | null; wedged: boolean }): RestartPlan {
    if (kind === 'fresh') return { ok: true, kind: 'fresh', resume: null, discards: agent.threadId };
    if (agent.wedged) return { ok: false, reason: 'this agent is not answering; only a fresh restart reaches a wedged agent' };
    if (agent.threadId === null) {
        return { ok: false, reason: 'this agent has no conversation to resume; a graceful restart would silently start a new chat — use a fresh restart if that is what you want' };
    }
    if (!RESUMABLE.test(agent.threadId)) return { ok: false, reason: 'the stored thread id is not one Genie will hand to the provider; use a fresh restart' };
    return { ok: true, kind: 'graceful', resume: agent.threadId };
}

export interface DeletePlan {
    readonly outcome: 'unmount' | 'delete';
    readonly removes: string[];
    readonly keeps: string[];
    readonly external: Array<{ system: string; action: 'kept'; optIn: string } | { system: string; action: 'removed' }>;
}

export function deletePlan(input: { outcome: 'unmount' | 'delete'; agentName: string; personaDir: string; linkedSystems: readonly string[]; alsoRemoveFrom?: readonly string[] }): DeletePlan {
    const optIn = input.alsoRemoveFrom ?? [];
    for (const s of optIn) {
        if (!input.linkedSystems.includes(s)) throw new Error(`${input.agentName} is not linked to ${s}; nothing to remove there`);
    }
    const removes = ['the agent record in Genie', 'its inbox registration'];
    const keeps = ['its thread history on the provider'];
    if (input.outcome === 'delete') removes.push(`${input.personaDir}/ (every file)`, 'its stored handoff');
    else keeps.unshift(`${input.personaDir}/ (every file)`);
    const external = input.linkedSystems.map((system) =>
        optIn.includes(system)
            ? ({ system, action: 'removed' } as const)
            : ({ system, action: 'kept', optIn: `alsoRemoveFrom: [${JSON.stringify(system)}]` } as const),
    );
    return { outcome: input.outcome, removes, keeps, external };
}

export interface AgentManifest {
    readonly name: string;
    /** The providers this agent may run under. Absent = any. */
    readonly tuis?: readonly string[];
}

/**
 * A switch that happened also says what it LEFT with the old provider: `discarded` — the old provider's conversation
 * (`null` = the agent never ran, so there was none) — and `droppedModel` — a model the new provider does not list
 * (`null` = none dropped). Absent on the pure decision and on a no-op; the host fills them in when it switches.
 */
export type SwitchDecision =
    | { ok: true; carries: string[]; from: string; to: string; noop?: true; discarded?: string | null; droppedModel?: string | null }
    | { ok: false; reason: string };

export function switchDriverDecision(manifest: AgentManifest, from: string, to: string, _by: 'user' | 'agent'): SwitchDecision {
    if (from === to) return { ok: true, carries: [], from, to, noop: true };
    if (manifest.tuis && !manifest.tuis.includes(to)) {
        return { ok: false, reason: `${manifest.name}’s AGENT.md allows tuis: ${manifest.tuis.join(', ')}; ${to} is not among them` };
    }
    return { ok: true, carries: ['identity', 'inbox', 'history', 'prompt'], from, to };
}

/**
 * WHAT THE VIEW SAYS AFTER A SWITCH. A provider's conversation is the provider's (a Claude session id means nothing to
 * Codex), so the agent starts a NEW one on the new provider — said plainly, so nobody expects the old chat to continue
 * there. Genie's own record of the agent (identity, inbox, history, prompt) is what comes along.
 */
export function switchOutcome(agentName: string, decision: SwitchDecision): string {
    if (!decision.ok) return decision.reason;
    if (decision.noop) return `${agentName} already runs on ${decision.to}`;
    const parts = [`${agentName} switched ${decision.from} → ${decision.to}`, `it starts a new conversation on ${decision.to}`];
    if (decision.discarded) parts.push(`its ${decision.from} conversation stays with ${decision.from}`);
    if (decision.droppedModel) parts.push(`"${decision.droppedModel}" is a ${decision.from} model; ${decision.to} starts on its default model`);
    parts.push(`kept: ${decision.carries.join(', ')}`);
    return `${parts.join('; ')}. Start it when ready.`;
}

export type BudgetDecision =
    | { kind: 'proceed'; remainingUsd: number | null }
    | { kind: 'park'; reason: string; spentUsd: number; limitUsd: number }
    | { kind: 'finish-then-park'; reason: string; spentUsd: number; limitUsd: number }
    | { kind: 'unenforceable'; reason: string };

export function budgetDecision(input: { dailyLimitUsd: number | null; spentTodayUsd: number; turnInFlight: boolean; costReported: boolean; agentName?: string }): BudgetDecision {
    if (input.dailyLimitUsd === null) return { kind: 'proceed', remainingUsd: null };
    if (!input.costReported) {
        return { kind: 'unenforceable', reason: 'this provider reports no cost, so a dollar budget cannot be enforced; the limit is shown but will not park anything' };
    }
    const name = input.agentName ?? 'atlas';
    if (input.spentTodayUsd < input.dailyLimitUsd) {
        return { kind: 'proceed', remainingUsd: Math.round((input.dailyLimitUsd - input.spentTodayUsd) * 100) / 100 };
    }
    const reason = `${name} has spent $${input.spentTodayUsd.toFixed(2)} of today’s $${input.dailyLimitUsd.toFixed(2)} budget; the next turn is parked until you raise the budget or say go`;
    return input.turnInFlight
        ? { kind: 'finish-then-park', reason, spentUsd: input.spentTodayUsd, limitUsd: input.dailyLimitUsd }
        : { kind: 'park', reason, spentUsd: input.spentTodayUsd, limitUsd: input.dailyLimitUsd };
}

/**
 * WHEN A SETTING THAT IS READ AT START TAKES EFFECT — the model, when the running session cannot switch it. The owner,
 * 2026-10-14: "I had to restart you because I was not able to change your model … all settings UI for agents is not
 * live". (A Claude agent's tool setting is no longer one of these: it is answered per shell call — `live`, genie#1188.)
 *
 * The provider reads it on its command line (`--model`), so a running session takes it by restarting ON THE SAME
 * CONVERSATION. Genie does that itself, at the first moment it costs nothing:
 * - not running: the next start reads it — nothing to do;
 * - idle, nothing parked, no background task running: now;
 * - mid-turn, or a question parked on the person: when the turn ends — a restart would cut the turn or cancel the
 *   question being answered;
 * - background tasks running: when they end — they die with the process, and nobody asked for that;
 * - failed: not by itself — a graceful restart refuses a wedged agent, and a fresh one would throw the conversation
 *   away; the next start (the person's restart) reads it.
 */
export type ApplyWhen =
    | { readonly when: 'next-start' }
    | { readonly when: 'now' }
    | { readonly when: 'after-turn' }
    | { readonly when: 'after-shells'; readonly shells: number }
    /**
     * SWITCHED ON THE RUNNING SESSION, no restart (prism-acp 0.22 `setModel`; the model only). Claude's CLI switches at
     * once (`now`); Codex sends the model with its next turn (`next-turn`), so a turn already running ends on its own.
     */
    | { readonly when: 'switched'; readonly timing: 'now' | 'next-turn' }
    /**
     * LIVE, nothing restarts (genie#1188): a Claude agent's tool setting is answered per shell call by the permission
     * hook, from the setting at that moment, so the next shell command follows the new one.
     */
    | { readonly when: 'live' };

export function applyWhen(session: { running: boolean; turnState: string; pendingApproval: unknown; failure: unknown } | null, shellsRunning: number): ApplyWhen {
    if (session === null || !session.running) return { when: 'next-start' };
    if (session.turnState === 'failed' || session.turnState === 'stopped' || session.failure !== null) return { when: 'next-start' };
    if (session.turnState !== 'idle' || session.pendingApproval !== null) return { when: 'after-turn' };
    if (shellsRunning > 0) return { when: 'after-shells', shells: shellsRunning };
    return { when: 'now' };
}

/** What the view says after the change: `what` is the setting's new value in words (`opus`, `edits only`). */
export function applyOutcome(agentName: string, what: string, apply: ApplyWhen): string {
    switch (apply.when) {
        case 'now': return `${what} — applied: ${agentName} restarted on the same conversation`;
        case 'after-turn': return `${what} — applies when ${agentName} finishes this turn (it restarts on the same conversation)`;
        case 'after-shells': return `${what} — applies when ${agentName}’s ${apply.shells === 1 ? 'background task ends' : `${apply.shells} background tasks end`}; restarting now would stop ${apply.shells === 1 ? 'it' : 'them'}`;
        case 'next-start': return `${what} — applies when ${agentName} next starts`;
        case 'live': return `${what} — applies from ${agentName}’s next shell command, no restart`;
        case 'switched': return apply.timing === 'now'
            ? `${what} — switched now on the same conversation, no restart: ${agentName}’s next turn runs on it`
            : `${what} — applies from ${agentName}’s next turn, on the same conversation, no restart (a turn already running finishes on its model)`;
    }
}

/**
 * A Claude agent's TOOL SETTING as the answer to one shell call (genie#1188), read at the moment the permission hook
 * asks: all tools (and no setting) → allow, nobody asked; ask → park it for the person; edits only → refuse.
 */
export function permissionDecisionFor(permissions: 'all' | 'ask' | 'edits' | undefined): 'allow' | 'deny' | 'ask' {
    if (permissions === 'ask') return 'ask';
    if (permissions === 'edits') return 'deny';
    return 'allow';
}
