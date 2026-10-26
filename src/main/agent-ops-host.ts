import { permissionDecisionFor } from '../core/agent-ops.js';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseAgentManifest } from '../core/agent-manifest.js';
import { applyWhen, budgetDecision, deletePlan, restartPlan, RESUME_AFTER_USER_RESTART, switchDriverDecision, type ApplyWhen, type BudgetDecision, type DeletePlan, type SwitchDecision } from '../core/agent-ops.js';
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
 * RESTART (`restartAgent(…, 'graceful')`) is THE ONE ACTION every Restart and Start control calls (genie#1238): it works
 * from every state and delivers what the agent is owed; `fresh` clears the thread on purpose. Delete is PREVIEWED
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
        setProvider(id: AgentRecord['id'], provider: AcpProvider, options: { keepModel: boolean }): Promise<{ ok: true; record: AgentRecord } | { ok: false; reason: string }>;
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
        /**
         * How the last stop ended, once it has (`SessionHost.ended`): a restart starts only after it. REQUIRED: it was
         * optional, main.ts never passed it, and every restart inside Claude's stop grace was refused "still stopping".
         */
        ended(id: AgentRecord['id']): Promise<StopVerdict | null>;
        probe(id: AgentRecord['id']): LiveSession | null;
        /** The running agent's own models (`SessionHost.modelState`): `null` = not running, or its driver cannot say. */
        modelState?(id: AgentRecord['id']): Promise<SessionModelState> | null;
        /** Switch the running agent's model, no restart (`SessionHost.switchModel`): `null` = not running, or it cannot. */
        switchModel?(id: AgentRecord['id'], model: string): Promise<void> | null;
        /** Answer a parked shell question by the new tool setting (`SessionHost.settleParked`): `false` = none parked. */
        settleParked?(id: AgentRecord['id'], decision: 'allow' | 'deny'): boolean;
        /**
         * WHAT A RESTART OWES (`SessionHost.deliverOwed`, genie#1238): every prompt of this agent's record that was never
         * delivered — the resume prompt of an interrupted turn, the person's drafts — handed to the new run, in the order
         * written, each once; `then`, when given, after them (the word to carry on, when the Restart cut a turn). Resolves
         * to how many were handed over. REQUIRED, as `ended` is: a port that forgot it would restart agents and quietly owe
         * them their work again.
         */
        deliverOwed(id: AgentRecord['id'], then?: { text: string; by: string }): Promise<number>;
    };
    /**
     * WHY A START WOULD BE REFUSED (§6.1, main.ts's `startRefusal`): an asleep workspace, the agent cap — what Start
     * always obeyed, now that Start is the restart. `null` = it may start. Asked only for an agent that is not running.
     */
    startRefusal(record: AgentRecord): string | null;
    /** Each provider's model list, asked of its CLI once and kept (core/provider-models.ts `ProviderModelCache`). */
    models?: { get(provider: string, options?: { refresh?: boolean }): Promise<ModelChoices> };
    cwdFor(record: AgentRecord): string;
    workspacePathFor(record: AgentRecord): string | null;
    /** The persona file's text, or `null` when there is none. */
    readManifest(record: AgentRecord): Promise<string | null>;
    removeDir(path: string): Promise<void>;
    /** Where `path` really is on disk, symlinks followed (`fs.realpath`); `null` when nothing is there. */
    realPath(path: string): Promise<string | null>;
    removeHandoff(record: AgentRecord): Promise<void>;
    /**
     * Asking a running agent for a handoff before it is unmounted or deleted (Genie 1's AgentDeleteModal): the ask is a
     * prompt; `landedSince` is whether its `imDone` handoff arrived at or after `sinceMs`; the wait is bounded by `waitMs`.
     */
    handoff: {
        ask(id: AgentRecord['id'], text: string): boolean;
        landedSince(id: AgentRecord['id'], sinceMs: number): boolean;
        now(): number;
        sleep(ms: number): Promise<void>;
        waitMs: number;
        pollMs: number;
    };
    /** Systems this agent is registered with beyond Genie (Tynn, …) — listed in the delete plan, kept unless opted in. */
    linkedSystems(record: AgentRecord): string[];
    providerInstalled(provider: string): boolean;
    signedIn(provider: string): boolean;
    /** A setting read at start changed: when it takes effect (`SettingApplier.requested`). Absent = the next start, said so. */
    applyOnStart?(id: AgentRecord['id']): ApplyWhen;
}

type Refusal = { ok: false; reason: string };
const UNKNOWN: Refusal = { ok: false, reason: 'unknown agent' };

/**
 * RESTART — THE ONE ACTION (genie#1238; the owner, 2026-10-26: "We have so many restart buttons across so many views and
 * some of them don't even work at all"). The Agent view's Restart and Start, the Dashboard's, the chat's, the phone's,
 * Try again on a paused account, a sign-in, "Restart with this", a missing MCP server: all of them call this, with
 * `graceful`, and it works from every state —
 *
 * - running (idle or mid-turn): stopped, and started again on its conversation;
 * - Broken (a crash, a failed preparation): started again on its conversation. It used to be REFUSED here ("only a fresh
 *   restart reaches a wedged agent") — and Broken was the only state the header's and the Dashboard's Restart were drawn in;
 * - stopped, or its run ended: started on its conversation; never started: started on its first;
 * - an asleep workspace or a full agent cap refuses a start, by name, as Start always did (`startRefusal`).
 *
 * After a start that went ahead it DELIVERS WHAT IS OWED (`deliverOwed`): the resume prompt Genie wrote for an
 * interrupted turn and the person's undelivered drafts, in order, once (the owner's beta.45 agents: the resume prompt was
 * recorded `undelivered` and never sent). `fresh` is the separate, named operation that drops the conversation.
 */
export async function restartAgent(ports: AgentOpsPorts, agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' } | { ok: true; kind: 'fresh'; discarded: string | null } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const plan = restartPlan(kind, { threadId: record.threadId });
    if (!plan.ok) return plan;
    const before = ports.host.probe(record.id);
    // A turn this Restart is about to cut short: the agent is told so once it is back (Genie 1 told every relaunch).
    const cutsTurn = before?.running === true && before.turnState === 'working';
    // A running agent is already counted in its workspace's cap and is plainly awake: only a START is asked.
    if (before?.running !== true) {
        const refused = ports.startRefusal(record);
        if (refused !== null) return { ok: false, reason: refused };
    }
    /*
     * STOP, THEN START — IN THAT ORDER (hosting plan 1.3). Both used to run in the same tick, so the new provider started
     * while the old one was still alive: two Claudes on one conversation. The new run starts only once the old one has
     * ended (its grace, its kill, a fresh reading); a stop that left processes running refuses the restart, naming them,
     * BEFORE a fresh restart discards the thread.
     */
    ports.host.stop(record.id);
    const verdict = await ports.host.ended(record.id);
    if (verdict && !verdict.verified && verdict.survivors.length > 0) {
        return { ok: false, reason: `${record.name}'s previous run did not end, so it was not started again: ${verdict.reason}` };
    }
    if (plan.kind === 'graceful') {
        const started = ports.host.start(record, ports.cwdFor(record));
        if (!started.ok) return started;
        await ports.host.deliverOwed(record.id, cutsTurn ? { text: RESUME_AFTER_USER_RESTART, by: 'genie' } : undefined);
        return { ok: true, kind: 'graceful' };
    }
    /*
     * FRESH: THE CONVERSATION IS DROPPED ONLY BY A START THAT WENT AHEAD. The new run starts on the record with no thread;
     * the stored thread is cleared only once that start was taken. A refused start (a missing folder, a hold, leftovers)
     * leaves the conversation exactly as it was — it used to be cleared first, so a refused start lost it and started
     * nothing. Nothing can record the new run's thread before the clear: `onThreadId` fires from a provider update, never
     * inside `start()`, and `clearThread` changes the in-memory record before its first await — no await comes between.
     */
    const started = ports.host.start({ ...record, threadId: null }, ports.cwdFor(record));
    if (!started.ok) return started;
    const cleared = ports.registry.clearThread(record.id);
    return (await cleared) ? { ok: true, kind: 'fresh', discarded: plan.discards } : UNKNOWN;
}

function planFor(ports: AgentOpsPorts, record: AgentRecord, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): { ok: true; plan: DeletePlan } | Refusal {
    try {
        return { ok: true, plan: deletePlan({ outcome, agentName: record.name, personaDir: `.agents/${record.name}`, linkedSystems: ports.linkedSystems(record), alsoRemoveFrom }) };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** `candidate` strictly below `root` — not `root` itself, not beside it, not on another drive. */
function strictlyInside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * THE FOLDER A DELETE MAY REMOVE (Genie 1's `resolveAgentDeletion`, main/agents/deletion.ts). Delete is `rm -rf`, so
 * the persona folder must be strictly inside the workspace's `.agents/` — by its name (`..`, `.`, an empty name would
 * be the workspace or every agent's files) AND where it really is on disk (a symlinked folder is judged at its
 * target). Anything else is REFUSED before the agent is stopped or forgotten, so a refused delete has changed nothing.
 * Genie 1 quietly kept the files and deleted the record; here the person is told and can unmount instead. A folder
 * already gone is nothing to remove and no reason to refuse. `null` folder = no workspace: nothing on disk to remove.
 */
async function personaFolderToRemove(ports: AgentOpsPorts, record: AgentRecord): Promise<{ ok: true; folder: string | null } | Refusal> {
    const workspace = ports.workspacePathFor(record);
    if (!workspace) return { ok: true, folder: null };
    const agentsDir = join(workspace, '.agents');
    const folder = join(agentsDir, record.name);
    const refuse = (where: string): Refusal => ({ ok: false, reason: `${record.name}'s folder ${where} is not inside ${agentsDir}, so Genie will not delete it — unmount the agent instead, which removes no file` });
    if (!strictlyInside(resolve(agentsDir), resolve(folder))) return refuse(resolve(folder));
    const real = await ports.realPath(folder);
    if (real === null) return { ok: true, folder };
    const realAgentsDir = (await ports.realPath(agentsDir)) ?? resolve(agentsDir);
    if (!strictlyInside(realAgentsDir, real)) return refuse(`(really ${real})`);
    return { ok: true, folder };
}

/** What a delete WOULD do — shown before the person confirms. Touches nothing; a folder delete may not remove is refused here too. */
export async function previewDelete(ports: AgentOpsPorts, agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    if (outcome === 'delete') {
        const folder = await personaFolderToRemove(ports, record);
        if (!folder.ok) return folder;
    }
    return planFor(ports, record, outcome, alsoRemoveFrom);
}

/** How the handoff ask went: `landed` in time, `missing` (asked, none in time), `not-running` (nobody to ask), `not-asked`. */
export type HandoffAsk = 'landed' | 'missing' | 'not-running' | 'not-asked';

const HANDOFF_BEFORE = (outcome: 'unmount' | 'delete') =>
    `You are about to be ${outcome === 'delete' ? 'deleted from this workspace' : 'unmounted from Genie'}: call imDone with a handoff now — what you were doing, what is unfinished, what the next run picks up. You will be stopped shortly.`;

/**
 * ASK FOR A HANDOFF FIRST (Genie 1's AgentDeleteModal; the owner, 2026-10-21: "I need to be able to purge an agent from
 * a workspace or detach it"). A running agent is asked to `imDone` with a handoff and given a BOUNDED wait — the
 * hibernate flow's ask (workspace-ops-host) for one agent. It never blocks the delete: no note in time is `missing`.
 */
async function askForHandoff(ports: AgentOpsPorts, record: AgentRecord, outcome: 'unmount' | 'delete'): Promise<HandoffAsk> {
    if (ports.host.probe(record.id)?.running !== true) return 'not-running';
    const since = ports.handoff.now();
    if (!ports.handoff.ask(record.id, HANDOFF_BEFORE(outcome))) return 'missing';
    const deadline = since + ports.handoff.waitMs;
    while (!ports.handoff.landedSince(record.id, since)) {
        if (ports.handoff.now() >= deadline) return 'missing';
        await ports.handoff.sleep(ports.handoff.pollMs);
    }
    return 'landed';
}

export async function deleteAgent(ports: AgentOpsPorts, agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[], options: { handoff?: boolean } = {}): Promise<{ ok: true; plan: DeletePlan; handoff: HandoffAsk } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    const planned = planFor(ports, record, outcome, alsoRemoveFrom);
    if (!planned.ok) return planned;
    // Checked BEFORE the stop: a refused delete leaves the agent running and registered, exactly as it was.
    const folder = outcome === 'delete' ? await personaFolderToRemove(ports, record) : ({ ok: true, folder: null } as const);
    if (!folder.ok) return folder;
    const handoff = options.handoff === true ? await askForHandoff(ports, record, outcome) : 'not-asked';
    ports.host.stop(record.id);
    await ports.registry.forget(record.id);
    // A handoff asked for and written is the one thing a delete keeps: Genie 1's "that note survives even though its
    // .agents/ files do not". Without a fresh one, an old note goes with the agent as before.
    const keepNote = handoff === 'landed';
    if (outcome === 'delete') {
        if (folder.folder) await ports.removeDir(folder.folder);
        if (!keepNote) await ports.removeHandoff(record);
    }
    const plan = keepNote && outcome === 'delete'
        ? { ...planned.plan, removes: planned.plan.removes.filter((r) => r !== STORED_HANDOFF), keeps: [...planned.plan.keeps, STORED_HANDOFF] }
        : planned.plan;
    return { ok: true, plan, handoff };
}

/** The delete plan's own words for the handoff note (core/agent-ops `deletePlan`). */
const STORED_HANDOFF = 'its stored handoff';

export async function switchDriver(ports: AgentOpsPorts, agentId: string, to: string): Promise<SwitchDecision> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    if (!isAcpProvider(to)) return { ok: false, reason: `Genie cannot run a "${to}" agent; the providers it knows are ${ACP_PROVIDERS.join(', ')}` };
    const manifest = parseAgentManifest(await ports.readManifest(record), record.name);
    const decision = switchDriverDecision(manifest, record.provider, to, 'user');
    if (!decision.ok || decision.noop) return decision;
    /*
     * A CLEAN START ON THE NEW PROVIDER (the owner, 2026-10-21: "I need to be able to change provider as well as model").
     * The old provider's conversation and model used to ride along — a Claude session id resumed on Codex, `opus` passed
     * to Codex. The conversation never carries (the registry drops it); the model carries only when the NEW provider's
     * own list has it. A provider that cannot say gets its default: Genie does not guess a model name.
     */
    const keepModel = record.model !== undefined && (await providerLists(ports, to, record.model));
    ports.host.stop(record.id);
    // Answered once the old provider has ended, so "Start it when ready" is true when it is said (not refused "still stopping").
    await ports.host.ended(record.id);
    const switched = await ports.registry.setProvider(record.id, to, { keepModel });
    if (!switched.ok) return switched;
    return { ...decision, discarded: record.threadId, droppedModel: record.model !== undefined && !keepModel ? record.model : null };
}

/** Whether `provider`'s own model list (asked of its CLI) names `model`. No list, or no way to ask, is `false`. */
async function providerLists(ports: AgentOpsPorts, provider: string, model: string): Promise<boolean> {
    if (!ports.models) return false;
    try {
        const choices = await ports.models.get(provider);
        return choices.ok && choices.models.some((m) => m.modelId === model);
    } catch {
        return false;
    }
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
 * Codex asks in the chat for each approval, so it has no such setting.
 *
 * LIVE, NOTHING RESTARTS (genie#1188): each shell call's question is answered from the setting at that moment
 * (session-host `claudeOptionsFor`), so saving it is enough. A shell command already parked on the person is answered
 * by the new setting at once — all tools → allowed, edits only → refused; ask leaves it waiting for the person.
 */
export async function setPermissions(ports: AgentOpsPorts, agentId: string, permissions: AgentPermissions): Promise<{ ok: true; record: AgentRecord; apply: ApplyWhen } | Refusal> {
    const record = ports.registry.find(agentId);
    if (!record) return UNKNOWN;
    if (record.provider !== 'claude') return { ok: false, reason: `${record.name} runs on ${record.provider}; Codex asks in the chat for each approval, so it has no tool setting` };
    const updated = await ports.registry.setPermissions(record.id, permissions);
    if (!updated) return UNKNOWN;
    const decision = permissionDecisionFor(permissions);
    if (decision !== 'ask') ports.host?.settleParked?.(record.id, decision);
    return { ok: true, record: updated, apply: { when: 'live' } };
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
