import { formatLanes, parseLanes } from '../core/lanes.js';
import { formatRoute, parseRoute } from '../core/route.js';
import { DOCK_WIDTH, dockReserve, type DockPanel } from '../core/dock.js';
import { Deck } from './components/Deck.js';
import type { DeckItem } from '../core/deck.js';
import { railSurfacesFor, railWorkspaces, type Surface } from '../core/rail-view.js';
import { AgentView, type AgentOpsProps } from './components/AgentView.js';
import { ChatFlyout, type ChatThread } from './components/ChatFlyout.js';
import { Dashboard } from './components/Dashboard.js';
import { Onboarding } from './components/Onboarding.js';
import { Sidebar } from './components/Sidebar.js';
import { TitleBar } from './components/TitleBar.js';
import { Workspace, type WorkspaceOpsProps } from './components/Workspace.js';
import { FilesPanelContainer } from './components/FilesPanelContainer.js';
import { AddFromGitForm, AddWorkspacePreview, type AddPreviewView } from './components/AddWorkspacePreview.js';
import { BrowserSurface, FlowsSurface, HostingSurface, InboxSurface, KnowledgeSurface, SettingsSurface, ToolchainSurface, type RemoteConnectProps } from './components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from './features.js';
import { NO_FILES, NO_TERMINALS, NO_UPDATES, type AgentDetail, type GenieBridge, type GenieSnapshot, type UpdateState } from './bridge.js';
import { useEffect, useState } from 'react';

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
    /** Which surfaces this build renders. The rail's rows are DERIVED from it, not parallel. */
    servable: readonly Surface[];
    /** The agent the route names, when it names one. `null` while loading or if unknown. */
    agentDetail: AgentDetail | null;
    /** Whether `agentDetail` has been looked up yet — `null` alone cannot say. */
    agentResolved: boolean;
    selectedRowId: string | null;
    /** The chat thread the route names, when it names one. */
    chatThread: ChatThread | null;
    /** What the feature surfaces render from; `null` sections draw skeletons. Defaults to nothing asked yet. */
    features?: FeatureData | undefined;
    /** A feature surface asking the main process for something. */
    onFeature?: ((action: FeatureAction) => void) | undefined;
    /** The host's file picker for attachments (§6.4); absent = no Attach button. */
    pickFiles?: (() => Promise<string[]>) | undefined;
    /** The browser surface's box, for main to place the view over. */
    onBrowserBounds?: ((b: { x: number; y: number; width: number; height: number }) => void) | undefined;
    /** Which panel holds the single dock slot. `null` = nothing pinned, so no reserve. */
    pinned: DockPanel | null;
    onNavigate: (route: string) => void;
    onSend: (agentId: string, text: string) => void;
    /** `null` unless an answer is in flight, so the buttons can refuse a second press. */
    answeringApproval: string | null;
    onAnswerApproval: (optionId: string) => void;
    /** Answering from the DECK names its agent, because the route is not on that agent. */
    /** An inline answer on a Deck item. The ITEM travels, because which channel it takes is decided by its id. */
    onAnswerDeckItem: (item: DeckItem, optionId: string) => void;
    onTogglePin: () => void;
    onCloseChat: () => void;
    onOpenAgent: (agentId: string) => void;
    onAddAgent: (workspaceId: string) => void;
    /** The first-run invitation. Without it that button is a control that does nothing. */
    onAddWorkspace: () => void;
    /** The terminal half of the bridge, handed to the Workspace surface. Keyed by workspace, never agent. */
    terminals?: GenieBridge['terminals'];
    /** The file panel's half of the bridge (§4.3); the Workspace surface mounts it for `?panel=files`. */
    files?: GenieBridge['files'] | undefined;
    /** The workspace whose file panel holds the dock when `pinned === 'files'` (§4.3). */
    filesWorkspaceId?: string | null | undefined;
    /** Pin or unpin a workspace's file panel into the single dock slot (§4.4). */
    onToggleFilesPin?: ((workspaceId: string) => void) | undefined;
    /** The updates half of the bridge (§7); the Deck's signal strip shows it and acts on it. */
    updates?: GenieBridge['updates'];
    onTakeOver?: ((agentId: string) => void) | undefined;
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
    onCancelAddGit?: (() => void) | undefined;
    onConfirmAdd?: ((path: string) => void) | undefined;
    onCancelAdd?: (() => void) | undefined;
}

export type ShellRemote = { host: string; driver: string | null; driving: boolean; locked: boolean } | null;

export function Shell({
    route,
    snapshot,
    servable,
    features = EMPTY_FEATURES,
    onFeature = () => {},
    pickFiles,
    onBrowserBounds,
    agentDetail,
    agentResolved,
    selectedRowId,
    chatThread,
    pinned,
    onNavigate,
    onOpenAgent,
    onAddAgent,
    onAddWorkspace,
    terminals = NO_TERMINALS,
    files = NO_FILES,
    filesWorkspaceId,
    onToggleFilesPin,
    updates = NO_UPDATES,
    onTakeOver,
    onOpenPalette,
    onSelectRow,
    onSend,
    onTogglePin,
    onCloseChat,
    answeringApproval,
    onAnswerApproval,
    onAnswerDeckItem,
    remote,
    remoteConnect,
    agentOps,
    workspaceOps,
    addPreview,
    addFromGit,
    onAddWorkspaceFromGit,
    onPreviewFromGit,
    onConfirmAddGit,
    onCancelAddGit,
    onConfirmAdd,
    onCancelAdd,
}: ShellProps) {
    const parsed = parseRoute(route);
    const updateState = useUpdateState(updates);
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
    const canServe = servable.includes(parsed.surface);

    /**
     * THE DOCK RESERVE, and the three places it must not be.
     *
     * It is a **`marginRight` on the content row** — the row that holds the rail and the
     * surface, BELOW the title bar. From `dockReserve`, which reads the same `DOCK_WIDTH` the
     * panel is sized by, so the two cannot diverge. See `core/dock.ts`:
     *
     *  - not `padding`, or the content sizes to the padded box and its borders run under the
     *    panel;
     *  - not on the outer wrapper, or the view header narrows too — the gutter starts BELOW
     *    the header, which keeps its width and position;
     *  - not on a `flex: 1` column — measured: that squeezed the left rail from 300px to
     *    163px, because a flex child with a margin gives up basis rather than slack.
     *
     * An unpinned flyout reserves nothing: it overlays the right edge and nothing moves.
     */
    const reserve = dockReserve(pinned);

    /**
     * The approval the FLYOUT may answer — only when this chat is the composer for the agent
     * the approval belongs to. `approvalPlacement`'s decision, applied at the other end.
     *
     * Hoisted rather than inlined because a JSX expression container cannot sit between
     * attributes, and the reasoning is worth more than the saved line.
     */
    const chatApproval =
        chatThread && agentDetail?.agent.id === chatThread.agentId
            ? agentDetail.session?.pendingApproval ?? null
            : null;

    return (
        <div className="flex h-full flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <TitleBar
                route={route}
                workstation={snapshot.workstation}
                remote={remote}
                onNavigate={onNavigate}
                onOpenPalette={onOpenPalette}
            />

            <div className="relative flex min-h-0 flex-1" style={{ marginRight: reserve }} data-dock-reserve={reserve}>
                <Sidebar
                    route={route}
                    deckCount={snapshot.deckItems?.length ?? null}
                    workspaces={railWorkspaces(snapshot.workspaces ?? [], snapshot.agents)}
                    available={railSurfacesFor(servable)}
                    onNavigate={onNavigate}
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
                                tynnSignedIn: null,
                            }}
                            onAddWorkspace={onAddWorkspace}
                            onAddWorkspaceFromGit={onAddWorkspaceFromGit}
                            onAddAgent={() => { const w = snapshot.workspaces?.[0]; if (w) onAddAgent(w.id); }}
                            onNavigate={onNavigate}
                        />
                    ) : null}
                    {addPreview ? <AddWorkspacePreview preview={addPreview} onConfirm={(p) => onConfirmAdd?.(p)} onConfirmGit={(u, p) => onConfirmAddGit?.(u, p)} onCancel={() => onCancelAdd?.()} /> : null}
                    {addFromGit && !addPreview ? <AddFromGitForm onPreview={(u) => onPreviewFromGit?.(u)} onCancel={() => onCancelAddGit?.()} /> : null}
                    {canServe && parsed.surface === 'dashboard' ? (
                        <Dashboard
                            rows={snapshot.agents}
                            workspaces={snapshot.workspaces}
                            onOpenAgent={onOpenAgent}
                            onAddAgent={onAddAgent}
                            onAddWorkspace={onAddWorkspace}
                            onAddWorkspaceFromGit={onAddWorkspaceFromGit}
                        />
                    ) : null}

                    {canServe && parsed.surface === 'knowledge' ? <KnowledgeSurface data={features} onAction={onFeature} onNavigate={onNavigate} workspaces={snapshot.workspaces ?? []} /> : null}
                    {canServe && parsed.surface === 'flows' ? <FlowsSurface data={features} onAction={onFeature} onNavigate={onNavigate} workspaces={snapshot.workspaces ?? []} adding={features.flows?.adding ? { kind: 'flow', ...features.flows.adding } : undefined} onCloseForm={() => onFeature({ kind: 'flows.cancelForm' })} /> : null}
                    {canServe && parsed.surface === 'hosting' ? <HostingSurface data={features} onAction={onFeature} onNavigate={onNavigate} workspaces={snapshot.workspaces ?? []} adding={features.hosting?.adding ? { kind: 'site', ...features.hosting.adding } : features.services?.adding ? { kind: 'service', ...features.services.adding } : undefined} onCloseForm={() => onFeature({ kind: features.hosting?.adding ? 'hosting.cancelForm' : 'services.cancelForm' })} /> : null}
                    {canServe && parsed.surface === 'toolchain' ? <ToolchainSurface data={features} onAction={onFeature} onNavigate={onNavigate} /> : null}
                    {canServe && parsed.surface === 'inbox' ? <InboxSurface data={features} onAction={onFeature} onNavigate={onNavigate} compose={inboxCompose} /> : null}
                    {canServe && parsed.surface === 'settings' ? <SettingsSurface data={features} onAction={onFeature} onNavigate={onNavigate} group={parsed.group} workspaces={snapshot.workspaces ?? []} remoteConnect={remoteConnect} /> : null}
                    {canServe && parsed.surface === 'browser' ? <BrowserSurface data={features} onAction={onFeature} onNavigate={onNavigate} onBrowserBounds={onBrowserBounds} /> : null}

                    {canServe && parsed.surface === 'deck' ? (
                        <Deck
                            items={snapshot.deckItems ?? []}
                            signals={{ ...snapshot.signals, update: updateState }}
                            answering={answeringApproval}
                            onAnswer={(item, optionId) => onAnswerDeckItem(item, optionId)}
                            onOpenItem={(item) => { if (item.agentId) onNavigate(`genie://agent/${item.agentId}?tab=stream`); }}
                            onNavigate={onNavigate}
                            onSignalAction={(action) => {
                                if (action === 'update-download') void updates.download();
                                else if (action === 'update-install') void updates.install();
                                else if (action === 'update-cancel') void updates.cancel();
                            }}
                        />
                    ) : null}

                    {canServe && parsed.surface === 'agent' && agentDetail ? (
                        <AgentView
                            agent={agentDetail.agent}
                            session={agentDetail.session}
                            rows={agentDetail.rows}
                            tab={parsed.tab}
                            lanes={parseLanes(parsed.lane)}
                            at={parsed.at}
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
                        />
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
                            onTogglePanel={() => onNavigate(parsed.panel === 'files' ? `genie://workspace/${parsed.workspaceId}` : `genie://workspace/${parsed.workspaceId}?panel=files`)}
                            filesPinned={pinned === 'files' && filesWorkspaceId === parsed.workspaceId}
                            onPinFiles={() => onToggleFilesPin?.(parsed.workspaceId)}
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
                 * The flyout. Pinned, it sits in the row and the reserve above makes room for
                 * it; unpinned, it is absolutely positioned over the right edge and the
                 * reserve is zero. One component, two geometries, one width.
                 */}
                {/*
                 * THE FILE PANEL IN THE DOCK (§4.3/§4.4): pinned, the one panel of that workspace sits in the
                 * slot on every surface; the reserve above makes room. One panel per workspace — the Workspace
                 * surface does not draw it inline while it is here.
                 */}
                {pinned === 'files' && filesWorkspaceId && workspaceFor(filesWorkspaceId) ? (
                    <aside data-dock="files" className="shrink-0 border-l border-[var(--border-1)]" style={{ width: DOCK_WIDTH }}>
                        <FilesPanelContainer workspace={workspaceFor(filesWorkspaceId)!} files={files} pinned onPin={() => onToggleFilesPin?.(filesWorkspaceId)} onClose={() => onToggleFilesPin?.(filesWorkspaceId)} />
                    </aside>
                ) : null}
                {chatThread || parsed.chat ? (
                    <ChatFlyout
                        thread={chatThread}
                        pinned={pinned === 'chat'}
                        contextTokens={200_000}
                        approval={chatApproval}
                        answeringApproval={answeringApproval}
                        onAnswerApproval={onAnswerApproval}
                        onSend={(text) => onSend(chatThread?.agentId ?? '', text)}
                        onTogglePin={onTogglePin}
                        onClose={onCloseChat}
                    />
                ) : null}
            </div>
        </div>
    );
}
