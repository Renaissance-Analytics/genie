import { observedRowFor, type TakeOverProbe } from '../core/observed.js';
import { ACP_PROVIDERS, isAcpProvider, type AcpProvider } from '../core/engine.js';
import type { CarryOver } from '../core/carry-over.js';
import { OS_AGENT_NAME, agentRecord, mintAgentId, type AgentRecord, type AgentId, type AgentPermissions, type PlanStepRecord, threadIdIsResumable } from '../core/identity.js';
import type { IssueWatchSetting } from '../core/issue-watch.js';
import { agentRowFor, type LiveSession } from '../core/roster.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { GenieSnapshot } from '../renderer/bridge.js';
import { Store, type RecordChange, type RecordPatch, type WorkspaceRecord } from './store.js';

/**
 * Where a Registry's files are read and written (the host split, P3.2): the Store itself (genie-host), or a window's
 * HostRegistryStore — the same calls, answered by the host, the files' one writer. A Registry writes RECORDS, never a
 * whole list (Tynn #1007): `changeWorkspaces` / `changeAgents` name only the records and fields it changed, and the
 * host applies them to the files as they are then, so a stale copy here cannot clobber another writer's change.
 */
export type RegistryStore = Pick<Store, 'readWorkspaces' | 'readAgents' | 'readRunningAtQuit' | 'readInterruptedAtQuit' | 'beginRestore' | 'restoreStarted' | 'changeWorkspaces' | 'changeAgents' | 'writeRunningAtQuit' | 'writeInterruptedAtQuit' | 'dropped'>;
import { withMcpSeen, withWorkspaceMcpServer } from '../core/agent-mcp.js';
import { isOsAgent, OS_WORKSPACE, withOsAgentPolicy } from '../core/os-agent.js';
import { folderName } from '../core/workspace-name.js';
import { envFileName } from '../core/dotenv.js';
import { slugsFor } from '../core/address.js';
import { WorkspaceMailVisibility, hibernatedRecipientRefusal, resolveAddress as resolveMailAddress } from '../core/inbox.js';

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
export { OS_WORKSPACE };

/** What the registry can see of a running session. Supplied by whatever owns the sessions. */
export type SessionProbe = (id: AgentId) => LiveSession | null;

export class Registry {
    #store: RegistryStore;
    #workspaces: readonly WorkspaceRecord[] = [];
    #agents: readonly AgentRecord[] = [];
    #registrations: Promise<void> = Promise.resolve();
    readonly #mailVisibility = new WorkspaceMailVisibility();
    #probe: SessionProbe = () => null;
    #observed: (id: AgentId) => TakeOverProbe | null = () => null;
    #handoff: (id: AgentId) => { text: string; at: number } | null = () => null;
    #listeners = new Set<(snapshot: GenieSnapshot) => void>();
    #recordListeners = new Set<(agentId: AgentId) => void>();
    #workstation: { name: string; healthy: boolean } | null = null;
    #signals: (() => SignalState) | null = null;
    #safeMode: (() => import('../core/safe-mode.js').SafeModeView | null) | null = null;
    #hangNotice: (() => import('../core/crash-record.js').HangNotice | null) | null = null;
    #rendererNotice: (() => import('../core/renderer-notice.js').RendererNotice | null) | null = null;
    #deckSource: () => readonly DeckItem[] = () => [];
    #runningAtQuit: AgentId[] = [];
    #interruptedAtQuit: AgentId[] = [];
    #loaded = false;
    /** The display name for a workspace path — the envelope's project.json name, supplied by the composition root; the folder until then. */
    #namer: (path: string) => string = (path) => folderName(path);
    /** A workspace's colour (genie#1300: project.json `appearance.color`, main/workspace-color-host.ts); `null` = none yet. */
    #colorer: (path: string) => string | null = () => null;
    /** Whether a workspace's recorded folder is not there now (main/missing-workspaces.ts): a fact of this machine, never stored. */
    #missing: (workspaceId: string) => boolean = () => false;

    constructor(store: RegistryStore) {
        this.#store = store;
    }

    /** Read and write through `store` instead (genie-host's, P3.2). Before `load` only: a loaded model is not re-homed. */
    useStore(store: RegistryStore): void {
        if (this.#loaded) throw new Error('the registry is loaded; its store is not changed under it');
        this.#store = store;
    }

    /**
     * Read the files again — another window, or the host, wrote them (P3.2: two windows, one registry). Announced only
     * when something changed, so a window's own write, read back, redraws nothing twice.
     */
    async refresh(): Promise<void> {
        if (!this.#loaded) return;
        let workspaces: readonly WorkspaceRecord[], agents: readonly AgentRecord[];
        for (;;) {
            const registrations = this.#registrations;
            await registrations;
            const beforeWorkspaces = this.#workspaces, beforeAgents = this.#agents;
            workspaces = await this.#store.readWorkspaces();
            agents = await this.#store.readAgents();
            // A read started before a local change cannot replace that change. Read the store again;
            // keeping just the local rows would hide legitimate changes and deletions from another window.
            if (registrations === this.#registrations && beforeWorkspaces === this.#workspaces && beforeAgents === this.#agents) break;
        }
        const changedAgents = agents.filter((a) => JSON.stringify(a) !== JSON.stringify(this.#agents.find((x) => x.id === a.id) ?? null)).map((a) => a.id);
        const gone = this.#agents.filter((a) => !agents.some((x) => x.id === a.id)).map((a) => a.id);
        const workspacesChanged = JSON.stringify(workspaces) !== JSON.stringify(this.#workspaces);
        if (!workspacesChanged && changedAgents.length === 0 && gone.length === 0) return;
        this.#workspaces = workspaces;
        this.#agents = agents;
        this.#emit();
        for (const id of [...changedAgents, ...gone]) for (const listener of this.#recordListeners) listener(id as AgentId);
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
        const existing = this.#agents.find(isOsAgent);
        if (existing) {
            const normalized = withOsAgentPolicy(existing);
            if (normalized !== existing) {
                await this.#commitAgents(this.#agents.map((a) => a.id === existing.id ? normalized : a));
            }
            return;
        }

        const record = withOsAgentPolicy(agentRecord({
            id: mintAgentId(),
            workspaceId: OS_WORKSPACE,
            provider: 'claude',
            name: OS_AGENT_NAME,
        }));
        await this.#commitAgents([...this.#agents, record]);
    }

    /** How a workspace is NAMED in every surface: project.json's name, else the folder — never the id (beta.7 showed 26 ULIDs). */
    setWorkspaceNamer(namer: (path: string) => string): void {
        this.#namer = namer;
        if (this.#loaded) this.#emit();
    }

    /** Each workspace's COLOUR (genie#1300), from the composition root: carried on its snapshot row when it has one. */
    setWorkspaceColorer(colorer: (path: string) => string | null): void {
        this.#colorer = colorer;
        if (this.#loaded) this.#emit();
    }

    /**
     * Which workspaces' folders are NOT THERE now (host split P7; main/missing-workspaces.ts), from the composition root:
     * such a row carries `missing: true`. It stays in every list; nothing about it is written.
     */
    setMissingWorkspaces(isMissing: (workspaceId: string) => boolean): void {
        this.#missing = isMissing;
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
    /** genie-host's safe mode (Tynn #386), read into every snapshot: the banner on every window. */
    setSafeMode(provider: () => import('../core/safe-mode.js').SafeModeView | null): void {
        this.#safeMode = provider;
    }

    /** genie-host's reopened-window notice (Tynn #386): a hung window was ended and this one started; read into every snapshot. */
    setHangNotice(provider: () => import('../core/crash-record.js').HangNotice | null): void {
        this.#hangNotice = provider;
    }

    /** This window's page ended and was brought back (Tynn #386, renderer-recovery.ts); read into every snapshot. */
    setRendererNotice(provider: () => import('../core/renderer-notice.js').RendererNotice | null): void {
        this.#rendererNotice = provider;
    }

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

    /** The agents a shutdown cut off mid-turn, as recorded — read, not taken (safe mode lists them, Tynn #386). */
    interruptedAtQuit(): readonly AgentId[] {
        return this.#interruptedAtQuit;
    }

    /** The agents a shutdown cut off mid-turn (written at quit or upgrade, before the sessions end). */
    async markInterruptedAtQuit(ids: readonly AgentId[]): Promise<void> {
        this.#interruptedAtQuit = ids.filter((id) => this.#agents.some((a) => a.id === id));
        await this.#store.writeInterruptedAtQuit(this.#interruptedAtQuit);
    }

    /**
     * THE RESTORE BEGINS (Tynn #754): the agents the last shutdown recorded, READ and kept on disk. Each leaves the lists
     * only when its start went through (`restoreStarted`), so a shutdown inside the restore still records the agents
     * waiting to start. A crash mid-restore starts nobody twice: a started agent is already off the lists.
     */
    async beginRestore(): Promise<{ running: readonly AgentId[]; interrupted: readonly AgentId[] }> {
        const { running, interrupted } = await this.#store.beginRestore();
        this.#runningAtQuit = this.#known(running);
        this.#interruptedAtQuit = this.#known(interrupted);
        return { running: this.#runningAtQuit, interrupted: this.#interruptedAtQuit };
    }

    /** An agent's restore start went through: it leaves the saved lists (unless a shutdown has recorded since). */
    async restoreStarted(id: AgentId): Promise<void> {
        if (!(await this.#store.restoreStarted(id))) return;
        this.#runningAtQuit = this.#runningAtQuit.filter((x) => x !== id);
        this.#interruptedAtQuit = this.#interruptedAtQuit.filter((x) => x !== id);
    }

    /** The saved agents a restore has not started yet, as on disk now: what a shutdown record keeps (Tynn #754). */
    async pendingRestore(): Promise<{ running: readonly AgentId[]; interrupted: readonly AgentId[] }> {
        const [running, interrupted] = await Promise.all([this.#store.readRunningAtQuit(), this.#store.readInterruptedAtQuit()]);
        return { running: this.#known(running), interrupted: this.#known(interrupted) };
    }

    #known(ids: readonly string[]): AgentId[] {
        return ids.filter((id): id is AgentId => this.#agents.some((a) => a.id === id));
    }

    setProbe(probe: SessionProbe): void {
        this.#probe = probe;
    }

    /** What the Take Over host knows about an agent's TUI, or `null`. Drives the Observed row. */
    setObservedProbe(probe: (id: AgentId) => TakeOverProbe | null): void {
        this.#observed = probe;
    }

    /** An agent's last finished turn's handoff (the attention store's record), for the workspace dashboard (q_09d1f4a0). */
    setHandoffProbe(probe: (id: AgentId) => { text: string; at: number } | null): void {
        this.#handoff = probe;
    }

    /** Count of live sessions — the only correct source for "how many agents are running". */
    get runningCount(): number {
        return this.listAgents().filter((a) => this.#probe(a.id)?.running === true).length;
    }

    snapshot(): GenieSnapshot {
        // ONE PROBE PER AGENT PER SNAPSHOT (genie#1200): the rows and the live approvals both read it, and each probe
        // carries the agent's comms — read twice, it doubled the cost of a snapshot rebuilt every 50 ms.
        const outer = this.#probe;
        const seen = new Map<AgentId, ReturnType<SessionProbe>>();
        this.#probe = (id) => {
            if (seen.has(id)) return seen.get(id)!;
            const v = outer(id);
            seen.set(id, v);
            return v;
        };
        try {
            return this.#snapshot();
        } finally {
            this.#probe = outer;
        }
    }

    #snapshot(): GenieSnapshot {
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
            agents: this.listAgents()
                .filter((record) => record.workspaceId !== OS_WORKSPACE)
                // An agent with a live Take Over is OBSERVED: Genie sees its bytes and nothing
                // else, and the row says so (§4.1). Otherwise the declared row as before.
                .map((record) => {
                    const observed = this.#observed(record.id);
                    const row = observed ? observedRowFor(record, observed, now()) : agentRowFor(record, this.#probe(record.id), now);
                    return { ...row, handoff: this.#handoff(record.id) };
                }),
            // GENIE'S OWN ROW, beside the workspace agents (the design mockup's `genie · default agent · not in a workspace`
            // group): the Dashboard draws it in a group of its own, so the census that counts it has its row.
            osAgent: (() => {
                const os = this.osAgent();
                if (!os) return null;
                const observed = this.#observed(os.id);
                return observed ? observedRowFor(os, observed, now()) : agentRowFor(os, this.#probe(os.id), now);
            })(),
            // `agentsKnown` is TRUE only once the store has actually been read. Before that the
            // rail must render no counts at all: a `0` on first paint says "this workspace is
            // empty" when the truth is "nobody has looked yet".
            // `null` until the store has been read. Not `[]`: "we have not looked" and "there
            // are none" are different claims, and the Dashboard gives them different surfaces.
            workspaces: this.#loaded
                // `governs` / `governedBy` appear only when they carry something: every other workspace literal stays exact.
                ? this.listWorkspaces().map((w) => ({ id: w.id, path: w.path, name: this.#namer(w.path), agentsKnown: true, asleep: false, ...(w.governs && w.governs.length > 0 ? { governs: w.governs.filter((id) => !this.#isHibernated(id)) } : {}), ...(this.governorOf(w.id) ? { governedBy: this.governorOf(w.id) } : {}), ...(w.defaultAgentId ? { defaultAgentId: w.defaultAgentId } : {}), ...(w.mcpOff && w.mcpOff.length > 0 ? { mcpOff: w.mcpOff } : {}), ...(this.#workspaceMcpSeen(w.id).length > 0 ? { mcpSeen: this.#workspaceMcpSeen(w.id) } : {}), ...this.#colorOf(w.path), ...(this.#missing(w.id) ? { missing: true as const } : {}) }))
                : null,
            ...(this.#loaded && this.#workspaces.some((workspace) => workspace.asleep) ? {
                hibernatedWorkspaces: this.#workspaces.filter((workspace) => workspace.asleep).map((workspace) => ({ id: workspace.id, path: workspace.path, name: workspace.hibernatedName ?? folderName(workspace.path), asleep: true as const })),
            } : {}),
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
             * Without a provider every signal is false — honest zeros, so the strip renders nothing.
             * main sets the provider: the stores' counts, and what the GitHub sign-in read from GitHub.
             */
            signals: this.#signals?.() ?? { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
            workstation: this.#workstation,
            // Only once main has said where it comes from: a snapshot with no host to ask carries no claim about it.
            ...(this.#safeMode ? { safeMode: this.#safeMode() } : {}),
            ...(this.#hangNotice ? { hangNotice: this.#hangNotice() } : {}),
            ...(this.#rendererNotice ? { rendererNotice: this.#rendererNotice() } : {}),
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
        return [...this.#sessionApprovals(), ...this.#deckSource()].filter((item) => {
            const workspaceId = item.workspaceId ?? this.#agents.find((record) => record.id === item.agentId)?.workspaceId;
            return workspaceId === undefined || !this.#isHibernated(workspaceId);
        });
    }

    #sessionApprovals(): DeckItem[] {
        return this.listAgents().flatMap((record): DeckItem[] => {
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

    /** Child windows need membership/hibernation changes, without the main window's activity-rate snapshots. */
    subscribeWorkspaceVisibility(listener: (snapshot: GenieSnapshot) => void): () => void {
        const key = () => JSON.stringify(this.#workspaces.map((w) => [w.id, w.asleep === true]));
        let previous = key();
        return this.subscribe((snapshot) => {
            const next = key();
            if (next === previous) return;
            previous = next; listener(snapshot);
        });
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
        if (workspace.id === OS_WORKSPACE) throw new Error('The built-in Genie workspace is reserved; choose a regular workspace');
        if (this.#workspaces.some((w) => w.id === workspace.id)) return;
        await this.#commitWorkspaces([...this.#workspaces, workspace]);
        this.#emit();
    }

    /**
     * Register an agent. **Consumes no resources** — no process, no session, no pty, nothing.
     *
     * §6.2 separates registering from starting on purpose: an identity should be creatable,
     * nameable and persistable without anything running, so that a workspace can be set up
     * before anyone is ready to spend a provider turn on it.
     */
    async register(input: { workspaceId: string; provider: AgentRecord['provider']; name: string; instructions?: string | null }): Promise<AgentRecord> {
        if (input.workspaceId === OS_WORKSPACE) throw new Error('The built-in Genie identity is reserved; agents belong to a regular workspace');
        const record = agentRecord({ id: mintAgentId(), ...input });
        // THE FIRST AGENT IS THE DEFAULT (Tynn #1015): a workspace with none gets this one, automatically.
        const first = this.#workspaces.some((w) => w.id === input.workspaceId && w.defaultAgentId === undefined);
        const writing = this.#commitAgents([...this.#agents, record]).then(() => (first ? this.#commitWorkspaces(this.#withDefault(this.#workspaces, input.workspaceId, record.id, true)) : undefined));
        // Refresh also waits for an already-started creation: its in-memory rows precede durable storage.
        // A failed write still rejects register(), while refresh must remain able to read the actual store.
        this.#registrations = Promise.allSettled([this.#registrations, writing]).then(() => {});
        await writing;
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

        await this.#commitAgents(this.#agents.map((a) => (a.id === agentId ? { ...a, threadId } : a)));
        this.#changed(existing.id);
        return { ok: true };
    }

    /** The OS agent's record. Always present after `load`. */
    osAgent(): AgentRecord | null {
        return this.#agents.find((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME) ?? null;
    }

    workspace(id: string): { id: string; path: string; asleep: boolean; governs: string[]; defaultAgentId: string | null } | null {
        const w = this.#workspaces.find((x) => x.id === id);
        return w ? { id: w.id, path: w.path, asleep: w.asleep === true, governs: [...(w.governs ?? [])], defaultAgentId: w.defaultAgentId ?? null } : null;
    }

    /** OPS PROJECTS (§6.1): which workspaces `opsId` governs — known ids only, never itself. */
    async setGoverns(opsId: string, childIds: readonly string[]): Promise<{ ok: true; governs: string[] } | { ok: false; reason: string }> {
        if (!this.#workspaces.some((w) => w.id === opsId)) return { ok: false, reason: `no workspace "${opsId}"` };
        const governs = [...new Set(childIds)].filter((id) => id !== opsId && this.#workspaces.some((w) => w.id === id));
        await this.#commitWorkspaces(this.#workspaces.map((w) => (w.id === opsId ? { ...w, governs } : w)));
        this.#emit();
        return { ok: true, governs };
    }

    /** The workspace that governs `childId`, or `null`. */
    governorOf(childId: string): string | null {
        return this.#isHibernated(childId) ? null : this.listWorkspaces().find((w) => (w.governs ?? []).includes(childId))?.id ?? null;
    }

    agentsOf(workspaceId: string): readonly AgentRecord[] {
        return this.listAgents().filter((a) => a.workspaceId === workspaceId);
    }

    /**
     * The workspace's default agent (Genie 1's), or `null` when it has no agents. The first or only agent is the default
     * automatically (Tynn #1015): registering records it, and assignMissingDefaults records it for workspaces from before.
     */
    defaultAgentOf(workspaceId: string): string | null {
        if (this.#isHibernated(workspaceId)) return null;
        const w = this.#workspaces.find((x) => x.id === workspaceId);
        if (!w) return null;
        // Not recorded yet (a workspace from before, until genie-host's boot records it): its first agent, as the host says.
        return w.defaultAgentId ?? this.#agents.find((a) => a.workspaceId === workspaceId)?.id ?? null;
    }

    /** The default someone CHOSE (the person, project.json, Genie 1's import), or `null` — an automatic one is not. */
    chosenDefaultAgentOf(workspaceId: string): string | null {
        const w = this.#workspaces.find((x) => x.id === workspaceId);
        return w === undefined || w.defaultAgentAuto === true || this.#isHibernated(workspaceId) ? null : w.defaultAgentId ?? null;
    }

    /**
     * Every workspace with agents and NO default recorded gets its first agent (by registration order), automatically
     * (Tynn #1015: six of the owner's workspaces had none, so nothing that asks for the default found one). Idempotent: a
     * second pass finds nothing to do and writes nothing. genie-host, the one writer, runs it at boot. The ids it gave.
     */
    async assignMissingDefaults(): Promise<string[]> {
        let next = this.#workspaces;
        const given: string[] = [];
        for (const w of this.#workspaces) {
            if (w.defaultAgentId !== undefined) continue;
            const first = this.#agents.find((a) => a.workspaceId === w.id);
            if (!first) continue;
            next = this.#withDefault(next, w.id, first.id, true);
            given.push(w.id);
        }
        if (given.length === 0) return given;
        await this.#commitWorkspaces(next);
        this.#emit();
        return given;
    }

    #withDefault(workspaces: readonly WorkspaceRecord[], workspaceId: string, agentId: string | null, automatic: boolean): WorkspaceRecord[] {
        return workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const { defaultAgentId: _previous, defaultAgentAuto: _auto, ...rest } = w;
            if (agentId === null) return rest;
            return automatic ? { ...rest, defaultAgentId: agentId, defaultAgentAuto: true } : { ...rest, defaultAgentId: agentId };
        });
    }

    /**
     * Designate one of the workspace's OWN agents its default (Genie 1's setWorkspaceDefaultAgent), or with `null` go back
     * to the automatic one: its first agent (Tynn #1015).
     * An agent of another workspace is refused: it would be the default of a workspace it does not belong to.
     */
    async setDefaultAgent(workspaceId: string, agentId: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (!this.#workspaces.some((w) => w.id === workspaceId)) return { ok: false, reason: `no workspace ${workspaceId}` };
        if (agentId !== null) {
            const agent = this.#agents.find((a) => a.id === agentId);
            if (!agent) return { ok: false, reason: `no agent ${agentId}` };
            if (agent.workspaceId !== workspaceId) return { ok: false, reason: `${agent.name} is an agent of ${agent.workspaceId}, not of ${workspaceId}` };
        }
        // A CHOSEN default: an automatic one never replaces it (Tynn #1015). `null` is no choice: back to the first agent,
        // automatically, or none when the workspace has no agents.
        const first = this.#agents.find((a) => a.workspaceId === workspaceId)?.id ?? null;
        await this.#commitWorkspaces(agentId === null
            ? this.#withDefault(this.#workspaces, workspaceId, first, true)
            : this.#withDefault(this.#workspaces, workspaceId, agentId, false));
        this.#emit();
        return { ok: true };
    }

    /**
     * The env file its sites' service connection is written to (`WorkspaceRecord.envFile`): a plain file name, or `null` for the
     * default every workspace without one has (Tynn #756, PR8: a clone's project.json may name another). Never a path.
     */
    async setWorkspaceEnvFile(workspaceId: string, file: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (!this.#workspaces.some((w) => w.id === workspaceId)) return { ok: false, reason: `no workspace ${workspaceId}` };
        if (file !== null && (file.trim() === '' || envFileName(file) === null)) return { ok: false, reason: `"${file}" is not a file name: an env file is a plain name inside each site's folder, like .env.local` };
        await this.#commitWorkspaces(this.#workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const { envFile: _previous, ...rest } = w;
            return file === null ? rest : { ...rest, envFile: file.trim() };
        }));
        this.#emit();
        return { ok: true };
    }

    /** The MCP servers off by default for every agent of this workspace (Tynn #628); an agent's own switch wins. */
    workspaceMcpOff(workspaceId: string): string[] {
        return [...(this.#workspaces.find((w) => w.id === workspaceId)?.mcpOff ?? [])];
    }

    /** One server on or off as the workspace's default. Read when each of its agents next starts a session. */
    async setWorkspaceMcpServer(workspaceId: string, name: unknown, on: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
        const workspace = this.#workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return { ok: false, reason: `no workspace ${workspaceId}` };
        const changed = withWorkspaceMcpServer(workspace.mcpOff, name, on);
        if (!changed.ok) return changed;
        await this.#commitWorkspaces(this.#workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const { mcpOff: _previous, ...rest } = w;
            return changed.mcpOff.length > 0 ? { ...rest, mcpOff: changed.mcpOff } : rest;
        }));
        this.#emit();
        return { ok: true };
    }

    /** Every MCP server a session of one of this workspace's agents reported: what its Settings can list. */
    #workspaceMcpSeen(workspaceId: string): string[] {
        return [...new Set(this.#agents.filter((a) => a.workspaceId === workspaceId).flatMap((a) => a.mcpSeen ?? []))].sort((a, b) => a.localeCompare(b));
    }

    /** Hibernate / wake (§6.1). On disk, so it survives restarts and upgrades. */
    async setAsleep(workspaceId: string, asleep: boolean): Promise<boolean> {
        const workspace = this.#workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return false;
        if (workspace.asleep === true && !asleep) {
            // Persist first, before any consumer can see the workspace as awake and start its agents.
            const redockAt = new Date().toISOString();
            await this.#commitAgents(this.#agents.map((record) => record.workspaceId === workspaceId ? { ...record, redockAt } : record));
        }
        const hibernatedName = asleep && workspace.asleep !== true ? this.#namer(workspace.path) : workspace.hibernatedName;
        // Persisted before this model shows it (persistFirst): nothing here sees a workspace awake that is not, on disk.
        await this.#commitWorkspaces(this.#workspaces.map((w) => (w.id === workspaceId ? { ...w, asleep, ...(hibernatedName ? { hibernatedName } : {}) } : w)), { persistFirst: true });
        this.#emit();
        return true;
    }

    /** A late acknowledgement must not consume a newer redock's reorientation. */
    async clearRedock(agentId: AgentId, at: string): Promise<void> {
        const record = this.#agents.find((candidate) => candidate.id === agentId);
        if (!record || record.redockAt !== at) return;
        await this.#commitAgents(this.#agents.map((candidate) => {
            if (candidate.id !== agentId) return candidate;
            const { redockAt: _redockAt, ...rest } = candidate;
            return rest;
        }));
        this.#changed(agentId);
    }

    /** Remove from Genie (§6.1): the workspace and its agent records go; the folder is not this class's to touch. */
    async forgetWorkspace(workspaceId: string): Promise<{ agentsForgotten: number } | null> {
        if (!this.#workspaces.some((w) => w.id === workspaceId)) return null;
        const agentsForgotten = this.#agents.filter((a) => a.workspaceId === workspaceId).length;
        // A removed workspace leaves every governor's list.
        const gone = new Set<string>(this.#agents.filter((a) => a.workspaceId === workspaceId).map((a) => a.id));
        await this.#commitWorkspaces(this.#workspaces.filter((w) => w.id !== workspaceId).map((w) => (w.governs?.includes(workspaceId) ? { ...w, governs: w.governs.filter((id) => id !== workspaceId) } : w)));
        await this.#commitAgents(dropChosen(this.#agents.filter((a) => a.workspaceId !== workspaceId), gone));
        this.#emit();
        return { agentsForgotten };
    }

    /** Unmount or delete (§6.2): the record goes; the persona folder is the caller's decision. */
    async forget(agentId: AgentId): Promise<boolean> {
        if (!this.#agents.some((a) => a.id === agentId)) return false;
        await this.#commitAgents(dropChosen(this.#agents.filter((a) => a.id !== agentId), new Set([agentId])));
        // A designation never points at nothing: the forgotten default's workspace takes its first agent left,
        // automatically (Tynn #1015), or none when it has no agents left.
        const owning = this.#workspaces.find((w) => w.defaultAgentId === agentId);
        if (owning) {
            const first = this.#agents.find((a) => a.workspaceId === owning.id);
            await this.#commitWorkspaces(this.#withDefault(this.#workspaces, owning.id, first?.id ?? null, true));
        }
        this.#emit();
        return true;
    }

    /** A FRESH restart: the conversation is dropped on purpose, before the next start. */
    async clearThread(agentId: AgentId): Promise<AgentRecord | null> {
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return null;
        const { genieWordsInThread: _words, ...rest } = existing;
        const cleared: AgentRecord = { ...rest, threadId: null };
        await this.#commitAgents(this.#agents.map((a) => (a.id === agentId ? cleared : a)));
        this.#changed(cleared.id);
        return this.#agents.find((a) => a.id === agentId) ?? null;
    }

    /**
     * Switch provider (Tynn story #380): identity, inbox, history, plan and the conversation stay with the agent. Each
     * provider keeps ITS OWN native session — a Claude session id means nothing to Codex — so the one it leaves is PARKED
     * under the old provider (`threadIds`) with when it left (`leftAt`), and the destination's is resumed when it has one
     * (`null` = it never ran there). `carryOver` is what the next prompt carries (core/carry-over.ts); a switch always
     * REPLACES it, never stacks. The model goes with the old provider unless the caller found it in the new provider's own
     * list (`keepModel`). The owner, 2026-10-21: "I need to be able to change provider as well as model". The same
     * provider changes nothing. An agent has no account: the provider's ONE active account is the host's (Tynn #751).
     */
    async setProvider(agentId: AgentId, provider: string, options: { keepModel: boolean; carryOver?: CarryOver | null; now?: string }): Promise<{ ok: true; record: AgentRecord } | { ok: false; reason: string }> {
        if (!isAcpProvider(provider)) return { ok: false, reason: `Genie cannot run a "${provider}" agent; the providers it knows are ${ACP_PROVIDERS.join(', ')}` };
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return { ok: false, reason: `No agent ${agentId}.` };
        if (existing.provider === provider) return { ok: true, record: existing };
        const { model: _oldModel, carryOver: _oldCarry, ...withoutModel } = existing;
        const { carryOver: _carry, ...keptModel } = existing;
        const from = existing.provider, to = provider;
        const parked: Record<string, string> = { ...(existing.threadIds ?? {}) };
        if (existing.threadId) parked[from] = existing.threadId;
        else delete parked[from];
        const resumed = parked[to] ?? null;
        delete parked[to];
        const leftAt = { ...(existing.leftAt ?? {}), [from]: options.now ?? new Date().toISOString() };
        const record: AgentRecord = {
            ...(options.keepModel ? keptModel : withoutModel),
            provider,
            threadId: resumed,
            threadIds: parked,
            leftAt,
            ...(options.carryOver ? { carryOver: options.carryOver } : {}),
        };
        await this.#commitAgents(this.#agents.map((a) => (a.id === agentId ? record : a)));
        this.#changed(record.id);
        const written = this.#agents.find((a) => a.id === agentId);
        return written ? { ok: true, record: written } : { ok: false, reason: `No agent ${agentId}.` };
    }

    /** The carry-over went with a prompt (Tynn story #380): it is not carried again. */
    async clearCarryOver(agentId: AgentId): Promise<AgentRecord | null> {
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing || existing.carryOver === undefined) return existing ?? null;
        return this.#update(agentId, ({ carryOver: _sent, ...rest }) => rest, ['carryOver']);
    }

    /** Mode is WORDING for the agent (§6.2) — automated or manual — not a permission boundary. */
    async setMode(agentId: AgentId, mode: AgentRecord['mode']): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, mode }), ['mode']);
    }

    /** What a Claude agent may do: all tools, ask before shell commands, or edits only (shell refused). Read when its session starts. */
    /** Genie's own words are in this agent's thread now. */
    async markGenieWords(agentId: AgentId): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, genieWordsInThread: true }), ['genieWordsInThread']);
    }

    async setPermissions(agentId: AgentId, permissions: AgentPermissions): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, permissions }), ['permissions']);
    }

    /** The model the agent's provider starts with; `null` clears it — back to the provider's default. Read when its session starts. */
    async setModel(agentId: AgentId, model: string | null): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => {
            const { model: _previous, ...rest } = a;
            return model === null ? rest : { ...rest, model };
        }, ['model']);
    }

    /** The agent's own half of who may message it (§6.4). */
    /** Autonomous or asked (Tynn #801); kept on the record like every other setting of the agent. */
    async setAutoApprove(agentId: AgentId, autoApprove: boolean): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, autoApprove }), ['autoApprove']);
    }

    /** May manage the workspace's tabs (beta.35 item 36): the `workspaceTabs` tool appears in its next tools/list. */
    async setManageTabs(agentId: AgentId, manageTabs: boolean): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, manageTabs }), ['manageTabs']);
    }

    /** May drive pages (browser rebuild step 7): the page tool appears in its next tools/list. */
    async setDrivePages(agentId: AgentId, drivePages: boolean): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, drivePages }), ['drivePages']);
    }

    /** The MCP servers switched off for this agent (Tynn #628); read when its next session starts. */
    async setMcpOff(agentId: AgentId, mcpOff: readonly string[], mcpOn: readonly string[] = []): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, mcpOff: [...mcpOff], mcpOn: [...mcpOn] }), ['mcpOff', 'mcpOn']);
    }

    /** What one of its sessions reported, added to what its Settings can list. Writes only when it adds a name. */
    async noteMcpSeen(agentId: AgentId, names: readonly string[]): Promise<AgentRecord | null> {
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing || withMcpSeen(existing, names) === null) return existing ?? null;
        return this.#update(agentId, (a) => withMcpSeen(a, names) ?? a);
    }

    /** What it hears from IssueWatch (Tynn #806); kept on the record like every other setting of the agent. */
    async setIssueWatch(agentId: AgentId, issueWatch: IssueWatchSetting): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, issueWatch }), ['issueWatch']);
    }

    /** Chosen agents (Tynn #526); `null` turns the choice off. */
    async setAccessAgents(agentId: AgentId, accessAgents: readonly string[] | null): Promise<AgentRecord | null> {
        return this.#update(agentId, ({ accessAgents: _old, ...rest }) => (accessAgents === null ? rest : { ...rest, accessAgents: [...accessAgents] }), ['accessAgents']);
    }

    /**
     * A MOUNTED AGENT TAKES TYNN'S SETTINGS (Tynn #1016), in ONE write: written setter by setter, each half-applied state was
     * sent to Tynn by the settings sync, and each was one more write for a stale one to land between. Only what is given.
     */
    async applyMountedSettings(agentId: AgentId, settings: { readonly permissions?: AgentPermissions; readonly mode?: AgentRecord['mode']; readonly autoApprove?: boolean; readonly accessScope?: AgentRecord['accessScope']; readonly model?: string }): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({
            ...a,
            ...(settings.permissions !== undefined ? { permissions: settings.permissions } : {}),
            ...(settings.mode !== undefined ? { mode: settings.mode } : {}),
            ...(settings.autoApprove !== undefined ? { autoApprove: settings.autoApprove } : {}),
            ...(settings.accessScope !== undefined ? { accessScope: settings.accessScope } : {}),
            ...(settings.model !== undefined ? { model: settings.model } : {}),
        }));
    }

    async setAccessScope(agentId: AgentId, accessScope: AgentRecord['accessScope']): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, accessScope }), ['accessScope']);
    }

    /**
     * One agent's record changed. `sets` names the fields the caller SETS: they are written even when this model already
     * holds that value, because this model can be behind the files (a setting put back to what a stale copy shows must
     * still land). Every other field is written only when it changed.
     */
    async #update(agentId: AgentId, change: (a: AgentRecord) => AgentRecord, sets: readonly (keyof AgentRecord)[] = []): Promise<AgentRecord | null> {
        const existing = this.#agents.find((a) => a.id === agentId);
        if (!existing) return null;
        const record = withOsAgentPolicy(change(existing));
        await this.#commitAgents(this.#agents.map((a) => (a.id === agentId ? record : a)), { sets: { id: agentId, fields: sets } });
        this.#changed(record.id);
        return this.#agents.find((a) => a.id === agentId) ?? null;
    }

    /**
     * THE ONE WAY THIS MODEL WRITES (Tynn #1007). `next` is the list as this model would have it; only what differs from
     * its list now crosses — the records added and removed, and each changed record's changed fields — and genie-host
     * applies that to the files as they are then, one record at a time under its lock. Then the records it touched are
     * taken back as the host has them, so this model holds what was written, other writers' fields included. A whole
     * list never crosses: the last whole-list writer won, and a stale replica clobbered the field another had just written.
     */
    async #commitAgents(next: readonly AgentRecord[], options: { persistFirst?: boolean; sets?: { id: string; fields: readonly string[] } } = {}): Promise<void> {
        const change = recordChange(this.#agents, next, options.sets);
        if (change === null) return;
        if (!options.persistFirst) this.#agents = next;
        const written = await this.#store.changeAgents(change);
        this.#agents = adopt(this.#agents, written, change);
    }

    async #commitWorkspaces(next: readonly WorkspaceRecord[], options: { persistFirst?: boolean } = {}): Promise<void> {
        const change = recordChange(this.#workspaces, next);
        if (change === null) return;
        if (!options.persistFirst) this.#workspaces = next;
        const written = await this.#store.changeWorkspaces(change);
        this.#workspaces = adopt(this.#workspaces, written, change);
    }

    async setBudget(agentId: AgentId, dailyBudgetUsd: number | null): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, dailyBudgetUsd }), ['dailyBudgetUsd']);
    }

    /** Its app wake cap (Tynn #1053): a number of wakes an hour, or the word `unlimited`. Read by the mail wake each time. */
    async setAppWakeCap(agentId: AgentId, appWakeCap: number | 'unlimited'): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => ({ ...a, appWakeCap }), ['appWakeCap']);
    }

    /** The agent's last turn number (identity.ts `lastTurn`): what its next session numbers on from. */
    async setLastTurn(agentId: AgentId, lastTurn: number): Promise<AgentRecord | null> {
        return this.#update(agentId, (a) => (a.lastTurn === lastTurn ? a : { ...a, lastTurn }));
    }

    /** The agent's latest plan (identity.ts `plan`): what its next run shows at once, and what the `plan` tool reads back. */
    async setPlan(agentId: AgentId, plan: readonly PlanStepRecord[]): Promise<AgentRecord | null> {
        const steps = plan.map((s) => ({ content: s.content, status: s.status }));
        return this.#update(agentId, (a) => (JSON.stringify(a.plan ?? null) === JSON.stringify(steps) ? a : { ...a, plan: steps }));
    }

    /**
     * By id — or by the OS agent's NAME. The rail links to `genie://agent/genie` because the OS
     * agent's id is minted on first boot and the rail cannot know it; OS_AGENT_NAME is an alias for
     * the one agent that has no workspace, and for nothing else (a workspace agent named `genie`
     * is found by its id only).
     */
    find(id: AgentId): AgentRecord | null {
        const byId = this.listAgents().find((a) => a.id === id);
        if (byId) return byId;
        if ((id as string) === OS_AGENT_NAME) return this.#agents.find((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME) ?? null;
        return null;
    }

    /** Every workspace record, for the one-time v1 import to plan against. */
    /** Each workspace's address slug (core/address.ts slugsFor) — the same names, in the same order, the window uses. */
    /**
     * "Locate folder" (host split P7; main/workspace-relocate-host.ts): where the workspace's folder IS. Only the record's
     * `path` changes: its id, agents, threads, settings, hibernation and every other field stay as they are.
     */
    async setWorkspacePath(workspaceId: string, path: string): Promise<boolean> {
        if (!this.#workspaces.some((w) => w.id === workspaceId)) return false;
        await this.#commitWorkspaces(this.#workspaces.map((w) => (w.id === workspaceId ? { ...w, path } : w)), { persistFirst: true });
        this.#emit();
        return true;
    }

    workspaceSlugs(): Map<string, string> {
        return slugsFor(this.listWorkspaces().map((w) => ({ id: w.id, path: w.path, name: this.#namer(w.path) })));
    }

    listWorkspaces(): readonly WorkspaceRecord[] {
        return this.#workspaces.filter((workspace) => workspace.asleep !== true);
    }

    /** Internal lifecycle metadata. Never enumerate it in a view or read an asleep folder through it. */
    workspaceStates(): readonly WorkspaceRecord[] { return this.#workspaces; }

    /** Internal ownership lookup for mail. This reads metadata only, including hidden identities. */
    mailParticipantVisible(id: string): boolean {
        return !this.mailVisibilityVersion().has(id);
    }

    mailVisibilityVersion(): ReadonlySet<string> { return this.#mailVisibility.read(this.#agents, this.#workspaces); }

    mailRefusal(text: string, workspaceScope?: string): string | null {
        const visible = this.listAgents().filter((r) => workspaceScope === undefined || r.workspaceId === workspaceScope);
        if (resolveMailAddress(text, visible, this.workspaceSlugs()).kind !== 'none') return null;
        const asleep = new Set(this.#workspaces.filter((w) => w.asleep === true).map((w) => w.id));
        const slugs = slugsFor(this.#workspaces.map((w) => ({ id: w.id, path: w.path, name: w.asleep === true ? w.hibernatedName ?? folderName(w.path) : this.#namer(w.path) })));
        return hibernatedRecipientRefusal(text, this.#agents, asleep, slugs, workspaceScope);
    }

    /** Every agent record, for the same. */
    listAgents(): readonly AgentRecord[] {
        return this.#agents.filter((record) => !this.#isHibernated(record.workspaceId));
    }

    #isHibernated(workspaceId: string): boolean {
        return this.#workspaces.some((workspace) => workspace.id === workspaceId && workspace.asleep === true);
    }

    /** `{ color }` when the workspace has one; nothing otherwise, so every other workspace literal stays exact. */
    #colorOf(path: string): { color?: string } {
        const color = this.#colorer(path);
        return color ? { color } : {};
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

/**
 * What differs between two copies of a list, by record (Tynn #1007): the records added, the ids removed, and for each
 * record in both, only the fields that changed (`undefined` is no field). `null` when nothing did.
 */
function recordChange<T extends { readonly id: string }>(before: readonly T[], after: readonly T[], sets?: { id: string; fields: readonly string[] }): RecordChange<T> | null {
    const was = new Map(before.map((r) => [r.id, r] as const));
    const now = new Set(after.map((r) => r.id));
    const add: T[] = [], patch: RecordPatch[] = [];
    for (const record of after) {
        const old = was.get(record.id);
        if (!old) { add.push(record); continue; }
        const forced = sets?.id === record.id ? sets.fields.filter((key) => key !== 'id') : [];
        if (old === record && forced.length === 0) continue;
        const o = old as unknown as Record<string, unknown>, n = record as unknown as Record<string, unknown>;
        const set: Record<string, unknown> = {};
        const unset: string[] = [];
        for (const key of Object.keys(n)) {
            if (key === 'id') continue;
            if (n[key] === undefined) { if (o[key] !== undefined) unset.push(key); continue; }
            if (JSON.stringify(n[key]) !== JSON.stringify(o[key])) set[key] = n[key];
        }
        for (const key of Object.keys(o)) if (key !== 'id' && !(key in n) && o[key] !== undefined) unset.push(key);
        // A field the caller sets is written whatever this copy held (see #update).
        for (const key of forced) {
            if (n[key] === undefined) { if (!unset.includes(key)) unset.push(key); } else set[key] = n[key];
        }
        if (Object.keys(set).length > 0 || unset.length > 0) patch.push({ id: record.id, ...(Object.keys(set).length > 0 ? { set } : {}), ...(unset.length > 0 ? { unset } : {}) });
    }
    const remove = before.filter((r) => !now.has(r.id)).map((r) => r.id);
    if (add.length === 0 && patch.length === 0 && remove.length === 0) return null;
    return { ...(add.length > 0 ? { add } : {}), ...(patch.length > 0 ? { patch } : {}), ...(remove.length > 0 ? { remove } : {}) };
}

/**
 * This model's list, with the records a change touched taken back as the host wrote them (a record the host no longer
 * has leaves). A removal can change other records (a chosen-agents list, a governor's list), so then the host's whole
 * answer is taken.
 */
function adopt<T extends { readonly id: string }>(local: readonly T[], written: readonly T[], change: RecordChange<T>): T[] {
    if ((change.remove?.length ?? 0) > 0) return [...written];
    const host = new Map(written.map((r) => [r.id, r] as const));
    const touched = new Set<string>([...(change.add ?? []).map((r) => r.id), ...(change.patch ?? []).map((p) => p.id)]);
    const out: T[] = [];
    for (const record of local) {
        if (!touched.has(record.id)) out.push(record);
        else if (host.has(record.id)) out.push(host.get(record.id)!);
    }
    for (const id of touched) if (host.has(id) && !out.some((r) => r.id === id)) out.push(host.get(id)!);
    return out;
}

/** A deleted agent leaves every chosen-agents list it was on (Tynn #526); a list it was not on is the same object. */
function dropChosen(agents: AgentRecord[], gone: ReadonlySet<string>): AgentRecord[] {
    return agents.map((a) => (a.accessAgents?.some((id) => gone.has(id)) ? { ...a, accessAgents: a.accessAgents.filter((id) => !gone.has(id)) } : a));
}
