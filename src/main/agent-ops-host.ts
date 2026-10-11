import { join } from 'node:path';
import { parseAgentManifest } from '../core/agent-manifest.js';
import { budgetDecision, deletePlan, restartPlan, switchDriverDecision, type BudgetDecision, type DeletePlan, type SwitchDecision } from '../core/agent-ops.js';
import { ACP_PROVIDERS, isAcpProvider, type AcpProvider } from '../core/engine.js';
import type { AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
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
    };
    host: {
        start(record: AgentRecord, cwd: string): { ok: true } | { ok: false; reason: string };
        stop(id: AgentRecord['id']): boolean;
        probe(id: AgentRecord['id']): LiveSession | null;
    };
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
}

type Refusal = { ok: false; reason: string };
const UNKNOWN: Refusal = { ok: false, reason: 'unknown agent' };

const isWedged = (session: LiveSession | null): boolean => session !== null && (session.turnState === 'failed' || session.failure !== null);

export async function restartAgent(ports: AgentOpsPorts, agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' } | { ok: true; kind: 'fresh'; discarded: string | null } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const plan = restartPlan(kind, { threadId: record.threadId, wedged: isWedged(ports.host.probe(record.id)) });
    if (!plan.ok) return plan;
    ports.host.stop(record.id);
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

/** The agent's own half of who may message it (§6.4). */
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
