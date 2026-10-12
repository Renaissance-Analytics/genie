import type { BudgetDecision, DeletePlan, SwitchDecision } from '../core/agent-ops.js';
import type { AgentRow, Fidelity } from '../core/dashboard-view.js';
import type { TynnProject } from '../core/tynn.js';
import type { Diagnosis, FolderKind, PlanStep } from '../core/workspace-model.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { RailWorkspace, Surface } from '../core/rail-view.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from './features.js';
import type { LiveSession } from '../core/roster.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { TreeNode } from '../core/files-panel.js';
import type { FilesState, OpenResult, WriteResult } from '../main/files-host.js';
import type { DrainRoster } from '../core/upgrade-drain.js';
import type { RepoEntry } from '../core/repo-registry.js';

/**
 * THE RENDERER'S ONLY WINDOW ONTO THE MAIN PROCESS.
 *
 * One narrow, declared surface. The renderer never reaches for `ipcRenderer` directly and
 * never holds a Node capability: the preload script implements exactly this interface over
 * `contextBridge` and nothing else crosses.
 *
 * ## Push, never poll
 *
 * `subscribe` is a subscription, not a timer. A dashboard that polls is a dashboard that is
 * wrong for up to its interval, and with thirty agents it is also a dashboard that reads the
 * session registry a hundred times a minute to learn nothing. The main process owns the
 * registry and says when it changed.
 *
 * ## `null` crosses the bridge intact
 *
 * Every nullable field on `AgentRow` and `RailWorkspace` means *"Genie cannot see this"*, and
 * the bridge must not helpfully coalesce one to a zero on the way through. The rule only
 * works if it holds end to end — a `?? 0` anywhere in the IPC layer silently converts "we
 * have not looked" into "we looked and it was none", and the UI has no way to tell.
 */
export interface GenieSnapshot {
    agents: readonly AgentRow[];
    /**
     * `null` until the store has actually been read.
     *
     * **Not `[]`.** The two are different claims and they get different surfaces: an empty
     * array means Genie looked and this machine has no workspaces, which is a first run and
     * deserves an invitation; `null` means nobody has looked yet, which deserves a skeleton.
     *
     * This distinction was missing for exactly one commit, and the Dashboard's brand-new
     * first-run state rendered "Nothing is being worked on yet" before the bridge had
     * answered — a confident claim about a machine nobody had asked. An older test caught it.
     */
    workspaces: readonly RailWorkspace[] | null;
    /**
     * The attention band, or `null` until the queue has been read.
     *
     * The rail's badge count is DERIVED from this rather than carried beside it. Two numbers
     * for one fact is how a badge ends up saying 3 while the Deck shows 2, and the badge is
     * the thing people trust enough not to check.
     */
    deckItems: readonly DeckItem[] | null;
    signals: SignalState;
    /** `null` until the workstation has been read — never a default `healthy: false`. */
    workstation: { name: string; healthy: boolean } | null;
}

/**
 * One agent's full state — what the Agent view needs.
 *
 * Fetched per agent rather than carried in the snapshot: a ledger is thousands of rows, and
 * pushing every agent's to every renderer on every event would send the whole estate's
 * history down the wire to redraw one line.
 */
export interface AgentDetail {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity; cwd: string; dailyBudgetUsd?: number | null; mode?: 'automated' | 'manual'; accessScope?: 'none' | 'self' | 'specific' | 'all' };
    /** `null` when the agent is registered but not running. Not an error. */
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    turns: number;
    /** `null` when the provider reports no cost. codex reports none — so there is no row. */
    cost: number | null;
    /** Why a start was refused, if one was. Reported, never swallowed. */
    refusal: string | null;
}

/** The three feature channels, named ONCE. Preload and main import this; neither retypes a string. */
export const FEATURE_CHANNELS = {
    snapshot: 'genie:features-snapshot',
    act: 'genie:features-act',
    changed: 'genie:features-changed',
    /** The renderer reports where the browser box is, so main can place the WebContentsView over it. */
    browserBounds: 'genie:features-browser-bounds',
    /** The host's file picker, for attachments (§6.4): paths never typed, never guessed. */
    pickFiles: 'genie:features-pick-files',
} as const;

export interface GenieBridge {
    /**
     * THE FEATURE SURFACES — knowledge, flows, hosting, toolchain, inbox, settings, browser.
     * One snapshot, pushed on change; one `act` that applies a person's action in main and
     * answers with the next snapshot, or rejects with the refusal's reason.
     */
    features: {
        snapshot(): Promise<FeatureData>;
        subscribe(onChange: (data: FeatureData) => void): () => void;
        act(action: FeatureAction): Promise<FeatureData>;
        /** Where the browser surface's box is, in window coordinates; sent on mount and resize, never polled. */
        setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
        /** The host's own file picker; the paths it answers are what `inbox.send` may attach. `[]` when cancelled. */
        pickFiles(): Promise<string[]>;
    };

    /** The current snapshot. Resolves once; changes arrive through `subscribe`. */
    snapshot(): Promise<GenieSnapshot>;
    /** Called whenever the main process's view of the world changes. Returns an unsubscribe. */
    subscribe(onChange: (snapshot: GenieSnapshot) => void): () => void;

    /** One agent's detail, or `null` for an id that is not registered. */
    agentDetail(agentId: string): Promise<AgentDetail | null>;
    /** Changes to one agent. Separate from `subscribe` so a ledger is not broadcast. */
    subscribeAgent(agentId: string, onChange: (detail: AgentDetail | null) => void): () => void;

    /** The host asking the window to go somewhere (the tray's Settings…). Absent on a remote bridge: a remote window is not this host's tray. */
    onNavigate?(onRoute: (route: string) => void): () => void;

    /** Start or REATTACH a session. Never creates a second for the same agent. */
    openAgent(agentId: string): void;
    /** Stop means stop: the provider tree goes, and the capacity slot frees. */
    stopAgent(agentId: string): void;
    prompt(agentId: string, text: string): void;
    /**
     * Answer a parked approval, with the PROVIDER'S own option id.
     *
     * The id goes back over the wire verbatim and the main process checks it against the
     * request before sending it on — the renderer is not trusted to produce a valid one, and
     * a provider receiving an option it never offered is a protocol error at best.
     */
    answerApproval(agentId: string, optionId: string): void;
    /**
     * "Restart with this" on a finish (§4.5): stop, start, and send the agent its own handoff note
     * as the first prompt; the finish is marked seen only when the prompt was taken. A refusal
     * names its reason and leaves the item on the Deck.
     */
    restartWithHandoff(agentId: string, finishedId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    addAgent(workspaceId: string): void;
    /**
     * Open the folder picker and register what the user chose.
     *
     * The first-run invitation's one action. Genie never guesses a path and never writes into
     * a folder before showing what it found there.
     */
    addWorkspace(): void;

    /**
     * TAKE OVER — open the agent's TUI in a terminal in a NEW window (§1). The main process
     * opens the terminal in the agent's workspace and the window on it; Genie then only
     * watches. The answer says whether it opened and which terminal, or why not.
     */
    takeOver(agentId: string): Promise<{ ok: true; terminalId: string } | { ok: false; reason: string }>;

    /** WORKSPACE OPERATIONS (§6.1). Add is preview-then-confirm: nothing is written before the plan was shown. */
    workspaces: {
        /** The folder picker on the host, then the classification and plan. Writes nothing. */
        previewAdd(): Promise<{ ok: true; path: string; kind: FolderKind; steps: PlanStep[] } | { ok: false; reason: string }>;
        confirmAdd(path: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | { ok: false; reason: string }>;
        /** Add from a git URL (§6.1): the host picks the parent folder; the plan comes back BEFORE any clone. */
        previewAddFromGit(url: string): Promise<{ ok: true; source: 'git'; url: string; parent: string; path: string; kind: FolderKind; steps: PlanStep[] } | { ok: false; reason: string }>;
        confirmAddFromGit(url: string, parent: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | { ok: false; reason: string }>;
        /** From Tynn (§6.1): the parent picked on the host, the project the token belongs to, the plan before anything is written. */
        previewAddFromTynn(): Promise<{ ok: true; source: 'tynn'; project: TynnProject; host: string; parent: string; path: string; kind: FolderKind; steps: PlanStep[] } | { ok: false; reason: string }>;
        confirmAddFromTynn(parent: string): Promise<{ ok: true; id: string; kind: FolderKind; stamped: { from: string | null; backup: string } | null } | { ok: false; reason: string }>;
        hibernate(workspaceId: string): Promise<{ ok: true; asleep: true; handoffs: { landed: string[]; missing: string[] } } | { ok: false; reason: string }>;
        wake(workspaceId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** Forgets the workspace and its agents. The folder on disk is never touched. */
        remove(workspaceId: string): Promise<{ ok: true; agentsForgotten: number; path: string; folderUntouched: true } | { ok: false; reason: string }>;
        /** The repo registry (§6.1): the envelope's repos[]; the host repo cannot be removed. */
        listRepos(workspaceId: string): Promise<{ ok: true; repos: RepoEntry[] } | { ok: false; reason: string }>;
        addRepo(workspaceId: string, input: { name: string; path: string }): Promise<{ ok: true; slug: string } | { ok: false; reason: string }>;
        removeRepo(workspaceId: string, slug: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** This workspace's effective values for the workspace-scoped settings and which keys it overrides (§6.1). */
        settings(workspaceId: string): Promise<{ ok: true; values: Record<string, boolean | string>; overridden: string[] } | { ok: false; reason: string }>;
        setSetting(workspaceId: string, key: string, value: boolean | string): Promise<{ ok: true } | { ok: false; reason: string }>;
        resetSetting(workspaceId: string, key: string): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** Ops projects (§6.1): which other workspaces this one governs; known ids only, never itself. */
        setGoverns(workspaceId: string, childIds: readonly string[]): Promise<{ ok: true; governs: string[] } | { ok: false; reason: string }>;
    };

    /** AGENT OPERATIONS (§6.2). Each answers with what happened or why not; nothing is silent. */
    agents: {
        /** Graceful resumes the same thread and REFUSES when it cannot; fresh discards it on purpose. */
        restart(agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' } | { ok: true; kind: 'fresh'; discarded: string | null } | { ok: false; reason: string }>;
        /** What a delete WOULD do — shown before the person confirms. Touches nothing. */
        previewDelete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        delete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        switchDriver(agentId: string, to: string): Promise<SwitchDecision>;
        setBudget(agentId: string, dailyLimitUsd: number | null): Promise<{ ok: true; decision: BudgetDecision } | { ok: false; reason: string }>;
        diagnose(agentId: string): Promise<{ ok: true; diagnosis: Diagnosis } | { ok: false; reason: string }>;
        /** Mode is wording for the agent (§6.2), not a permission boundary. */
        setMode(agentId: string, mode: 'automated' | 'manual'): Promise<{ ok: true } | { ok: false; reason: string }>;
        /** The agent's own half of who may message it (§6.4). */
        setAccessScope(agentId: string, scope: 'none' | 'self' | 'all'): Promise<{ ok: true } | { ok: false; reason: string }>;
    };

    /**
     * TERMINALS — for shells, builds, services and hosted sites. **No agent has one.**
     *
     * Keyed by WORKSPACE, never by agent: there is no way to express "a terminal for this
     * agent" through this contract, which is the renderer's half of the one rule. Output and
     * exits are pushed; the renderer holds them in `workspace-view.ts` and hands the buffer to
     * `fancy-term`'s controlled `output` prop.
     */
    terminals: {
        open(
            workspaceId: string,
            options: { cols: number; rows: number; command?: string },
        ): Promise<{ id: string; pid: number; shell: string; scrollback: string }>;
        write(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        close(id: string): void;
        /** Open terminals in one workspace — so a window that reloads can re-attach (§6.5). */
        list(workspaceId: string): Promise<readonly { id: string; pid: number; shell: string }[]>;
        /**
         * JOIN a running terminal (§6.5 multi-attach): its scrollback so far; the live bytes follow on `onData`. Null when it is
         * gone or not this workspace's. `null` for the workspace means "whichever it is in" — the host's OWN windows may; a remote
         * connection always names the workspace, because that is what its scope is checked against.
         */
        attach(workspaceId: string | null, id: string): Promise<{ id: string; pid: number; shell: string; scrollback: string } | null>;
        /** The previous session's scrollback for this workspace, ONCE (§6.5); `null` when there is none. */
        previousSession(workspaceId: string): Promise<string | null>;
        onData(listener: (id: string, data: string) => void): () => void;
        onExit(listener: (id: string, exitCode: number) => void): () => void;
    };

    /**
     * THE FILE PANEL (§4.3) — one per workspace. Reads are confined to the workspace root in main;
     * refusals come back in words. `onChange` is a push from the host's watcher, never a poll.
     */
    files: {
        /** The workspace tree without .git or node_modules; `null` for an unknown workspace. */
        tree(workspaceId: string): Promise<readonly TreeNode[] | null>;
        open(workspaceId: string, path: string): Promise<OpenResult>;
        state(workspaceId: string): Promise<FilesState | null>;
        watch(workspaceId: string): Promise<void>;
        onChange(listener: (workspaceId: string) => void): () => void;
        /** Write against the sha that was read; a changed file comes back as a conflict, never overwritten (§4.3). */
        write(workspaceId: string, path: string, text: string, expectedSha: string | null): Promise<WriteResult>;
        /** The popped-out panels (§4.3): host-only windows, so a remote bridge has none of this. */
        windows?: {
            popOut(workspaceId: string): Promise<void>;
            bringBack(workspaceId: string): Promise<void>;
            list(): Promise<readonly string[]>;
            onChange(listener: (popped: readonly string[]) => void): () => void;
        };
    };

    /**
     * UPDATES — §7. The main process owns the state machine (`UpdateHost`); the renderer only
     * asks and shows. Nothing downloads without `download()`, nothing installs without
     * `install()`, and both answer honestly when refused: `false` / `null`, never a silent
     * no-op. `install` answers with the §7.2 teardown report — what had to be stopped — before
     * the app quits to apply.
     */
    updates: {
        state(): Promise<UpdateState>;
        subscribe(onChange: (state: UpdateState) => void): () => void;
        check(): Promise<UpdateState>;
        download(): Promise<boolean>;
        /** Abandon a drain in progress (§7.5): nothing stopped, nothing installed; `false` when there is none. */
        cancel(): Promise<boolean>;
        install(): Promise<{ report: string } | null>;
    };

    /** A phone's upload (§6.8): only the remote bridge has it — the desktop picks files natively. */
    uploads?: {
        sendFile(to: string, text: string, name: string, base64: string): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }>;
    };
}

/** Mirror of `src/main/updater.ts`'s state, crossed as-is — every unknown is `null`. */
export interface UpdateState {
    phase: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'draining' | 'installing' | 'error';
    version: string | null;
    percent: number | null;
    error: string | null;
    checkedAt: number | null;
    /** The drain roster (§7.5) while agents are asked for their handoffs; absent otherwise. */
    drain?: DrainRoster | null;
}

/** The updates bridge when there is no bridge: idle forever, every action refused. */
export const NO_UPDATES: GenieBridge['updates'] = {
    state: () => Promise.resolve({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null }),
    subscribe: () => () => {},
    check: () => Promise.resolve({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null }),
    download: () => Promise.resolve(false),
    cancel: () => Promise.resolve(false),
    install: () => Promise.resolve(null),
};

/**
 * Which surfaces this build can actually render.
 *
 * Exported from here because both the shell and the rail read it, and the rail's rows are
 * DERIVED from it — see `railSurfacesFor`. Two lists would drift, and the failure is silent in
 * both directions: a row that navigates nowhere, or a surface nothing points at.
 *
 * **Add a surface in the commit that makes it render, never before.**
 */
/** No main process (tests, the live check): first-paint data, and actions refused out loud. */
export const NO_FEATURES: GenieBridge['features'] = {
    snapshot: async () => EMPTY_FEATURES,
    subscribe: () => () => {},
    act: async () => { throw new Error('no main process to act on'); },
    setBrowserBounds: async () => {},
    pickFiles: async () => [],
};

export const SERVABLE: readonly Surface[] = ['dashboard', 'agent', 'deck', 'workspace', 'takeover', 'files', 'knowledge', 'flows', 'hosting', 'toolchain', 'inbox', 'settings', 'browser'];

/**
 * The terminal bridge when there is NO bridge — a render test, or `App` before `window.genie`
 * exists. Every call is a no-op and every list is empty, which is the honest answer: nothing
 * is opened, nothing is written, nothing is claimed. Never a fake terminal.
 */
export const NO_FILES: GenieBridge['files'] = {
    tree: () => Promise.resolve(null),
    open: (_w, path) => Promise.resolve({ ok: false as const, path, error: 'no files host is attached' }),
    state: () => Promise.resolve(null),
    watch: () => Promise.resolve(),
    onChange: () => () => {},
    write: async () => ({ ok: false as const, reason: 'no files host is attached' }),
};

export const NO_TERMINALS: GenieBridge['terminals'] = {
    open: () => Promise.reject(new Error('no terminal engine is attached')),
    write: () => {},
    resize: () => {},
    close: () => {},
    list: () => Promise.resolve([]),
    attach: () => Promise.resolve(null),
    previousSession: () => Promise.resolve(null),
    onData: () => () => {},
    onExit: () => () => {},
};

declare global {
    interface Window {
        /**
         * Present only in the real app. It is optional on purpose: a renderer that assumes a
         * bridge cannot be rendered in a test, and the surfaces are then only ever checked by
         * launching the app — which is exactly how four releases shipped unexamined.
         */
        genie?: GenieBridge;
    }
}

/**
 * The snapshot a surface starts from before the bridge has answered.
 *
 * **Everything unknowable is `null`, and `agents` is empty with `workspaces` empty too.** This
 * is the state that renders skeletons, and it is deliberately NOT "zero agents in zero
 * workspaces": *"No agents"* and *"we have not heard yet"* are different claims, and first
 * paint must make the second one.
 */
export const EMPTY_SNAPSHOT: GenieSnapshot = {
    agents: [],
    workspaces: null,
    deckItems: null,
    signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
    workstation: null,
};
