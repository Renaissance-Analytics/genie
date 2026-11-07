/**
 * AGENT OPERATIONS (§6.2) — the pure half.
 *
 * - RESTART is one action (genie#1238): it keeps the conversation, and a Broken, stopped or
 *   never-started agent is STARTED by it. A restart never quietly starts a new conversation for an
 *   agent that has one — an agent that forgot everything while the user believes it remembers.
 *   RESTART FRESH discards the conversation on purpose.
 * - DELETE is two named outcomes: UNMOUNT keeps every `.agents/*` file and forgets the record;
 *   DELETE removes the folder too. Linked systems are LISTED and kept unless the same prompt opts
 *   in by name — a deletion that reached into Tynn because a checkbox defaulted on is not a
 *   deletion anyone asked for.
 * - SWITCH PROVIDER carries the agent: its identity, inbox, history, plan and its CONVERSATION (core/carry-over.ts), and
 *   each provider keeps its own native session to resume on switching back (Tynn story #380). The person can always
 *   switch; AGENT.md is the person's persona and names no provider.
 * - A daily BUDGET parks the NEXT turn and asks; it never kills a turn in flight; and when the
 *   provider reports no cost it says `unenforceable` instead of silently never firing.
 */

const RESUMABLE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * `graceful` is RESTART — THE ONE ACTION every Restart and Start control calls (genie#1238). It keeps the conversation
 * whenever there is one, and works from every state: a Broken agent is started again on its thread (it used to be refused
 * "only a fresh restart reaches a wedged agent" — the one state the Broken Restart buttons were drawn in), and an agent
 * with no conversation yet starts its first (it used to be refused; there is nothing to forget). `resume: null` = a first
 * conversation. A thread id Genie will not hand to the provider is still refused. `fresh` drops the conversation on purpose.
 */
/**
 * WHAT AN AGENT IS TOLD WHEN A RESTART CUT ITS TURN (genie#1238). Genie 1 told every relaunched agent that it had been
 * restarted and to pick up where it left off (v0.7.0-beta.342 main/agents/relaunch-prompt.ts:68-101). Genie 2 resumes the
 * conversation itself, so an agent that was idle is not prompted — nothing was cut off, and a prompt would start a turn
 * nobody asked for — but one that was MID-TURN had that turn cancelled by the Restart and is told, as a relaunch after a
 * quit tells it (core/upgrade-drain.ts RESUME_AFTER_RESTART).
 */
export const RESUME_AFTER_USER_RESTART =
    'You were restarted (Restart in Genie) while you were in the middle of a turn, so that turn was cancelled. ' +
    'Genie has resumed this conversation. Continue the work you were doing, from where you left off. ' +
    'Check the state of anything you were changing before you carry on — the cancelled step may not have finished.';

export type RestartPlan =
    | { ok: true; kind: 'graceful'; resume: string | null }
    | { ok: true; kind: 'fresh'; resume: null; discards: string | null }
    | { ok: false; reason: string };

export function restartPlan(kind: 'graceful' | 'fresh', agent: { threadId: string | null }): RestartPlan {
    if (kind === 'fresh') return { ok: true, kind: 'fresh', resume: null, discards: agent.threadId };
    if (agent.threadId === null) return { ok: true, kind: 'graceful', resume: null };
    if (!RESUMABLE.test(agent.threadId)) return { ok: false, reason: 'the stored thread id is not one Genie will hand to the provider; use Restart fresh' };
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

/**
 * A switch that happened also says what came along and what waits: `carried` — how much of the conversation the next
 * prompt carries (core/carry-over.ts; `null` = nothing to carry) — `left` — the old provider's own session, kept to
 * resume on switching back (`null` = it never ran there) — and `droppedModel` — a model the new provider does not list
 * (`null` = none dropped). Absent on the pure decision and on a no-op; the host fills them in when it switches.
 */
export type SwitchDecision =
    | { ok: true; from: string; to: string; noop?: true; carried?: { turns: number; of: number; plan: boolean } | null; left?: string | null; droppedModel?: string | null }
    | { ok: false; reason: string };

/** Where the Provider control's switch stands (genie#1569). */
export type ProviderSwitchState = { kind: 'idle' } | { kind: 'working'; to: string } | { kind: 'done'; text: string } | { kind: 'failed'; to: string; reason: string };

/** The Provider control's state once a switch to `to` has answered: a refusal keeps `to`, so Retry asks for it again. */
export function providerSwitchAfter(agentName: string, to: string, decision: SwitchDecision): ProviderSwitchState {
    return decision.ok ? { kind: 'done', text: switchOutcome(agentName, decision) } : { kind: 'failed', to, reason: decision.reason };
}

/** The person can always switch an agent's provider (Tynn story #380); the same provider is a no-op. */
export function switchDriverDecision(from: string, to: string): SwitchDecision {
    if (from === to) return { ok: true, from, to, noop: true };
    return { ok: true, from, to };
}

/**
 * WHAT THE PERSON IS TOLD AFTER A SWITCH (Tynn story #380): the conversation comes with the agent (the last N turns, or
 * N of M when the carry-over had to cut, and its plan), and switching back resumes the old provider's own conversation.
 */
export function switchOutcome(agentName: string, decision: SwitchDecision): string {
    if (!decision.ok) return decision.reason;
    if (decision.noop) return `${agentName} already runs on ${decision.to}`;
    const parts = [`${agentName} switched ${decision.from} → ${decision.to}.`];
    const carried = decision.carried;
    if (carried && carried.turns > 0) {
        const turns = carried.of > carried.turns ? `${carried.turns} of ${carried.of} turns` : `${carried.turns} turn${carried.turns === 1 ? '' : 's'}`;
        parts.push(`Its conversation comes with it (the last ${turns}${carried.plan ? ' and its plan' : ''}).`);
    } else if (carried?.plan) parts.push('Its plan comes with it.');
    if (decision.left) parts.push(`Switching back to ${decision.from} resumes its ${decision.from} conversation.`);
    if (decision.droppedModel) parts.push(`"${decision.droppedModel}" is a ${decision.from} model; ${decision.to} starts on its default model.`);
    return parts.join(' ');
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
 * - failed: not by itself — a Broken agent is the person's to restart (they see why it broke first); that Restart
 *   reads it.
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

/** Why an AUTONOMOUS agent was still asked (Tynn #439), drawn on the card: the workspace is not trusted. */
export const AUTONOMY_UNTRUSTED = 'Autonomous doesn’t apply here: this workspace isn’t trusted.';
/** Why an AUTONOMOUS agent was still asked (Tynn #439): the action is one autonomy never answers (approval-queue PERSON_ONLY_ACTIONS). */
export const AUTONOMY_PERSON_ONLY = 'Autonomous doesn’t cover this: it always asks you.';

/**
 * A Claude agent's TOOL SETTING as the answer to one shell call (genie#1188), read at the moment the permission hook
 * asks: all tools (and no setting) → allow, nobody asked; ask → park it for the person; edits only → refuse. In a workspace the person has not trusted, "all tools" asks too: the setting was never about this folder.
 *
 * AUTONOMOUS (Tynn #801) means nobody is asked (Tynn #439; the owner, 2026-11-04: "I have an agent with autonomous turned
 * on but it's still prompting me to approve an execution"): it answers "ask" with allow. It does not turn edits only
 * into allow — that setting is a refusal, never a question — and it does not apply in a workspace that is not trusted,
 * as a Codex agent's yolo never did (session-host `codexRecordFor`); there the card says why (`askedWhy`).
 */
export function permissionDecisionFor(permissions: 'all' | 'ask' | 'edits' | undefined, where: { readonly untrusted?: boolean; readonly autonomous?: boolean } = {}): 'allow' | 'deny' | 'ask' {
    if (permissions === 'edits') return 'deny';
    if (where.untrusted === true) return 'ask';
    if (where.autonomous === true) return 'allow';
    return permissions === 'ask' ? 'ask' : 'allow';
}

/**
 * What Codex asks (its command and file-change approvals), answered at the moment it asks (Tynn #439). Codex has no tool
 * setting; an Autonomous agent is launched with Codex's own prompts off (session-host `codexOptionsFor`), so a request
 * reaching Genie means the switch was turned on after the launch — answered now, as the launch would have. Otherwise, and
 * in a workspace that is not trusted, the person answers.
 */
export function codexDecisionFor(where: { readonly untrusted?: boolean; readonly autonomous?: boolean }): 'allow' | 'ask' {
    return where.autonomous === true && where.untrusted !== true ? 'allow' : 'ask';
}

/** Why a request still reaches the person although its agent is Autonomous, in words for the card; `null` = nothing to explain. */
export function askedWhy(where: { readonly untrusted?: boolean; readonly autonomous?: boolean }): string | null {
    return where.autonomous === true && where.untrusted === true ? AUTONOMY_UNTRUSTED : null;
}
