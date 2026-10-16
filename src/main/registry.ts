import { observedRowFor, type TakeOverProbe } from '../core/observed.js';
import { ACP_PROVIDERS, isAcpProvider } from '../core/engine.js';
import { OS_AGENT_NAME, agentRecord, mintAgentId, type AgentRecord, type AgentId, type AgentPermissions, threadIdIsResumable } from '../core/identity.js';
import { agentRowFor, type LiveSession } from '../core/roster.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { GenieSnapshot } from '../renderer/bridge.js';
import { Store, type WorkspaceRecord } from './store.js';
import { folderName } from '../core/workspace-name.js';

/**
 * THE REGISTRY — the main process's single answer to "what is going on".
 *
 * Records come from the `Store`; live state comes from whatever sessions are running; the
 * snapshot is the join. Every surface reads this one object, so there is one place for the
 * question and no second copy to disagree with it.
 *
 * ## Capacity is counted in SESSIONS, never in processes
 *
 * §2.5, and it is worth stating in the file that would otherwise be tempted. "3 of 5 running"
 * is a property of this map. **Never `ptys.length`, never a process scan.** The previous build
 * counted ptys, so removing ptys from agents broke fifty-two tests — a number that only looks
 * absurd until you notice what it means: fifty-two places had agreed that an agent's existence
 * was a terminal's existence.
 *
 * ## Push, never poll
 *
 * `onChange` fires when something actually changed. A renderer that polls is wrong for up to
 * its interval and, with thirty agents, reads this map a hundred times a minute to learn
 * nothing.
 */

/**
 * The OS agent's name and its non-workspace.
 *
 * `OS_WORKSPACE` is not a workspace anybody has and never appears in the rail: it exists so
 * the one agent that belongs to no workspace still has a well-formed record.
 */
export { OS_AGENT_NAME };
export const OS_WORKSPACE = '__genie__';

/** What the registry can see of a running session. Supplied by whatever owns the sessions. */
export type SessionProbe = (id: AgentId) => LiveSession | null;

export class Registry {
    readonly #store: Store;
    #workspaces: readonly WorkspaceRecord[] = [];
    #agents: readonly AgentRecord[] = [];
    #probe: SessionProbe = () => null;
    #observed: (id: AgentId) => TakeOverProbe | null = () => null;
    #listeners = new Set<(snapshot: GenieSnapshot) => void>();
    #recordListeners = new Set<(agentId: AgentId) => void>();
    #workstation: { name: string; healthy: boolean } | null = null;
    #signals: (() => SignalState) | null = null;
    #deckSource: () => readonly DeckItem[] = () => [];
    #runningAtQuit: AgentId[] = [];
    #interruptedAtQuit: AgentId[] = [];
    #loaded = false;
    /** The display name for a workspace path — the envelope's project.json name, supplied by the composition root; the folder until then. */
    #namer: (path: string) => string = (path) => folderName(path);

    constructor(store: Store) {
        this.#store = store;
    }

    /** Problems found while loading, for the surface to report rather than swallow. */
    readonly faults: string[] = [];

    async load(workstation: { name: string; healthy: boolean }): Promise<void> {
        this.#workspaces = await this.#store.readWorkspaces();
        this.#agents = await this.#store.readAgents();
        this.#runningAtQuit = (await this.#store.readRunningAtQuit()).filter((id): id is AgentId => this.#agents.some((a) => a.id === id));
        this.#interruptedAtQuit = (await this.#store.readInterruptedAtQuit()).filter((id): id is AgentId => this.#agents.some((a) => a.id === id));
        this.faults.push(...this.#store.dropped);
        this.#workstation = workstation;
        this.#loaded = true;

        await this.#seedOsAgent();
        this.#emit();
    }

    /**
     * The OS agent, seeded once.
     *
     * The rail carries a `genie` row unconditionally — *"the OS agent, always present"* — and
     * a row that navigates to an agent which does not exist lands on a not-found. That is the
     * same class of failure as a disabled control: the product offering something it cannot
     * deliver. So the record is real, has a real id, and persists like any other.
     *
     * Its `workspaceId` is `OS_WORKSPACE`, which is deliberately not a workspace anybody has.
     * It is *"the one agent that is not in a workspace"*, and filing it under a real one would
     * inflate that workspace's count — the group header's `4 agents` is a census people read.
     */
    async #seedOsAgent(): Promise<void> {
        if (this.#agents.some((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME)) return;

        const record = agentRecord({
            id: mintAgentId(),
            workspaceId: OS_WORKSPACE,
            provider: 'claude',
            name: OS_AGENT_NAME,
        });
        this.#agents = [...this.#agents, record];
        await this.#store.writeAgents(this.#agents);
    }

    /** How a workspace is NAMED in every surface: project.json's name, else the folder — never the id (beta.7 showed 26 ULIDs). */
    setWorkspaceNamer(namer: (path: string) => string): void {
        this.#namer = namer;
        if (this.#loaded) this.#emit();
    }

    /**
     * Everything else the Deck holds, from the composition root: questions agents asked (ForceTheQuestion), the things
     * only a person can do, unread mail to the person, finished agents, Genie's own tool approvals. The snapshot carried
     * only live sessions' permission requests, and this source was built and never read, so no question ever reached the
     * Deck (the owner, 2026-10-14).
     */
    setDeckSource(source: () => readonly DeckItem[]): void {
        this.#deckSource = source;
        if (this.#loaded) this.#emit();
    }

    /** The Deck's signal strip, MEASURED by the composition root; honest zeros until then. */
    setSignals(provider: () => SignalState): void {
        this.#signals = provider;
    }

    /** Who was RUNNING when Genie last closed (§7.6). What the user had stopped was not running, so it is never here. */
    runningAtQuit(): readonly AgentId[] {
        return this.#runningAtQuit;
    }

    async markRunningAtQuit(ids: readonly AgentId[]): Promise<void> {
        this.#runningAtQuit = ids.filter((id) => this.#agents.some((a) => a.id === id));
        await this.#store.writeRunningAtQuit(this.#runningAtQuit);
    }

    /** The agents a shutdown cut off mid-turn (written at quit or upgrade, before the sessions end). */
    async markInterruptedAtQuit(ids: readonly AgentId[]): Promise<void> {
        this.#interruptedAtQuit = ids.filter((id) => this.#agents.some((a) => a.id === id));
        await this.#store.writeInterruptedAtQuit(this.#interruptedAtQuit);
    }

    /** Read once and cleared, like the running set: a crash mid-resume prompts nobody twice. */
    async takeInterruptedAtQuit(): Promise<readonly AgentId[]> {
        const ids = this.#interruptedAtQuit;
        this.#interruptedAtQuit = [];
        await this.#store.writeInterruptedAtQuit([]);
        return ids;
    }

    /** Read once and cleared, so a crash mid-restore does not start anyone twice. */
    async takeRunningAtQuit(): Promise<readonly AgentId[]> {
        const ids = this.#runningAtQuit;
        this.#runningAtQuit = [];
        await this.#store.writeRunningAtQuit([]);
        return ids;
    }

    setProbe(probe: SessionProbe): void {
        this.#probe = probe;
    }

    /** What the Take Over host knows about an agent's TUI, or `null`. Drives the Observed row. */
    setObservedProbe(probe: (id: AgentId) => TakeOverProbe | null): void {
        this.#observed = probe;
    }

    /** Count of live sessions — the only correct source for "how many agents are running". */
    get runningCount(): number {
        return this.#agents.filter((a) => this.#probe(a.id)?.running === true).length;
    }

    snapshot(): GenieSnapshot {
        const now = () => Date.now();

        return {
            /**
             * The Dashboard's census — **workspace agents only**.
             *
             * The OS agent is deliberately excluded. It appears in no workspace group, so a
             * header chip counting it would read `1 working` with no working row anywhere to
             * account for it, and a number a reader cannot trace to a row is worse than no
             * number. It is reachable by its own route from the rail, and `find` still
             * resolves it.
             *
             * This was the other way round for one commit: seeding the OS agent into `agents`
             * broke six tests that asserted exact counts, and mass fixture churn is the signal
             * to suspect the guard rather than the fixtures. It was the guard.
             */
            agents: this.#agents
                .filter((record) => record.workspaceId !== OS_WORKSPACE)
                // An agent with a live Take Over is OBSERVED: Genie sees its bytes and nothing
                // else, and the row says so (§4.1). Otherwise the declared row as before.
                .map((record) => {
                    const observed = this.#observed(record.id);
                    return observed ? observedRowFor(record, observed, now()) : agentRowFor(record, this.#probe(record.id), now);
                }),
            // `agentsKnown` is TRUE only once the store has actually been read. Before that the
            // rail must render no counts at all: a `0` on first paint says "this workspace is
            // empty" when the truth is "nobody has looked yet".
            // `null` until the store has been read. Not `[]`: "we have not looked" and "there
            // are none" are different claims, and the Dashboard gives them different surfaces.
            workspaces: this.#loaded
                // `governs` / `governedBy` appear only when they carry something: every other workspace literal stays exact.
                ? this.#workspaces.map((w) => ({ id: w.id, path: w.path, name: this.#namer(w.path), agentsKnown: true, asleep: w.asleep === true, ...(w.governs && w.governs.length > 0 ? { governs: [...w.governs] } : {}), ...(this.governorOf(w.id) ? { governedBy: this.governorOf(w.id) } : {}) }))
                : null,
            /*
             * The attention band.
             *
             * Today it has ONE source: agents parked on an approval. The other three the design
             * names — user-list items, unread DMs, finished-with-handoff — need subsystems that
             * do not exist yet, and nothing here invents them. `null` before the store is read,
             * because an empty band is a claim that nothing needs you.
             */
            deckItems: this.#loaded ? this.#deckItems() : null,
            /*
             * Every signal false, and that is honest rather than lazy: Flows, AgentInbox and
             * the GitHub integration are not built, so none of them has anything to report. The
             * strip renders nothing, which is exactly what it should do when nothing is true.
             */
            signals: this.#signals?.() ?? { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
            workstation: this.#workstation,
        };
    }

    /**
     * Agents parked on an approval, as Deck items.
     *
     * `blocking: true` without exception — a parked approval means the agent has STOPPED. That
     * is the strongest claim the band can carry and it is literally true here.
     */
    /** Live sessions' permission requests, then everything the composition root's Deck source holds. */
    #deckItems(): readonly DeckItem[] {
        return [...this.#sessionApprovals(), ...this.#deckSource()];
    }

    #sessionApprovals(): DeckItem[] {
        return this.#agents.flatMap((record): DeckItem[] => {
            const live = this.#probe(record.id);
            const approval = live?.pendingApproval;
            if (!approval) return [];

            return [{
                id: `approval:${record.id}`,
                source: 'agent-question',
                agentId: record.id,
                agentName: record.name,
                workspaceId: record.workspaceId,
                title: approval.question,
                blocking: true,
                // The protocol carries no priority for a permission request, so this is NOT a
                // guess dressed as one: `normal` is the absence of a claim, and `blocking`
                // already carries the urgency that matters.
                priority: 'normal',
                at: live?.startedAt ?? 0,
                answer: { kind: 'inline', options: approval.options },
                // Cross-host forwarding needs remote workstations, which are not built. `null`
                // here means "raised locally", which is true of every approval today.
                forwardedFrom: null,
            }];
        });
    }

    subscribe(listener: (snapshot: GenieSnapshot) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Which agent's RECORD changed — a setting saved, its provider switched, its thread cleared. The
     * snapshot carries no detail, and the Agent view reads its settings from the agent's detail, so
     * whoever pushes details listens here as well as to the session host.
     */
    subscribeAgentRecords(listener: (agentId: AgentId) => void): () => void {
        this.#recordListeners.add(listener);
        return () => this.#recordListeners.delete(listener);
    }

    /** Call when live session state changed. The registry does not watch anything itself. */
    touch(): void {
        this.#emit();
    }

    async addWorkspace(workspace: WorkspaceRecord): Promise<void> {
        if (this.#workspaces.some((w) => w.id === workspace.id)) return;
        this.#workspaces = [...this.#workspaces, workspace];
        await this.#store.writeWorkspaces(this.#workspaces);
        this.#emit();
    }

    /**
     * Register an agent. **Consumes no resources** — no process, no session, no pty, nothing.
     *
     * §6.2 separates registering from starting on purpose: an identity should be creatable,
     * nameable and persistable without anything running, so that a workspace can be set up
     * before anyone is ready to spend a provider turn on it.
     */
    async register(input: { workspaceId: string; provider: AgentRecord['provider']; name: string; instructions?: string | null; sidecarOf?: AgentId }): Promise<AgentRecord> {
        const record = agentRecord({ id: mintAgentId(), ...input });
        this.#agents = [...this.#agents, record];
        await this.#store.writeAgents(this.#agents);
        this.#emit();
        return record;
    }

    /**
     * Write down the conversation a provider reported, so a restart can resume it.
     *
     * Until this existed the registry could create an agent and never update it again, so a
     * captured session id had nowhere to go: P1's *"the thread survives a restart"* held at the
     * session layer, where a `resumeSessionId` passed in is passed through, and nowhere else.
     * The app was asking the session to resume an id it had never kept, and every test about
     * resume passed.
     *
     * ## It guards, even though the caller already did
     *
     * `SessionHost` checks the same thing at ingest, which is the earlier and more important
     * place. This checks again because **this is the function that writes to disk**, and the
     * value is provider-supplied: prism-acp's only check on it is `typeof === 'string'`, and on
     * Windows it ends up in argv under `shell: true`, where cmd.exe interprets `&`, `|` and
     * `&&` inside arguments. A second caller added later would otherwise inherit a hole from a
     * guard it never knew about. Two checks, because the cost is a regex and the failure is
     * command execution.
     *
     * An unknown agent is REFUSED rather than created: a stale callback arriving after a delete
     * must not resurrect the agent as a record with a thread id and nothing else.
     */
    async recordThread(agentId: AgentId, threadId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (!threadIdIsResumable(threadId)) {
            return { ok: false, reason: `Refusing to store a thread id Genie will not pass to a provider: "${threadId}"` };
        }

        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return { ok: false, reason: `No agent ${agentId} to record a thread for.` };
        if (existing.threadId === threadId) return { ok: true }; // Already written; no disk churn.

        this.#agents = this.#agents.map((a) => (a.id === agentId ? { ...a, threadId } : a));
        await this.#store.writeAgents(this.#agents);
        this.#changed(existing.id);
        return { ok: true };
    }

    /** The OS agent's record. Always present after `load`. */
    osAgent(): AgentRecord | null {
        return this.#agents.find((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME) ?? null;
    }

    workspace(id: string): { id: string; path: string; asleep: boolean; governs: string[] } | null {
        const w = this.#workspaces.find((x) => x.id === id);
        return w ? { id: w.id, path: w.path, asleep: w.asleep === true, governs: [...(w.governs ?? [])] } : null;
    }

    /** OPS PROJECTS (§6.1): which workspaces `opsId` governs — known ids only, never itself. */
    async setGoverns(opsId: string, childIds: readonly string[]): Promise<{ ok: true; governs: string[] } | { ok: false; reason: string }> {
        if (!this.#workspaces.some((w) => w.id === opsId)) return { ok: false, reason: `no workspace "${opsId}"` };
        const governs = [...new Set(childIds)].filter((id) => id !== opsId && this.#workspaces.some((w) => w.id === id));
        this.#workspaces = this.#workspaces.map((w) => (w.id === opsId ? { ...w, governs } : w));
        await this.#store.writeWorkspaces(this.#workspaces);
        this.#emit();
        return { ok: true, governs };
    }

    /** The workspace that governs `childId`, or `null`. */
    governorOf(childId: string): string | null {
        return this.#workspaces.find((w) => (w.governs ?? []).includes(childId))?.id ?? null;
    }

    agentsOf(workspaceId: string): readonly AgentRecord[] {
        return this.#agents.filter((a) => a.workspaceId === workspaceId);
    }

    /** Hibernate / wake (§6.1). On disk, so it survives restarts and upgrades. */
    async setAsleep(workspaceId: string, asleep: boolean): Promise<boolean> {
        if (!this.#workspaces.some((w) => w.id === workspaceId)) return false;
        this.#workspaces = this.#workspaces.map((w) => (w.id === workspaceId ? { ...w, asleep } : w));
        await this.#store.writeWorkspaces(this.#workspaces);
        this.#emit();
        return true;
    }

    /** Remove from Genie (§6.1): the workspace and its agent records go; the folder is not this class's to touch. */
    async forgetWorkspace(workspaceId: string): Promise<{ agentsForgotten: number } | null> {
        if (!this.#workspaces.some((w) => w.id === workspaceId)) return null;
        const agentsForgotten = this.#agents.filter((a) => a.workspaceId === workspaceId).length;
        // A removed workspace leaves every governor's list.
        this.#workspaces = this.#workspaces.filter((w) => w.id !== workspaceId).map((w) => (w.governs?.includes(workspaceId) ? { ...w, governs: w.governs.filter((id) => id !== workspaceId) } : w));
        this.#agents = this.#agents.filter((a) => a.workspaceId !== workspaceId);
        await this.#store.writeWorkspaces(this.#workspaces);
        await this.#store.writeAgents(this.#agents);
        this.#emit();
        return { agentsForgotten };
    }

    /** Unmount or delete (§6.2): the record goes; the persona folder is the caller's decision. */
    async forget(agentId: AgentId): Promise<boolean> {
        if (!this.#agents.some((a) => a.id === agentId)) return false;
        this.#agents = this.#agents.filter((a) => a.id !== agentId);
        await this.#store.writeAgents(this.#agents);
        this.#emit();
        return true;
    }

    /** A FRESH restart: the conversation is dropped on purpose, before the next start. */
    async clearThread(agentId: AgentId): Promise<AgentRecord | null> {
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return null;
        const cleared: AgentRecord = { ...existing, threadId: null };
        this.#agents = this.#agents.map((a) => (a.id === agentId ? cleared : a));
        await this.#store.writeAgents(this.#agents);
        this.#changed(cleared.id);
        return cleared;
    }

    /** Switch driver: identity, inbox, history and prompt stay; only the provider changes. */
    async setProvider(agentId: AgentId, provider: string): Promise<{ ok: true; record: AgentRecord } | { ok: false; reason: string }> {
        if (!isAcpProvider(provider)) return { ok: false, reason: `Genie cannot run a "${provider}" agent; the providers it knows are ${ACP_PROVIDERS.join(', ')}` };
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return { ok: false, reason: `No agent ${agentId}.` };
        const record: AgentRecord = { ...existing, provider };
        this.#agents = this.#agents.map((a) => (a.id === agentId ? record : a));
        await this.#store.writeAgents(this.#agents);
        this.#changed(record.id);
        return { ok: true, record };
    }

    /** Mode is WORDING for the agent (§6.2) — automated or manual — not a permission boundary. */
    async setMode(agentId: AgentId, mode: AgentRecord['mode']): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, mode }));
    }

    /** What a Claude agent may do: all tools, ask before shell commands, or edits only (shell refused). Read when its session starts. */
    async setPermissions(agentId: AgentId, permissions: AgentPermissions): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, permissions }));
    }

    /** The model the agent's provider starts with; `null` clears it — back to the provider's default. Read when its session starts. */
    async setModel(agentId: AgentId, model: string | null): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => {
            const { model: _previous, ...rest } = a;
            return model === null ? rest : { ...rest, model };
        });
    }

    /** The agent's own half of who may message it (§6.4). */
    async setAccessScope(agentId: AgentId, accessScope: AgentRecord['accessScope']): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, accessScope }));
    }

    async #update(agentId: AgentId, change: (a: AgentRecord) => AgentRecord): Promise<AgentRecord | null> {
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return null;
        const record = change(existing);
        this.#agents = this.#agents.map((a) => (a.id === agentId ? record : a));
        await this.#store.writeAgents(this.#agents);
        this.#changed(record.id);
        return record;
    }

    async setBudget(agentId: AgentId, dailyBudgetUsd: number | null): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, dailyBudgetUsd }));
    }

    /**
     * By id — or by the OS agent's NAME. The rail links to `genie://agent/genie` because the OS
     * agent's id is minted on first boot and the rail cannot know it; OS_AGENT_NAME is an alias for
     * the one agent that has no workspace, and for nothing else (a workspace agent named `genie`
     * is found by its id only).
     */
    find(id: AgentId): AgentRecord | null {
        const byId = this.#agents.find((a) => a.id === id);
        if (byId) return byId;
        if ((id as string) === OS_AGENT_NAME) return this.#agents.find((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME) ?? null;
        return null;
    }

    /** Every workspace record, for the one-time v1 import to plan against. */
    listWorkspaces(): readonly WorkspaceRecord[] {
        return this.#workspaces;
    }

    /** Every agent record, for the same. */
    listAgents(): readonly AgentRecord[] {
        return this.#agents;
    }

    #emit(): void {
        const snapshot = this.snapshot();
        for (const listener of this.#listeners) listener(snapshot);
    }

    /** One agent's record changed: the estate snapshot, then that agent's own listeners. */
    #changed(agentId: AgentId): void {
        this.#emit();
        for (const listener of this.#recordListeners) listener(agentId);
    }
}
