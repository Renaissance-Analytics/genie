import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CARRY_OVER_BYTES, CARRY_OVER_ROWS } from '../core/carry-over.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { sessionHostPort, type AgentOpsHostEngine } from './agent-ops-host-port.js';
import { deleteAgent, diagnose, listModels, previewDelete, restartAgent, setAccessAgents, setAccessScope, setAutoApprove, setBudget, setDrivePages, setIssueWatch, setManageTabs, setMode, setModel, setPermissions, switchDriver, type AgentOpsPorts } from './agent-ops-host.js';
import type { AgentEngine } from './agent-engine.js';
import type { Finished } from './attention-store.js';
import type { HostApiDeps } from './host-api.js';
import type { Registry } from './registry.js';

/**
 * AGENT OPERATIONS, ONE WIRING FOR EVERY PROCESS THAT ANSWERS THEM (Tynn #553, host split P5d.5a).
 *
 * The window and genie-host answer the same `agents.*` calls with the same operations (agent-ops-host.ts). What differs is
 * where the registry, the session host and the model list come from, so those are the only things each one passes. A Pilot
 * with every window closed gets exactly what a window gives it, because there is no second copy to drift.
 */

/** What a process answering agent operations needs of its session host. */
export type AgentOpsEngine = AgentOpsHostEngine & Pick<AgentEngine, 'prompt' | 'historyRows'>;

export interface AgentOpsWiring {
    registry(): Registry | null;
    engine(): AgentOpsEngine | null;
    /** Each provider's models, asked of the CLI an agent of it launches with, once, kept until Refresh. */
    readonly models: AgentOpsPorts['models'];
    readonly cwdFor: AgentOpsPorts['cwdFor'];
    readonly startRefusal: AgentOpsPorts['startRefusal'];
    /** The finished items in attention: how a handoff asked for before a delete is seen to have landed. */
    finished(): readonly Finished[];
    readonly providerInstalled: AgentOpsPorts['providerInstalled'];
    readonly applyOnStart?: AgentOpsPorts['applyOnStart'];
}

export function agentOpsPorts(wiring: AgentOpsWiring): AgentOpsPorts {
    const registry = () => wiring.registry()!;
    const workspaceOf = (record: AgentRecord) => wiring.registry()?.snapshot().workspaces?.find((w) => w.id === record.workspaceId)?.path ?? null;
    return {
        registry: {
            find: (id) => wiring.registry()?.find(id as AgentId) ?? null,
            forget: (id) => registry().forget(id),
            clearThread: (id) => registry().clearThread(id),
            setProvider: (id, provider, options) => registry().setProvider(id, provider, options),
            setBudget: (id, usd) => registry().setBudget(id, usd),
            setMode: (id, mode) => registry().setMode(id, mode),
            setAccessScope: (id, scope) => registry().setAccessScope(id, scope),
            setAccessAgents: (id, ids) => registry().setAccessAgents(id, ids),
            setAutoApprove: (id, on) => registry().setAutoApprove(id, on),
            setManageTabs: (id, on) => registry().setManageTabs(id, on),
            setDrivePages: (id, on) => registry().setDrivePages(id, on),
            setIssueWatch: (id, setting) => registry().setIssueWatch(id, setting),
            setPermissions: (id, permissions) => registry().setPermissions(id, permissions),
            setModel: (id, model) => registry().setModel(id, model),
        },
        // The real session host (agent-ops-host-port.ts — the same wiring the restart tests drive).
        host: sessionHostPort(wiring.engine),
        ...(wiring.models ? { models: wiring.models } : {}),
        cwdFor: wiring.cwdFor,
        workspacePathFor: workspaceOf,
        readManifest: async (record) => {
            const workspace = workspaceOf(record);
            if (!workspace) return null;
            try {
                return await readFile(join(workspace, record.instructions ?? join('.agents', record.name, 'AGENT.md')), 'utf8');
            } catch {
                return null;
            }
        },
        // What a provider switch carries (Tynn story #380): the agent's rows, asked of the agent host, which reads its own store.
        history: async (record) => {
            const engine = wiring.engine();
            return engine ? (await engine.historyRows(record.id, { limit: CARRY_OVER_ROWS, maxBytes: CARRY_OVER_BYTES })).rows : [];
        },
        removeDir: (path) => rm(path, { recursive: true, force: true }),
        realPath: async (path) => { try { return await realpath(path); } catch { return null; } },
        // Ask for a handoff before an unmount/delete: Genie asks, the agent's imDone lands in attention; 45 s, as Genie 1.
        handoff: {
            ask: (id, text) => wiring.engine()?.prompt(id, text, 'genie') ?? false,
            landedSince: (id, since) => wiring.finished().some((f) => f.agentId === id && f.handoff !== null && Date.parse(f.at) >= since),
            now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            waitMs: 45_000,
            pollMs: 1_000,
        },
        removeHandoff: async (record) => {
            const workspace = workspaceOf(record);
            if (workspace) await rm(join(workspace, '.ai', 'handoff', `${record.name}.md`), { force: true });
        },
        linkedSystems: () => [],
        providerInstalled: wiring.providerInstalled,
        signedIn: () => true,
        ...(wiring.applyOnStart ? { applyOnStart: wiring.applyOnStart } : {}),
        startRefusal: wiring.startRefusal,
    };
}

/** The host API's `agents.*`, over those ports. Every write refreshes what clients see the moment it ends (`touch`). */
export function agentOpsApi(ops: AgentOpsPorts, touch: () => void, engine: () => Pick<AgentEngine, 'toolOutput'> | null): HostApiDeps['agentOps'] {
    return {
        restart: (id, kind) => restartAgent(ops, id, kind).finally(touch),
        previewDelete: (id, outcome, also) => previewDelete(ops, id, outcome, also),
        delete: (id, outcome, also, handoff) => deleteAgent(ops, id, outcome, also, { handoff }).finally(touch),
        switchDriver: (id, to) => switchDriver(ops, id, to).finally(touch),
        setBudget: (id, usd) => setBudget(ops, id, usd).finally(touch),
        setMode: (id, mode) => setMode(ops, id, mode).finally(touch),
        setAccessScope: (id, scope) => setAccessScope(ops, id, scope).finally(touch),
        setAccessAgents: (id, ids) => setAccessAgents(ops, id, ids).finally(touch),
        setAutoApprove: (id, on) => setAutoApprove(ops, id, on).finally(touch),
        setManageTabs: (id, on) => setManageTabs(ops, id, on).finally(touch),
        setDrivePages: (id, on) => setDrivePages(ops, id, on).finally(touch),
        setIssueWatch: (id, setting) => setIssueWatch(ops, id, setting).finally(touch),
        setPermissions: (id, permissions) => setPermissions(ops, id, permissions).finally(touch),
        setModel: (id, model) => setModel(ops, id, model).finally(touch),
        models: (id, refresh) => listModels(ops, id, refresh),
        diagnose: (id) => diagnose(ops, id),
        // A tool row's whole output, read by the agent host from its own store (Tynn story #386).
        toolOutput: (id, toolCallId) => engine()?.toolOutput(id as AgentId, toolCallId) ?? Promise.resolve({ ok: false as const, reason: 'Genie’s agents are not running yet' }),
    };
}
