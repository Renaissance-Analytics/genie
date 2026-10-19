import { readChatDockWidth } from '../core/chat-width.js';
import { providerLogin } from '../core/provider-login.js';
import { formatLanes, parseLanes } from '../core/lanes.js';
import { formatRoute, parseRoute, routeWorkspace } from '../core/route.js';
import { Icon } from '@particle-academy/react-fancy';
import { CHAT_STRIP_WIDTH, DOCK_WIDTH, dockHolder, dockReserve, type DockPanel, type DockNotice, type PinnedPanel } from '../core/dock.js';
import { chatScope, followChat } from '../core/chat-scope.js';
import { composerMeter } from '../core/composer.js';
import { filesDock } from '../core/files-popout.js';
import { updateChip } from '../core/update-chip.js';
import { useControlsInset, useOverlayColors } from './window-chrome.js';
import { Deck } from './components/Deck.js';
import { ApprovalToasts } from './components/ApprovalToasts.js';
import { deckItemFor, needsYouCount, type DeckItem } from '../core/deck.js';
import type { LiveSession } from '../core/roster.js';
import { turnStopOffered } from '../core/agent-view.js';
import { railSurfacesFor, railWorkspaces, type Surface } from '../core/rail-view.js';
import { workspaceLabel } from '../core/workspace-label.js';
import { AgentView, type AgentOpsProps } from './components/AgentView.js';
import { ChatFlyout, GenieMark, type ChatThread } from './components/ChatFlyout.js';
import { Dashboard } from './components/Dashboard.js';
import { Onboarding } from './components/Onboarding.js';
import { Sidebar } from './components/Sidebar.js';
import { TitleBar } from './components/TitleBar.js';
import { Workspace, type WorkspaceOpsProps } from './components/Workspace.js';
import { WorkspaceTabs } from './components/WorkspaceTabs.js';
import { addTab, parseTabs, serializeTabs, workspaceViewRoute } from '../core/workspace-tabs.js';
import { FilesPanelContainer } from './components/FilesPanelContainer.js';
import { AddFromGitForm, AddWorkspacePreview, type AddPreviewView } from './components/AddWorkspacePreview.js';
import { BrowserSurface, FlowsSurface, HostingSurface, InboxSurface, KnowledgeSurface, SettingsSurface, ToolchainSurface, type RemoteConnectProps } from './components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from './features.js';
import { openFileRoute } from '../core/files-panel.js';
import { bindingsFrom } from '../core/hotkeys.js';
import type { WorkspaceFault } from '../core/dashboard-view.js';
import type { RepoCommit } from '../core/commits.js';
import { NO_FILES, NO_TERMINALS, NO_UPDATES, type AgentDetail, type GenieBridge, type GenieSnapshot, type UpdateState } from './bridge.js';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
    /** The panel pinned to the dock (files, lists), or `null`. An open chat holds the dock over it (`dockHolder`). */
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
    onCloseChat: () => void;
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
    /** The workspace whose file panel holds the dock when `pinned === 'files'` (§4.3). */
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
    /** From Tynn (§6.1): the preview is asked for on the host; confirm creates the envelope under the parent it showed. */
    onAddWorkspaceFromTynn?: (() => void) | undefined;
    onConfirmAddTynn?: ((parent: string) => void) | undefined;
    onCancelAddGit?: (() => void) | undefined;
    onConfirmAdd?: ((path: string) => void) | undefined;
    onCancelAdd?: (() => void) | undefined;
}

export type ShellRemote = { host: string; driver: string | null; driving: boolean; locked: boolean } | null;

/** The dock's panels, as the notice names them (§4.4). */
const PANEL_NAME: Record<DockPanel, string> = { chat: 'chat', files: 'file panel', lists: 'lists' };

/** No Deck items yet: one array, so the toasts see the same list on every render until the snapshot brings one. */
const NO_DECK_ITEMS: readonly DeckItem[] = [];

/** The chat sits in the dock's frame, under the view header (§4.4) — always: there is no overlay (2026-10-17). */
function DockFrame({ style, children }: { style: CSSProperties; children: ReactNode }) {
    return <div data-dock-frame="chat" className="z-10 bg-[var(--bg-0)]" style={style}>{children}</div>;
}

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
    pinned,
    onNavigate,
    onOpenAgent,
    openAgentTabs,
    onAddAgent,
    onAddWorkspace,
    terminals = NO_TERMINALS,
    files = NO_FILES,
    filesWorkspaceId,
    onToggleFilesPin,
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
    onCloseChat,
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
    onCancelAddGit,
    onConfirmAdd,
    onCancelAdd,
}: ShellProps) {
    const parsed = parseRoute(route);
    const updateState = useUpdateState(updates);
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

    /**
     * THE DOCK RESERVE, and the three places it must not be.
     *
     * It starts BELOW THE VIEW HEADER (§4.4) — the surface's own header (`data-view-header`), not the title bar —
     * which keeps its width and position while the body reflows. The content row carries it as `--dock-reserve`;
     * styles.css applies it as a `margin-right` to every child of a surface except its header, and the docked
     * panel's frame starts at that header's measured height (`--view-header-h`). From `dockReserve`, which reads
     * the same `DOCK_WIDTH` the panel is sized by, so the two cannot diverge. See `core/dock.ts`:
     *
     *  - not `padding`, or the content sizes to the padded box and its borders run under the
     *    panel;
     *  - not on the outer wrapper, or the view header narrows too — the gutter starts BELOW
     *    the header, which keeps its width and position;
     *  - not on a `flex: 1` column — measured: that squeezed the left rail from 300px to
     *    163px, because a flex child with a margin gives up basis rather than slack.
     *
     * An open chat holds the dock over whatever is pinned (`dockHolder`): it reserves its own width, and a pinned file
     * panel under it stays mounted, hidden, until the chat closes.
     */
    // The file panel popped out releases the reserve (§4.3); the slot stays its workspace's, the lamp stays on.
    const filesSlot = filesDock({ pinned, filesWorkspaceId: filesWorkspaceId ?? null, popped: filesPopped });
    // A pinned slot reserves whatever panel holds it; only a POPPED-OUT file panel gives the width back.
    // The pinned chat's width is the person's (Tynn #798): remembered, dragged live — and the reserve is the same number.
    const [chatDockWidth, setChatDockWidth] = useState(() => readChatDockWidth(typeof window === 'undefined' ? null : (() => { try { return window.localStorage; } catch { return null; } })()));
    const chatOpen = chatThread !== null || parsed.chat !== null;
    const holder = dockHolder(pinned, chatOpen);
    const reserve = holder !== 'chat' && filesSlot.kind === 'popped' ? filesSlot.reserve : dockReserve(holder, chatDockWidth);
    // The header on screen sets where the dock starts: 56px on most surfaces, 44px on the Agent view. Measured before
    // paint; 56 until then (and in a static render), 0 on a surface without one.
    const rowRef = useRef<HTMLDivElement | null>(null);
    const [headerHeight, setHeaderHeight] = useState(56);
    useLayoutEffect(() => {
        const header = rowRef.current?.querySelector<HTMLElement>('[data-view-header]') ?? null;
        const h = header ? Math.round(header.getBoundingClientRect().height) : 0;
        if (h !== headerHeight) setHeaderHeight(h);
    });
    // `?files=detached` (the board's key): a link to the panel in its own window pops it out, once per arrival.
    useEffect(() => {
        if (parsed.surface === 'workspace' && parsed.detached && onPopOutFiles && !filesPopped.includes(parsed.workspaceId)) onPopOutFiles(parsed.workspaceId);
    }, [route]);
    const dockFrame: CSSProperties = { position: 'absolute', right: 0, bottom: 0, top: 'var(--view-header-h)', display: 'flex' };

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
    // Where the chat opens from here: the agent the view says (core/chat-scope.ts `followChat`) — never a tab to pick.
    const openChatRoute = formatRoute({ ...parsed, chat: followChat(parsed.chat ?? 'genie', parsed, snapshot.agents, openedThreads ?? []) });
    const openChatName = (() => { const to = parseRoute(openChatRoute).chat; return snapshot.agents.find((a) => a.id === to)?.name ?? to ?? 'genie'; })();
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
                onUpdateAction={(action) => {
                    if (action === 'update-download') void updates.download();
                    else if (action === 'update-install') void updates.install();
                }}
            />

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

            <div ref={rowRef} className="relative flex min-h-0 flex-1" style={{ '--dock-reserve': `${reserve}px`, '--view-header-h': `${headerHeight}px` } as CSSProperties} data-dock-reserve={reserve}>
                <Sidebar
                    route={route}
                    // The badge is what is WAITING on you (§4.5) — a finished agent's handoff is read, not resolved.
                    deckCount={snapshot.deckItems === null ? null : needsYouCount(snapshot.deckItems)}
                    workspaces={railWorkspaces(snapshot.workspaces ?? [], snapshot.agents)}
                    // On an agent's page its workspace stays the highlighted row (Tynn #805).
                    currentWorkspaceId={routeWorkspace(route, snapshot.agents)}
                    agents={snapshot.agents}
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
                    {addPreview ? <AddWorkspacePreview preview={addPreview} onConfirm={(p) => onConfirmAdd?.(p)} onConfirmGit={(u, p) => onConfirmAddGit?.(u, p)} onConfirmTynn={(p) => onConfirmAddTynn?.(p)} onCancel={() => onCancelAdd?.()} /> : null}
                    {addFromGit && !addPreview ? <AddFromGitForm onPreview={(u) => onPreviewFromGit?.(u)} onCancel={() => onCancelAddGit?.()} /> : null}
                    {/*
                     * ONE first-run invitation. With no workspaces the Onboarding above IS the first run (§6.9's two
                     * steps); the Dashboard's own invitation would stack a second one under it — measured on the
                     * board audit. The skeleton (`workspaces === null`) still belongs to the Dashboard.
                     */}
                    {canServe && parsed.surface === 'dashboard' && (snapshot.workspaces === null || snapshot.workspaces.length > 0) ? (
                        <Dashboard
                            rows={snapshot.agents}
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
                    {canServe && parsed.surface === 'settings' ? <SettingsSurface data={features} onAction={onFeature} onNavigate={onNavigate} group={parsed.group} workspaces={snapshot.workspaces ?? []} remoteConnect={remoteConnect} update={{ state: updateState, onCheck: () => { void updates.check(); } }} /> : null}
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
                            workspace={workspaceFor(parsed.workspaceId)!}
                            terminals={terminals}
                            files={files}
                            panel={parsed.panel}
                            view={parsed.view}
                            issueWatch={features.issueWatch?.[parsed.workspaceId] ?? null}
                            rows={snapshot.agents}
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
                            filesPinned={pinned === 'files' && filesWorkspaceId === parsed.workspaceId}
                            onPinFiles={() => onToggleFilesPin?.(parsed.workspaceId)}
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
                 * THE FILE PANEL IN THE DOCK (§4.3/§4.4): pinned, the one panel of that workspace sits in the
                 * slot on every surface; the reserve above makes room. One panel per workspace — the Workspace
                 * surface does not draw it inline while it is here.
                 */}
                {filesSlot.kind === 'docked' && workspaceFor(filesSlot.workspaceId!) ? (
                    <aside data-dock="files" data-dock-frame="files" hidden={holder === 'chat'} className="z-10 border-l border-[var(--border-1)] bg-[var(--bg-0)]" style={{ ...dockFrame, width: DOCK_WIDTH, ...(holder === 'chat' ? { display: 'none' } : {}) }}>
                        <FilesPanelContainer
                            workspace={workspaceFor(filesSlot.workspaceId!)!}
                            files={files}
                            pinned
                            onPin={() => onToggleFilesPin?.(filesSlot.workspaceId!)}
                            onClose={() => onToggleFilesPin?.(filesSlot.workspaceId!)}
                            onPopOut={onPopOutFiles ? () => onPopOutFiles(filesSlot.workspaceId!) : undefined}
                            onPause={onPauseAgent}
                            onResume={onResumeAgent}
                            onDirtyChange={onFilesDirtyChange}
                        />
                    </aside>
                ) : null}
                {/* Popped out (§4.3): the reserve is released and the dock column is a bar that brings the panel back. */}
                {filesSlot.kind === 'popped' && holder !== 'chat' ? (
                    <aside data-files-popped={filesSlot.workspaceId} data-dock-frame="files-popped" className="z-10 w-7 items-start justify-center border-l border-[var(--border-1)] bg-[var(--bg-0)] pt-2" style={dockFrame}>
                        <button
                            type="button"
                            data-action="bring-back-files"
                            title={`The ${workspaceLabel(snapshot.workspaces, filesSlot.workspaceId!)} file panel is in its own window — bring it back`}
                            onClick={() => onBringBackFiles?.(filesSlot.workspaceId!)}
                            className="rounded-md border border-[var(--border-1)] px-1 py-1 text-[10px] text-[var(--fg-3)] hover:bg-[var(--bg-2)]"
                            style={{ writingMode: 'vertical-rl' }}
                        >
                            files · bring back
                        </button>
                    </aside>
                ) : null}
                {/*
                 * OPEN THE CHAT (the owner, 2026-10-18: no chat tabs — "the workspaces have agent tabs already. Any view that
                 * is not a workspace view shows the genie agent chat"): with the chat closed and nothing pinned, ONE button on
                 * the edge, in the width the reserve keeps, opens it on the agent the view says.
                 */}
                {holder === null ? (
                    <aside data-chat-edge="" aria-label="Chat" className="flex-col items-center border-l border-[var(--border-1)] bg-[var(--bg-1)] py-2" style={{ ...dockFrame, width: CHAT_STRIP_WIDTH, flexDirection: 'column' }}>
                        <button
                            type="button"
                            data-action="open-chat"
                            data-nav={openChatRoute}
                            title={`Chat with ${openChatName}`}
                            onClick={() => onNavigate(openChatRoute)}
                            className="flex w-6 shrink-0 flex-col items-center gap-1.5 rounded-md py-1.5 text-[11px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]"
                        >
                            <GenieMark />
                            <span className="max-h-24 overflow-hidden text-ellipsis whitespace-nowrap" style={{ writingMode: 'vertical-rl' }}>{openChatName}</span>
                        </button>
                    </aside>
                ) : null}
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
                    right={reserve + 16}
                />
                {chatOpen ? (
                    <DockFrame style={dockFrame}>
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
                        onClose={onCloseChat}
                        onRestartAndSend={onRestartAndSend}
                        onStopTurn={chatTurnStop && chatThread ? () => onCancelTurn?.(chatThread.agentId) : undefined}
                        onResumeLimit={chatThread && onResumeLimit && chatSession?.limit && chatSession.limit.state !== 'open' ? () => onResumeLimit(chatThread.agentId) : undefined}
                        onProviderLogin={chatThread && onProviderLogin && chatSession?.signedOut ? { name: providerLogin(snapshot.agents.find((a) => a.id === chatThread.agentId)?.provider ?? '')?.name ?? 'your provider', run: () => onProviderLogin(chatThread.agentId) } : undefined}
                    />
                    </DockFrame>
                ) : null}
            </div>
        </div>
    );
}
