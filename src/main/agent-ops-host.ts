import { join } from 'node:path';
import { parseAgentManifest } from '../core/agent-manifest.js';
import { applyWhen, budgetDecision, deletePlan, restartPlan, switchDriverDecision, type ApplyWhen, type BudgetDecision, type DeletePlan, type SwitchDecision } from '../core/agent-ops.js';
import { ACP_PROVIDERS, isAcpProvider, type AcpProvider } from '../core/engine.js';
import type { AgentPermissions, AgentRecord } from '../core/identity.js';
import { parseIssueWatchSetting, type IssueWatchSetting } from '../core/issue-watch.js';
import type { LiveSession } from '../core/roster.js';
import type { StopVerdict } from '../core/session.js';
import { switchTiming, type ModelChoices, type SessionModelState } from '../core/provider-models.js';
import { diagnoseAgent, type Diagnosis } from '../core/workspace-model.js';

/**
 * AGENT OPERATIONS IN THE APP (§6.2) — the main-process half over the pure plans in core/agent-ops.
 *
 * Restart is two NAMED operations: graceful resumes the same thread and refuses when it cannot;
 * fresh clears the thread first and is the only one that reaches a wedged agent. Delete is PREVIEWED
 * with its plan before it acts, and the cross-system opt-in travels in the same call. Switch driver
 * reads the persona's own `tuis:`. A budget is set and judged at once — unenforceable when the
 * provider reports no cost, said rather than silently never firing. Diagnose names a cause and the
 * repair that fits; a never-run agent is dormant, not a fault. Every port is injected; main.ts
 * passes the registry, the session host and the filesystem.
 */

export interface AgentOpsPorts {
    registry: {
        find(id: string): AgentRecord | null;
        forget(id: AgentRecord['id']): Promise<boolean>;
        clearThread(id: AgentRecord['id']): Promise<AgentRecord | null>;
        setProvider(id: AgentRecord['id'], provider: AcpProvider): Promise<{ ok: true; record: AgentRecord } | { ok: false; reason: string }>;
        setBudget(id: AgentRecord['id'], usd: number | null): Promise<AgentRecord | null>;
        setMode(id: AgentRecord['id'], mode: AgentRecord['mode']): Promise<AgentRecord | null>;
        setAccessScope(id: AgentRecord['id'], scope: AgentRecord['accessScope']): Promise<AgentRecord | null>;
        setAutoApprove(id: AgentRecord['id'], autoApprove: boolean): Promise<AgentRecord | null>;
        setManageTabs(id: AgentRecord['id'], manageTabs: boolean): Promise<AgentRecord | null>;
        setDrivePages(id: AgentRecord['id'], drivePages: boolean): Promise<AgentRecord | null>;
        setIssueWatch(id: AgentRecord['id'], setting: IssueWatchSetting): Promise<AgentRecord | null>;
        setPermissions(id: AgentRecord['id'], permissions: AgentPermissions): Promise<AgentRecord | null>;
        setModel(id: AgentRecord['id'], model: string | null): Promise<AgentRecord | null>;
    };
    host: {
        start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string };
        stop(id: AgentRecord['id']): boolean;
        /** How the last stop ended, once it has (`SessionHost.ended`): a restart starts only after it. */
        ended?(id: AgentRecord['id']): Promise<StopVerdict | null>;
        probe(id: AgentRecord['id']): LiveSession | null;
        /** The running agent's own models (`SessionHost.modelState`): `null` = not running, or its driver cannot say. */
        modelState?(id: AgentRecord['id']): Promise<SessionModelState> | null;
        /** Switch the running agent's model, no restart (`SessionHost.switchModel`): `null` = not running, or it cannot. */
        switchModel?(id: AgentRecord['id'], model: string): Promise<void> | null;
    };
    /** Each provider's model list, asked of its CLI once and kept (core/provider-models.ts `ProviderModelCache`). */
    models?: { get(provider: string, options?: { refresh?: boolean }): Promise<ModelChoices> };
    cwdFor(record: AgentRecord): string;
    workspacePathFor(record: AgentRecord): string | null;
    /** The persona file's text, or `null` when there is none. */
    readManifest(record: AgentRecord): Promise<string | null>;
    removeDir(path: string): Promise<void>;
    removeHandoff(record: AgentRecord): Promise<void>;
    /** Systems this agent is registered with beyond Genie (Tynn, …) — listed in the delete plan, kept unless opted in. */
    linkedSystems(record: AgentRecord): string[];
    providerInstalled(provider: string): boolean;
    signedIn(provider: string): boolean;
    /** A setting read at start changed: when it takes effect (`SettingApplier.requested`). Absent = the next start, said so. */
    applyOnStart?(id: AgentRecord['id']): ApplyWhen;
}

type Refusal = { ok: false; reason: string };
const UNKNOWN: Refusal = { ok: false, reason: 'unknown agent' };

const isWedged = (session: LiveSession | null): boolean => session !== null && (session.turnState === 'failed' || session.failure !== null);

export async function restartAgent(ports: AgentOpsPorts, agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' } | { ok: true; kind: 'fresh'; discarded: string | null } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const plan = restartPlan(kind, { threadId: record.threadId, wedged: isWedged(ports.host.probe(record.id)) });
    if (!plan.ok) return plan;
    /*
     * STOP, THEN START — IN THAT ORDER (hosting plan 1.3). Both used to run in the same tick, so the new provider started
     * while the old one was still alive: two Claudes on one conversation. The new run starts only once the old one has
     * ended (its grace, its kill, a fresh reading); a stop that left processes running refuses the restart, naming them,
     * BEFORE a fresh restart discards the thread.
     */
    ports.host.stop(record.id);
    const verdict = (await ports.host.ended?.(record.id)) ?? null;
    if (verdict && !verdict.verified && verdict.survivors.length > 0) {
        return { ok: false, reason: `${record.name}'s previous run did not end, so it was not started again: ${verdict.reason}` };
    }
    if (plan.kind === 'graceful') {
        const started = ports.host.start(record, ports.cwdFor(record));
        return started.ok ? { ok: true, kind: 'graceful' } : started;
    }
    const cleared = await ports.registry.clearThread(record.id);
    if (!cleared) return UNKNOWN;
    const started = ports.host.start(cleared, ports.cwdFor(cleared));
    return started.ok ? { ok: true, kind: 'fresh', discarded: plan.discards } : started;
}

function planFor(ports: AgentOpsPorts, record: AgentRecord, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): { ok: true; plan: DeletePlan } | Refusal {
    try {
        return { ok: true, plan: deletePlan({ outcome, agentName: record.name, personaDir: `.agents/${record.name}`, linkedSystems: ports.linkedSystems(record), alsoRemoveFrom }) };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** What a delete WOULD do — shown before the person confirms. Touches nothing. */
export async function previewDelete(ports: AgentOpsPorts, agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    return planFor(ports, record, outcome, alsoRemoveFrom);
}

export async function deleteAgent(ports: AgentOpsPorts, agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const planned = planFor(ports, record, outcome, alsoRemoveFrom);
    if (!planned.ok) return planned;
    ports.host.stop(record.id);
    await ports.registry.forget(record.id);
    if (outcome === 'delete') {
        const workspace = ports.workspacePathFor(record);
        if (workspace) await ports.removeDir(join(workspace, '.agents', record.name));
        await ports.removeHandoff(record);
    }
    return planned;
}

export async function switchDriver(ports: AgentOpsPorts, agentId: string, to: string): Promise<SwitchDecision> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    if (!isAcpProvider(to)) return { ok: false, reason: `Genie cannot run a "${to}" agent; the providers it knows are ${ACP_PROVIDERS.join(', ')}` };
    const manifest = parseAgentManifest(await ports.readManifest(record), record.name);
    const decision = switchDriverDecision(manifest, record.provider, to, 'user');
    if (!decision.ok || decision.noop) return decision;
    ports.host.stop(record.id);
    const switched = await ports.registry.setProvider(record.id, to);
    return switched.ok ? decision : switched;
}

export async function setBudget(ports: AgentOpsPorts, agentId: string, dailyLimitUsd: number | null): Promise<{ ok: true; record: AgentRecord; decision: BudgetDecision } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setBudget(record.id, dailyLimitUsd);
    if (!updated) return UNKNOWN;
    const session = ports.host.probe(record.id);
    // No provider reports a cost over ACP today, so a dollar budget is UNENFORCEABLE — said, not silent.
    const decision = budgetDecision({ dailyLimitUsd, spentTodayUsd: 0, turnInFlight: session?.turnState === 'working', costReported: false, agentName: record.name });
    return { ok: true, record: updated, decision };
}

/** Mode is wording for the agent, not a permission boundary (§6.2). */
export async function setMode(ports: AgentOpsPorts, agentId: string, mode: AgentRecord['mode']): Promise<{ ok: true; record: AgentRecord } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setMode(record.id, mode);
    return updated ? { ok: true, record: updated } : UNKNOWN;
}

/**
 * What a CLAUDE agent may do: all tools, ask the person before shell commands, or edits only (shell refused).
 * Codex asks in the chat for each approval, so it has no such setting. Applies when the session next starts.
 */
export async function setPermissions(ports: AgentOpsPorts, agentId: string, permissions: AgentPermissions): Promise<{ ok: true; record: AgentRecord; apply: ApplyWhen } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    if (record.provider !== 'claude') return { ok: false, reason: `${record.name} runs on ${record.provider}; Codex asks in the chat for each approval, so it has no tool setting` };
    const updated = await ports.registry.setPermissions(record.id, permissions);
    return updated ? { ok: true, record: updated, apply: ports.applyOnStart?.(record.id) ?? { when: 'next-start' } } : UNKNOWN;
}

/**
 * The model an agent's provider starts with — any provider; `null` clears it (back to the provider's default). Which
 * names a provider accepts is the provider's call: Genie refuses only what cannot be a model name — empty, or a
 * leading `-` that would read as a flag on the command line.
 *
 * A RUNNING agent is switched where it runs (prism-acp 0.22 `setModel`): no restart, same conversation — Claude's CLI
 * at once, Codex from its next turn. Back to the default switches it to the entry the provider marks default. A
 * provider that refuses the model is said in its words and the choice is NOT kept: the next start would only be refused
 * again. Where nothing can switch live (not running, a driver without setModel) the choice is kept and applies the old
 * way (`applyOnStart`: a restart on the same conversation when that costs nothing, else the next start).
 */
export async function setModel(ports: AgentOpsPorts, agentId: string, model: string | null): Promise<{ ok: true; record: AgentRecord; apply: ApplyWhen } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const name = model === null ? null : model.trim();
    if (name !== null && name.length === 0) return { ok: false, reason: 'a model needs a name — choose the default to clear it' };
    if (name !== null && name.startsWith('-')) return { ok: false, reason: `"${name}" is not a model name — it would read as a command-line flag` };
    const target = name ?? (await defaultModelOf(ports, record));
    const switching = target === null ? null : ports.host.switchModel?.(record.id, target) ?? null;
    if (switching) {
        try {
            await switching;
        } catch (error) {
            return { ok: false, reason: `${record.name}'s provider would not switch to "${target}": ${error instanceof Error ? error.message : String(error)}` };
        }
        const switched = await ports.registry.setModel(record.id, name);
        return switched ? { ok: true, record: switched, apply: { when: 'switched', timing: switchTiming(record.provider) } } : UNKNOWN;
    }
    const updated = await ports.registry.setModel(record.id, name);
    return updated ? { ok: true, record: updated, apply: ports.applyOnStart?.(record.id) ?? { when: 'next-start' } } : UNKNOWN;
}

/** The running session's DEFAULT entry, for "back to the default" on a live switch; `null` when it cannot say. */
async function defaultModelOf(ports: AgentOpsPorts, record: AgentRecord): Promise<string | null> {
    const live = ports.host.modelState?.(record.id) ?? null;
    if (!live) return null;
    try {
        return (await live).availableModels.find((m) => m.isDefault === true)?.modelId ?? null;
    } catch {
        return null;
    }
}

/**
 * THE MODELS AN AGENT CAN BE GIVEN — the provider's own list (the owner, 2026-10-21: "make sure that the model selection
 * for agents is using actual available options from the providers"). A running agent's session answers for itself
 * (`modelState`: no extra process, and `current` is the model it runs on); otherwise, or when it cannot say, the
 * provider's CLI is asked once and kept (`refresh` asks again).
 */
export async function listModels(ports: AgentOpsPorts, agentId: string, refresh = false): Promise<ModelChoices | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const live = ports.host.modelState?.(record.id) ?? null;
    if (live) {
        try {
            const state = await live;
            if (state.availableModels.length > 0) return { ok: true, provider: record.provider, source: 'session', models: state.availableModels, current: state.currentModelId };
        } catch {
            // The session could not say (an older CLI, a refused model/list): the provider's CLI is asked below instead.
        }
    }
    if (!ports.models) return { ok: false, provider: record.provider, reason: 'this Genie cannot ask a provider for its models' };
    return ports.models.get(record.provider, { refresh });
}

/**
 * APPLYING A START-TIME SETTING TO A RUNNING AGENT (`applyWhen` in core/agent-ops). `requested` restarts at once when
 * that costs nothing, and otherwise remembers the agent; `changed` — called on every change to the agent's session —
 * restarts it the first time it is free. One restart per request, however many changes follow: the pending entry is
 * dropped BEFORE the restart, so the restart's own events find nothing to do.
 *
 * The restart is graceful (the same conversation); an agent that has never been prompted has no conversation to lose,
 * so a plain stop and start is the same thing.
 */
export class SettingApplier {
    readonly #ports: AgentOpsPorts;
    readonly #shellsRunning: (id: AgentRecord['id']) => number;
    readonly #pending = new Set<AgentRecord['id']>();

    constructor(ports: AgentOpsPorts, shellsRunning: (id: AgentRecord['id']) => number) {
        this.#ports = ports;
        this.#shellsRunning = shellsRunning;
    }

    requested(id: AgentRecord['id']): ApplyWhen {
        const decision = this.#decide(id);
        if (decision.when === 'now') {
            this.#pending.delete(id);
            void this.#restart(id);
        } else if (decision.when === 'next-start') {
            this.#pending.delete(id);
        } else {
            this.#pending.add(id);
        }
        return decision;
    }

    changed(id: AgentRecord['id']): void {
        if (!this.#pending.has(id)) return;
        const decision = this.#decide(id);
        if (decision.when === 'next-start') { this.#pending.delete(id); return; }
        if (decision.when !== 'now') return;
        this.#pending.delete(id);
        void this.#restart(id);
    }

    /** Waiting to apply — for the view to say so. */
    pending(id: AgentRecord['id']): boolean {
        return this.#pending.has(id);
    }

    #decide(id: AgentRecord['id']): ApplyWhen {
        return applyWhen(this.#ports.host.probe(id), this.#shellsRunning(id));
    }

    async #restart(id: AgentRecord['id']): Promise<void> {
        const record = this.#ports.registry.find(id);
        if (!record) return;
        await restartAgent(this.#ports, record.id, record.threadId === null ? 'fresh' : 'graceful');
    }
}

/** The agent's own half of who may message it (§6.4). */
/** Autonomous or asked (Tynn #801): applies to its NEXT gated action — nothing restarts. */
export async function setAutoApprove(ports: AgentOpsPorts, agentId: string, autoApprove: boolean): Promise<{ ok: true; record: AgentRecord } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setAutoApprove(record.id, autoApprove);
    return updated ? { ok: true, record: updated } : UNKNOWN;
}

/** May manage the workspace's tabs (beta.35 item 36): the tool is in or out of its next tools/list — nothing restarts. */
export async function setManageTabs(ports: AgentOpsPorts, agentId: string, manageTabs: boolean): Promise<{ ok: true; record: AgentRecord } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setManageTabs(record.id, manageTabs);
    return updated ? { ok: true, record: updated } : UNKNOWN;
}

/** May drive pages (browser rebuild step 7): the page tool is in or out of its next tools/list — nothing restarts. */
export async function setDrivePages(ports: AgentOpsPorts, agentId: string, drivePages: boolean): Promise<{ ok: true; record: AgentRecord } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setDrivePages(record.id, drivePages);
    return updated ? { ok: true, record: updated } : UNKNOWN;
}

/**
 * What the agent hears from IssueWatch (Tynn #806): checked before it is kept — a delivery Genie knows and kinds it
 * knows — and refused with the reason otherwise. Applies to the next thing IssueWatch has to say; nothing restarts.
 */
export async function setIssueWatch(ports: AgentOpsPorts, agentId: string, raw: unknown): Promise<{ ok: true; record: AgentRecord } | Refusal> {
    const setting = parseIssueWatchSetting(raw);
    if (typeof setting === 'string') return { ok: false, reason: setting };
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setIssueWatch(record.id, setting);
    return updated ? { ok: true, record: updated } : UNKNOWN;
}

export async function setAccessScope(ports: AgentOpsPorts, agentId: string, scope: AgentRecord['accessScope']): Promise<{ ok: true; record: AgentRecord } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const updated = await ports.registry.setAccessScope(record.id, scope);
    return updated ? { ok: true, record: updated } : UNKNOWN;
}

export async function diagnose(ports: AgentOpsPorts, agentId: string): Promise<{ ok: true; diagnosis: Diagnosis } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const probe = ports.host.probe(record.id);
    const session: Parameters<typeof diagnoseAgent>[0]['session'] =
        probe === null ? null
        : probe.failure !== null || probe.turnState === 'failed' ? { state: 'crashed', exitCode: null }
        : probe.turnState === 'unknown' ? { state: 'starting', sinceMs: probe.startedAt === null ? 0 : Date.now() - probe.startedAt }
        : { state: 'running' };
    return {
        ok: true,
        diagnosis: diagnoseAgent({
            threadId: record.threadId,
            lastUsedAt: record.lastUsedAt,
            session,
            providerInstalled: ports.providerInstalled(record.provider),
            signedIn: ports.signedIn(record.provider),
            provider: record.provider,
        }),
    };
}
