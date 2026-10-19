import { readChatDockWidth } from '../core/chat-width.js';
import { providerLogin } from '../core/provider-login.js';
import { formatLanes, parseLanes } from '../core/lanes.js';
import { formatRoute, parseRoute, routeWorkspace } from '../core/route.js';
import { Icon } from '@particle-academy/react-fancy';
import { type DockPanel, type DockNotice, type PinnedPanel } from '../core/dock.js';
import { chatScope, followChat } from '../core/chat-scope.js';
import { composerMeter } from '../core/composer.js';
import { updateChip } from '../core/update-chip.js';
import { useControlsInset, useOverlayColors } from './window-chrome.js';
import { Deck } from './components/Deck.js';
import { ApprovalToasts } from './components/ApprovalToasts.js';
import { deckItemFor, needsYouCount, type DeckItem } from '../core/deck.js';
import type { LiveSession } from '../core/roster.js';
import { turnStopOffered } from '../core/agent-view.js';
import { railSurfacesFor, railWorkspaces, type Surface } from '../core/rail-view.js';
import { AgentView, type AgentOpsProps } from './components/AgentView.js';
import { ChatFlyout, type ChatThread } from './components/ChatFlyout.js';
import { Dashboard } from './components/Dashboard.js';
import { Onboarding } from './components/Onboarding.js';
import { Sidebar } from './components/Sidebar.js';
import { TitleBar } from './components/TitleBar.js';
import { UpdateWindow } from './components/UpdateWindow.js';
import { Workspace, type WorkspaceOpsProps } from './components/Workspace.js';
import { WorkspaceTabs } from './components/WorkspaceTabs.js';
import { addTab, parseTabs, serializeTabs, workspaceViewRoute } from '../core/workspace-tabs.js';
import { FilesPanelContainer } from './components/FilesPanelContainer.js';
import { AddFromGitForm, AddWorkspacePreview, type AddPreviewView } from './components/AddWorkspacePreview.js';
import { TynnProjectPicker, type TynnProjectsView } from './components/TynnProjectPicker.js';
import { WorkspaceRuntimeModal } from './components/WorkspaceRuntimeModal.js';
import { BrowserSurface, FlowsSurface, HostingSurface, InboxSurface, KnowledgeSurface, SettingsSurface, ToolchainSurface, type RemoteConnectProps } from './components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from './features.js';
import type { ProviderStatus } from './components/FeatureSurfaces.js';
import { openFileRoute } from '../core/files-panel.js';
import { bindingsFrom } from '../core/hotkeys.js';
import type { WorkspaceFault } from '../core/dashboard-view.js';
import type { RepoCommit } from '../core/commits.js';
import { NO_FILES, NO_TERMINALS, NO_UPDATES, type AgentDetail, type GenieBridge, type GenieSnapshot, type UpdateState } from './bridge.js';
import { useEffect, useState } from 'react';
import type { Attachment } from '../core/prompt-content.js';

/**
 * The updater's state, pushed by the main process. Starts as `null` — "no updater has said
 * anything" — which the strip renders as nothing (§5), not as "no update".
 */
function useUpdateState(updates: GenieBridge['updates']): UpdateState | null {
    const [state, setState] = useState<UpdateState | null>(null);
    useEffect(() => {
        let live = true;
        void updates.state().then((s) => { if (live) setState(s); });
        const off = updates.subscribe((s) => { if (live) setState(s); });
        return () => { live = false; off(); };
    }, [updates]);
    return state;
}

/**
 * THE SHELL — chrome, route, surface, and **no effects**.
 *
 * Everything here is a function of `(route, snapshot)`. The hash listener, the bridge
 * subscription and the redirect all live in `App`, one layer out.
 *
 * That split is not tidiness. A shell that owns its own data loading can only be rendered by
 * launching Electron, so the only way to look at it is to open the app — and nobody opened
 * the app for four releases. This one renders from a plain object, which means the surfaces
 * can be asserted on, with real agents in them, in a test that runs on CI.
 *
 * ## Which surfaces the rail offers
 *
 * `available` is the honest list of what this build can render; the rail **omits** the rest
 * rather than disabling it. Each phase has to leave the app usable, and a rail offering a
 * route the shell cannot serve is the previous attempt's "built and unreachable" with the
 * arrow reversed.
 *
 * **Add a surface to that list in the same commit that makes it render, never before.**
 */

export interface ShellProps {
    route: string;
    snapshot: GenieSnapshot;
    /** Workspace-level faults (a missing repo) by workspace id, from each workspace's registry; absent = none seen. */
    workspaceFaults?: Readonly<Record<string, WorkspaceFault | null | undefined>> | undefined;
    /** The fault's fix: the host's folder picker and the manifest write. Absent = the registry door. */
    onLocateRepo?: ((workspaceId: string, repo: string) => void) | undefined;
    /** Which surfaces this build renders. The rail's rows are DERIVED from it, not parallel. */
    servable: readonly Surface[];
    /** The agent the route names, when it names one. `null` while loading or if unknown. */
    agentDetail: AgentDetail | null;
    /** Whether `agentDetail` has been looked up yet — `null` alone cannot say. */
    agentResolved: boolean;
    selectedRowId: string | null;
    /** The chat thread the route names, when it names one. */
    chatThread: ChatThread | null;
    /** The agents you last chatted with, newest first (`rememberThread`): a workspace's chat opens on the latest there. */
    openedThreads?: readonly string[] | undefined;
    /** The chat subject's session (§4.4): its approval is answered where the composer is; its running turn gets `[Stop]`. */
    chatSession?: LiveSession | null | undefined;
    /** What the feature surfaces render from; `null` sections draw skeletons. Defaults to nothing asked yet. */
    features?: FeatureData | undefined;
    /** A feature surface asking the main process for something. */
    onFeature?: ((action: FeatureAction) => void) | undefined;
    /** The host's file picker for attachments (§6.4); absent = no Attach button. */
    pickFiles?: (() => Promise<string[]>) | undefined;
    /** The browser surface's box, for main to place the view over. */
    onBrowserBounds?: ((b: { x: number; y: number; width: number; height: number }) => void) | undefined;
    /** NOT DRAWN since 2026-10-19 (the chat holds the side for good); the pin model is removed in its own cleanup row. */
    pinned: PinnedPanel | null;
    onNavigate: (route: string) => void;
    onSend: (agentId: string, text: string, attachments?: readonly Attachment[]) => void;
    /** `null` unless an answer is in flight, so the buttons can refuse a second press. */
    answeringApproval: string | null;
    onAnswerApproval: (optionId: string) => void;
    /** Answering from the DECK names its agent, because the route is not on that agent. */
    /** An inline answer on a Deck item. The ITEM travels, because which channel it takes is decided by its id. */
    onAnswerDeckItem: (item: DeckItem, optionId: string) => void;
    /** A multi-part question's form, filled in place (§4.5): labels and one note per question. */
    onAnswerDeckForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
    /** The last refused form answer, said beside that item's Answer button. */
    deckFormRefusal?: { itemId: string; reason: string } | null | undefined;
    /** NOT USED since 2026-10-19: the chat cannot be closed. Removed with the pin model's cleanup row. */
    onCloseChat?: (() => void) | undefined;
    /** `Restart <agent> and send` on an undelivered chat draft (§4.4). */
    onRestartAndSend?: ((draftId: string) => void) | undefined;
    onOpenAgent: (agentId: string) => void;
    /** The agents open as tabs in the workspace on screen, and closing one (Tynn #805). */
    openAgentTabs?: { workspaceId: string; agents: ReadonlyArray<{ id: string; name: string; state: string }>; onClose: (agentId: string) => void } | null | undefined;
    onAddAgent: (workspaceId: string) => void;
    /** The first-run invitation. Without it that button is a control that does nothing. */
    onAddWorkspace: () => void;
    /** The terminal half of the bridge, handed to the Workspace surface. Keyed by workspace, never agent. */
    terminals?: GenieBridge['terminals'];
    /** The file panel's half of the bridge (§4.3); the Workspace surface mounts it for `?panel=files`. */
    files?: GenieBridge['files'] | undefined;
    /** The commits in a workspace's repos since a moment (an observed agent's Activity tab); absent = no section. */
    readCommits?: ((workspaceId: string, sinceMs: number) => Promise<readonly RepoCommit[]>) | undefined;
    /** NOT DRAWN since 2026-10-19: a workspace's file panel shows inline or pops out. Removed with the pin model. */
    filesWorkspaceId?: string | null | undefined;
    /** Pin or unpin a workspace's file panel into the single dock slot (§4.4). */
    onToggleFilesPin?: ((workspaceId: string) => void) | undefined;
    /** Workspaces whose file panel is in its own window (§4.3): the dock holds a bar, not the panel. */
    filesPopped?: readonly string[] | undefined;
    onPopOutFiles?: ((workspaceId: string) => void) | undefined;
    onBringBackFiles?: ((workspaceId: string) => void) | undefined;
    /** An agent is writing a file you have dirty (§4.3): the ask, and its lifting. */
    onPauseAgent?: ((agent: string, path: string) => void) | undefined;
    onResumeAgent?: ((agent: string, path: string) => void) | undefined;
    /** The dock's notice after a pin (§4.4): a handoff or a refusal, one line under the title bar. */
    dockNotice?: DockNotice | null | undefined;
    onDismissDockNotice?: (() => void) | undefined;
    /** The docked file panel reports its dirty buffers, so the refusal is real. */
    onFilesDirtyChange?: ((dirty: boolean) => void) | undefined;
    /** The updates half of the bridge (§7); the Deck's signal strip shows it and acts on it. */
    updates?: GenieBridge['updates'];
    /** The native window buttons over the title bar (their space and colours); absent in a browser or on a phone. */
    windowChrome?: GenieBridge['windowChrome'];
    onTakeOver?: ((agentId: string) => void) | undefined;
    /** A broken row's `Restart` (graceful) from the Dashboard — the same operation the Agent view's header offers. */
    onRestartAgent?: ((agentId: string) => void) | undefined;
    /** "Stop agent" — END the agent's session (§6.2 stop): the Agent view's operations menu. Not the turn's Stop. */
    onStopAgent?: ((agentId: string) => void) | undefined;
    /** `Stop this turn` — the Agent view's header and the chat's context line: the turn ends, the agent keeps running. */
    onCancelTurn?: ((agentId: string) => void) | undefined;
    /** `Resume now` while the agent's provider login is held for its rate limit (Tynn #794). */
    onResumeLimit?: ((agentId: string) => void) | undefined;
    onProviderLogin?: ((agentId: string) => void) | undefined;
    /** Start an agent that is not running (the Agent view's Start). */
    onStartAgent?: ((agentId: string) => void) | undefined;
    onOpenPalette: () => void;
    onSelectRow: (rowId: string | null) => void;
    /** Driving another machine: the title bar's REMOTE badge. Absent on the local machine. */
    remote?: ShellRemote | undefined;
    /** The client side of remote: this window driving another machine (Settings → Workstation). */
    remoteConnect?: RemoteConnectProps | undefined;
    /** Agent operations (§6.2) for the Agent view; absent when this window cannot operate agents. */
    agentOps?: AgentOpsProps | undefined;
    /** Workspace operations (§6.1) for the Workspace surface; absent when this window cannot operate workspaces. */
    workspaceOps?: WorkspaceOpsProps | undefined;
    /** A folder picked and classified, awaiting confirmation — shown over the Dashboard / onboarding. */
    addPreview?: AddPreviewView | null | undefined;
    /** Add from a git URL (§6.1): the form is up, and what its two steps call. */
    addFromGit?: boolean | undefined;
    onAddWorkspaceFromGit?: (() => void) | undefined;
    onPreviewFromGit?: ((url: string) => void) | undefined;
    onConfirmAddGit?: ((url: string, parent: string) => void) | undefined;
    /** From Tynn (§6.1, Genie 1's): the person's projects to pick from (`undefined` = not picking); then the host's folder picker and the plan. */
    tynnPick?: TynnProjectsView | undefined;
    onAddWorkspaceFromTynn?: (() => void) | undefined;
    onPickTynnProject?: ((projectId: string) => void) | undefined;
    onCancelTynnPick?: (() => void) | undefined;
    onConfirmAddTynn?: ((parent: string, projectId: string) => void) | undefined;
    onCancelAddGit?: (() => void) | undefined;
    onConfirmAdd?: ((path: string) => void) | undefined;
    onCancelAdd?: (() => void) | undefined;
}

/**
 * The Providers page (Settings → Agents): each agent CLI Genie runs, installed or not (Toolchain), and the first of its
 * agents that is signed out (#971) with that agent's Log in. `undefined` until Toolchain has looked.
 */
function providerStatuses(features: FeatureData, agents: readonly { id: string; name: string; provider: string; signedOut?: boolean | undefined }[], onLogin: ((agentId: string) => void) | undefined): ProviderStatus[] | undefined {
    if (!features.toolchain) return undefined;
    const tools = features.toolchain.tools;
    return [
        { provider: 'claude', name: 'Claude Code', tool: 'claude-code' },
        { provider: 'codex', name: 'Codex', tool: 'codex' },
    ].map(({ provider, name, tool }) => {
        const t = tools.find((x) => x.tool === tool);
        const out = agents.find((a) => a.provider === provider && a.signedOut === true);
        return { provider, name, installed: t ? t.installed !== null : null, version: t?.installed ?? null, signedOut: out ? { agentId: out.id, agentName: out.name } : null, ...(onLogin ? { onLogin } : {}) };
    });
}

export type ShellRemote = { host: string; driver: string | null; driving: boolean; locked: boolean } | null;

/** The dock's panels, as the notice names them (§4.4). */
const PANEL_NAME: Record<DockPanel, string> = { chat: 'chat', files: 'file panel', lists: 'lists' };

/** No Deck items yet: one array, so the toasts see the same list on every render until the snapshot brings one. */
const NO_DECK_ITEMS: readonly DeckItem[] = [];

export function Shell({
    route,
    snapshot,
    workspaceFaults,
    onLocateRepo,
    servable,
    features = EMPTY_FEATURES,
    onFeature = () => {},
    pickFiles,
    onBrowserBounds,
    agentDetail,
    agentResolved,
    selectedRowId,
    chatThread,
    openedThreads,
    chatSession = null,
    onNavigate,
    onOpenAgent,
    openAgentTabs,
    onAddAgent,
    onAddWorkspace,
    terminals = NO_TERMINALS,
    files = NO_FILES,
    filesPopped = [],
    readCommits,
    onPopOutFiles,
    onBringBackFiles,
    onPauseAgent,
    onResumeAgent,
    dockNotice = null,
    onDismissDockNotice,
    onFilesDirtyChange,
    updates = NO_UPDATES,
    windowChrome,
    onTakeOver,
    onRestartAgent,
    onStopAgent,
    onCancelTurn,
    onResumeLimit,
    onProviderLogin,
    onStartAgent,
    onOpenPalette,
    onSelectRow,
    onSend,
    onRestartAndSend,
    answeringApproval,
    onAnswerApproval,
    onAnswerDeckItem,
    onAnswerDeckForm,
    deckFormRefusal,
    remote,
    remoteConnect,
    agentOps,
    workspaceOps,
    addPreview,
    addFromGit,
    onAddWorkspaceFromGit,
    onPreviewFromGit,
    onConfirmAddGit,
    onAddWorkspaceFromTynn,
    onConfirmAddTynn,
    tynnPick,
    onPickTynnProject,
    onCancelTynnPick,
    onCancelAddGit,
    onConfirmAdd,
    onCancelAdd,
}: ShellProps) {
    const parsed = parseRoute(route);
    const updateState = useUpdateState(updates);
    // The update window (what is in the update): open from the header's update button until closed.
    const [updateOpen, setUpdateOpen] = useState(false);
    // A workspace row's process / site indicator opened that workspace's config (Genie 1's modals).
    const [runtimeModal, setRuntimeModal] = useState<{ kind: 'processes' | 'sites'; workspaceId: string } | null>(null);
    const runtimeWorkspace = runtimeModal ? (snapshot.workspaces ?? []).find((w) => w.id === runtimeModal.workspaceId) ?? null : null;
    // The native window buttons: the space they take, and the theme's colours on them (the owner: content covered, wrong colours).
    const controlsInset = useControlsInset(windowChrome?.overlay === true);
    useOverlayColors(windowChrome);
    // The AgentInbox composer's picked files (§6.4): held here, cleared after a send.
    const [attachments, setAttachments] = useState<readonly string[]>([]);
    const inboxCompose = pickFiles
        ? {
              attachments,
              onPick: () => { void pickFiles().then((paths) => setAttachments((a) => [...a, ...paths.filter((p) => !a.includes(p))])); },
              onRemove: (path: string) => setAttachments((a) => a.filter((p) => p !== path)),
              onClear: () => setAttachments([]),
          }
        : undefined;
    /** The workspace a route names, from the snapshot — `null` both for unknown and not-yet-loaded; the caller tells them apart. */
    const workspaceFor = (id: string) => snapshot.workspaces?.find((w) => w.id === id) ?? null;
    // The workspace an agent's page belongs to (Tynn #805): its strip is drawn over the page.
    const agentWorkspace = parsed.surface === 'agent' ? workspaceFor(snapshot.agents.find((a) => a.id === parsed.agentId)?.workspaceId ?? '') : null;
    const canServe = servable.includes(parsed.surface);

    /*
     * THE CHAT IS A COLUMN OF THE ROW, beside the page (the owner, 2026-10-19: "the chat still covers up the UX. Chat cannot
     * be closed PERIOD"). It used to float over the page (`position: absolute`), each page making room with a margin on
     * every child but its view header — and since agents open inside their workspace a page has two headers; the first was
     * measured, so the agent's own header ran on under the chat. A column cannot cover anything, however a page nests.
     * Always there: its width is the person's (Tynn #798), remembered and dragged live.
     */
    const [chatDockWidth, setChatDockWidth] = useState(() => readChatDockWidth(typeof window === 'undefined' ? null : (() => { try { return window.localStorage; } catch { return null; } })()));

    /**
     * The approval the FLYOUT may answer — only when this chat is the composer for the agent
     * the approval belongs to. `approvalPlacement`'s decision, applied at the other end.
     *
     * Hoisted rather than inlined because a JSX expression container cannot sit between
     * attributes, and the reasoning is worth more than the saved line.
     */
    // The chat is the composer for ITS subject wherever the view is, so the approval comes from the subject's own session
    // (the Agent view shows the marker) — not only when the routed agent happens to be the subject.
    const chatApproval = chatThread ? chatSession?.pendingApproval ?? (agentDetail?.agent.id === chatThread.agentId ? agentDetail.session?.pendingApproval ?? null : null) : null;
    // `Stop this turn` in the chat: only while its agent's turn runs AND can be stopped with the agent kept — the same
    // rule as the Agent view's header (`turnStopOffered`). Never the session's stop (the owner, 2026-10-15).
    const chatTurnStop = chatThread !== null && onCancelTurn !== undefined && turnStopOffered(chatSession);
    // Which workspace the chat talks to, against the one on screen (core/chat-scope.ts; the owner's beta.26 report): another
    // workspace's agent is NAMED in the composer, and a workspace with no agent to message has no composer at all.
    const scope = chatScope({ ...parsed, chat: chatThread?.agentId ?? parsed.chat }, snapshot.agents, snapshot.workspaces);

    return (
        <div className="flex h-full flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <TitleBar
                route={route}
                controlsInset={controlsInset}
                workstation={snapshot.workstation}
                remote={remote}
                onNavigate={onNavigate}
                onOpenPalette={onOpenPalette}
                paletteKey={bindingsFrom(features.settings.values).commandWindow ?? undefined}
                update={updateChip(updateState)}
                version={features.version ?? null}
                onOpenUpdate={() => setUpdateOpen(true)}
            />
            {/* WHAT IS IN THIS UPDATE (Genie 1's upgrade window; the owner, 2026-10-19), opened from the header's update button. */}
            {updateOpen && updateChip(updateState) ? (
                <UpdateWindow
                    update={updateChip(updateState)!}
                    onClose={() => setUpdateOpen(false)}
                    onAction={(action) => {
                        if (action === 'update-download') void updates.download();
                        else if (action === 'update-install') void updates.install();
                    }}
                />
            ) : null}
            {/* A workspace's background processes or sites, from its row's indicator (Genie 1's modals). */}
            {runtimeModal && runtimeWorkspace ? (
                <WorkspaceRuntimeModal kind={runtimeModal.kind} workspace={runtimeWorkspace} data={features} onAction={onFeature} onClose={() => setRuntimeModal(null)} />
            ) : null}

            {/* THE DOCK'S NOTICE (§4.4): a second pin replaces the first VISIBLY; a refusal says why and offers pop-out. */}
            {dockNotice ? (
                <div data-dock-notice={dockNotice.kind} className="flex h-8 shrink-0 items-center gap-3 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 text-[12px] text-[var(--fg-2)]">
                    <Icon name={dockNotice.kind === 'refused' ? 'circle-alert' : 'arrow-right-left'} size="xs" className={dockNotice.kind === 'refused' ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'} />
                    <span className="min-w-0 flex-1 truncate">
                        {dockNotice.kind === 'replaced'
                            ? `The ${PANEL_NAME[dockNotice.replaced]} is no longer pinned; the ${dockNotice.pinned ? PANEL_NAME[dockNotice.pinned] : 'dock'} took the dock.`
                            : dockNotice.reason}
                    </span>
                    {dockNotice.kind === 'refused' && dockNotice.workspaceId && onPopOutFiles ? (
                        <button type="button" data-action="pop-out-files" data-workspace={dockNotice.workspaceId} onClick={() => { onPopOutFiles(dockNotice.workspaceId!); onDismissDockNotice?.(); }} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-2)]">Pop the file panel out</button>
                    ) : null}
                    <button type="button" data-action="dismiss-dock-notice" aria-label="Dismiss" onClick={() => onDismissDockNotice?.()} className="text-[var(--fg-4)] hover:text-[var(--fg-2)]"><Icon name="x" size="xs" /></button>
                </div>
            ) : null}

            <div className="relative flex min-h-0 flex-1">
                <Sidebar
                    route={route}
                    // The badge is what is WAITING on you (§4.5) — a finished agent's handoff is read, not resolved.
                    deckCount={snapshot.deckItems === null ? null : needsYouCount(snapshot.deckItems)}
                    // Genie 1's row: the pulse from the agents' sessions, and the process / site indicators from Hosting.
                    workspaces={railWorkspaces(snapshot.workspaces ?? [], snapshot.agents, { processes: features.hosting?.processes ?? [], sites: features.hosting?.sites ?? [] })}
                    onOpenProcesses={(workspaceId) => setRuntimeModal({ kind: 'processes', workspaceId })}
                    onOpenSites={(workspaceId) => setRuntimeModal({ kind: 'sites', workspaceId })}
                    // On an agent's page its workspace stays the highlighted row (Tynn #805).
                    currentWorkspaceId={routeWorkspace(route, snapshot.agents)}
                    available={railSurfacesFor(servable)}
                    onNavigate={onNavigate}
                    // Add a workspace from the rail, any time (Tynn #283): the same flow as the Dashboard's.
                    onAddWorkspace={onAddWorkspace}
                />

                <main className="min-w-0 flex-1 overflow-auto">
                    {/*
                     * A route this build cannot serve renders NOTHING here, and `App` redirects
                     * it. The alternative — a surface frame with an empty body — is the one
                     * state a person cannot recover from without knowing a shortcut, and it is
                     * indistinguishable from a load that failed.
                     */}
                    {canServe && parsed.surface === 'dashboard' && snapshot.workspaces !== null && snapshot.workspaces.length === 0 ? (
                        <Onboarding
                            state={{
                                workspaces: snapshot.workspaces.length,
                                agents: snapshot.agents.length,
                                // Providers come from the toolchain scan when one has run; until then NOT a line.
                                providers: features.toolchain ? features.toolchain.tools.filter((t) => (t.tool === 'claude-code' || t.tool === 'codex') && t.installed !== null).map((t) => t.tool) : null,
                                githubConnected: null,
                                // Signed in to Tynn when the integrations section says so; `null` until it has been read.
                                tynnSignedIn: features.integrations?.tynnSignedIn ?? null,
                            }}
                            onAddWorkspace={onAddWorkspace}
                            onAddWorkspaceFromGit={onAddWorkspaceFromGit}
                            onAddWorkspaceFromTynn={onAddWorkspaceFromTynn}
                            onAddAgent={() => { const w = snapshot.workspaces?.[0]; if (w) onAddAgent(w.id); }}
                            onNavigate={onNavigate}
                        />
                    ) : null}
                    {addPreview ? <AddWorkspacePreview preview={addPreview} onConfirm={(p) => onConfirmAdd?.(p)} onConfirmGit={(u, p) => onConfirmAddGit?.(u, p)} onConfirmTynn={(p, id) => onConfirmAddTynn?.(p, id)} onCancel={() => onCancelAdd?.()} /> : null}
                    {addFromGit && !addPreview ? <AddFromGitForm onPreview={(u) => onPreviewFromGit?.(u)} onCancel={() => onCancelAddGit?.()} /> : null}
                    {tynnPick !== undefined && !addPreview ? <TynnProjectPicker state={tynnPick} onPick={(id) => onPickTynnProject?.(id)} onCancel={() => onCancelTynnPick?.()} /> : null}
                    {/*
                     * ONE first-run invitation. With no workspaces the Onboarding above IS the first run (§6.9's two
                     * steps); the Dashboard's own invitation would stack a second one under it — measured on the
                     * board audit. The skeleton (`workspaces === null`) still belongs to the Dashboard.
                     */}
                    {canServe && parsed.surface === 'dashboard' && (snapshot.workspaces === null || snapshot.workspaces.length > 0) ? (
                        <Dashboard
                            rows={snapshot.agents}
                            // Genie's own row, its group first (the design mockup).
                            genie={snapshot.osAgent ?? null}
                            workspaces={snapshot.workspaces}
                            // A WAITING row is a door to its Deck item (§4.1): the Deck resolves, the Dashboard shows.
                            onOpenAgent={(id) => {
                                const item = deckItemFor(id, snapshot.deckItems ?? []);
                                if (item) onNavigate(`genie://deck?item=${encodeURIComponent(item)}`);
                                else onOpenAgent(id);
                            }}
                            onAddAgent={onAddAgent}
                            onAddWorkspace={onAddWorkspace}
                            onAddWorkspaceFromGit={onAddWorkspaceFromGit}
                            onAddWorkspaceFromTynn={onAddWorkspaceFromTynn}
                            group={parsed.group}
                            onGroup={(group) => onNavigate(formatRoute({ ...parsed, group }))}
                            // The row tray's doors (Open agent / Terminal / Files).
                            onNavigate={onNavigate}
                            onOpenWorkspace={(id) => onNavigate(`genie://workspace/${id}`)}
                            faults={workspaceFaults}
                            // The fix: the host's picker and the manifest write; without a bridge for it, the registry's page.
                            onLocateRepo={onLocateRepo ?? ((id) => onNavigate(`genie://workspace/${id}`))}
                            onFix={(fix) => {
                                // The board's fix buttons act (`fixRoute`): two verbs Genie performs, else the agent's page.
                                if (fix.kind === 'restart') onRestartAgent?.(fix.agentId);
                                else if (fix.kind === 'takeover') onTakeOver?.(fix.agentId);
                                else onOpenAgent(fix.agentId);
                            }}
                            onChat={() => onNavigate(formatRoute({ ...parsed, chat: 'genie' }))}
                        />
                    ) : null}

                    {canServe && parsed.surface === 'knowledge' ? <KnowledgeSurface data={features} onAction={onFeature} onNavigate={onNavigate} workspaces={snapshot.workspaces ?? []} /> : null}
                    {canServe && parsed.surface === 'flows' ? <FlowsSurface data={features} onAction={onFeature} onNavigate={onNavigate} workspaces={snapshot.workspaces ?? []} adding={features.flows?.adding ? { kind: 'flow', ...features.flows.adding } : undefined} onCloseForm={() => onFeature({ kind: 'flows.cancelForm' })} /> : null}
                    {canServe && parsed.surface === 'hosting' ? <HostingSurface tab={parsed.tab} data={features} onAction={onFeature} onNavigate={onNavigate} workspaces={snapshot.workspaces ?? []} adding={features.hosting?.adding ? { kind: 'site', ...features.hosting.adding } : features.services?.adding ? { kind: 'service', ...features.services.adding } : undefined} onCloseForm={() => onFeature({ kind: features.hosting?.adding ? 'hosting.cancelForm' : 'services.cancelForm' })} /> : null}
                    {canServe && parsed.surface === 'toolchain' ? <ToolchainSurface data={features} onAction={onFeature} onNavigate={onNavigate} /> : null}
                    {canServe && parsed.surface === 'inbox' ? <InboxSurface data={features} onAction={onFeature} onNavigate={onNavigate} compose={inboxCompose} /> : null}
                    {canServe && parsed.surface === 'settings' ? <SettingsSurface data={features} onAction={onFeature} onNavigate={onNavigate} section={parsed.section} providers={providerStatuses(features, snapshot.agents, onProviderLogin)} workspaces={snapshot.workspaces ?? []} remoteConnect={remoteConnect} update={{ state: updateState, onCheck: () => { void updates.check(); } }} /> : null}
                    {canServe && parsed.surface === 'browser' ? <BrowserSurface data={features} onAction={onFeature} onNavigate={onNavigate} onBrowserBounds={onBrowserBounds} /> : null}

                    {canServe && parsed.surface === 'deck' ? (
                        <Deck
                            items={snapshot.deckItems ?? []}
                            focusId={parsed.item}
                            signals={{ ...snapshot.signals, update: updateState }}
                            answering={answeringApproval}
                            onAnswer={(item, optionId) => onAnswerDeckItem(item, optionId)}
                            onAnswerForm={onAnswerDeckForm}
                            formRefusal={deckFormRefusal ?? null}
                            // Dismiss without an answer — one (with the notes written in its form), every stale one shown, or
                            // every question older than a day; the agents are told (main).
                            onDismiss={(item, notes) => onFeature({ kind: 'deck.dismiss', item, notes })}
                            onDismissStale={(ids) => onFeature({ kind: 'deck.dismissStale', ids })}
                            onDismissOlder={(olderThanMs) => onFeature({ kind: 'deck.dismissOlder', olderThanMs })}
                            onOpenItem={(item) => { if (item.agentId) onNavigate(`genie://agent/${item.agentId}?tab=stream`); }}
                            onNavigate={onNavigate}
                            onSignalAction={(action) => {
                                if (action === 'update-download') void updates.download();
                                else if (action === 'update-install') void updates.install();
                            }}
                        />
                    ) : null}

                    {canServe && parsed.surface === 'agent' && agentDetail ? (
                        // AN AGENT OPENS INSIDE ITS WORKSPACE (Tynn #805; the owner's choice, as in Genie 1): its page sits under
                        // its workspace's strip — Agents, the agents you opened, your tabs, +, Settings — one click from each.
                        <div data-agent-in-workspace={agentWorkspace?.id ?? ''} className="flex h-full min-h-0 flex-col">
                            {agentWorkspace ? (
                                <WorkspaceTabs
                                    designed={parseTabs(typeof workspaceOps?.settings?.values?.['workspace_tabs'] === 'string' ? (workspaceOps.settings.values['workspace_tabs'] as string) : '{"tabs":[]}')}
                                    openAgents={openAgentTabs?.workspaceId === agentWorkspace.id ? openAgentTabs.agents : []}
                                    current={{ kind: 'agent', id: parsed.agentId }}
                                    canDesign={Boolean(workspaceOps?.settings && workspaceOps.settings.values !== null)}
                                    hasSettings={Boolean(workspaceOps?.settings || workspaceOps?.governs || workspaceOps?.repos)}
                                    github={features.issueWatch?.[agentWorkspace.id]?.linked === true}
                                    onView={(v) => onNavigate(workspaceViewRoute(agentWorkspace.id, v))}
                                    onAdd={() => {
                                        const raw = workspaceOps?.settings?.values?.['workspace_tabs'];
                                        const made = addTab(parseTabs(typeof raw === 'string' ? raw : '{"tabs":[]}'));
                                        workspaceOps?.settings?.onSet('workspace_tabs', serializeTabs(made.state));
                                        onNavigate(workspaceViewRoute(agentWorkspace.id, `tab:${made.id}`));
                                    }}
                                    onOpenAgent={onOpenAgent}
                                    onCloseAgent={(id) => openAgentTabs?.onClose(id)}
                                />
                            ) : null}
                            <div className="min-h-0 flex-1">
                            <AgentView
                                agent={agentDetail.agent}
                                session={agentDetail.session}
                                rows={agentDetail.rows}
                                tab={parsed.tab}
                                lanes={parseLanes(parsed.lane)}
                                readCommits={readCommits}
                                at={parsed.at}
                                layout={parsed.layout}
                                selectedId={selectedRowId}
                                turns={agentDetail.turns}
                                cost={agentDetail.cost}
                                onNavigate={onNavigate}
                                onSelect={onSelectRow}
                                chatSubject={parsed.chat}
                                onLanes={(next) => {
                                    const value = formatLanes(next);
                                    const base = `genie://agent/${agentDetail.agent.id}?tab=${parsed.tab}`;
                                    onNavigate(value === null ? base : `${base}&lane=${value}`);
                                }}
                                range={parsed.range}
                                onRange={(next) => onNavigate(formatRoute({ ...parsed, range: next }))}
                                onTakeOver={onTakeOver}
                                answeringApproval={answeringApproval}
                                onAnswerApproval={onAnswerApproval}
                                ops={agentDetail.agent.fidelity === 'declared' ? agentOps : undefined}
                                files={files}
                                workspace={workspaceFor(snapshot.agents.find((a) => a.id === agentDetail.agent.id)?.workspaceId ?? '') ?? undefined}
                                takeOver={agentDetail.takeOver ?? null}
                                log={agentDetail.log ?? []}
                                onStop={onStopAgent}
                                onCancelTurn={onCancelTurn}
                                onResumeLimit={onResumeLimit}
                                onProviderLogin={onProviderLogin}
                                onStart={onStartAgent}
                                terminals={terminals}
                            />
                            </div>
                        </div>
                    ) : null}

                    {/*
                     * The Workspace surface — §4.6, terminals for shells and builds. Looked up
                     * from the snapshot's workspace list; an unknown id gets the same honest
                     * not-found as an unknown agent, below, rather than a blank body.
                     */}
                    {canServe && parsed.surface === 'workspace' && workspaceFor(parsed.workspaceId) ? (
                        <Workspace
                            key={parsed.workspaceId}
                            // Settings → Hosting opens the same modals as the row's indicators.
                            onOpenRuntime={(kind) => setRuntimeModal({ kind, workspaceId: parsed.workspaceId })}
                            workspace={workspaceFor(parsed.workspaceId)!}
                            terminals={terminals}
                            files={files}
                            panel={parsed.panel}
                            view={parsed.view}
                            issueWatch={features.issueWatch?.[parsed.workspaceId] ?? null}
                            rows={snapshot.agents}
                            // The workspace dashboard's "waiting on you" (q_09d1f4a0): a row opens its item on the Deck.
                            deckItems={snapshot.deckItems ?? NO_DECK_ITEMS}
                            onOpenDeckItem={(id) => onNavigate(`genie://deck?item=${encodeURIComponent(id)}`)}
                            onOpenAgent={onOpenAgent}
                            openAgents={openAgentTabs?.workspaceId === parsed.workspaceId ? openAgentTabs.agents : []}
                            onCloseAgent={(id) => openAgentTabs?.onClose(id)}
                            onAddAgent={() => onAddAgent(parsed.workspaceId)}
                            onViewChange={(view) => onNavigate(formatRoute({ ...parsed, view }))}
                            onTogglePanel={() => onNavigate(formatRoute({ ...parsed, panel: parsed.panel === 'files' ? null : 'files' }))}
                            filesFile={parsed.file}
                            filesLine={parsed.line}
                            filesFilter={parsed.filter}
                            onFilesRoute={(file, filter) => onNavigate(formatRoute({ ...parsed, panel: 'files', file, filter, detached: false }))}
                            onOpenFile={(path, line) => onNavigate(openFileRoute(parsed.workspaceId, path, line))}
                            // The chat holds the side for good: a workspace's file panel shows inline (or pops out), never pinned.
                            filesPinned={false}
                            filesPopped={filesPopped.includes(parsed.workspaceId)}
                            onPopOutFiles={onPopOutFiles ? () => onPopOutFiles(parsed.workspaceId) : undefined}
                            onBringBackFiles={() => onBringBackFiles?.(parsed.workspaceId)}
                            onPauseAgent={onPauseAgent}
                            onResumeAgent={onResumeAgent}
                            pluginPanels={features.plugins?.panels ?? []}
                            ops={workspaceOps}
                        />
                    ) : null}
                    {canServe && parsed.surface === 'workspace' && snapshot.workspaces !== null && !workspaceFor(parsed.workspaceId) ? (
                        <div data-surface="workspace-unknown" className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-[var(--fg-3)]">
                            <p>
                                No workspace is registered as{' '}
                                <span className="font-mono text-[var(--fg-2)]">{parsed.workspaceId}</span>.
                            </p>
                            <button
                                type="button"
                                data-nav="genie://dashboard"
                                onClick={() => onNavigate('genie://dashboard')}
                                className="rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]"
                            >
                                Back to the Dashboard
                            </button>
                        </div>
                    ) : null}

                    {/*
                     * An agent id that is not registered. **Only once the lookup has actually
                     * happened** — `agentDetail === null` is both "not found" and "not asked
                     * yet", and rendering a not-found during the load would flash an error on
                     * every navigation to a perfectly good agent.
                     *
                     * It says what is wrong and offers the way back. A blank body under a
                     * stale address is the one state a person cannot recover from without
                     * knowing a shortcut.
                     */}
                    {canServe && parsed.surface === 'agent' && agentResolved && !agentDetail ? (
                        <div data-surface="agent-unknown" className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-[var(--fg-3)]">
                            <p>
                                No agent is registered as{' '}
                                <span className="font-mono text-[var(--fg-2)]">{parsed.agentId}</span>.
                            </p>
                            <button
                                type="button"
                                data-nav="genie://dashboard"
                                onClick={() => onNavigate('genie://dashboard')}
                                className="rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]"
                            >
                                Back to the Dashboard
                            </button>
                        </div>
                    ) : null}
                </main>

                {/*
                 * THE APPROVAL TOASTS (the owner, 2026-10-15: "I should not have to go to the deck to respond to every single
                 * thing an agent needs"): an agent's gated Genie workflow, answered from any screen with the Deck's own answer,
                 * so answering in either place clears both. Clear of the chat strip, a docked panel or an open flyout. Not
                 * drawn over the Deck itself, which shows the same requests with the same buttons.
                 */}
                <ApprovalToasts
                    items={snapshot.deckItems ?? NO_DECK_ITEMS}
                    dnd={features.settings.values?.do_not_disturb === true}
                    hidden={parsed.surface === 'deck'}
                    onAnswer={onAnswerDeckItem}
                    onOpenDeck={(item) => onNavigate(`genie://deck?item=${encodeURIComponent(item.id)}`)}
                    right={chatDockWidth + 16}
                />
                {/* THE CHAT, always: a column of this row, after the page — never over it, never closed. */}
                <div data-dock-frame="chat" className="flex min-h-0 shrink-0" style={{ width: chatDockWidth }}>
                    <ChatFlyout
                        thread={chatThread}
                        dockWidth={chatDockWidth}
                        onDockWidth={setChatDockWidth}
                        contextUsage={chatThread ? composerMeter(chatSession) : null}
                        approval={chatApproval}
                        commands={chatSession?.extensions?.commands ?? null}
                        answeringApproval={answeringApproval}
                        onAnswerApproval={onAnswerApproval}
                        scope={scope}
                        onSend={(text, attachments) => { if (scope.kind !== 'blocked') onSend(chatThread?.agentId ?? '', text, attachments); }}
                        onRestartAndSend={onRestartAndSend}
                        onStopTurn={chatTurnStop && chatThread ? () => onCancelTurn?.(chatThread.agentId) : undefined}
                        onResumeLimit={chatThread && onResumeLimit && chatSession?.limit && chatSession.limit.state !== 'open' ? () => onResumeLimit(chatThread.agentId) : undefined}
                        onProviderLogin={chatThread && onProviderLogin && chatSession?.signedOut ? { name: providerLogin(snapshot.agents.find((a) => a.id === chatThread.agentId)?.provider ?? '')?.name ?? 'your provider', run: () => onProviderLogin(chatThread.agentId) } : undefined}
                    />
                </div>
            </div>
        </div>
    );
}
