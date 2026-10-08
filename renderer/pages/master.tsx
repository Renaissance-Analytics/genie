import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ensureOverlayRoot } from '../lib/overlay-root';
import { hostSessionRoster } from '../lib/host-session-roster';
import { DEFAULT_HOTKEYS, type HotkeyBindings } from '../lib/hotkeys';
import { useGenieHotkeys } from '../lib/use-genie-hotkeys';
import { ftqNudgeDelivery } from '../lib/ftq-nudge';
import { pairingPrompt } from '../../main/remote/pairing-reason';
import GenieCommandWindow, { type SavedPrompt } from '../components/Master/GenieCommandWindow';
import FeedbackModal from '../components/Master/FeedbackModal';
import { feedbackWorkspaceFor } from '../lib/feedback-target';
import Chooser from '../components/Master/Chooser';
import ProjectContextMenu from '../components/Master/ProjectContextMenu';
import ShareWorkspaceModal from '../components/Master/ShareWorkspaceModal';
import SharingFlyout from '../components/Master/SharingFlyout';
import NewAgentModal from '../components/Master/NewAgentModal';
import { FirstRunOnboarding } from '../components/Master/FirstRunOnboarding';
import type { AgentRecordSpec, AgentRuntimeSpec } from '../lib/ams-grid';
import {
    restartOptionsFor,
    type RestartMode,
} from '../../main/agents/restart-options';
import WorkspaceSettingsModal, {
    WorkspaceAgentsModal,
} from '../components/Master/WorkspaceSettingsModal';
import WorkspaceSiteManager from '../components/Master/WorkspaceSiteManager';
import WorkspaceProcessManager from '../components/Master/WorkspaceProcessManager';
import { processSpecsOf, type ProcessCreate, type ProcessPatch } from '../lib/process-manager';
import { useStreamingTerminals } from '../lib/use-streaming-terminals';
import SpecContextMenu from '../components/Master/SpecContextMenu';
import { PromptHost, showPrompt } from '../components/Master/Prompt';
import QuitTerminalsModal, {
    type QuitTerminal,
} from '../components/Master/QuitTerminalsModal';
import { type LayoutMode } from '../components/Master/TerminalGrid';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import BootScreen from '../components/Master/BootScreen';
import HostUpgradeOverlay from '../components/Master/HostUpgradeOverlay';
import HostBuildNudge from '../components/Master/HostBuildNudge';
import { RecipeLauncher, WorkstationSetupLauncher } from '../components/Wizard';
import DocsFlyout from '../components/Master/DocsFlyout';
import IssueWatchFlyout from '../components/Master/IssueWatchFlyout';
import TaskManagerFlyout from '../components/Master/TaskManagerFlyout';
import AgentInboxFlyout from '../components/Master/AgentInboxFlyout';
import FlowManagerFlyout from '../components/Master/FlowManagerFlyout';
import QuestionInboxFlyout from '../components/Master/QuestionInboxFlyout';
import ListsFlyout from '../components/Master/ListsFlyout';
import AppStoreFlyout from '../components/Master/AppStoreFlyout';
import AppTray from '../components/Master/AppTray';
import Floor from '../components/Master/Floor';
import AgentTerminal from '../components/Master/AgentTerminal';
import { questionBadgeCount } from '../lib/question-badge';
import TerminalTypeSplitButton from '../components/Master/TerminalTypeSplitButton';
import AgentTerminalForm from '../components/Master/AgentTerminalForm';
import AgentManager from '../components/Master/AgentManager';
import RecoveryBanner from '../components/Master/RecoveryBanner';
import { bumpRecoverGen, type RecoveryState } from '../lib/host-loss-recovery';
import GithubCapabilitiesFlyout from '../components/Master/GithubCapabilitiesFlyout';
import TynnHealthIndicator from '../components/Master/TynnHealthIndicator';
import { useGithubCapabilities } from '../lib/githubCapabilities';
import { issueWatchBadge } from '../lib/issuewatch';
import {
    awakeSpecs,
    hibernateOutcome,
    isHibernated,
    wakeOutcome,
} from '../lib/workspace-hibernation';
import {
    activeAfterHiding,
    hiddenHibernatedCount,
    withoutHibernated,
} from '../lib/hibernated-visibility';
import { gappLaunchLabel, gappLaunchTargets } from '../lib/gapp-launch';
import { terminalTypeById, type TerminalTypeId } from '../lib/terminal-types';
import type {
    AgentType,
    BackendUser,
    ViewType,
    AgentInboxScope,
    TynnHealth,
} from '../lib/genie';
import { resolveShortcut } from '../lib/master-shortcuts';
import {
    clampToMaxViews,
    computeLaunchSelection,
    DEFAULT_MAX_VIEWS,
    parseMaxViews,
} from '../lib/launch-restore';
import { canRunRecipe, recipeLaunchScope } from '../lib/recipe-launch';
import { applyPanelOrder } from '../lib/panel-reorder';
import {
    overlayOwnConnKey,
    parseViewStateStore,
    readWorkspaceView,
    writeWorkspaceView,
    type ViewStateStore,
    type WorkspaceViewState,
} from '../lib/view-state';
import {
    headerUpdateLabel,
    planCommitStep,
    shouldDriveRestart,
    updateIsPending,
} from '../lib/updater-flow';
import {
    canSatisfyDrainRow,
    drainRosterSummary,
    drainRowIcon,
    drainRowStatusLabel,
    upgradeModalPlan,
} from '../lib/drain-roster';
import {
    closeUpgradeView,
    commitUpgrade,
    markRestartDriven,
    openUpgradeView,
    resetUpgradeCommit,
    useUpgradeView,
} from '../lib/upgrade-view';
import type { DrainSnapshot } from '../../main/agents/drain';
import { autoOpenWhatsNew } from '../lib/whats-new';
import { emitOpenInPanel, openFileInEditor, surfaceMaximized } from '../lib/editor-open';
import { pluginPanelSpecMeta } from '../lib/panel-routing';
import {
    workstationConnectState,
    connectableWorkstationIds,
    newlyConnectableWorkstationIds,
} from '../lib/workstation-status';
import { cloudHostVisual, unifiedCloudWorkstations } from '../lib/cloud-host-visual';
import {
    IconColumns,
    IconLayoutGrid,
    IconMaximize,
    IconPanelLeft,
    IconEye,
    IconCpu,
    IconListTree,
    IconShare,
    IconMessage,
    IconMailQuestion,
    IconFlow,
    IconGraph,
    IconMenu,
    IconAlert,
    IconWand,
    IconThumbUp,
    IconX,
} from '../components/Master/icons';
import {
    api,
    currentConnKey,
    hasGenieBridge,
    isRemoteWindow,
    isSystemWorkspace,
    isGenieOsTerminalSpec,
    workspaceSurfaceSpecs,
    workspaceSurfaceRows,
    systemWorkspaceRow,
    SYSTEM_WORKSPACE_ID,
    sidebarWorkspaceRows,
    ulid,
    type AgentInboxIncomingNotice,
    type Changelog,
    type WatchTypeCounts,
    type GenSitesAll,
    type DevSiteInfo,
    type TerminalSpec,
    type UpdaterStatus,
    type WorkspaceRow,
    type RemoteStatus,
    type RemoteLinkState,
    type MobilePeer,
    type BatonParticipant,
    type KnownHost,
    type GenieHost,
    type ConnectableWorkstation,
    type PluginPanelView,
} from '../lib/genie';
import { nudgeGappDevSync, nudgeGappDevSyncOnFocus } from '../lib/gapp-dev';
import { playChime } from '../lib/alert-chime';
import { motifForPayload } from '../../main/notify-sound-kinds';
import { replacePageQuery, usePageQuery } from '../lib/page-query';
import { mergeViewRoute, parseViewRoute, type GenieView, type RouteQuery } from '../lib/view-route';
import { AgentView } from '../components/Master/AgentView';
import { parkedApproval } from '../lib/agent-view';
import { answerForOption } from '../lib/attention-actions';
import { attentionItems, moveQueueFocus } from '../lib/attention-queue';
import { floorSurface } from '../lib/floor-surface';
import { ChatFlyout } from '../components/Master/ChatFlyout';
import { Dashboard } from '../components/Master/Dashboard';
import { Deck } from '../components/Master/Deck';
import { escapeLeavesForDeck, focusOwnerOf } from '../lib/master-shortcuts';
import type { AgentSessionSpec, ListItemSpec, PendingQuestionSpec } from '../lib/genie';
import { probeTynnAuth } from '../lib/auth-probe';
import {
    closeDrawerNext,
    DOCKABLE,
    isDocked,
    isDrawerOpen,
    pinDockNext,
    somethingCoversTheFloor,
    type DockId,
    type DrawerId,
} from '../lib/drawers';

/**
 * Master workspace — cross-project terminal organiser. Hosts the
 * chooser tree (Pinned · Custom views · Projects), the panel grid
 * (auto-layout based on selected count) and the chrome bars.
 *
 * State strategy:
 *   - `workspaces` + `specs` come from main on mount, refreshed when we
 *     mutate something.
 *   - `selected` is in-memory only (a "view" the user is currently
 *     composing). Persisted custom views are a v2 feature.
 *   - `activeIds` reflects which selected spec has a live pty. We track
 *     this in renderer state because the TerminalManager is per-window;
 *     a panel goes "active" once XTerm mounts and "inactive" on exit.
 */

/** Whether the lists panel is docked to the right edge — per WINDOW, not a
 *  setting: it describes this screen's layout, not the workstation's. */
const LISTS_PIN_KEY = 'genie-lists-pinned';

export default function MasterPage() {
    const [ready, setReady] = useState(false);
    // Keep the magical boot screen mounted briefly after readiness so it can
    // fade out smoothly over the workspace UI instead of snapping away.
    const [showBoot, setShowBoot] = useState(true);

    useEffect(() => {
        if (hasGenieBridge()) {
            setReady(true);
            return;
        }
        const t = setInterval(() => {
            if (hasGenieBridge()) {
                setReady(true);
                clearInterval(t);
            }
        }, 100);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        if (!ready) return;
        // Match the boot-out CSS duration (520ms) before unmounting the overlay.
        const t = setTimeout(() => setShowBoot(false), 560);
        return () => clearTimeout(t);
    }, [ready]);

    // Host-window bridge link health (version match + upgrade/limbo reconnect).
    const isHostWindow =
        typeof window !== 'undefined' && /[?&]host=/.test(window.location.search);
    const [link, setLink] = useState<RemoteLinkState>({ phase: 'connected' });
    useEffect(() => {
        if (!isHostWindow || !ready) return;
        let alive = true;
        api()
            .remote.linkState()
            .then((s) => alive && setLink(s))
            .catch(() => {});
        const off = api().remote.onLink(setLink);
        return () => {
            alive = false;
            off();
        };
    }, [isHostWindow, ready]);
    // Host-window CONTROL state: when the host owner takes control (its kill-switch),
    // this remote driver becomes VIEW-ONLY — the remote-bridge stops forwarding
    // keystrokes and we show a banner so it's obvious WHY typing does nothing. Read
    // on mount + live via `onControl`, so a control handoff reflects immediately and
    // is restored correctly across reconnect/upgrade (main re-reads it on recovery).
    const [viewOnly, setViewOnly] = useState(false);
    // WHO took it — several members can drive one workstation, so the banner names
    // the person holding the baton rather than blaming "the host" for a peer.
    const [controlHolder, setControlHolder] = useState<{
        emoji?: string | null;
        name?: string | null;
    } | null>(null);
    useEffect(() => {
        if (!isHostWindow || !ready) return;
        let alive = true;
        const apply = (s: { locked: boolean; holderEmoji?: string | null; holderName?: string | null }) => {
            setViewOnly(s.locked);
            setControlHolder(s.locked ? { emoji: s.holderEmoji, name: s.holderName } : null);
        };
        api()
            .remote.controlState()
            .then((s) => alive && apply(s))
            .catch(() => {});
        const off = api().remote.onControl(apply);
        return () => {
            alive = false;
            off();
        };
    }, [isHostWindow, ready]);
    // A VERSION mismatch must NOT render the (incompatible) host dashboard — the
    // overlay replaces it. 'reconnecting'/'lost' keep the floor mounted
    // underneath (session restores on recovery); the overlay just covers it.
    const blockDashboard = isHostWindow && link.phase === 'mismatch';

    return (
        <>
            {/* Mount the real UI as soon as the bridge is up; the boot screen
                sits on top (z-index) and fades out, so the workspace is already
                painted underneath when the fade completes — no second flash. */}
            {ready && !blockDashboard && <MasterInner />}
            {showBoot && !blockDashboard && <BootScreen fadingOut={ready} />}
            {isHostWindow && link.phase !== 'connected' && (
                <HostUpgradeOverlay link={link} />
            )}
            {isHostWindow && link.phase === 'connected' && link.hostBuildBehind && (
                <HostBuildNudge build={link.hostBuildBehind} />
            )}
            {/* Owner connected to a workstation: open the setup wizard if the host
                still needs setup (idempotent; the launcher decides via the host). */}
            {isHostWindow && link.phase === 'connected' && <WorkstationSetupLauncher />}
            {isHostWindow && viewOnly && <RemoteViewOnlyBanner holder={controlHolder} />}
        </>

    );
}

/**
 * The EFFECTIVE workspace id a spec belongs to. System Workspace specs persist
 * with `workspace_id: null` + `meta.system` (the synthetic `__system__`
 * workspace has no DB row to FK against), so map those onto SYSTEM_WORKSPACE_ID
 * everywhere grouping/selection keys off a workspace id. All other specs use
 * their stored `workspace_id`.
 */
function specWorkspaceId(s: TerminalSpec): string | null {
    if (s.workspace_id === null && s.meta?.system === true) {
        return SYSTEM_WORKSPACE_ID;
    }
    return s.workspace_id;
}

function MasterInner() {
    const [authChecked, setAuthChecked] = useState(false);
    const [signedIn, setSignedIn] = useState(false);
    /** The account's NAME, for the menu. Null signed out, which is a legitimate state now. */
    const [tynnAccountName, setTynnAccountName] = useState<string | null>(null);
    const [hosts, setHosts] = useState<{ tynn: string }>({
        tynn: 'https://tynn.ai',
    });
    const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
    const [specs, setSpecs] = useState<TerminalSpec[]>([]);

    /**
     * WHICH SURFACE IS ON SCREEN, read from the url.
     *
     * The route is the navigational truth (`lib/view-route.ts`); this only reads it.
     * `mergeViewRoute` is what navigation goes through, because the window does not
     * start on a clean url — it is loaded with `?stage=<workspaceId>` or
     * `?host=<connKey>`, and `host` decides whether this renderer points at a remote
     * host at all. Replacing the whole query would silently turn a remote window local.
     */
    const pageQuery = usePageQuery();
    const view: GenieView = parseViewRoute(pageQuery);
    const surface = floorSurface(view);

    /**
     * Every agent's session, for the Deck.
     *
     * NO POLLING: it re-reads on the events that already announce the facts a session
     * is built from. There is deliberately no `sessions:changed` emitter — a sixth one
     * would have to be kept in step with the five that already fire.
     */
    const [sessions, setSessions] = useState<AgentSessionSpec[]>([]);
    const loadSessions = useCallback(() => {
        api()
            .agentSession.list()
            .then(setSessions)
            // A failed read leaves the previous answer standing rather than blanking the
            // board: "nothing needs you" is the one thing this surface must not say by
            // accident.
            .catch(() => {});
    }, []);
    /**
     * The two things the Needs-You band is built from.
     *
     * Questions come in one call. UserList items are per-workspace, so this asks each — the
     * Deck is cross-workspace by definition, and reading only the active one would
     * UNDER-REPORT, which on a surface whose job is "does anything need me" is the worst
     * direction to be wrong in. A failed read leaves the previous answer standing rather
     * than emptying the board.
     */
    const [deckQuestions, setDeckQuestions] = useState<PendingQuestionSpec[]>([]);
    const [deckListItems, setDeckListItems] = useState<ListItemSpec[]>([]);
    const loadAttention = useCallback(() => {
        api()
            .questions.list()
            .then((r) => setDeckQuestions(r.groups.flatMap((g) => g.questions)))
            .catch(() => {});
        Promise.all(
            workspaces.map((w) =>
                api()
                    .lists.read(w.id)
                    .then((r) => r.user)
                    .catch(() => [] as ListItemSpec[]),
            ),
        )
            .then((all) => setDeckListItems(all.flat()))
            .catch(() => {});
    }, [workspaces]);

    useEffect(() => {
        if (!surface.showDeck && !surface.showAgent) return;
        loadSessions();
        loadAttention();
        const offQ = api().on.questionsChanged?.(() => {
            loadSessions();
            loadAttention();
        });
        const offA = api().on.agentsChanged?.(loadSessions);
        const offL = api().on.listsChanged?.(() => loadAttention());
        return () => {
            offQ?.();
            offA?.();
            offL?.();
        };
    }, [surface.showDeck, surface.showAgent, loadSessions, loadAttention]);
    // The agent RECORD for whichever agent's settings are open. Loaded on
    // demand rather than kept for every workspace: this is the only surface in
    // master.tsx that needs it, and the sidebar keeps its own copy.
    const [agentRecord, setAgentRecord] = useState<{
        agents: AgentRecordSpec[];
        runtimes: AgentRuntimeSpec[];
    } | null>(null);
    // The ACTIVE workspace's agents, for the panels on the floor. Separate from
    // `agentRecord` above, which belongs to whichever agent the settings modal
    // has open and is cleared when it closes -- a panel's driver control must
    // not blink out because someone shut a modal.
    const [activeAgentRecord, setActiveAgentRecord] = useState<{
        agents: AgentRecordSpec[];
        runtimes: AgentRuntimeSpec[];
    } | null>(null);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    // The workspace whose views fill the grid. Persisted as the
    // `active_workspace` setting; seeded on launch from that setting (or the
    // most-recent workspace). Stage windows seed from `?stage=`.
    const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
    // Guards the one-time seed so a later refresh() doesn't reset the user's
    // active workspace back to most-recent.
    const seededActiveRef = useRef(false);
    // CLIENT-LOCAL panel view store for THIS window (see lib/view-state.ts):
    // `${connKey}|${workspaceId}` → { visibleIds, focusId, maximizedId,
    // layoutMode }. Warmed from `view_state_json` in refresh(), read on workspace
    // switch to restore this window's layout, and written back debounced. Kept in
    // a ref (not state) so reads/writes are synchronous and never re-render.
    const viewCacheRef = useRef<ViewStateStore>({});
    const viewFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Gate persistence until the launch restore has run, so the pre-restore
    // render (activeWorkspaceId still null) can't overwrite a saved layout.
    const viewRestoredRef = useRef(false);
    // The same moment as render state, for what must wait on it to re-run.
    const [launchRestored, setLaunchRestored] = useState(false);
    const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
    // Bytes in the last 1200ms — what the Genie OS surfaces animate on. See
    // `use-streaming-terminals` for why this is NOT `activeIds` above it: that
    // one is "the pty is alive", which stays true for as long as a panel is open.
    const streamingTerms = useStreamingTerminals();
    // Agent-integration MCP: terminals that called imDone and want attention.
    // Cleared when the terminal gets focus.
    const [attentionIds, setAttentionIds] = useState<Set<string>>(() => new Set());
    const [focusId, setFocusId] = useState<string | null>(null);
    const [maximizedId, setMaximizedId] = useState<string | null>(null);
    const [chooserPinned, setChooserPinned] = useState(true);
    // Legacy fallback until the dedicated Genie OS terminal spec resolves.
    const [homeDir, setHomeDir] = useState<string | null>(null);
    useEffect(() => {
        void api()
            .app.homeDir()
            .then(setHomeDir)
            .catch(() => {});
    }, []);
    const [layoutMode, setLayoutMode] = useState<LayoutMode>('auto');
    const [contextMenu, setContextMenu] = useState<{
        specId: string;
        x: number;
        y: number;
    } | null>(null);
    const [projectMenu, setProjectMenu] = useState<{
        workspaceId: string;
        x: number;
        y: number;
    } | null>(null);
    const [addingWorkspace, setAddingWorkspace] = useState(false);
    const [settingsWorkspaceId, setSettingsWorkspaceId] = useState<string | null>(null);
    /** Which workspace the Share modal is open for (right-click → Share workspace). */
    const [shareWsId, setShareWsId] = useState<string | null>(null);
    /** The global Sharing flyout — what is shared, workstation links, Connect to…. */
    /** The workspace whose AGENT ROSTER is open — the registry plus the
     *  `.agents/*` files Genie has not registered (genie#465). */
    const [agentsWsId, setAgentsWsId] = useState<string | null>(null);

    // Terminal-scoped hotkeys (Tynn #246/#247): F5 nudges the focused agent to
    // re-ask through ForceTheQuestion, Ctrl+K opens the Command Window. Both bind
    // ONLY while a terminal panel has focus and are consumed there, so the
    // terminal never also receives the keypress — see renderer/lib/hotkeys.ts.
    // Remappable per workstation; defaults until settings load.
    const [hotkeys, setHotkeys] = useState<HotkeyBindings>(DEFAULT_HOTKEYS);
    useEffect(() => {
        void api()
            .settings.get()
            .then((s) => {
                setHotkeys({
                    ftqNudge: s.ftq_nudge_hotkey || DEFAULT_HOTKEYS.ftqNudge,
                    commandWindow: s.command_window_hotkey || DEFAULT_HOTKEYS.commandWindow,
                });
                // A malformed library must not take the palette down with it —
                // an unusable Ctrl+K is worse than an empty prompt list.
                try {
                    const parsed = JSON.parse(s.saved_prompts || '[]');
                    if (Array.isArray(parsed)) setPrompts(parsed as SavedPrompt[]);
                } catch {
                    setPrompts([]);
                }
            })
            .catch(() => {});
    }, []);

    const [commandWindowFor, setCommandWindowFor] = useState<string | null>(null);
    /**
     * Whether the palette is OPEN — separate from which terminal is focused.
     *
     * The open flag used to be derived from a non-null terminal id — one value doubling as
     * two facts — which made the palette structurally unopenable without a focused
     * terminal. The Deck focuses none, so under Genie 2 Ctrl+K would never have opened
     * at all -- and P7 deletes eight title-bar icons on the promise that their features
     * "survive as Ctrl+K entries". Two states, because they are two facts.
     */
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [feedbackWsId, setFeedbackWsId] = useState<string | null>(null);
    // The global Feedback hotkey / tray item asked for Feedback (genie#675). Held
    // until the launch restore has settled which workspace is active, so a
    // hotkey that opened this window does not file against a guess.
    const [feedbackRequested, setFeedbackRequested] = useState(false);
    useEffect(() => {
        const off = api().on.openFeedback?.(() => setFeedbackRequested(true));
        // A hotkey that fired while this page was still loading is parked in main.
        void api()
            .app.claimPendingFeedback?.()
            .then((pending) => {
                if (pending) setFeedbackRequested(true);
            })
            .catch(() => {});
        return off;
    }, []);
    const [prompts, setPrompts] = useState<SavedPrompt[]>([]);

    useGenieHotkeys(
        useMemo(
            () => ({
                // Typed into the agent's TUI exactly as a person would, then
                // submitted — the agent re-asks through the MCP tool itself.
                //
                // The submit is delivered SEPARATELY when the nudge is long
                // enough to trip a TUI's paste heuristic: in paste mode a
                // trailing CR lands in the buffer as a newline rather than
                // submitting (genie#218), which parks the prompt with text in
                // it and no turn started — silent, and indistinguishable from
                // the agent ignoring you. `ftqNudgeDelivery` decides; this just
                // performs it.
                onFtqNudge: (terminalId: string) => {
                    const plan = ftqNudgeDelivery();
                    void (async () => {
                        await api().terminal.write(terminalId, plan.body);
                        if (!plan.submitSeparately) return;
                        await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
                        await api().terminal.write(terminalId, plan.submit);
                    })();
                },
                onCommandWindow: (terminalId: string) => {
                    // The terminal-scoped layer still exists for a reason (Tynn #247):
                    // inside a terminal the keypress must never reach the shell. It now
                    // records the terminal AND opens, instead of conflating the two.
                    setCommandWindowFor(terminalId);
                    setPaletteOpen(true);
                },
            }),
            [],
        ),
        hotkeys,
    );
    // "Run a recipe" launcher (Toolbar wand button). Scoped to the active
    // workspace so a recipe's git/gh terminal steps default their cwd to the
    // repo — see recipeLaunchScope + RecipeLauncher.
    const [recipeLauncherOpen, setRecipeLauncherOpen] = useState(false);
    /**
     * ONE DRAWER AT A TIME — P7, and the owner's ruling on the conflict with the Lists dock.
     *
     * This replaces ELEVEN independent booleans that were OR-ed by hand to answer one question. The
     * old comment on that OR said what was wrong with it: *"a missing flag means Escape navigates out
     * from under an open panel."* Two-open-at-once is now unrepresentable rather than merely absent.
     *
     * The palette, first run and the recipe launcher keep their own state DELIBERATELY — see
     * `lib/drawers.ts`. ⌘K must open over a flyout (genie#820 was that bug), first run must not be
     * cancellable by a flyout, and neither competes for the right edge.
     */
    const [openDrawer, setOpenDrawer] = useState<DrawerId | null>(null);
    // Launchable plugin PANELS (enabled + `ui.panel`-granted plugins). Client-local
    // (like editorFor): the panel renders in whichever window the user sits at.
    const [pluginPanels, setPluginPanels] = useState<PluginPanelView[]>([]);
    const pluginPanelsRef = useRef(pluginPanels);
    pluginPanelsRef.current = pluginPanels;
    // The container Dev Server (#234). One map of workspaceId → its dev sites,
    // because the rail's indicator is per-row and a per-workspace fetch on paint
    // would be N calls. HOST-SOURCED in a remote window now: `api().devServer.site`
    // routes to the HOST over the bridge, so the rail indicator reflects the HOST's
    // sites and the `dev-server:changed` push arrives via PASSTHROUGH_EVENTS.
    const [siteManagerWsId, setSiteManagerWsId] = useState<string | null>(null);
    /** The workspace whose Processes modal is open. */
    const [processManagerWsId, setProcessManagerWsId] = useState<string | null>(null);
    const [newAgentWsId, setNewAgentWsId] = useState<string | null>(null);
    const [devSites, setDevSites] = useState<Record<string, DevSiteInfo[]>>({});

    const [onboardingOpen, setOnboardingOpen] = useState(false);
    // The System Workspace row is hidden by default; the sidebar's chip toggles
    // it. Distinct from the `genie-os` DRAWER, which is the full-screen Genie OS layer.
    const [systemRevealed, setSystemRevealed] = useState(false);
    // Hibernated workspaces are hidden by default (genie#705) — the point of
    // hibernating one is to get it out of the way. Persisted, so the choice
    // survives a restart the way the collapse state does.
    const [hibernatedRevealed, setHibernatedRevealed] = useState(false);
    useEffect(() => {
        let alive = true;
        void api()
            .settings.get()
            .then((s) => {
                if (!alive) return;
                setHibernatedRevealed(s?.reveal_hibernated === 'on');
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, []);
    useEffect(() => {
        if (isRemoteWindow()) return;
        void api().app.genieOsStatus().then(({ setup }) => {
            setOnboardingOpen(!setup);
            if (!setup) setOpenDrawer('genie-os');
        });
    }, []);
    useEffect(() => {
        if (!hasGenieBridge()) return;
        const load = () => {
            const ids = workspaces.map((w) => w.id);
            void Promise.all(
                ids.map((id) =>
                    api()
                        .devServer.site(id, { action: 'list' })
                        .then((r) => [id, r.sites ?? []] as const)
                        .catch(() => [id, [] as DevSiteInfo[]] as const),
                ),
            ).then((pairs) => setDevSites(Object.fromEntries(pairs)));
        };
        load();
        // PUSH (no poll): main fires this on every config edit, start/stop and
        // boot adoption — a site can come up minutes into the session.
        return api().on.devServerChanged(load);
    }, [workspaces]);
    // Docs flyout (the ? titlebar button toggles this in-window panel rather
    // than opening a separate BrowserWindow).
    // Issue Watch: the flyout (scoped to a chosen workspace) + per-workspace
    // unread counts by type (the sidebar 3-dot pill: Issues · PRs · Dependabot).
    const [issueWatchWsId, setIssueWatchWsId] = useState<string | null>(null);
    const [issueWatchCounts, setIssueWatchCounts] = useState<
        Record<string, WatchTypeCounts>
    >(() => ({}));
    useEffect(() => {
        const load = () =>
            void api()
                .issueWatch.counts()
                .then(setIssueWatchCounts)
                .catch(() => {});
        load();
        return api().on.issueWatchUpdate(({ counts }) => setIssueWatchCounts(counts));
    }, []);
    const openIssueWatch = useCallback((wsId: string) => {
        setIssueWatchWsId(wsId);
        setOpenDrawer('issuewatch');
    }, []);
    // Task Manager: cross-workspace view of every spawned background process.
    // Opening from the tray sends a one-shot event; mirror it into the flyout.
    useEffect(() => {
        return api().on.openTaskManager?.(() => setOpenDrawer('tasks'));
    }, []);
    // AgentInbox: the human panel + an AGENT-LAG badge on its titlebar button.
    const [agentInboxLag, setAgentInboxLag] = useState(0);
    // genie #64 — the badge counts messages the AGENTS haven't received/ACKed, not
    // messages the human hasn't read. It used to bump on every `agentinbox:message`
    // while the panel was closed, so ordinary agent-to-agent chatter pulled the
    // owner in constantly. The actionable signal is an agent falling BEHIND, which
    // only the host knows (delivery/ACK cursors) — so seed from the host and track
    // its `agentinbox:lag` level. Opening the panel deliberately does NOT clear it:
    // looking at the inbox doesn't catch an agent up. The human's own read/unread
    // is separate and lives client-side, inside the flyout.
    useEffect(() => {
        let alive = true;
        const seed = () => {
            api()
                .agentInbox.lag()
                .then((r) => {
                    if (alive) setAgentInboxLag(r.count);
                })
                .catch(() => {});
        };
        seed();
        const off = api().on.agentInboxLag?.((p) => setAgentInboxLag(p.count));
        return () => {
            alive = false;
            off?.();
        };
    }, []);
    // Flows: the manager flyout + whether ANYTHING is running, which is what the
    // header icon animates on.
    //
    // Seed then subscribe, like the AgentInbox lag above. Both halves are
    // load-bearing: `flows:activity` is a broadcast with no persistence and
    // nothing replays it, so a Flow that started before this window existed would
    // leave the icon still while work was in flight. The seed is the answer to
    // "what is true right now"; the subscription is every change after.
    //
    // There is no interval anywhere in this path. A poller would both lag the
    // thing it reports and keep waking the renderer to be told nothing happened.
    /**
     * A VIRTUAL WORKSTATION CAME ONLINE since you last looked.
     *
     * This effect was inside `HostsButton`, glowing its icon. That icon is gone with the rest of
     * the cluster, and this is the signal with the longest wait behind it — spawning takes minutes,
     * and without it the owner re-opens a popover to catch the moment a workstation becomes
     * connectable. So it moved up here and feeds the Deck's strip.
     *
     * It POLLS, which it also did before, and that is not an improvement: `api().workstations`
     * has no push for this transition. Left as it was rather than quietly changed — a 20s interval
     * on an existing path is a different conversation from deleting an icon.
     */
    const [workstationCameOnline, setWorkstationCameOnline] = useState(false);
    const seenConnectableRef = useRef<Set<string> | null>(null);
    useEffect(() => {
        // A remote Floor does not spawn workstations, so it has nothing to be told about.
        if (isRemoteWindow()) return;
        let cancelled = false;
        const poll = async () => {
            const ws = await api()
                .workstations.connectable()
                .catch(() => [] as ConnectableWorkstation[]);
            if (cancelled) return;
            const fresh = newlyConnectableWorkstationIds(seenConnectableRef.current, ws);
            seenConnectableRef.current = connectableWorkstationIds(ws);
            if (fresh.length > 0) setWorkstationCameOnline(true);
        };
        void poll(); // the first poll seeds the baseline — no signal for already-online
        const t = setInterval(() => void poll(), 20_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const [flowsBusy, setFlowsBusy] = useState(false);
    useEffect(() => {
        if (!hasGenieBridge()) return;
        // NEVER in a remote window. `flows.*` is not routed over the bridge, so
        // the seed would report THIS workstation's runs — and `broadcastLocal`
        // skips host-bound windows, so no push would ever arrive to clear it.
        // The icon would animate for the wrong machine's work and then stay lit
        // forever, which is the stuck badge this whole feature is careful not to
        // produce. The manager itself says whose Flows it is listing.
        if (isRemoteWindow()) return;
        // The push IS the source. `flows.list()` used to carry a `busy` flag for
        // the seed, back when it returned one kitchen-sink payload; the unified
        // list returns rows and nothing else, which is right — a badge whose
        // state is fetched from a list is a badge that can disagree with the
        // runs it is meant to be reporting.
        //
        // Losing the seed costs nothing here. `flowsBusy` starts false, which is
        // the honest answer for a window that has not been told otherwise, and
        // the first push corrects it. The failure this whole feature avoids is
        // the OPPOSITE one — a badge lit with no run behind it, which no push
        // ever arrives to clear.
        const off = api().on.flowActivity?.((p) => setFlowsBusy(p.busy));
        return () => off?.();
    }, []);
    // PendingQuestions inbox: the top-bar question icon + its live pending count.
    // The panel owns the grouped list; the master just tracks the badge total and
    // refreshes it on `questions:changed` (event-driven, no polling).
    /**
     * Which Needs-you row has its answer form open.
     *
     * Here rather than inside `NeedsYou` so the expanded shape is assertable — the renderer's
     * test environment has no DOM and cannot click — and so answering survives the band
     * re-rendering as questions arrive.
     */
    const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(null);
    /** The Needs-you row the keyboard is on — `J`/`K` move it (`moveQueueFocus`). */
    const [focusedQueueKey, setFocusedQueueKey] = useState<string | null>(null);
    // The workspace lists (genie#556): a header icon, and a PIN that docks the
    // panel to the right edge. The pin is a per-window UI preference, so it
    // lives in localStorage — same reasoning as the AgentInbox's seen state, and
    // unlike a setting it has no business reaching another workstation.
    /**
     * THE ONE DOCK SLOT — at most one panel docked at the right edge.
     *
     * Was `listsPinned: boolean`, which was right while Lists was the only pinnable panel.
     * §5.4 adds a pinnable chat and §5.3 a file panel, and three booleans would make "all
     * pinned" representable: three panels competing for the same gutter, each reserving its
     * own. The owner's escape valve for wanting two at once is the file panel's own window.
     *
     * The same move as `openDrawer` replacing eleven booleans, for the same reason — the
     * illegal state becomes unrepresentable rather than merely absent. See `lib/drawers.ts`.
     */
    const [pinnedDock, setPinnedDock] = useState<DockId | null>(null);
    /**
     * WHO the chat thread is with — the agent on screen, or null for the genie thread.
     *
     * Derived rather than stored, so it cannot disagree with the route. A second piece of
     * state holding "which agent am I chatting to" is a second truth, and the one nobody
     * updates is the one a send goes to.
     */
    const chatSession = useMemo(
        () => (surface.showAgent ? (sessions.find((x) => x.agentId === surface.showAgent) ?? null) : null),
        [surface.showAgent, sessions],
    );
    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(LISTS_PIN_KEY);
            /**
             * BACK-COMPAT, deliberately. Every existing install has `'1'` in this key, written
             * when the pin was a boolean that could only ever mean Lists. Reading only the new
             * id form would silently unpin everyone who had it docked — a preference lost by a
             * refactor, which is the shape of defect this repo has already paid for (a changed
             * default cannot reach a value already persisted).
             */
            const dock = stored === '1' ? 'lists' : DOCKABLE.find((d) => d === stored);
            if (dock) {
                setPinnedDock(dock);
                // A panel that was docked when the window closed comes back
                // docked. Restoring the preference but not the panel would
                // leave the pin set with nothing on screen to show for it.
                setOpenDrawer(dock);
            }
        } catch {
            /* a browser with storage blocked simply starts unpinned */
        }
    }, []);
    // The two stay separate on purpose: `openDrawer === 'lists'` is "the panel is
    // showing", the dock slot is "when it shows, dock it rather than float it".
    // Folding them together is what made the header icon a dead control while
    // the panel was docked — it toggled a state nothing rendered.
    //
    // And the pin is why a docked panel is not simply a drawer like the other eleven.
    // Owner's ruling, asked directly: "a pinned dock is NOT a drawer" — a pin exists so
    // the panel stays up WHILE you work, so `somethingCoversTheFloor` excludes the DOCKED
    // panel from the overlay question even though it occupies the drawer slot.
    const togglePin = useCallback((id: DockId) => {
        setPinnedDock((was) => {
            // ONE SLOT: pinning chat while Lists is docked undocks Lists, and pinning the
            // panel already docked undocks it. Both in `pinDockNext`, with its tests.
            const next = pinDockNext(was, id);
            try {
                window.localStorage.setItem(LISTS_PIN_KEY, next ?? '');
            } catch {
                /* the pin still applies for this session */
            }
            // Pinning is done FROM the open panel, so it stays open: changing
            // HOW it is shown must never be a way to lose it.
            setOpenDrawer(id);
            return next;
        });
    }, []);
    // The Lists panel's own pin, which is what its header button calls.
    const toggleListsPin = useCallback(() => togglePin('lists'), [togglePin]);
    // The badge counts ONLY what is waiting on the PERSON. An agent's own
    // checklist is the agent's work, and a number the user cannot clear is a
    // number they learn to ignore.
    const [listsUserCount, setListsUserCount] = useState(0);
    useEffect(() => {
        // A host window counts the HOST's items: `lists.read` is host-sourced in
        // the bridge (genie#586), so the badge reflects the machine whose work it
        // is. A failed read falls back to NO badge rather than a stale number —
        // "we could not ask" is not "nothing is waiting", and the panel is where
        // that difference gets said in words.
        if (!hasGenieBridge() || !activeWorkspaceId) {
            setListsUserCount(0);
            return;
        }
        const load = () =>
            void api()
                .lists.read(activeWorkspaceId)
                .then((v) => setListsUserCount(v.userCount))
                .catch(() => setListsUserCount(0));
        load();
        // Push-driven, like the questions badge: an agent adding an item through
        // the `lists` tool moves this without a timer. On a host window the push
        // is the HOST's `lists:changed`, re-emitted onto this channel by main.
        return api().on.listsChanged?.((payload) => {
            if (!payload?.workspaceId || payload.workspaceId === activeWorkspaceId) load();
        });
    }, [activeWorkspaceId]);
    // The GApp Store drawer, opened from the App Tray's icon in the header.
    const [questionCount, setQuestionCount] = useState(0);
    useEffect(() => {
        // #60: badge how many QUESTIONS are waiting (incl. DND-deferred) — not how
        // many workspaces they are spread across, which was the old behaviour and
        // showed "1" for the three questions the flyout was listing.
        //
        // `questionBadgeCount` returns NULL when a payload carries no readable
        // total, and null means FETCH rather than zero: several emitters send
        // `questions:changed` with no payload at all, and treating that as "none"
        // is precisely how this badge sat empty while questions were waiting.
        const fetchCount = (): void => {
            api()
                .questions?.list?.()
                .then((r) => {
                    const n = questionBadgeCount(r);
                    if (n !== null) setQuestionCount(n);
                })
                .catch(() => {});
        };
        const load = (payload?: unknown): void => {
            const pushed = questionBadgeCount(payload);
            if (pushed !== null) setQuestionCount(pushed);
            else fetchCount();
        };
        load();
        const off = api().on.questionsChanged?.(load);
        // Self-heal. A dropped event, a bridge that attached late, a window that
        // was asleep — any of them would otherwise leave the badge frozen until
        // the next question arrives. Refocusing the window is the moment the user
        // looks at it, so it is the moment to be right, and it costs one local
        // IPC call. Event-driven, not a timer.
        window.addEventListener('focus', fetchCount);
        return () => {
            off?.();
            window.removeEventListener('focus', fetchCount);
        };
    }, []);
    // Split Add-Terminal button: the last-used terminal type (persisted) + the
    // configured custom-agent command (for the create form's placeholder).
    const [lastTerminalType, setLastTerminalTypeState] = useState<TerminalTypeId>('regular');
    const [agentCustomCommand, setAgentCustomCommand] = useState<string>('');
    // Persist the last-used terminal type (runtime-owned: targeted patch, so the
    // Settings window's stale-snapshot Save can't clobber it — see settings-nav).
    const setLastTerminalType = useCallback((id: TerminalTypeId) => {
        setLastTerminalTypeState(id);
        void api().settings.set({ last_terminal_type: id }).catch(() => {});
    }, []);
    // The spec whose AgentInbox purpose/scope is being edited (context menu →
    // "Agent settings…"), or null. Rendered as a modal reusing the create form.
    const [agentEditSpec, setAgentEditSpec] = useState<TerminalSpec | null>(null);
    /**
     * The agent whose MANAGER is open — its persona, MCP servers, sidecar and
     * driver. Keyed on the AGENT RECORD, so it opens for a DORMANT agent.
     *
     * The manager is not new and was never unreachable: `AgentSettingsModal`
     * renders it whenever it finds a record. But that modal takes a
     * `TerminalSpec`, and the only route to it — "Edit agent…" — was guarded by
     * `if (row.specId)`. An agent that is not running has no spec, so the menu
     * item silently did nothing. This is the route that does not go through a
     * terminal.
     */
    const [manageAgentId, setManageAgentId] = useState<string | null>(null);
    // Load it when the settings modal opens on an agent. Cleared on close so a
    // stale record can never describe the NEXT agent someone opens.
    const agentEditWorkspace = agentEditSpec?.workspace_id ?? null;
    useEffect(() => {
        if (!agentEditWorkspace) {
            setAgentRecord(null);
            return;
        }
        void api().agents.list(agentEditWorkspace).then(setAgentRecord).catch(() => {});
    }, [agentEditWorkspace]);
    // The ACTIVE workspace's agents, for the panels on the floor. Re-read on a
    // driver switch so the control shows what happened rather than what was
    // clicked -- `addRuntime` can front an existing sidecar instead of adding
    // one, and the two look different.
    const reloadActiveAgents = useCallback(() => {
        if (!activeWorkspaceId) {
            setActiveAgentRecord(null);
            return;
        }
        void api().agents.list(activeWorkspaceId).then(setActiveAgentRecord).catch(() => {});
    }, [activeWorkspaceId]);
    useEffect(reloadActiveAgents, [reloadActiveAgents]);
    // ...and again whenever an agent record changes on the machine this window
    // drives. On a remote window that is the HOST, so a create or delete there
    // must reach this roster live rather than at the next mount (genie #327).
    useEffect(() => api().on.agentsChanged(reloadActiveAgents), [reloadActiveAgents]);
    // GitHub capability gate: which GitHub-powered features are unavailable
    // because the App is missing permissions on the user's installation. Drives
    // a persistent header warning + a resolve flyout (also auto-shown once on
    // boot when something's missing).
    const { caps: githubCaps, hasMissing: githubNeedsResolve } =
        useGithubCapabilities();
    // Auto-raise the resolve flyout ONCE per session the first time the boot
    // check reports a missing permission. Dismissible — the header warning
    // stays for resolving later. The ref guards against re-raising on every
    // capability push (reconnect, recheck) after the user has seen it once.
    const bootCapModalShown = useRef(false);
    useEffect(() => {
        if (!githubNeedsResolve || bootCapModalShown.current) return;
        // Only the master window auto-raises the boot modal; a Stage window
        // would otherwise double-surface it. (The header warning still shows on
        // both — it's a useful resolve affordance everywhere.)
        const onStage =
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).has('stage');
        if (onStage) return;
        bootCapModalShown.current = true;
        setOpenDrawer('github-caps');
    }, [githubNeedsResolve]);
    // Max panels visible per workspace (Settings → max_views, default 4).
    const [maxViews, setMaxViews] = useState(DEFAULT_MAX_VIEWS);
    // Transient notice (Tier 2 cap warnings, max-views blocks). Auto-clears.
    const [toast, setToast] = useState<string | null>(null);
    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(t);
    }, [toast]);

    // Tier 3: surface a non-fatal toast when the detached pty-host is
    // unavailable and Genie falls back to in-process terminals.
    useEffect(() => {
        return api().on.terminalHostStatus((p) => setToast(p.message));
    }, []);

    // A message came in HOT for an agent whose input box Genie would not touch:
    // Genie could not be certain what was in there (history recall, an image, an
    // exotic edit), so the notice was appended WITHOUT being submitted rather
    // than cutting text it could not restore.
    //
    // The whole PAYLOAD is kept, not a fixed sentence. This toast used to read "A
    // message just came in for THIS agent … press Enter to deliver it", with the
    // `{ id }` argument discarded right here — so it named no terminal, and "this
    // agent" could only be read as the one with focus. The notice had gone to the
    // ADDRESSEE, which is usually a different terminal and often a different
    // workspace, and pressing Enter went into a box that was genuinely empty.
    const [incoming, setIncoming] = useState<Record<string, AgentInboxIncomingNotice>>({});
    useEffect(() => {
        // Optional: the remote bridge does not carry it (a local-prompt concern).
        return api().on.agentInboxIncoming?.((payload) =>
            setIncoming((current) => {
                if (!payload.pending) {
                    const next = { ...current };
                    delete next[payload.id];
                    return next;
                }
                return { ...current, [payload.id]: payload };
            }),
        );
    }, []);
    const pendingWorkspaceIds = new Set(
        Object.values(incoming)
            .map((notice) => notice.workspaceId)
            .filter((id): id is string => !!id),
    );
    /**
     * Release a parked notice, and report whether it landed so the banner can
     * follow up. `clearInput` is the person saying the box is theirs to clear.
     *
     * A refusal no longer just raises a toast telling someone to do something
     * they may already have done: the banner takes the answer and offers the
     * kill-line, which is the only way past a draft the TUI cleared behind
     * Genie's back (genie#333).
     */
    const sendPendingNudge = async (
        terminalId: string,
        options?: { clearInput?: boolean },
    ): Promise<boolean> => {
        const result = await api().agentInbox.sendPendingNudge(terminalId, options);
        if (result.ok) return true;
        if (result.reason !== 'input-not-empty') {
            setToast('The nudge could not be sent. The notice is still queued.');
        }
        return false;
    };

    // Host-loss recovery (genie#203). When the shared pty-host dies mid-session,
    // main respawns a backend and asks us to remount the affected panes (their
    // create() rejoins + replays) via a per-id generation bump, plus a banner.
    const [recoverGenById, setRecoverGenById] = useState<
        Record<string, number>
    >({});
    const [recovery, setRecovery] = useState<RecoveryState | null>(null);
    useEffect(() => {
        return api().on.terminalRecover?.(({ ids }) => {
            setRecoverGenById((prev) => bumpRecoverGen(prev, ids));
        });
    }, []);
    useEffect(() => {
        return api().on.terminalRecoveryStatus?.(({ state }) =>
            setRecovery(state),
        );
    }, []);
    // Auto-dismiss the banner once recovery settles (keep 'recovering' pinned).
    useEffect(() => {
        if (recovery !== 'recovered' && recovery !== 'degraded') return;
        const t = setTimeout(() => setRecovery(null), 5000);
        return () => clearTimeout(t);
    }, [recovery]);

    // Customization: play the notification sound for whichever alert the main
    // side fired — the eight kinds in main/notify-sound-kinds.ts, each with its
    // own Settings row (genie#546). The payload carries a `sound` descriptor
    // resolved per-alert: 'synth' keeps the built-in Web Audio chime, 'asset'
    // plays a bundled wav from ./sounds/<name>.wav (relative to the page, so it
    // resolves under file://), 'data' plays a custom file the main side read
    // into a data-URL. A legacy payload with no descriptor falls back to synth.
    //
    // WHICH chime `synth` means comes from `motifForPayload`, not from a `kind`
    // comparison here: the payload now names its motif, and the kind-only form
    // is the fallback for a REMOTE host one version behind. All best-effort.
    useEffect(() => {
        return api().on.notifySound((payload) => {
            try {
                const mode = payload?.sound?.mode ?? 'synth';
                if (mode === 'asset' && payload.sound?.mode === 'asset') {
                    void new Audio(`./sounds/${payload.sound.name}.wav`)
                        .play()
                        .catch(() => {});
                    return;
                }
                if (mode === 'data' && payload.sound?.mode === 'data') {
                    void new Audio(payload.sound.dataUrl).play().catch(() => {});
                    return;
                }
                playChime(motifForPayload(payload ?? {}));
            } catch {
                /* audio is best-effort */
            }
        });
    }, []);

    // Agent-integration MCP: a terminal called imDone → start/stop its glow.
    useEffect(() => {
        return api().on.terminalAttention(({ id, on }) => {
            setAttentionIds((prev) => {
                if (on === prev.has(id)) return prev;
                const next = new Set(prev);
                if (on) next.add(id);
                else next.delete(id);
                return next;
            });
        });
    }, []);

    // Clear a terminal's attention glow as soon as it gets focus.
    useEffect(() => {
        if (!focusId) return;
        setAttentionIds((prev) => {
            if (!prev.has(focusId)) return prev;
            const next = new Set(prev);
            next.delete(focusId);
            return next;
        });
    }, [focusId]);

    // Clear a terminal's attention glow when the user actually focuses its
    // panel (clicks/tabs into the xterm). The focusId effect above only fires
    // on focus *transitions* — but a terminal that called imDone is usually
    // already the focused one, so re-clicking it never re-fires that effect.
    // This is the robust path: it reacts to the real DOM focus event and
    // broadcasts a clear so the rail/flyout/border stop pulsing in every window.
    const clearAttention = useCallback((id: string) => {
        setAttentionIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        void api().terminal.clearAttention(id).catch(() => {});
    }, []);

    // Manual-quit terminal confirmation (T3). Main broadcasts the live host
    // terminals when the user quits with detached terminals running; we show a
    // modal and reply with the keep/kill decision. Null = no dialog up. The
    // master window is the only one that registers this (the dialog is shown in
    // whichever window main picks; all windows subscribe so any can host it).
    const [quitPrompt, setQuitPrompt] = useState<{
        terminals: QuitTerminal[];
        destructive: boolean;
    } | null>(null);
    useEffect(() => {
        return api().on.confirmQuitTerminals((p) => {
            setQuitPrompt({
                terminals: p.terminals ?? [],
                destructive: !!p.destructive,
            });
        });
    }, []);
    const decideQuit = useCallback(
        (decision: { confirmed: boolean; keepIds: string[] }) => {
            setQuitPrompt(null);
            api().app.quitDecision(decision);
        },
        [],
    );

    // The System Workspace row the sidebar draws (null until the path resolves).
    // Composed here because main's `listWorkspaces()` deliberately withholds the
    // real, protected row from every list a picker reads.
    // It's the CLIENT machine's local full-filesystem home dir — a desktop-only
    // concept. In a remote/host window you're driving ANOTHER machine, so it makes
    // no sense there and must NOT appear in the rail: keep it null (which also
    // inerts the reveal chip + the id resolver entry for a host window).
    const genieOsSpec = useMemo(
        () => specs.find(isGenieOsTerminalSpec) ?? null,
        [specs],
    );
    // Composed from the OSA terminal's cwd, which is the HOST's on a remote
    // window — so the chip, and the Host Genie OSA under it, now appear when
    // driving another machine (genie#455). `homeDir` stays desktop-only.
    const systemWorkspace = useMemo(
        () => systemWorkspaceRow(genieOsSpec?.cwd, homeDir, isRemoteWindow()),
        [genieOsSpec?.cwd, homeDir],
    );

    // Workspaces shown in the sidebar: the persisted list, with the System
    // Workspace pinned to the TOP when revealed. It's fixed (never draggable /
    // reorderable) so it always sits first and doesn't shuffle the user's order.
    /** Every workspace id that exists, displayed or not — the set that lets the
     *  rail tell an ORPHAN from a terminal whose workspace is merely hidden. */
    const knownWorkspaceIds = useMemo(
        () => new Set(workspaces.map((w) => w.id)),
        [workspaces],
    );

    const displayWorkspaces = useMemo(
        () =>
            sidebarWorkspaceRows(
                // Hibernated workspaces drop out of the rail unless revealed
                // (genie#705). Filtered BEFORE the System row is prepended: the
                // System Workspace is Genie's own and never hibernates.
                withoutHibernated(workspaces, hibernatedRevealed),
                systemWorkspace,
                systemRevealed,
                genieOsSpec?.cwd,
            ),
        [workspaces, systemWorkspace, systemRevealed, hibernatedRevealed, genieOsSpec?.cwd],
    );

    // id → workspace resolver. ALWAYS includes the System Workspace (even when
    // hidden) so handlers can resolve its id for terminals/editors/processes
    // that already exist in it; visibility is a sidebar concern, not a lookup
    // concern.
    const workspacesById = useMemo(() => {
        const m = new Map<string, WorkspaceRow>();
        for (const w of workspaces) m.set(w.id, w);
        if (systemWorkspace) m.set(systemWorkspace.id, systemWorkspace);
        return m;
    }, [workspaces, systemWorkspace]);

    // Resolve a Feedback request against the ACTIVE workspace once it is known.
    useEffect(() => {
        if (!feedbackRequested || !launchRestored) return;
        const ws = feedbackWorkspaceFor(activeWorkspaceId, workspacesById);
        if (!ws) return;
        setFeedbackRequested(false);
        setFeedbackWsId(ws.id);
    }, [feedbackRequested, launchRestored, activeWorkspaceId, workspacesById]);

    /**
     * LAUNCH THE APP A GApp DEVELOPMENT WORKSPACE BUILDS (genie#245).
     *
     * ONE handler behind EVERY affordance — the workspace row's GApp control,
     * the Command Window's action, and the GApp Store's dev-launcher entry —
     * because entry points that each did their own thing would be that many
     * chances to disagree about which workspace's folder gets opened. It is the
     * same `apps.previewFolder` the Settings button calls, aimed at the workspace
     * path rather than a folder picker.
     *
     * The outcome is ALWAYS said out loud. Launching an app is a slow, invisible
     * act — the window takes seconds to appear and may not appear at all — and a
     * control that silently does nothing on failure is the shape of bug this
     * whole piece of work is a reaction to.
     */
    const [launchingGappWsId, setLaunchingGappWsId] = useState<string | null>(null);
    const launchGapp = useCallback(
        (workspaceId: string) => {
            const ws = workspacesById.get(workspaceId);
            const target = ws ? gappLaunchTargets([ws])[0] : undefined;
            if (!target) return;
            setLaunchingGappWsId(workspaceId);
            void api()
                .apps.previewFolder(target.path)
                .then((r) => {
                    setToast(
                        r.ok
                            ? `${target.name} is open at ${r.homeUrl ?? 'its preview address'}.`
                            : r.errors?.join(' ') || `${target.name} did not open.`,
                    );
                })
                .catch(() => setToast(`${target.name} did not open.`))
                .finally(() => setLaunchingGappWsId(null));
        },
        [workspacesById],
    );

    // Auto-provision the Tynn agent token + Agent MCP config when a workspace
    // becomes active. Silent + best-effort + once per workspace per session:
    // main-side decideProvision() no-ops when the workspace is unlinked, the
    // user is signed out, or it's already configured — so this only mints when
    // a linked, signed-in workspace is missing its token.
    const tynnProvisionedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        if (!activeWorkspaceId || tynnProvisionedRef.current.has(activeWorkspaceId)) return;
        // The System Workspace is not a real project — never provision it.
        if (activeWorkspaceId === SYSTEM_WORKSPACE_ID) return;
        const ws = workspacesById.get(activeWorkspaceId);
        if (!ws?.path) return;
        tynnProvisionedRef.current.add(activeWorkspaceId);
        void api().tynn.provision(ws.path).catch(() => {});
    }, [activeWorkspaceId, workspacesById]);

    // --- Tynn MCP health (the logo's light) ------------------------------
    // Can the agents in THIS workspace actually reach Tynn, and if not, why?
    // The probe is read-only (initialize + tools/list — the endpoint is the
    // user's production Tynn) and lives in main; see main/mcp/tynn-health.ts.
    const [tynnHealth, setTynnHealth] = useState<Record<string, TynnHealth>>({});
    const [tynnChecking, setTynnChecking] = useState<Record<string, boolean>>({});
    const checkTynnHealth = useCallback(
        async (wsId: string) => {
            const ws = workspacesById.get(wsId);
            if (!ws?.path || wsId === SYSTEM_WORKSPACE_ID) return;
            setTynnChecking((m) => ({ ...m, [wsId]: true }));
            try {
                const health = await api().tynn.health(wsId, ws.path, ws.project_name);
                setTynnHealth((m) => ({ ...m, [wsId]: health }));
            } catch {
                // The main-side probe never throws; only a dead bridge lands
                // here, and the indicator simply keeps its last known state.
            } finally {
                setTynnChecking((m) => ({ ...m, [wsId]: false }));
            }
        },
        [workspacesById],
    );
    // Probe on ACTIVATE, once per workspace per session. Not on every switch:
    // each probe is two real requests to production, and health only moves when
    // the config or the server does. Clicking the logo is the explicit re-check.
    useEffect(() => {
        if (!activeWorkspaceId || activeWorkspaceId === SYSTEM_WORKSPACE_ID) return;
        if (tynnHealth[activeWorkspaceId] || tynnChecking[activeWorkspaceId]) return;
        void checkTynnHealth(activeWorkspaceId);
    }, [activeWorkspaceId, tynnHealth, tynnChecking, checkTynnHealth]);
    // Results are PUSHED (no polling): another window's probe updates this one,
    // and a warm cache from main survives a renderer reload.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        void api()
            .tynn.healthAll()
            .then((all) => setTynnHealth((m) => ({ ...all, ...m })))
            .catch(() => {});
        return api().on.tynnHealthUpdate((health) =>
            setTynnHealth((m) => ({ ...m, [health.workspaceId]: health })),
        );
    }, []);

    // Stage windows arrive with ?stage=<workspaceId>. Read it once on mount so
    // the launch restore below can pin the grid to that workspace's terminals.
    const isStage = useMemo(() => {
        if (typeof window === 'undefined') return false;
        const p = new URLSearchParams(window.location.search);
        return p.has('stage');
    }, []);
    const stageSeedWorkspace = useMemo(() => {
        if (typeof window === 'undefined') return null;
        const p = new URLSearchParams(window.location.search);
        const v = p.get('stage');
        return v && v !== '1' ? v : null;
    }, []);

    /**
     * Record this window's view of a workspace: update the in-memory cache
     * synchronously (so a switch reads the settled value at once) and flush the
     * whole store to the LOCAL settings table debounced — coalescing the
     * transient intermediate renders of a workspace switch into ONE write,
     * exactly like `layout_json`. `api().settings` is never bridged to a host,
     * so a host window's writes stay client-local.
     *
     * Declared ABOVE `refresh` because the launch restore itself calls
     * `persistView` to record a first-connect seed (genie#579) — a later `const`
     * could not go in `refresh`'s dependency array without a TDZ error.
     */
    // Flush this window's view slice to the LOCAL settings, MERGING onto a fresh
    // read so a CONCURRENT window (local + host windows share one `view_state_json`
    // blob) that edited a different connKey isn't clobbered by our snapshot. We own
    // only our `${currentConnKey()}|…` entries; every other window's slice is
    // preserved from the freshly-read store. Best-effort: a read/link blip just
    // skips this flush (the next view change re-flushes) rather than writing a
    // possibly-stale full blob.
    const flushViewState = useCallback(async () => {
        const connKey = currentConnKey();
        let latest: ViewStateStore;
        try {
            const s = await api().settings.get();
            latest = parseViewStateStore(s.view_state_json);
        } catch {
            return;
        }
        const merged = overlayOwnConnKey(latest, viewCacheRef.current, connKey);
        // Keep the cache consistent with disk for OTHER connKeys so a later restore
        // (workspace switch) reads their up-to-date values, not our stale mount seed.
        viewCacheRef.current = merged;
        await api()
            .settings.set({ view_state_json: JSON.stringify(merged) })
            .catch(() => {});
    }, []);

    const persistView = useCallback(
        (connKey: string, workspaceId: string, state: WorkspaceViewState) => {
            viewCacheRef.current = writeWorkspaceView(
                viewCacheRef.current,
                connKey,
                workspaceId,
                state,
            );
            if (viewFlushRef.current) clearTimeout(viewFlushRef.current);
            viewFlushRef.current = setTimeout(() => {
                viewFlushRef.current = null;
                void flushViewState();
            }, 150);
        },
        [flushViewState],
    );

    const refresh = useCallback(async () => {
        const [ws, sp, settings] = await Promise.all([
            api().workspaces.list(),
            api().terminalSpec.list(),
            // active_workspace drives the launch restore below; load it here so
            // the seed is computed from data in hand, never a later async read.
            api()
                .settings.get()
                .catch(() => null),
        ]);
        setWorkspaces(ws);
        setSpecs(sp);
        // Warm THIS window's client-local view store from the (local) settings
        // so the launch restore + subsequent switches read a settled cache.
        const connKey = currentConnKey();
        // Re-warm from disk, but KEEP this window's own `${connKey}|…` slice: a
        // refresh can land inside the 150ms persist debounce, and a plain
        // re-parse would drop the close/focus the user just made — the pending
        // flush would then write the STALE entry back and the panel would reopen
        // on the next connect (genie#579). Other windows' slices still come from
        // disk, which is what `overlayOwnConnKey` is for. On the first refresh the
        // cache is empty, so this is exactly the plain parse.
        viewCacheRef.current = overlayOwnConnKey(
            parseViewStateStore(settings?.view_state_json),
            viewCacheRef.current,
            connKey,
        );
        // Restore the launch grid ONCE, computed from the FRESHLY-FETCHED arrays
        // (not React state read through an effect closure). The previous seed
        // effect fired on `[workspaces.length]` but read `specs` via closure and
        // latched a one-shot guard; if it ever ran before the target's specs
        // landed in state it seeded an empty selection and never retried, so the
        // grid came up empty across a quit+relaunch. Seeding from `sp`/`ws`
        // directly removes that race — the specs are always in hand here.
        if (!seededActiveRef.current && ws.length > 0) {
            seededActiveRef.current = true;
            const { activeWorkspaceId: target, selectedIds, seeded } = computeLaunchSelection({
                specs: sp,
                workspaces: ws,
                savedActiveWorkspace: settings?.active_workspace ?? null,
                stageSeedWorkspace,
                systemWorkspaceId: SYSTEM_WORKSPACE_ID,
                viewStore: viewCacheRef.current,
                connKey,
                // The cap comes from the settings ALREADY IN HAND, not the
                // `maxViews` state — that is loaded by its own effect and may not
                // have landed yet, and a restore that races it would open an
                // unclamped grid exactly once, on the launch that matters
                // (genie#577).
                maxViews: parseMaxViews(settings?.max_views),
            });
            if (target) {
                setActiveWorkspaceId(target);
                // A Stage window's `?stage=` seed may already have populated the
                // selection — don't clobber it.
                setSelected((prev) => (prev.size > 0 ? prev : new Set(selectedIds)));
                // Restore this window's focus/maximize/layout for the launch
                // workspace too (activateWorkspace does the same on later switches).
                const saved = readWorkspaceView(viewCacheRef.current, connKey, target);
                if (saved) {
                    setFocusId(saved.focusId);
                    setMaximizedId(saved.maximizedId);
                    setLayoutMode(saved.layoutMode);
                } else if (seeded) {
                    // FIRST connect for this `(connKey, workspace)`: record the seed
                    // NOW, so the "seed from the host's enabled specs" fallback runs
                    // exactly once. It is not a neutral default — closing a panel
                    // never clears the host's `enabled`, so any later connect that
                    // finds no entry resurrects every panel the user ever closed
                    // (genie#579). Waiting for the debounced write-back effect left
                    // that window open on every launch the user changed nothing in.
                    persistView(connKey, target, {
                        visibleIds: selectedIds,
                        focusId: null,
                        maximizedId: null,
                        layoutMode: 'auto',
                    });
                }
            }
        }
        // The launch restore has run — subsequent view changes may now persist.
        viewRestoredRef.current = true;
        setLaunchRestored(true);
    }, [isStage, stageSeedWorkspace, persistView]);

    /**
     * Persist a user-defined sidebar order (full ordered list of workspace
     * ids from the flyout drag). Reorder locally first so the rail + flyout
     * update instantly, then persist; main re-sorts on the next list().
     */
    const reorderWorkspaces = useCallback((ids: string[]) => {
        // The synthetic System Workspace is never part of the persisted order.
        const realIds = ids.filter((id) => id !== SYSTEM_WORKSPACE_ID);
        setWorkspaces((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            const next = realIds
                .map((id) => byId.get(id))
                .filter((w): w is WorkspaceRow => !!w);
            // Append any workspaces not present in the id list (defensive).
            for (const w of prev) if (!realIds.includes(w.id)) next.push(w);
            return next;
        });
        void api().workspaces.reorder(realIds).catch(() => {});
    }, []);

    /**
     * Persist a user-defined PANEL order for the active workspace (the grid's
     * drag-reorder). Same shape as the sidebar reorder above: apply locally
     * first so the tiles settle instantly, then persist — main writes each
     * index to `terminal_specs.sort_order`, which is what the next list()
     * sorts by, so the order survives a reload.
     */
    const reorderSpecs = useCallback((orderedIds: string[]) => {
        setSpecs((prev) => applyPanelOrder(prev, orderedIds));
        void api().terminalSpec.reorder(orderedIds).catch(() => {});
    }, []);

    /**
     * CANNOT FAIL, and that is the whole point — see `probeTynnAuth`.
     *
     * This was `await Promise.all([whoami, tynnHost.get()])` with no catch, and the effect below
     * sets `authChecked` AFTER it. The window renders "Checking sign-in…" until that flag flips, so
     * a rejected probe left Genie on that screen permanently: offline, a bad `tynnHost`, Tynn down.
     * The sign-in wall the owner asked to be removed, reached by failure instead of by being signed
     * out — which is worse, because being signed out at least looked deliberate.
     */
    const refreshAuth = useCallback(async () => {
        const probe = await probeTynnAuth({
            whoami: () => api().auth.whoami('tynn') as Promise<BackendUser | null>,
            host: () => api().tynnHost.get(),
        });
        setHosts({ tynn: probe.host });
        setSignedIn(probe.signedIn);
        // The NAME, for the menu. A workstation can be signed into the wrong account and nothing
        // else in the window says so.
        setTynnAccountName(probe.name);
        return probe.signedIn;
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const any = await refreshAuth();
            if (cancelled) return;
            // BEFORE anything that can throw. This flag is what dismisses "Checking sign-in…", so
            // every failure after it is a failure in a window the owner can see and use.
            setAuthChecked(true);
            // REFRESH EITHER WAY. Tynn is optional, so a signed-out workstation has local
            // workspaces to list and a Deck to fill — gating the read on an account is what made
            // "fully local mode" impossible, one layer below the sign-in wall itself.
            void any;
            await refresh().catch(() => {});
        })();
        const off = api().on.authChanged(async () => {
            const any = await refreshAuth();
            if (any) await refresh();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [refresh, refreshAuth]);

    // Keep the spec list live when main mutates it behind the renderer's back —
    // notably a process created via the MCP `manageProcess` tool. The renderer
    // mirrors its own create/delete edits locally, so this only re-fetches for
    // changes it can't see; the new process appears in the Processes list at
    // once, no restart. Re-fetch only specs (workspaces are unaffected).
    useEffect(() => {
        const off = api().on.terminalSpecsChanged(() => {
            void api()
                .terminalSpec.list()
                .then(setSpecs)
                .catch(() => {});
        });
        return off;
    }, []);

    // Workspaces provisioned outside this renderer (e.g. via the MCP
    // provisionWorkspaces tool, or the per-workspace Ops panel in another
    // window) — re-fetch the workspace list so the rail shows them live.
    useEffect(() => {
        const off = api().on.workspacesChanged(() => {
            void api()
                .workspaces.list()
                .then(setWorkspaces)
                .catch(() => {});
        });
        return off;
    }, []);

    // Ask Tynn for the project list on mount and whenever this window regains
    // focus. Same reason the max_views read below does it: the thing that
    // changed lives in ANOTHER window — here, another APPLICATION. Marking a
    // project as a Genie App happens in Tynn in a browser, and coming back to
    // Genie is exactly the moment the user expects it to have noticed (genie#245).
    //
    // The fetch is the sync: main reconciles `is_gapp` onto the workspace rows
    // inside the `tynn:projects` handler and broadcasts `workspaces:changed` when
    // something moved, which the effect above turns into a rail re-render. So
    // this deliberately discards the result — it is not a poll for project data,
    // it is a nudge, and it costs one request only when the window is focused.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        nudgeGappDevSyncOnFocus();
        window.addEventListener('focus', nudgeGappDevSyncOnFocus);
        return () => window.removeEventListener('focus', nudgeGappDevSyncOnFocus);
    }, []);

    // Load the max_views setting and keep it fresh — the Settings screen is
    // a separate window, so re-read whenever this window regains focus.
    useEffect(() => {
        const load = () => {
            void api()
                .settings.get()
                .then((s) => {
                    // Same parser the launch restore uses, so the cap that
                    // disables the Add button can never differ from the cap the
                    // restore clamped to (genie#577).
                    setMaxViews(parseMaxViews(s.max_views));
                    // Split Add-Terminal button: the last-used type + the custom
                    // agent command (drives the create form's placeholder).
                    setLastTerminalTypeState(
                        terminalTypeById(s.last_terminal_type).id,
                    );
                    setAgentCustomCommand(s.agent_command_custom ?? '');
                })
                .catch(() => {});
        };
        load();
        window.addEventListener('focus', load);
        return () => window.removeEventListener('focus', load);
    }, []);

    // NOTE: launch restore (which workspace is active + which of its terminals
    // are selected) is seeded inside `refresh()` from the freshly-fetched
    // arrays — including Stage windows, which pin to their `?stage=` workspace.
    // It used to live in a `[workspaces.length]` effect that read `specs` via
    // closure and latched a one-shot guard; that could seed an empty selection
    // before specs loaded and never retry, leaving the grid blank after a
    // quit+relaunch. See `computeLaunchSelection` + its tests.

    // Active-workspace views drive the grid layout + counts. Processes are
    // headless services — they never surface in the main grid.
    const selectedSpecs = useMemo(
        () =>
            // A HIBERNATING workspace mounts no panel (genie#672): main refuses
            // the pty, so a mounted panel would be an error card where the floor
            // should say the workspace is asleep.
            awakeSpecs(
                workspaceSurfaceSpecs(specs).filter(
                    (s) =>
                        s.type !== 'process' &&
                        specWorkspaceId(s) === activeWorkspaceId &&
                        selected.has(s.id),
                ),
                workspacesById,
            ),
        [specs, selected, activeWorkspaceId, workspacesById],
    );

    // Selected views in OTHER workspaces — rendered mounted-hidden so their
    // PTYs survive a workspace switch (Decision 1: keep-alive).
    const backgroundSpecs = useMemo(
        () =>
            awakeSpecs(
                workspaceSurfaceSpecs(specs).filter(
                    (s) =>
                        s.type !== 'process' &&
                        specWorkspaceId(s) !== activeWorkspaceId &&
                        selected.has(s.id),
                ),
                workspacesById,
            ),
        [specs, selected, activeWorkspaceId, workspacesById],
    );

    /**
     * Eyeball toggle — show/hide a view in the grid. HIDING a terminal (not a
     * Code view) must RETAIN its pty FIRST, so the shell — and any agent running
     * in it, with its MCP endpoint + AgentInbox membership — stays ALIVE and
     * windowless, instead of the panel's unmount detaching → KILLING it (the
     * eyeball-hide crash). Showing releases retention (a visible panel isn't a
     * windowless retained one). Same retain-before-unmount ordering as disableSpec.
     * Agent terminals are exempt from the retained cap; a plain terminal past the
     * cap is REFUSED (stays visible + a toast) rather than silently killed.
     */
    const toggleSpec = useCallback(
        async (id: string) => {
            const spec = specs.find((s) => s.id === id);
            const hiding = selected.has(id);
            if (spec && spec.type !== 'code') {
                if (hiding) {
                    const res = await api()
                        .terminal.setRetained(id, true)
                        .catch(
                            () =>
                                ({ ok: false, reason: 'Could not hide terminal.' }) as {
                                    ok: boolean;
                                    reason?: string;
                                },
                        );
                    if (!res.ok) {
                        setToast(res.reason ?? 'Could not hide terminal.');
                        return; // keep it visible — NEVER silently kill the pty/agent
                    }
                } else {
                    await api().terminal.setRetained(id, false).catch(() => {});
                }
            }
            setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
        },
        [specs, selected],
    );

    const addSpec = useCallback(
        async (workspaceId: string, type: ViewType = 'terminal') => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            // A sleeping workspace opens nothing (genie#672). Caught here rather
            // than at the pty: a spec created now would sit invisible until the
            // workspace woke and then spawn a panel nobody asked for.
            if (isHibernated(ws)) {
                setToast(`${ws.project_name} is hibernating. Wake it first.`);
                return;
            }
            // A System-Workspace PANEL or PROCESS persists UNATTACHED
            // (workspace_id: null) with a `meta.system` tag, and must: an
            // attached panel resolves its tabs against the workspace path, so a
            // panel rooted at the user's chosen cwd would be re-rooted. (The
            // operator's own terminal is a different thing — it carries the real
            // `__system__` id and is seeded by main.) Real workspaces persist
            // their own id.
            const system = isSystemWorkspace(ws);
            const persistedWsId = system ? null : workspaceId;
            const existing = specs.filter((s) =>
                system
                    ? s.workspace_id === null && s.meta?.system === true
                    : s.workspace_id === workspaceId,
            );
            const baseLabel = ws.project_name.toLowerCase().replace(/\s+/g, '-');
            // Files panels get a `-files` label so they read distinctly in the
            // tree alongside terminals.
            const root = type === 'code' ? `${baseLabel}-files` : baseLabel;
            const sameType = existing.filter((s) => s.type === type);
            const label = sameType.length === 0 ? root : `${root}-${sameType.length + 1}`;
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: persistedWsId,
                label,
                cwd: ws.path,
                type,
                ...(system ? { meta: { system: true } } : {}),
            });
            // Append the new spec in place rather than re-fetching the full
            // list — refresh() would replace the array reference, which makes
            // the panels' parent re-render. Existing TerminalPanels stay keyed
            // by their spec id so they don't unmount, but minimising churn
            // here keeps the new-panel-while-others-running path smooth.
            setSpecs((prev) => [...prev, created]);
            setSelected((prev) => new Set(prev).add(created.id));
        },
        [specs, workspacesById],
    );

    // Load the launchable plugin panels for the Add-view menu (client-local).
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const panels = await api().plugins.panels();
                if (alive) setPluginPanels(panels);
            } catch {
                if (alive) setPluginPanels([]);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    /**
     * Open a plugin PANEL (e.g. the Repository panel) as a `plugin-panel` grid
     * spec in a workspace — the generic open trigger for the panel surface. The
     * declared Fancy component is mounted through the renderer's compile-time
     * adapter registry (`PluginPanelBody`); the plugin ships no UI code.
     */
    const addPluginPanel = useCallback(
        async (workspaceId: string, panel: PluginPanelView) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            const system = isSystemWorkspace(ws);
            const persistedWsId = system ? null : workspaceId;
            const meta = pluginPanelSpecMeta(
                {
                    pluginId: panel.pluginId,
                    panelId: panel.panel.id,
                    title: panel.panel.title,
                    icon: panel.panel.icon,
                    fancyExport: panel.panel.fancyComponent.export,
                    fancyPackage: panel.panel.fancyComponent.package,
                    fancyVersion: panel.panel.fancyComponent.version,
                },
                system,
            );
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: persistedWsId,
                label: panel.panel.title.toLowerCase().replace(/\s+/g, '-'),
                cwd: ws.path,
                type: 'plugin-panel',
                meta,
            });
            setSpecs((prev) => [...prev, created]);
            setSelected((prev) => new Set(prev).add(created.id));
        },
        [workspacesById],
    );

    /**
     * Create a Process (background service runner). Headless — it does NOT surface
     * in the main grid; it is managed from the workspace's Processes modal. The
     * spec is built by `lib/process-manager.ts` (`draftToCreate`), which owns every
     * rule about it: a System process runs unattached in its picked directory, and a
     * scheduled one has the service behaviours off.
     */
    const createProcess = useCallback(async (spec: ProcessCreate & { id: string }) => {
        const created = await api().terminalSpec.create(spec as TerminalSpec);
        // Not added to `selected` — processes aren't grid panels.
        setSpecs((prev) => [...prev, created]);
    }, []);

    /**
     * Save an edit from the Processes modal. `restart` is decided by
     * `restartAfterSave`: a running service whose command, directory, shell or
     * environment changed is restarted so the change takes effect, and nothing
     * else is interrupted.
     */
    const updateProcess = useCallback(async (id: string, patch: ProcessPatch, restart: boolean) => {
        const updated = await api().terminalSpec.update(id, patch);
        if (updated) setSpecs((prev) => prev.map((s) => (s.id === id ? updated : s)));
        if (restart) await api().process.restart(id).catch(() => {});
    }, []);

    /** Arm or pause a scheduled task. The window's spec list is updated from the
     *  result: main re-arms off the flag but does not broadcast this edit back. */
    const setProcessEnabled = useCallback(async (id: string, enabled: boolean) => {
        const updated = await api().terminalSpec.update(id, { enabled });
        if (updated) setSpecs((prev) => prev.map((s) => (s.id === id ? updated : s)));
        return !!updated;
    }, []);

    /**
     * The panel ×: DISMISS the panel, keep the terminal running (genie#724).
     *
     * The owner: *"The x button should not kill the terminal when I click it.
     * All that should do is remove it from the main panel display."*
     *
     * It used to kill, and not by accident — `main/terminal/ipc.ts` reads
     * "Explicit close (the panel X) is a separate `terminal:kill`, unaffected",
     * and dropping the id here without retaining first meant the deliberate
     * detach that follows killed a non-retained pty anyway. Either route ended
     * the session. Meanwhile the very same header carries a Pause button
     * labelled "Suspend — keep running, hide panel": two adjacent controls that
     * look equally harmless, one of which ends an agent mid-conversation.
     *
     * So × now takes the path the RAIL's hide already took — retain, then drop
     * from view — and the retain is awaited rather than fired and forgotten,
     * because a failed retain followed by a detach is precisely the silent kill
     * this is removing. On failure the panel STAYS, which is the same choice
     * `toggleSpec` makes and for the same reason: never silently kill the
     * pty/agent.
     *
     * Killing is still available, and still says so — Delete on the terminal,
     * Stop or Delete on the agent.
     */
    const closeSelected = useCallback(
        async (id: string) => {
            const spec = specs.find((s) => s.id === id);
            if (spec && spec.type !== 'code') {
                const res = await api()
                    .terminal.setRetained(id, true)
                    .catch(
                        () =>
                            ({ ok: false, reason: 'Could not close the panel.' }) as {
                                ok: boolean;
                                reason?: string;
                            },
                    );
                if (!res.ok) {
                    setToast(res.reason ?? 'Could not close the panel.');
                    return; // keep it visible — NEVER silently kill the pty/agent
                }
            }
            setSelected((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            setActiveIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            setFocusId((cur) => (cur === id ? null : cur));
            setMaximizedId((cur) => (cur === id ? null : cur));
        },
        [specs],
    );

    const destroySpec = useCallback(async (id: string) => {
        // Optimistic: drop from local state first so the panel unmounts, then
        // DB-delete. If the DB call fails, refresh() on next mount brings it
        // back — worst case the user sees a deleted spec reappear.
        setSelected((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setActiveIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        setFocusId((cur) => (cur === id ? null : cur));
        setMaximizedId((cur) => (cur === id ? null : cur));
        setSpecs((prev) => prev.filter((s) => s.id !== id));
        // Tier 2: kill explicitly. This clears any retained flag, kills the pty
        // (even a windowless suspended one with no panel to unmount), AND drops
        // the Tier 1 snapshot so a deleted terminal can't resurrect. For an
        // enabled terminal the panel unmount would also detach+kill, but calling
        // kill here makes the delete authoritative for both states.
        try {
            await api().terminal.kill(id).catch(() => {});
            await api().terminalSpec.remove(id);
        } catch (e) {
            console.error('Failed to delete terminal spec', e);
        }
    }, []);

    /**
     * Tier 2 DISABLE: suspend a terminal without deleting it. Keeps the spec
     * (enabled=false) and the running pty (retained), removing only the visible
     * panel. Re-enabling reattaches to the LIVE session.
     *
     * CRITICAL ordering: setRetained(true) MUST land BEFORE the panel unmounts,
     * else XTerm's unmount-detach would be the last detach and kill the pty
     * first. We await setRetained, THEN deselect (which triggers the unmount).
     * XTerm's unmount also fires a final Tier 1 snapshot, so a later full quit
     * has fresh state even before the windowless-serialize fallback runs.
     *
     * Refused when the retained cap is hit — the panel stays visible and we
     * surface the reason. Code views have no pty, so they're never retained;
     * disabling one just hides it (enabled=false).
     */
    const disableSpec = useCallback(
        async (id: string) => {
            const spec = specs.find((s) => s.id === id);
            if (!spec) return;
            if (spec.type !== 'code') {
                const res = await api()
                    .terminal.setRetained(id, true)
                    .catch(() => ({ ok: false, reason: 'Could not suspend terminal.' }) as {
                        ok: boolean;
                        reason?: string;
                    });
                if (!res.ok) {
                    setToast(res.reason ?? 'Could not suspend terminal.');
                    return;
                }
            }
            // Persist enabled=false; reflect locally so the Chooser shows it
            // suspended immediately.
            void api().terminalSpec.update(id, { enabled: false }).catch(() => {});
            setSpecs((prev) =>
                prev.map((s) => (s.id === id ? { ...s, enabled: false } : s)),
            );
            // Deselect → panel unmounts (detach leaves the retained pty alive).
            setSelected((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            // Keep it in activeIds: the pty is RETAINED (still running), so the
            // suspended row must read as live (run/online), not idle. activeIds is
            // cleared only on a real pty EXIT (onMarkInactive), not on suspend.
            setFocusId((cur) => (cur === id ? null : cur));
            setMaximizedId((cur) => (cur === id ? null : cur));
        },
        [specs],
    );

    /**
     * Tier 2 ENABLE: resume a suspended terminal. Re-selects it into the active
     * workspace grid; the remount's terminal:create rejoins the live pty and
     * replays scrollback (no restart). Clears retention so a later DELIBERATE
     * detach (deselecting the panel) kills it as usual — a window CLOSE still
     * persists it (the detached host keeps the pty for re-attach). Blocked when
     * re-enabling would exceed Max Views, with the same hint as the Add affordances.
     */
    const enableSpec = useCallback(
        async (id: string) => {
            const spec = specs.find((s) => s.id === id);
            if (!spec) return;
            // Activate the spec's workspace if it isn't already active, so the
            // re-enabled panel lands in the visible grid. Use the EFFECTIVE id
            // so a System Workspace spec (workspace_id null) resolves correctly.
            const wsId = specWorkspaceId(spec);
            const targetActive = wsId ?? activeWorkspaceId;
            // Count what's already visible in the workspace we're enabling into.
            const visibleInWs = specs.filter(
                (s) => specWorkspaceId(s) === targetActive && selected.has(s.id),
            ).length;
            if (visibleInWs >= maxViews) {
                setToast(maxViewsReason);
                return;
            }
            if (spec.type !== 'code') {
                await api().terminal.setRetained(id, false).catch(() => {});
            }
            void api().terminalSpec.update(id, { enabled: true }).catch(() => {});
            setSpecs((prev) =>
                prev.map((s) => (s.id === id ? { ...s, enabled: true } : s)),
            );
            if (wsId && wsId !== activeWorkspaceId) {
                setActiveWorkspaceId(wsId);
                void api().settings.set({ active_workspace: wsId }).catch(() => {});
            }
            setSelected((prev) => new Set(prev).add(id));
        },
        // maxViewsReason is derived below; safe to omit (string constant per render).
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [specs, selected, activeWorkspaceId, maxViews],
    );

    const toggleMaximize = useCallback((id: string) => {
        setMaximizedId((cur) => (cur === id ? null : id));
    }, []);

    /**
     * Activate a workspace: it becomes the grid's focus. Its visible panels come
     * from THIS window's client-local saved view (restore-on-switch) so a panel
     * hidden here stays hidden — and, in a host window, the layout is this
     * device's, not the host's `enabled` flags. Selections in OTHER workspaces
     * are left intact so their PTYs keep running mounted-hidden (Decision 1:
     * keep-alive). FIRST RUN for a `(connKey, workspace)` with no saved view
     * seeds from today's behaviour (every enabled terminal visible). The choice
     * is persisted so the next launch reopens here.
     */
    const activateWorkspace = useCallback(
        (workspaceId: string) => {
            const connKey = currentConnKey();
            const saved = readWorkspaceView(viewCacheRef.current, connKey, workspaceId);
            setActiveWorkspaceId(workspaceId);
            setSelected((prev) => {
                const next = new Set(prev);
                if (saved) {
                    // Restore exactly this window's saved visible set for the
                    // workspace: drop all of its specs first, then re-add only the
                    // saved ones, so a previously-hidden panel STAYS hidden.
                    const savedSet = new Set(saved.visibleIds);
                    for (const s of specs) {
                        if (specWorkspaceId(s) !== workspaceId) continue;
                        if (savedSet.has(s.id)) next.add(s.id);
                        else next.delete(s.id);
                    }
                } else {
                    // First run: every enabled (live) terminal is visible.
                    // Disabled (suspended) terminals stay out until re-enabled.
                    // CLAMPED to `max_views` — the same cap the Add affordances
                    // enforce, applied to the set itself so a switch can't land on
                    // a grid that is already over its own limit (genie#577).
                    const inWs = specs.filter((s) => specWorkspaceId(s) === workspaceId);
                    const seed = clampToMaxViews(
                        inWs.filter((s) => s.enabled !== false).map((s) => s.id),
                        inWs,
                        maxViews,
                    );
                    for (const id of seed) next.add(id);
                }
                return next;
            });
            if (saved) {
                setFocusId(saved.focusId);
                setMaximizedId(saved.maximizedId);
                setLayoutMode(saved.layoutMode);
            } else {
                setFocusId(null);
                setMaximizedId(null);
            }
            // Don't persist the synthetic System Workspace as the active one —
            // it isn't a real workspace and shouldn't be reopened on launch.
            if (workspaceId !== SYSTEM_WORKSPACE_ID) {
                void api()
                    .settings.set({ active_workspace: workspaceId })
                    .catch(() => {});
            }
        },
        [specs, maxViews],
    );

    /**
     * A specialized (agent) terminal was created via `terminalSpec.createAgent` —
     * mirror it into the grid the way `addSpec` does: append-if-absent (main may
     * also broadcast `terminalSpecsChanged`, so dedupe by id), select it, and jump
     * to its workspace so the agent booting is visible right away.
     */
    /**
     * OPEN a spec's panel and put the keyboard in it.
     *
     * The single action behind "click the agent square once and work". Not
     * `toggleSpec`: that also closes, and a click meaning "open" must never be
     * the click that closes. Focus is set unconditionally — an already-visible
     * panel the user clicked is one they want to type in, whether or not it was
     * on screen a moment ago.
     */
    const openSpec = useCallback((id: string) => {
        setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        setFocusId(id);
    }, []);

    const selectAgentSpec = useCallback(
        (spec: TerminalSpec) => {
            setSpecs((prev) => (prev.some((s) => s.id === spec.id) ? prev : [...prev, spec]));
            setSelected((prev) => new Set(prev).add(spec.id));
            const wsId = specWorkspaceId(spec) ?? SYSTEM_WORKSPACE_ID;
            activateWorkspace(wsId);
        },
        [activateWorkspace],
    );

    // Persist THIS window's panel VIEW state (visible set, focus, maximize,
    // layout) for the active workspace whenever any of it changes — this single
    // effect is the write-back for every trigger (closeSelected, toggleSpec,
    // toggleMaximize, onFocus, setLayoutMode, disable/enable), since they all
    // mutate one of these. The debounce settles the last state of a switch.
    useEffect(() => {
        if (!viewRestoredRef.current || !activeWorkspaceId) return;
        const visibleIds = specs
            .filter(
                (s) =>
                    s.type !== 'process' &&
                    specWorkspaceId(s) === activeWorkspaceId &&
                    selected.has(s.id),
            )
            .map((s) => s.id);
        persistView(currentConnKey(), activeWorkspaceId, {
            visibleIds,
            focusId,
            maximizedId,
            layoutMode,
        });
    }, [
        activeWorkspaceId,
        specs,
        selected,
        focusId,
        maximizedId,
        layoutMode,
        persistView,
    ]);

    // Flush a pending view-state write on unmount (window close) so the last
    // change within the debounce window isn't lost. Same merge-onto-fresh-read as
    // the debounced flush, so closing this window can't clobber another window's
    // slice (best-effort — a window teardown may not await the async round-trip,
    // but every earlier change already flushed during the session).
    const flushViewStateRef = useRef(flushViewState);
    flushViewStateRef.current = flushViewState;
    useEffect(() => {
        return () => {
            if (viewFlushRef.current) {
                clearTimeout(viewFlushRef.current);
                viewFlushRef.current = null;
                void flushViewStateRef.current();
            }
        };
    }, []);

    // Open-workspace from the tray / native menu / MCP just FOCUSES the workspace
    // in Genie (replacing the removed "launch an external editor" flow). It does
    // NOT auto-open the editor — terminals are Genie's main surface; the user
    // opens an editor only if they want one.
    useEffect(() => {
        return api().on.workspaceOpen?.(({ workspaceId }) => {
            activateWorkspace(workspaceId);
        });
    }, [activateWorkspace]);

    // openFileForUser (MCP): open a file in the workspace's built-in editor —
    // REUSE an editor panel already open for the workspace (incl __system__), or
    // open a new one. Refs keep the subscription stable while reading live state.
    const specsRef = useRef(specs);
    specsRef.current = specs;
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const focusIdRef = useRef(focusId);
    focusIdRef.current = focusId;
    const workspacesByIdRef = useRef(workspacesById);
    workspacesByIdRef.current = workspacesById;
    const activateWorkspaceRef = useRef(activateWorkspace);
    activateWorkspaceRef.current = activateWorkspace;
    useEffect(() => {
        return api().on.pluginPanelOpen?.((request) => {
            void (async () => {
                const existing = specsRef.current.find((spec) =>
                    spec.type === 'plugin-panel' &&
                    spec.workspace_id === request.workspaceId &&
                    spec.meta?.plugin_id === request.pluginId &&
                    spec.meta?.panel_id === request.panelId,
                );
                const surface = (id: string) => {
                    activateWorkspaceRef.current(request.workspaceId);
                    setSelected((current) => current.has(id) ? current : new Set(current).add(id));
                    setFocusId(id);
                    setMaximizedId((current) => surfaceMaximized(current, id));
                };

                if (existing) {
                    const meta = {
                        ...existing.meta,
                        ...(request.activeItemId
                            ? { active_artboard_post_id: request.activeItemId }
                            : {}),
                    };
                    const updated = await api().terminalSpec.update(existing.id, { meta });
                    if (updated) {
                        setSpecs((current) => current.map((spec) =>
                            spec.id === updated.id ? updated : spec,
                        ));
                    }
                    surface(existing.id);
                    return;
                }

                let panels = pluginPanelsRef.current;
                if (!panels.some((panel) =>
                    panel.pluginId === request.pluginId && panel.panel.id === request.panelId,
                )) {
                    panels = await api().plugins.panels();
                    pluginPanelsRef.current = panels;
                    setPluginPanels(panels);
                }
                const panel = panels.find((candidate) =>
                    candidate.pluginId === request.pluginId &&
                    candidate.panel.id === request.panelId,
                );
                const workspace = workspacesByIdRef.current.get(request.workspaceId);
                if (!panel || !workspace) return;
                const meta = {
                    ...pluginPanelSpecMeta({
                        pluginId: panel.pluginId,
                        panelId: panel.panel.id,
                        title: panel.panel.title,
                        icon: panel.panel.icon,
                        fancyExport: panel.panel.fancyComponent.export,
                        fancyPackage: panel.panel.fancyComponent.package,
                        fancyVersion: panel.panel.fancyComponent.version,
                    }, false),
                    ...(request.activeItemId
                        ? { active_artboard_post_id: request.activeItemId }
                        : {}),
                };
                const created = await api().terminalSpec.create({
                    id: ulid(),
                    workspace_id: request.workspaceId,
                    label: panel.panel.title.toLowerCase().replace(/\s+/g, '-'),
                    cwd: workspace.path,
                    type: 'plugin-panel',
                    meta,
                });
                setSpecs((current) => [...current, created]);
                surface(created.id);
            })();
        });
        // This subscription intentionally reads live state through refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        return api().on.editorOpenFile?.(({ requestId, ...req }) => {
            // The whole decision (reuse vs new, and the ORDER of the effects)
            // lives in `openFileInEditor` so it can be unit-tested; this page
            // only supplies the live state + the effects themselves.
            void (async () => {
                const result = await openFileInEditor(req, {
                    specs: () => specsRef.current,
                    focusId: () => focusIdRef.current,
                    selected: () => selectedRef.current,
                    workspacesById: () => workspacesByIdRef.current,
                    updateMeta: (id, meta) =>
                        api()
                            .terminalSpec.update(id, { meta })
                            .catch(() => null),
                    createPanel: (input) => api().terminalSpec.create({ id: ulid(), ...input }),
                    putSpec: (spec) =>
                        setSpecs((prev) =>
                            prev.some((s) => s.id === spec.id)
                                ? prev.map((s) => (s.id === spec.id ? spec : s))
                                : [...prev, spec],
                        ),
                    activateWorkspace: (id) => activateWorkspaceRef.current(id),
                    surface: (id) => {
                        setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
                        setFocusId(id);
                        setMaximizedId((cur) => surfaceMaximized(cur, id));
                    },
                    revealSystem: () => setOpenDrawer('genie-os'),
                    emitOpenInPanel,
                });
                void api().editor.openFileResult(requestId, result);
            })();
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // TAKE THE USER TO A TERMINAL: activate its workspace, then surface the
    // panel — the same three effects `openFileForUser` uses above, because "bring
    // this panel into view" is the same operation. Without it a toast click
    // landed on whatever the master window happened to be showing, which is what
    // made a finished agent a hunt across every open workspace instead of one
    // click.
    //
    // Shared by every notice that names a terminal: the `imDone` toast (via
    // main's `terminal:reveal`) and the AgentInbox incoming toast, which is a
    // renderer-side click and needs no round trip. A notice that names a terminal
    // and cannot open it is half a fix.
    const revealTerminal = useCallback((id: string, workspaceId: string | null) => {
        if (workspaceId) {
            if (workspaceId === SYSTEM_WORKSPACE_ID) setSystemRevealed(true);
            activateWorkspaceRef.current(workspaceId);
        }
        setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        setFocusId(id);
        setMaximizedId((cur) => surfaceMaximized(cur, id));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The imDone toast was CLICKED (main tells us which terminal finished).
    useEffect(() => {
        return api().on.terminalReveal?.(({ id, workspaceId }) =>
            revealTerminal(id, workspaceId),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Close every view in the ACTIVE workspace (deselect; PTYs detach on unmount). */
    const clearSelection = useCallback(() => {
        setSelected((prev) => {
            const next = new Set(prev);
            for (const s of specs) {
                if (specWorkspaceId(s) === activeWorkspaceId) next.delete(s.id);
            }
            return next;
        });
        setFocusId(null);
        setMaximizedId(null);
    }, [specs, activeWorkspaceId]);

    const renameSpec = useCallback(async (id: string, currentLabel: string) => {
        const next = await showPrompt({
            title: 'Rename terminal',
            label: 'New name',
            initial: currentLabel,
            placeholder: 'e.g. dev:vite',
            confirmLabel: 'Rename',
        });
        const trimmed = next?.trim();
        if (!trimmed || trimmed === currentLabel) return;
        const updated = await api().terminalSpec.update(id, { label: trimmed });
        if (updated) {
            setSpecs((prev) =>
                prev.map((s) => (s.id === id ? { ...s, label: trimmed } : s)),
            );
        }
    }, []);

    /**
     * The ONE place a restart is asked for, whichever surface asked (genie#443).
     *
     * TWO operations, and this confirms the right thing for each. `'resume'`
     * continues the conversation, so the only warning it needs is about unsent
     * input. `'fresh'` starts a NEW one — and it is offered on agents that have
     * no conversation at all (the wedged and the dead), so it warns about losing
     * one only when there IS one. Telling someone their work is at risk when it
     * is not is the same class of wrongness as not telling them when it is; the
     * reported terminal was refused a restart in order to protect a conversation
     * that had never started.
     *
     * The toast is the HOST's own `note`, never a stronger claim. `ok` means the
     * old agent was torn down and the command was handed to a fresh terminal —
     * not that the TUI came back up, which nothing here has observed (genie#364).
     * This surface used to say "Agent restarted — conversation resumed." on
     * evidence that only supported "restarting".
     */
    const restartAgentSpec = useCallback(
        async (spec: TerminalSpec, mode: RestartMode) => {
            const { losesConversation } = restartOptionsFor(spec);
            const ok = await showPrompt({
                title: mode === 'fresh' ? 'Restart agent (fresh)' : 'Restart agent (resume)',
                body:
                    mode === 'fresh'
                        ? `Restart "${spec.label}" from scratch? Its process is relaunched against the current settings and MCP tools. ` +
                          (losesConversation
                              ? 'It starts a NEW conversation — the current one is not carried over.'
                              : 'Genie has no saved conversation for it, so there is nothing to carry over.')
                        : `Restart "${spec.label}"? Its process is relaunched and reconnects to the ` +
                          'current MCP tools; the conversation is resumed, but any unsent input in the terminal is lost.',
                confirmLabel: 'Restart',
                destructive: mode === 'fresh' && losesConversation,
            });
            if (ok === null) return;
            const result = await api().terminalSpec.restartAgent(spec.id, mode);
            setToast(result.ok ? result.note : result.error || 'Could not restart the agent.');
        },
        [],
    );

    const duplicateSpec = useCallback(
        async (id: string) => {
            const src = specs.find((s) => s.id === id);
            if (!src) return;
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: src.workspace_id,
                label: `${src.label}-copy`,
                cwd: src.cwd,
                shell: src.shell ?? null,
                args: src.args,
                env: src.env,
            });
            setSpecs((prev) => [...prev, created]);
            setSelected((prev) => new Set(prev).add(created.id));
        },
        [specs],
    );

    const moveSpecToWorkspace = useCallback(
        async (id: string, workspaceId: string | null) => {
            const updated = await api().terminalSpec.update(id, {
                workspace_id: workspaceId,
            });
            if (updated) {
                setSpecs((prev) =>
                    prev.map((s) =>
                        s.id === id ? { ...s, workspace_id: workspaceId } : s,
                    ),
                );
            }
        },
        [],
    );

    const openSpecInNewWindow = useCallback((id: string) => {
        // Pop-out window is a stretch goal — for now the action just makes
        // sure the spec is in the current selection and maximises it so the
        // user sees the panel even if it was hidden.
        setSelected((prev) => new Set(prev).add(id));
        setMaximizedId(id);
    }, []);

    const openProjectInStage = useCallback((workspaceId: string) => {
        void api().app.openStage(workspaceId);
    }, []);

    const openProjectInBrowser = useCallback(
        (workspaceId: string) => {
            const ws = workspacesById.get(workspaceId);
            // A `none` workspace (System, a GApp) has no service dashboard to open.
            if (!ws || ws.backend !== 'tynn') return;
            void api().tynn.openInBrowser('/dashboard', 'tynn');
        },
        [workspacesById],
    );

    // HIBERNATE / WAKE a whole workspace (genie#672). The confirm says what it
    // costs — every terminal and agent in it stops — because it is not undone by
    // a restart: only a person waking it brings it back.
    const [hibernationBusy, setHibernationBusy] = useState<
        Record<string, 'hibernating' | 'waking'>
    >({});
    const setBusy = useCallback((id: string, state: 'hibernating' | 'waking' | null) => {
        setHibernationBusy((prev) => {
            const next = { ...prev };
            if (state) next[id] = state;
            else delete next[id];
            return next;
        });
    }, []);
    const hibernateWorkspaceRow = useCallback(
        async (workspaceId: string) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            const ok = await showPrompt({
                title: `Hibernate ${ws.project_name}?`,
                body: 'Its agents are asked to save a handoff first. Then every terminal, process, scheduled task, site and service in this workspace stops — and stays stopped through restarts and upgrades until you wake it.',
                confirmLabel: 'Hibernate',
            });
            if (ok === null) return;
            setBusy(workspaceId, 'hibernating');
            try {
                const res = await api().workspaces.hibernate(workspaceId);
                setToast(hibernateOutcome(ws.project_name, res).text);
            } catch (e) {
                setToast(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(workspaceId, null);
                await refresh();
            }
        },
        [workspacesById, refresh, setBusy],
    );
    const wakeWorkspaceRow = useCallback(
        async (workspaceId: string) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            setBusy(workspaceId, 'waking');
            try {
                const res = await api().workspaces.wake(workspaceId);
                setToast(wakeOutcome(ws.project_name, res).text);
            } catch (e) {
                setToast(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(workspaceId, null);
                await refresh();
            }
        },
        [workspacesById, refresh, setBusy],
    );

    const removeWorkspaceRow = useCallback(async (workspaceId: string) => {
        const ok = await showPrompt({
            title: 'Remove project from Genie',
            body: 'The folder on disk is not touched. Any terminal specs attached to it will become unattached.',
            confirmLabel: 'Remove',
            destructive: true,
        });
        if (ok === null) return;
        await api().workspaces.remove(workspaceId);
        await refresh();
    }, [refresh]);

    const markActive = useCallback((id: string) => {
        setActiveIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }, []);
    const markInactive = useCallback((id: string) => {
        setActiveIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const projectsActive = useMemo(() => {
        const ids = new Set<string>();
        for (const s of selectedSpecs) if (s.workspace_id) ids.add(s.workspace_id);
        return ids;
    }, [selectedSpecs]);

    // Enforce max_views: count only the ACTIVE workspace's visible views.
    // When at the cap, the Add affordances disable with a hint to raise it.
    const activeIsHibernating = isHibernated(
        activeWorkspaceId ? workspacesById.get(activeWorkspaceId) : undefined,
    );
    const atMaxViews = selectedSpecs.length >= maxViews || activeIsHibernating;
    const maxViewsReason = activeIsHibernating
        ? 'This workspace is hibernating. Wake it to open terminals.'
        : `Max views reached (${maxViews}) — raise it in Settings`;

    // Global keyboard shortcut: ⌘/Ctrl + , opens Settings. Fires on a WINDOW
    // keydown listener, so it works anywhere — including while a terminal is
    // focused (xterm doesn't claim this combo). The old focus/pin/close shortcuts
    // (⌘1–9 / ⌘\ / ⌘W) were removed: a focused terminal swallowed them, so they
    // were unreliable and their status-bar hint misled.
    //
    /**
     * EVERYTHING THE KEYBOARD LISTENER NEEDS, in a ref refreshed every render.
     *
     * The listener below is mounted ONCE (`[]` deps) and that is deliberate — re-subscribing a
     * window keydown handler on every state change is how a chord gets delivered twice. The cost
     * is that it closes over the first render's state, so anything it reads has to come through
     * here. Reading `view` or `sessions` directly would act on what was true when the window
     * opened, which in a long-lived window is any amount of wrong.
     *
     * `overlayOpen` is the OR of every flyout's own flag. It reads as a list because that is
     * genuinely the state today; P7's single `openDrawer` is what turns it into one comparison,
     * and until then an incomplete OR is the honest risk — a missing flag means Escape navigates
     * out from under an open panel.
     */
    const keys = useRef({
        view: 'deck' as 'deck' | 'dashboard' | 'grid' | 'workbench' | 'agent',
        overlayOpen: false,
        query: {} as RouteQuery,
        sessions: [] as AgentSessionSpec[],
        queue: [] as Array<{ key: string }>,
        agentId: null as string | null,
        agentSpecId: null as string | null,
        parkedApprovalId: null as string | null,
    });
    keys.current = {
        view: view.kind,
        // ONE CALL, not a fourteen-term OR maintained by hand. The three non-drawers are passed
        // explicitly, so adding a fourth is a type error rather than a forgotten clause — and a
        // PINNED Lists panel deliberately does not count, because it sits beside the content rather
        // than over it (`master.css`: the reserve exists "so a pinned panel covers nothing").
        overlayOpen: somethingCoversTheFloor({
            openDrawer,
            pinnedDock,
            paletteOpen,
            onboardingOpen,
            recipeLauncherOpen,
        }),
        query: pageQuery,
        sessions,
        // The SAME ranking the band renders, from the same function — a second ordering here
        // would mean `J` moved to a row that was not the next one on screen.
        queue: attentionItems({ questions: deckQuestions, listItems: deckListItems }),
        agentId: view.kind === 'agent' ? view.agentId : null,
        agentSpecId:
            view.kind === 'agent'
                ? (sessions.find((x) => x.agentId === view.agentId)?.specId ?? null)
                : null,
        parkedApprovalId: (() => {
            if (view.kind !== 'agent') return null;
            const s = sessions.find((x) => x.agentId === view.agentId);
            // `parkedApproval` takes a session, not a maybe-session: a route can name an agent
            // that has gone, and inventing an empty session to ask about would answer a question
            // about nothing.
            return s ? (parkedApproval(s)?.id ?? null) : null;
        })(),
    };

    /**
     * OPEN A FEATURE BY ID — one route, two callers.
     *
     * It was inline on the palette's `onActivateFeature`, which was fine while the palette was
     * the only way in. The Deck's signal strip is the second (owner: *"move the signals to the
     * Deck, then delete the icons"*), and the signals are ABOUT features — a running Flow opens
     * Flows, unread agent mail opens AgentInbox. Two copies of this switch would be two answers
     * to "where does this feature live", and the one nobody updated would be the one a badge
     * used.
     *
     * Ids come from `FEATURE_SURFACES` in `lib/feature-reachability`, which the reachability
     * guard also reads — so a feature cannot be contracted there and silently unreachable here.
     */
    const activateFeature = (featureId: string): void => {
        /**
         * NO ACCOUNT? Offer the account, not a dead surface.
         *
         * Tynn is optional (owner), so these four surfaces exist and cannot work without one.
         * Opening the Site Manager signed out would show an empty list that looks like "you have no
         * sites" rather than "Genie cannot see them", which is the confident-zero mistake in a new
         * costume. The same list is in `lib/command-window.ts`, where it annotates the row.
         */
        if (!signedIn && ['sites', 'remote-host', 'issuewatch', 'sharing'].includes(featureId)) {
            void api().auth.startSignIn('tynn').catch(() => {});
            return;
        }
                // Ids come from FEATURE_SURFACES in lib/feature-reachability, which the
                // reachability guard also reads -- so a feature cannot be contracted
                // there and silently unreachable here.
                const ws = activeWorkspaceId;
                switch (featureId) {
                    case 'remote-host':
                    case 'sharing':
                        setOpenDrawer('sharing');
                        break;
                    case 'plugins-appstore':
                        setOpenDrawer('appstore');
                        break;
                    case 'knowledge-graph':
                        // A main-owned window, not a flyout. Guarded so it no-ops if
                        // the preload bridge is not wired yet.
                        if (hasGenieBridge()) void api().knowledge.openWindow().catch(() => {});
                        break;
                    case 'agent-inbox':
                        setOpenDrawer('agent-inbox');
                        break;
                    case 'issuewatch':
                        setOpenDrawer('issuewatch');
                        break;
                    case 'flows':
                        setOpenDrawer('flows');
                        break;
                    case 'lists':
                        setOpenDrawer('lists');
                        break;
                    case 'questions':
                        setOpenDrawer('questions');
                        break;
                    case 'docs':
                        setOpenDrawer('docs');
                        break;
                    case 'tasks':
                        setOpenDrawer('tasks');
                        break;
                    case 'github-caps':
                        setOpenDrawer('github-caps');
                        break;
                    case 'genie-os':
                        setOpenDrawer('genie-os');
                        break;
                    // A SURFACE, not a flyout: the only way back to the 2x2 Floor now
                    // that the Deck is the default. `mergeViewRoute` rather than
                    // replacing the query, for the same reason as every other
                    // navigation here -- `host` and `stage` decide whether this window
                    // points at a remote machine, and dropping them would silently make
                    // a remote window local.
                    case 'grid':
                        replacePageQuery(mergeViewRoute(pageQuery, { kind: 'grid' }));
                        break;
                    // Also a SURFACE rather than a flyout, and routed the same way — through
                    // `mergeViewRoute`, so a remote window stays remote.
                    case 'dashboard':
                        replacePageQuery(mergeViewRoute(pageQuery, { kind: 'dashboard' }));
                        break;
                    // A DRAWER, not a surface: chat opens over or beside whatever you are
                    // looking at, which is the point of a flyout.
                    case 'chat':
                        setOpenDrawer('chat');
                        break;
                    // Workspace-SCOPED: these take a workspace, not a toggle. With no
                    // active workspace there is nothing to open them against, so they
                    // no-op rather than opening against a guess.
                    case 'sites':
                        if (ws) setSiteManagerWsId(ws);
                        break;
                    case 'processes':
                        if (ws) setProcessManagerWsId(ws);
                        break;
                }
    };

    // Guard against stealing the keystroke while the user is typing in a real text
    // input — the in-app prompt modal, the editor's fields, any <input>/<textarea>/
    // contenteditable. The xterm surface uses a hidden `.xterm-helper-textarea`;
    // that one is exempt so ⌘, still opens Settings from a focused terminal.
    useEffect(() => {
        /**
         * Classify focus, then let `resolveShortcut` decide — the policy lives in
         * `lib/master-shortcuts.ts` where it is tested, rather than here.
         *
         * The three owners matter because xterm focuses a hidden
         * `.xterm-helper-textarea`: calling that a text field disables every shortcut
         * inside a terminal, and ignoring it lets an unmodified letter fire while the
         * owner types into a TUI. It is neither.
         */
        const ownerOf = (el: Element | null) => {
            if (!el || !(el instanceof HTMLElement)) return focusOwnerOf(null);
            return focusOwnerOf({
                tagName: el.tagName,
                isContentEditable: el.isContentEditable,
                inXterm: el.classList.contains('xterm-helper-textarea') || !!el.closest('.xterm'),
            });
        };

        const onKeyDown = (e: KeyboardEvent) => {
            const intent = resolveShortcut(e, ownerOf(document.activeElement));
            if (!intent) return;
            // Read through the ref: this listener is mounted ONCE, so closing over state
            // directly would act on whatever was true when the window opened.
            const now = keys.current;
            if (intent.kind === 'settings') {
                e.preventDefault();
                api().app.showSettings(isRemoteWindow()).catch(() => {});
                return;
            }
            if (intent.kind === 'palette') {
                // Global now: no terminal required. `commandWindowFor` stays null, which
                // the palette reads as "no terminal" and uses to drop entries that would
                // have nowhere to act.
                e.preventDefault();
                setPaletteOpen(true);
                return;
            }
            /**
             * CHAT (⌘J) and its PIN (⌘⇧J) — the board's two new keys for §5.4.
             *
             * ⌘J TOGGLES, because it is the key you press to get to chat and the key you press
             * to get out of the way again. A key that only opens leaves the panel to be closed
             * by a different gesture, which is how the Lists header icon became a dead control.
             *
             * ⌘⇧J only pins. It does not open: pinning is a statement about HOW the panel is
             * shown, and `pinDockNext` already keeps the panel open when it fires.
             */
            if (intent.kind === 'chat') {
                e.preventDefault();
                setOpenDrawer((d) => (d === 'chat' ? closeDrawerNext(d, 'chat') : 'chat'));
                return;
            }
            if (intent.kind === 'chat-pin') {
                e.preventDefault();
                togglePin('chat');
                return;
            }
            /**
             * ESCAPE GOES UP A LEVEL — now that there is a level to go up to.
             *
             * This was deliberately unwired, and the reason is worth keeping: the naive version
             * navigated on EVERY Escape, and Escape already means something here — it closes a
             * flyout, dismisses a panel, leaves a docked layout. `preventDefault` on top of that
             * stole the key from the app's own handling and four E2E specs failed identically on
             * all three platforms.
             *
             * `escapeLeavesForDeck` is that lesson as a rule: an open overlay owns Escape, the
             * grid and the Workbench own it (that is where panels live, and all four failures
             * were panels), and the Deck has no level above it. What is left is an agent view,
             * which is exactly where "up" means something.
             */
            if (intent.kind === 'deck') {
                if (!escapeLeavesForDeck({ view: now.view, overlayOpen: now.overlayOpen })) return;
                e.preventDefault();
                replacePageQuery(mergeViewRoute(now.query, { kind: 'deck' }));
                return;
            }

            /**
             * ⌘1..9 — jump to the nth agent, in the order the Deck lists them.
             *
             * The ROSTER's order, not a saved slot map: the number means "the nth agent I can
             * see", so the key and the screen cannot disagree. Out of range is a no-op rather
             * than a clamp — ⌘7 with four agents means nothing, and jumping to the fourth would
             * be a guess at what was meant.
             */
            if (intent.kind === 'agent-slot') {
                const target = now.sessions[intent.slot - 1];
                if (!target) return;
                e.preventDefault();
                replacePageQuery(
                    mergeViewRoute(now.query, { kind: 'agent', agentId: target.agentId, tab: null }),
                );
                return;
            }

            // J / K through the Needs-you queue. `moveQueueFocus` owns the wrapping rule (it does
            // not wrap) and the vanished-row rule, both tested.
            if (intent.kind === 'queue-move') {
                e.preventDefault();
                setFocusedQueueKey((current) => moveQueueFocus(now.queue, current, intent.delta));
                return;
            }

            /**
             * A / D — allow or deny the approval the TURN IS PARKED ON.
             *
             * Only in an agent view, and only when that agent actually has one. A letter that
             * resolves a permission has to be unambiguous about which: on the Deck there is no
             * single agent in view, and acting on "the first parked one anywhere" is how the
             * wrong tool call gets approved.
             */
            if (intent.kind === 'approval') {
                if (now.view !== 'agent' || !now.agentSpecId || !now.parkedApprovalId) return;
                e.preventDefault();
                void api()
                    .agentSession.decide(
                        now.agentSpecId,
                        now.parkedApprovalId,
                        intent.decision === 'allow' ? 'allow-once' : 'deny-once',
                    )
                    .then(() => loadSessions())
                    .catch(() => {});
                return;
            }

            // ⌘⇧T — take over. A PLACE, not a mode: the agent's own pty, with the url recording
            // it so refresh and back land in the same place.
            if (intent.kind === 'take-over') {
                if (now.view !== 'agent' || !now.agentId) return;
                e.preventDefault();
                replacePageQuery(
                    mergeViewRoute(now.query, { kind: 'agent', agentId: now.agentId, tab: 'terminal' }),
                );
                return;
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    /**
     * NO SIGN-IN GATE. Tynn is OPTIONAL.
     *
     * This returned `SignInPrompt` instead of the app whenever `authChecked && !signedIn`, so a
     * workstation with no Tynn account could not open a workspace, run an agent or see the Deck —
     * none of which needs one. Owner decision, asked directly, 2026-10-08: *"fully local mode —
     * everything local works, Tynn features say 'sign in to use this'."*
     *
     * What replaces it, rather than nothing:
     *
     *  - the four Tynn-backed ⌘K rows say what they need (`TYNN_BACKED_FEATURES` in
     *    `lib/command-window.ts`), and activating one starts the sign-in instead of opening a
     *    surface that cannot work;
     *  - first run reports the account as OFF with a route, never as a fault
     *    (`workstationReadiness`);
     *  - `Sign in to Tynn` is in the system menu, which is where an account lives.
     *
     * `signedIn` is still read — it is what tells those three what to say.
     */
    if (!authChecked) {
        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'grid',
                    placeItems: 'center',
                    background: 'var(--bg-0)',
                    color: 'var(--fg-3)',
                    fontSize: 13,
                }}
            >
                Checking sign-in…
            </div>
        );
    }

    return (
        /**
         * `docked` names the SLOT and `docked-<id>` names the occupant, which is what lets ONE
         * reserve rule serve every dockable panel. The old class was `lists-docked`, and the
         * agent-surfaces design calls out why that shape is a trap: a third pinnable panel
         * arrives with its own class and its own forgotten reserve — which is exactly how the
         * Deck came to be overlapped by a pinned dock in genie#841.
         *
         * The WIDTH rides on the occupant class (`--dock-w`), because the panels are not the
         * same width: Lists is 340px and chat is 380px per the board.
         */
        <div
            className={`gwrap${isDocked(pinnedDock, openDrawer) ? ` docked docked-${pinnedDock!}` : ''}`}
            id="app"
        >
            {/* TWO FULL-HEIGHT COLUMNS:
                  LEFT  — the workspace chooser (icon rail + search/list
                          sidebar), under a drag strip that owns the window's
                          top-LEFT corner (where macOS paints its traffic
                          lights). Runs header to footer.
                  RIGHT — the app header, the workspace title + toolbar, the
                          panels, and the status bar.
                So the rail/sidebar span the whole window height and the
                workspace title + panels always sit to the right of them. */}
            <div className="winframe">
                <div className={`gleft${chooserPinned ? ' pinned' : ''}`}>
                    <div className="gleft-top">
                        <AppCorner
                            tynnHealth={
                                activeWorkspaceId ? (tynnHealth[activeWorkspaceId] ?? null) : null
                            }
                            tynnChecking={
                                !!activeWorkspaceId && !!tynnChecking[activeWorkspaceId]
                            }
                            onRecheckTynn={
                                activeWorkspaceId && activeWorkspaceId !== SYSTEM_WORKSPACE_ID
                                    ? () => void checkTynnHealth(activeWorkspaceId)
                                    : undefined
                            }
                        />
                    </div>
                    <Chooser
                        workspaces={displayWorkspaces}
                        // Every workspace that EXISTS, so a hidden one's
                        // terminals are not mistaken for orphans (genie#723).
                        knownWorkspaceIds={knownWorkspaceIds}
                        specs={specs}
                        selected={selected}
                        activeIds={activeIds}
                        attentionIds={attentionIds}
                        pendingNudgeWorkspaceIds={pendingWorkspaceIds}
                        issueWatchCounts={issueWatchCounts}
                        onShowIssueWatch={openIssueWatch}
                        devSites={devSites}
                        // The Site Manager is host-aware: in a remote window it
                        // drives the HOST's containers over the bridge, so the
                        // entry point is offered on a host Floor too.
                        onShowSiteManager={setSiteManagerWsId}
                        onLaunchGapp={launchGapp}
                        launchingGappWsId={launchingGappWsId}
                        activeWorkspaceId={activeWorkspaceId}
                        pinned={chooserPinned}
                        onTogglePin={() => setChooserPinned((p) => !p)}
                        systemRevealed={systemRevealed}
                        onToggleSystemWorkspace={() => {
                            setSystemRevealed((on) => {
                                const next = !on;
                                if (next && systemWorkspace) {
                                    // Revealing → jump straight to it.
                                    activateWorkspace(SYSTEM_WORKSPACE_ID);
                                } else if (
                                    !next &&
                                    activeWorkspaceId === SYSTEM_WORKSPACE_ID
                                ) {
                                    // Hiding while it's active → fall back to the
                                    // first real workspace so the toolbar/grid
                                    // don't keep pointing at a now-hidden row.
                                    activateWorkspace(workspaces[0]?.id ?? null);
                                }
                                return next;
                            });
                        }}
                        hibernatedRevealed={hibernatedRevealed}
                        hiddenHibernated={hiddenHibernatedCount(workspaces)}
                        onToggleHibernated={() => {
                            setHibernatedRevealed((on) => {
                                const next = !on;
                                void api()
                                    .settings.set({ reveal_hibernated: next ? 'on' : 'off' })
                                    .catch(() => {});
                                // Hiding the row you are STANDING on would leave the
                                // floor showing a workspace the rail denies exists
                                // (genie#705) — the same fallback the System toggle
                                // makes, for the same reason.
                                const stay = activeAfterHiding(activeWorkspaceId, workspaces, next);
                                if (stay && stay !== activeWorkspaceId) activateWorkspace(stay);
                                return next;
                            });
                        }}
                        onActivateWorkspace={activateWorkspace}
                        onToggleSpec={toggleSpec}
                        onOpenSpec={openSpec}
                        onAddSpec={(wsId, type) => void addSpec(wsId, type)}
                        onDestroySpec={(id) => void destroySpec(id)}
                        onRestartAgentSpec={(id, mode) => {
                            const sp = specs.find((x) => x.id === id);
                            if (!sp) return;
                            void restartAgentSpec(sp, mode);
                        }}
                        onManageAgent={(id) => setManageAgentId(id)}
                        onEditAgentSpec={(id) => {
                            const sp = specs.find((x) => x.id === id);
                            if (sp) setAgentEditSpec(sp);
                        }}
                        onDisableSpec={(id) => void disableSpec(id)}
                        onEnableSpec={(id) => void enableSpec(id)}
                        onOpenContextMenu={(specId, p) =>
                            setContextMenu({ specId, x: p.x, y: p.y })
                        }
                        onOpenProjectMenu={(wsId, p) =>
                            setProjectMenu({ workspaceId: wsId, x: p.x, y: p.y })
                        }
                        onAddWorkspace={() => setAddingWorkspace(true)}
                        onReorderWorkspaces={reorderWorkspaces}
                        onShowProcessManager={setProcessManagerWsId}
                        lastTerminalType={lastTerminalType}
                        onLastTerminalType={setLastTerminalType}
                        onAgentCreated={selectAgentSpec}
                        agentCustomCommand={agentCustomCommand}
                        pluginPanels={pluginPanels}
                        onAddPluginPanel={(workspaceId, panel) =>
                            void addPluginPanel(workspaceId, panel)
                        }
                        hibernationBusy={hibernationBusy}
                    />
                </div>
                <div className="gright">
                    <TitleBar
                        cornerInRail
                        isStage={isStage}
                        stageWorkspaceName={
                            stageSeedWorkspace
                                ? workspacesById.get(stageSeedWorkspace)?.project_name
                                : undefined
                        }
                        // FOURTEEN PROPS LESS. Everything that fed an icon or a badge went with
                        // the icon cluster — the features are ⌘K rows and the live signals are on
                        // the Deck (`stationSignals`). What is left is what this bar still does: a
                        // Docs menu item, the App Tray's store link, and the setup item while
                        // first run is unfinished.
                        onShowDocs={() => setOpenDrawer((d) => (d === 'docs' ? null : 'docs'))}
                        onShowAppStore={() => setOpenDrawer((d) => (d === 'appstore' ? null : 'appstore'))}
                        onShowGenieOs={() => setOpenDrawer((d) => (d === 'genie-os' ? null : 'genie-os'))}
                        setupIncomplete={onboardingOpen}
                        tynnAccount={tynnAccountName}
                        onSignInTynn={() => void api().auth.startSignIn('tynn').catch(() => {})}
                    />
                    <UpgradeModal />
                    {/* THE GRID'S OWN CHROME, with the grid.
                        It rendered unconditionally, so the Deck — the default surface — carried a
                        layout picker for a grid that was not on screen, beside Add buttons that
                        act on `activeWorkspaceId` while the Deck is cross-workspace by
                        definition. `showGridChrome` is the rule and it is tested; this is the one
                        place it is read.
                        A conditional RENDER, not a hidden one: nothing here owns a pty. That is
                        the whole reason `hideGrid` exists for the grid itself and does not apply
                        to its toolbar. */}
                    {surface.showGridChrome && <Toolbar
                        activeWorkspace={
                            activeWorkspaceId
                                ? workspacesById.get(activeWorkspaceId)
                                : undefined
                        }
                        workspaces={workspaces}
                        layoutMode={layoutMode}
                        onLayoutMode={setLayoutMode}
                        onAddView={(type) =>
                            activeWorkspaceId && void addSpec(activeWorkspaceId, type)
                        }
                        pluginPanels={pluginPanels}
                        onAddPluginPanel={(panel) =>
                            activeWorkspaceId && void addPluginPanel(activeWorkspaceId, panel)
                        }
                        addDisabled={atMaxViews}
                        addDisabledReason={maxViewsReason}
                        onRunRecipe={() => setRecipeLauncherOpen(true)}
                        lastTerminalType={lastTerminalType}
                        onLastTerminalType={setLastTerminalType}
                        onAgentCreated={selectAgentSpec}
                        agentCustomCommand={agentCustomCommand}
                    />}
                    {/* The Floor — the grid, now ONE component
                        the GApp window's Agent tab mounts too. The state stays
                        here because this window derives it across every workspace
                        (background specs keep off-workspace ptys alive); a GApp
                        window is a single workspace and derives the same shape
                        from far less. */}
                    <Floor
                        deck={
                            surface.showAgent ? (
                                (() => {
                                    const found = sessions.find((x) => x.agentId === surface.showAgent);
                                    // A route naming an agent that no longer exists resolves
                                    // to a SENTENCE, not a blank surface: an empty view would
                                    // read as Genie breaking rather than as a stale link.
                                    /**
                                     * A DORMANT agent has no terminal spec, and there is nothing
                                     * to write to. The write handlers are withheld rather than
                                     * guarded inside, which also means no composer is rendered —
                                     * a box that cannot send is worse than no box, because it
                                     * invites typing and swallows it.
                                     */
                                    const writable = found?.specId ?? null;
                                    return found ? (
                                        <AgentView
                                            session={found}
                                            {...(view.kind === 'agent' && view.tab ? { tab: view.tab } : {})}
                                            /**
                                             * THE WRITE PATH, finally connected.
                                             *
                                             * `AgentView` has taken `onApprove` and `onTakeOver`
                                             * since it was written and master passed NEITHER, and
                                             * there was no composer at all — so the default
                                             * surface could show an agent and not speak to it.
                                             * `terminal:write` does not help: it reaches a pty,
                                             * and an ACP agent's pty is an empty shell.
                                             *
                                             * Each handler re-reads the sessions afterwards rather
                                             * than mutating local state: the host is the record,
                                             * and a hopeful local edit would show a prompt as sent
                                             * when the channel had gone.
                                             */
                                            {...(writable ? { onSend: (text: string) => {
                                                void api()
                                                    .agentSession.prompt(writable, text)
                                                    .then((r) => {
                                                        // A named refusal is worth saying out
                                                        // loud: `parked` means the agent is over
                                                        // its own daily cap and the gate has
                                                        // already asked the owner, so silence here
                                                        // would look like Genie dropping the
                                                        // message.
                                                        if (!r.ok) {
                                                            console.warn(
                                                                `[agent] prompt not sent (${r.reason})`,
                                                            );
                                                        }
                                                        loadSessions();
                                                    })
                                                    .catch(() => {});
                                            } } : {})}
                                            {...(writable ? { onCancel: () => {
                                                void api()
                                                    .agentSession.cancel(writable)
                                                    .then((r) => {
                                                        // `session/cancel` only ASKS. An agent that
                                                        // keeps going is a fact to report, not a
                                                        // failure to retry.
                                                        if (r.ok && !r.honoured) {
                                                            console.warn(
                                                                '[agent] the agent did not stop when asked',
                                                            );
                                                        }
                                                        loadSessions();
                                                    })
                                                    .catch(() => {});
                                            } } : {})}
                                            {...(writable ? { onApprove: (
                                                approvalId: string,
                                                decision: 'allow-once' | 'allow-always' | 'deny-once',
                                            ) => {
                                                void api()
                                                    .agentSession.decide(writable, approvalId, decision)
                                                    .then(() => loadSessions())
                                                    .catch(() => {});
                                            } } : {})}
                                            onTakeOver={() => {
                                                // The pty is one click away and it is the SAME
                                                // terminal the agent's session belongs to — "take
                                                // over" is a place to go, not a mode to enter, so
                                                // it is the Terminal tab and the url records it.
                                                replacePageQuery(
                                                    mergeViewRoute(pageQuery, {
                                                        kind: 'agent',
                                                        agentId: surface.showAgent!,
                                                        tab: 'terminal',
                                                    }),
                                                );
                                            }}
                                            onTab={(t) => {
                                                // The tab lives in the URL, so refresh, back and a
                                                // shared link all land in the same place.
                                                //
                                                // `mergeViewRoute` rather than replacing the query:
                                                // `host` and `stage` are bound before load and decide
                                                // whether this renderer points at a REMOTE machine, so
                                                // dropping them would silently make a remote window
                                                // local.
                                                replacePageQuery(
                                                    mergeViewRoute(pageQuery, {
                                                        kind: 'agent',
                                                        agentId: surface.showAgent!,
                                                        tab: t,
                                                    }),
                                                );
                                            }}
                                        />
                                    ) : (
                                        <div className="agent-view-missing">
                                            That agent is no longer here.
                                        </div>
                                    );
                                })()
                            ) : surface.showDashboard ? (
                                /**
                                 * THE WORKFLOW DASHBOARD — a sibling of the Deck, not a layer
                                 * over it. `floorSurface` guarantees the two are never both
                                 * mounted, and that is asserted rather than assumed.
                                 *
                                 * Workspaces are passed WHOLE rather than filtered to those
                                 * with agents: the board keeps an empty workspace on screen
                                 * with an Add agent affordance, because a workspace that
                                 * disappears when its agents stop is one you cannot start work
                                 * in.
                                 */
                                <Dashboard
                                    sessions={sessions}
                                    workspaces={workspaces.map((w) => ({
                                        id: w.id,
                                        name: w.project_name,
                                        path: w.path,
                                    }))}
                                />
                            ) : surface.showDeck ? (
                                <Deck
                                    sessions={sessions}
                                    questions={deckQuestions}
                                    listItems={deckListItems}
                                    onAnswerOption={(questionId, label) => {
                                        const q = deckQuestions.find((x) => x.id === questionId);
                                        const answers = q ? answerForOption(q, label) : null;
                                        // answerForOption refuses a partial or invented answer.
                                        // Silence here is correct: nothing was submitted.
                                        if (!answers) return;
                                        void api()
                                            .questions.answer(questionId, answers)
                                            .then(() => loadAttention())
                                            .catch(() => {});
                                    }}
                                    /**
                                     * A FORWARDED question only. Everything else is answered on
                                     * the row itself now — `NeedsYou` grew the form — so the
                                     * flyout is no longer the way to answer a multi-part,
                                     * multi-select or free-text question.
                                     */
                                    onOpenQuestion={() => setOpenDrawer('questions')}
                                    /**
                                     * THE SIGNALS THE ICONS CARRIED.
                                     *
                                     * Owner decision: *"move the signals to the Deck, then delete
                                     * the icons."* The same facts the title bar read — a running
                                     * Flow, agent mail nobody has collected, GitHub permissions
                                     * blocking features, the OS agent working, IssueWatch unable
                                     * to tell. `stationSignals` decides which are worth saying
                                     * and keeps quiet otherwise.
                                     */
                                    signals={{
                                        flowsRunning: flowsBusy,
                                        mailBehind: agentInboxLag,
                                        githubBlocked: githubNeedsResolve,
                                        osWorking:
                                            !!genieOsSpec && streamingTerms.has(genieOsSpec.id),
                                        issueWatchUnknown: issueWatchBadge(
                                            activeWorkspaceId
                                                ? issueWatchCounts[activeWorkspaceId]
                                                : undefined,
                                        ).unknown,
                                        workstationCameOnline,
                                    }}
                                    // A signal is still a DOOR: it opens what the icon opened, by
                                    // the same `featureId` the palette dispatches on, so there is
                                    // one route to each feature rather than two that can drift.
                                    onSignal={(featureId) => {
                                        // Acting on the signal ACKNOWLEDGES it, exactly as opening
                                        // the Hosts popover used to clear its glow. A signal that
                                        // survives being acted on is a signal people learn to
                                        // ignore.
                                        if (featureId === 'remote-host') {
                                            setWorkstationCameOnline(false);
                                        }
                                        activateFeature(featureId);
                                    }}
                                    focusedKey={focusedQueueKey}
                                    expandedQuestionId={expandedQuestionId}
                                    onExpandQuestion={setExpandedQuestionId}
                                    onSubmitAnswer={(questionId, answers) => {
                                        // Already COMPLETE — `buildAnswer` refuses to produce a
                                        // partial — so this is the same call the one-click path
                                        // makes, with every part filled in.
                                        void api()
                                            .questions.answer(questionId, answers)
                                            .then(() => loadAttention())
                                            .catch(() => {});
                                    }}
                                    onResolveListItem={(todoId, action) => {
                                        void api()
                                            .lists.resolveUser(todoId, action, '')
                                            .then(() => loadAttention())
                                            .catch(() => {});
                                    }}
                                />
                            ) : undefined
                        }
                        hideGrid={surface.hideGrid}
                        agentRecord={activeAgentRecord ?? undefined}
                        onRuntimesChanged={reloadActiveAgents}
                        specs={selectedSpecs}
                        allSpecs={specs}
                        backgroundSpecs={backgroundSpecs}
                        workspacesById={workspacesById}
                        activeWorkspaceId={activeWorkspaceId}
                        addDisabled={atMaxViews}
                        addDisabledReason={maxViewsReason}
                        focusId={focusId}
                        attentionIds={attentionIds}
                        pendingNudges={incoming}
                        onSendPendingNudge={(id, options) => sendPendingNudge(id, options)}
                        onAttentionClear={clearAttention}
                        recoverGen={recoverGenById}
                        maximizedId={maximizedId}
                        onClose={closeSelected}
                        onFocus={(id) => setFocusId((cur) => (cur === id ? null : id))}
                        onToggleMaximize={toggleMaximize}
                        onDisable={(id) => void disableSpec(id)}
                        onAgentSettings={(spec) => setAgentEditSpec(spec)}
                        onRestartAgent={(spec, mode) => void restartAgentSpec(spec, mode)}
                        onAddTerminal={() =>
                            activeWorkspaceId && void addSpec(activeWorkspaceId, 'terminal')
                        }
                        onAddCode={() =>
                            activeWorkspaceId && void addSpec(activeWorkspaceId, 'code')
                        }
                        onMarkActive={markActive}
                        onMarkInactive={markInactive}
                        layoutMode={layoutMode}
                        onReorder={reorderSpecs}
                        projectCount={projectsActive.size}
                        activeCount={activeIds.size}
                        hibernated={(() => {
                            const ws = activeWorkspaceId
                                ? workspacesById.get(activeWorkspaceId)
                                : undefined;
                            if (!ws || !isHibernated(ws)) return undefined;
                            return {
                                name: ws.project_name,
                                waking: hibernationBusy[ws.id] === 'waking',
                                onWake: () => void wakeWorkspaceRow(ws.id),
                            };
                        })()}
                    />
                </div>
            </div>

            {!isStage && genieOsSpec && systemWorkspace && (
                <div
                    // `is-active` is the SHIMMER; `is-open` is only the slide-in.
                    // The chase used to key on is-open, so it ran for as long as
                    // the panel was up — an activity animation that meant "open".
                    className={`genie-os-layer${isDrawerOpen(openDrawer, 'genie-os') ? ' is-open' : ''}${
                        genieOsSpec && streamingTerms.has(genieOsSpec.id) ? ' is-active' : ''
                    }`}
                    aria-hidden={!isDrawerOpen(openDrawer, 'genie-os')}
                >
                    <button className="genie-os-backdrop" aria-label="Close Genie OS" onClick={() => setOpenDrawer((d) => closeDrawerNext(d, 'genie-os'))} />
                    <aside className="genie-os-flyout" aria-label="Genie OS agent">
                        <AgentTerminal
                            spec={genieOsSpec}
                            workspace={systemWorkspace}
                            focused={isDrawerOpen(openDrawer, 'genie-os')}
                            attention={attentionIds.has(genieOsSpec.id)}
                            onAttentionClear={() => clearAttention(genieOsSpec.id)}
                            onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'genie-os'))}
                            onAgentSettings={() => setAgentEditSpec(genieOsSpec)}
                            onRestartAgent={(mode) => void restartAgentSpec(genieOsSpec, mode)}
                            onMarkActive={() => markActive(genieOsSpec.id)}
                            onMarkInactive={() => markInactive(genieOsSpec.id)}
                        />
                    </aside>
                </div>
            )}

            {/* FIRST RUN — pick a folder, then meet an agent (P7, owner-approved 2026-10-08).
                MOUNTED, which it was not: P7 described rewriting a seven-gate wizard and that
                component had no mount site at all, so the "7 gates" were true of a file and not of
                the product. The owner's call was asked for and given — *"build that — folder, then
                'what I found' + start an agent"* — after reading how Paperclip onboards.

                Gated on there being NO workspace, which is the one state where the folder question
                has an answer worth asking for. An existing install never sees it; `canFinishFirstRun`
                is the same gate the component closes itself with.

                `onFix` routes a reported gap through the SAME `activateFeature` the palette and the
                Deck's signals use, so there is one answer to "where does this feature live". Tynn is
                the exception and has no feature id — it is an auth flow, so it is called directly. */}
            {!isRemoteWindow() && workspaces.length === 0 && (
                <FirstRunOnboarding
                    open={!localStorage.getItem('genie-onboarding-complete')}
                    existingWorkspaceCount={workspaces.length}
                    // `refresh` is the page's own workspace re-read — the same one every
                    // other path calls after a workspace changes.
                    onComplete={() => void refresh()}
                    onWorkspaceAdded={(ws) => {
                        void refresh();
                        setActiveWorkspaceId(ws.id);
                    }}
                    onFix={(route) => {
                        if (route === 'tynn-signin') {
                            void api().auth.startSignIn('tynn').catch(() => {});
                            return;
                        }
                        activateFeature(route);
                    }}
                />
            )}

            <DocsFlyout open={isDrawerOpen(openDrawer, 'docs')} onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'docs'))} />
            <IssueWatchFlyout
                open={isDrawerOpen(openDrawer, 'issuewatch')}
                workspaceId={issueWatchWsId}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'issuewatch'))}
                // ONE call, where it used to take two. Closing IssueWatch before opening
                // GitHub capabilities was necessary while each had its own boolean; with a
                // single slot the open IS the close, and a stale second setState could only
                // ever race it. A small demonstration of what the refactor buys.
                onResolveGithub={() => setOpenDrawer('github-caps')}
            />
            <TaskManagerFlyout
                open={isDrawerOpen(openDrawer, 'tasks')}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'tasks'))}
            />
            <AgentInboxFlyout
                open={isDrawerOpen(openDrawer, 'agent-inbox')}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'agent-inbox'))}
            />
            <FlowManagerFlyout open={isDrawerOpen(openDrawer, 'flows')} onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'flows'))} />
            {/* The store lists installed apps AND a ribboned launcher for every
                workspace that BUILDS one, so a developer finds their own app
                where they already look for everyone else's. It is handed the
                SAME `launchGapp` the workspace row and the Command Window use —
                one launch, one busy state, one toast. */}
            <AppStoreFlyout
                open={isDrawerOpen(openDrawer, 'appstore')}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'appstore'))}
                workspaces={workspaces}
                onLaunchGapp={launchGapp}
                launchingGappWsId={launchingGappWsId}
            />
            <QuestionInboxFlyout
                open={isDrawerOpen(openDrawer, 'questions')}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'questions'))}
            />
            {/* Renders in one of two shapes, chosen inside the component:
                floating over the Floor, or docked in the right-hand gutter that
                the per-content-row reserve in `master.css` holds the width — so a pinned panel covers
                nothing. The gutter starts BELOW both header rows and the header
                is pulled back out of it, so pinning never moves the header
                icons. */}
            <ListsFlyout
                open={isDrawerOpen(openDrawer, 'lists')}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'lists'))}
                workspaceId={activeWorkspaceId}
                pinned={pinnedDock === 'lists'}
                onTogglePin={toggleListsPin}
            />
            {/**
              * CHAT (§5.4) — the second DOCKABLE panel, and the first since the dock became a
              * single slot. Pinning it undocks Lists and vice versa, which is `pinDockNext`.
              *
              * Rendered only while open, unlike the grid: there is no live pty here to lose, so
              * concealment buys nothing and an unmounted composer cannot hold a stale draft for
              * an agent you have since navigated away from.
              */}
            {isDrawerOpen(openDrawer, 'chat') ? (
                <ChatFlyout
                    session={chatSession}
                    pinned={pinnedDock === 'chat'}
                    onTogglePin={() => togglePin('chat')}
                    onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'chat'))}
                />
            ) : null}
            <GithubCapabilitiesFlyout
                open={isDrawerOpen(openDrawer, 'github-caps')}
                caps={githubCaps}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'github-caps'))}
            />

            <PromptHost />

            {quitPrompt && (
                <QuitTerminalsModal
                    terminals={quitPrompt.terminals}
                    destructive={quitPrompt.destructive}
                    specs={specs}
                    workspacesById={workspacesById}
                    onDecision={decideQuit}
                />
            )}

            {toast && (
                <div className="g-toast" role="status" onClick={() => setToast(null)}>
                    {toast}
                </div>
            )}

            <RecoveryBanner state={recovery} onDismiss={() => setRecovery(null)} />

            {addingWorkspace && (
                <AddWorkspaceModal
                    onClose={() => setAddingWorkspace(false)}
                    onAdded={(row) => {
                        setWorkspaces((prev) => {
                            const exists = prev.some((w) => w.id === row.id);
                            return exists
                                ? prev.map((w) => (w.id === row.id ? row : w))
                                : [...prev, row];
                        });
                        setAddingWorkspace(false);
                        // A brand-new row has never been reconciled: the modal
                        // fetched its project list on MOUNT, before this workspace
                        // existed. Without this, a workspace created against a
                        // Genie App project would not look like one until the
                        // window next regained focus (genie#245).
                        nudgeGappDevSync();
                    }}
                />
            )}

            {newAgentWsId && (() => {
                const ws = workspacesById.get(newAgentWsId);
                if (!ws) return null;
                return (
                    <NewAgentModal
                        workspaceId={ws.id}
                        workspaceName={ws.project_name}
                        onClose={() => setNewAgentWsId(null)}
                        // The grid reads the agent record, so a new one only
                        // appears once that is re-read.
                        onCreated={() => void refresh()}
                    />
                );
            })()}
            {projectMenu && (() => {
                const ws = workspacesById.get(projectMenu.workspaceId);
                if (!ws) return null;
                return (
                    <ProjectContextMenu
                        position={{ x: projectMenu.x, y: projectMenu.y }}
                        workspace={ws}
                        onClose={() => setProjectMenu(null)}
                        onAddTerminal={() => void addSpec(ws.id)}
                        onNewAgent={() => setNewAgentWsId(ws.id)}
                        onAgents={() => setAgentsWsId(ws.id)}
                        onOpenStage={() => openProjectInStage(ws.id)}
                        onOpenInBrowser={() => openProjectInBrowser(ws.id)}
                        onSettings={() => setSettingsWorkspaceId(ws.id)}
                        onSiteManager={() => setSiteManagerWsId(ws.id)}
                        onProcessManager={() => setProcessManagerWsId(ws.id)}
                        onFeedback={() => setFeedbackWsId(ws.id)}
                        {...(isRemoteWindow() ? {} : { onShare: () => setShareWsId(ws.id) })}
                        hibernated={isHibernated(ws)}
                        busy={hibernationBusy[ws.id] ?? null}
                        onHibernate={() => void hibernateWorkspaceRow(ws.id)}
                        onWake={() => void wakeWorkspaceRow(ws.id)}
                        onRemove={() => void removeWorkspaceRow(ws.id)}
                    />
                );
            })()}

            {feedbackWsId && (() => {
                const ws = workspacesById.get(feedbackWsId);
                if (!ws) return null;
                return (
                    <FeedbackModal
                        workspace={ws}
                        open
                        onClose={() => setFeedbackWsId(null)}
                    />
                );
            })()}

            {agentsWsId && (() => {
                const ws = workspacesById.get(agentsWsId);
                if (!ws) return null;
                return (
                    <WorkspaceAgentsModal
                        workspace={ws}
                        onClose={() => setAgentsWsId(null)}
                    />
                );
            })()}

            {settingsWorkspaceId && (() => {
                const ws = workspacesById.get(settingsWorkspaceId);
                if (!ws) return null;
                return (
                    <WorkspaceSettingsModal
                        workspace={ws}
                        onClose={() => setSettingsWorkspaceId(null)}
                    />
                );
            })()}

            <SharingFlyout
                open={isDrawerOpen(openDrawer, 'sharing')}
                onClose={() => setOpenDrawer((d) => closeDrawerNext(d, 'sharing'))}
                workspaces={workspaces}
                tynnHost={hosts.tynn}
                onShareWorkspace={(id) => {
                    setOpenDrawer((d) => closeDrawerNext(d, 'sharing'));
                    setShareWsId(id);
                }}
            />

            {/* Share workspace — the right-click entry (owner's ask). "Manage
                links…" hands over to Workspace settings, which owns the list of
                live links and revoking them; this modal is the one-off act. */}
            {shareWsId && (() => {
                const ws = workspacesById.get(shareWsId);
                if (!ws) return null;
                return (
                    <ShareWorkspaceModal
                        workspace={ws}
                        onClose={() => setShareWsId(null)}
                        onManageLinks={() => {
                            setShareWsId(null);
                            setSettingsWorkspaceId(ws.id);
                        }}
                    />
                );
            })()}

            {/* Ctrl+K — opened by the terminal-scoped hotkey layer, so it appears
                only while a terminal panel has focus and the keypress never
                reaches the shell (Tynn #247). */}
            <GenieCommandWindow
                open={paletteOpen}
                onClose={() => {
                    setPaletteOpen(false);
                    setCommandWindowFor(null);
                }}
                terminalId={commandWindowFor}
                onActivateFeature={activateFeature}
                // Tynn is OPTIONAL, so the rows that need it say so. `signedIn` rather than a
                // guess: the palette must not accuse an account it never checked.
                tynnConnected={signedIn}
                workspaces={workspaces.map((w) => ({ id: w.id, name: w.project_name }))}
                terminals={specs.map((sp) => ({
                    id: sp.id,
                    label: sp.label || sp.type || 'terminal',
                    ...(sp.cwd ? { hint: sp.cwd } : {}),
                }))}
                prompts={prompts}
                // Genie's VERBS in the palette. Today: launch the app a GDW
                // builds — previously reachable only two clicks into Workspace
                // Settings, in a section that appears for some workspaces and
                // not others.
                actions={[
                    ...gappLaunchTargets(workspaces).map((t) => ({
                        id: `gapp-launch:${t.id}`,
                        label: gappLaunchLabel({ project_name: t.name }),
                        hint: t.path,
                        run: () => launchGapp(t.id),
                    })),
                    /**
                     * Tynn #447 -- every workspace can open a terminal, or start an agent
                     * in TUI MODE, in its OWN WINDOW so TheFloor stays clean.
                     *
                     * Offered here rather than as another title-bar glyph: the palette is
                     * where Genie 2 puts verbs, and these are workspace-scoped, so they
                     * only appear when there IS an active workspace to open them against.
                     * Offering them with none would be a row that silently does nothing.
                     */
                    ...(activeWorkspaceId
                        ? [
                              {
                                  id: 'terminal-window:open',
                                  label: 'Open a terminal in a new window',
                                  hint: workspacesById.get(activeWorkspaceId)?.project_name,
                                  run: () => {
                                      void api()
                                          .terminal.openWindow({ kind: 'terminal', workspaceId: activeWorkspaceId })
                                          .then((r) => {
                                              // The underlying message is the only thing
                                              // that says what to fix, so it is surfaced
                                              // rather than swallowed.
                                              if (!r?.ok && r?.error) console.warn(`[terminal window] ${r.error}`);
                                          })
                                          .catch(() => {});
                                  },
                              },
                          ]
                        : []),
                ]}
                onActivateWorkspace={activateWorkspace}
                onFocusTerminal={toggleSpec}
                onSendPrompt={(terminalId, text) => {
                    void api().terminal.write(terminalId, text);
                }}
            />
            {processManagerWsId && (() => {
                const ws = workspacesById.get(processManagerWsId);
                if (!ws) return null;
                return (
                    <WorkspaceProcessManager
                        workspace={ws}
                        specs={processSpecsOf(specs, ws)}
                        onCreate={createProcess}
                        onUpdate={updateProcess}
                        onSetEnabled={setProcessEnabled}
                        onDelete={(id) => void destroySpec(id)}
                        onClose={() => setProcessManagerWsId(null)}
                    />
                );
            })()}
            {siteManagerWsId && (() => {
                const ws = workspacesById.get(siteManagerWsId);
                if (!ws) return null;
                return (
                    <WorkspaceSiteManager
                        workspace={ws}
                        onClose={() => setSiteManagerWsId(null)}
                    />
                );
            })()}


            {/* "Run a recipe" (Toolbar wand). Scoped to the active workspace:
                the launcher lists every registered recipe (built-in + plugin —
                e.g. the Repository plugin's git recipes) and runs the chosen one
                in a WizardModal whose terminal steps default their cwd to the
                workspace repo. The button is disabled without an active
                workspace, so recipeLaunchScope is always resolvable here. */}
            {recipeLauncherOpen && (() => {
                const scope = activeWorkspaceId
                    ? recipeLaunchScope(workspacesById.get(activeWorkspaceId))
                    : null;
                if (!scope) return null;
                return (
                    <RecipeLauncher
                        workspaceId={scope.workspaceId}
                        defaultCwd={scope.defaultCwd}
                        onClose={() => setRecipeLauncherOpen(false)}
                    />
                );
            })()}

            {contextMenu && (() => {
                const target = specs.find((s) => s.id === contextMenu.specId);
                if (!target) return null;
                return (
                    <SpecContextMenu
                        position={{ x: contextMenu.x, y: contextMenu.y }}
                        spec={target}
                        inSelection={selected.has(target.id)}
                        workspaces={workspaces}
                        onClose={() => setContextMenu(null)}
                        onToggleInView={() => toggleSpec(target.id)}
                        onOpenInNewWindow={() => openSpecInNewWindow(target.id)}
                        onRename={() => void renameSpec(target.id, target.label)}
                        onDuplicate={() => void duplicateSpec(target.id)}
                        onMoveToWorkspace={(wsId) =>
                            void moveSpecToWorkspace(target.id, wsId)
                        }
                        onAgentSettings={() => setAgentEditSpec(target)}
                        onRestartAgent={(mode) => void restartAgentSpec(target, mode)}
                        onDelete={async () => {
                            const ok = await showPrompt({
                                title: 'Delete terminal',
                                body: `Delete "${target.label}"? Its saved spec is removed and any running shell is killed.`,
                                confirmLabel: 'Delete',
                                destructive: true,
                            });
                            if (ok !== null) void destroySpec(target.id);
                        }}
                    />
                );
            })()}

            {/* THE AGENT MANAGER, in the product at last. It was built, tested
                on three operating systems, and rendered only by the E2E harness
                page — so nobody outside the suite could reach it.

                It then spent three more reports UNREACHABLE for a second reason:
                this wrapper was written with `modal-backdrop` / `modal` /
                `modal-head` / `modal-title`, and not one of those classes existed
                in any stylesheet. An unstyled backdrop is not an overlay — no
                `position: fixed`, no `z-index`, no centring — so the manager laid
                out inline at the end of the document, under everything, and
                "Edit agent…" looked like a dead button.

                It now uses the scrim and card every other modal here uses, which
                is the point: a name that already has a rule cannot silently refer
                to nothing. `renderer/lib/__tests__/agent-manager-modal.test.ts`
                fails on any class in this block that the stylesheets do not
                define. */}
            {manageAgentId && (
                <div className="prompt-scrim" onMouseDown={() => setManageAgentId(null)}>
                    <div
                        className="prompt-card agent-manager-card"
                        role="dialog"
                        aria-label="Agent manager"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <div className="prompt-title">
                            <span>Agent</span>
                            <span className="grow" />
                            <button
                                type="button"
                                className="gicon"
                                onClick={() => setManageAgentId(null)}
                                aria-label="Close agent manager"
                                title="Close"
                            >
                                ×
                            </button>
                        </div>
                        <AgentManager
                            agentId={manageAgentId}
                            onChanged={() => {
                                void api().terminalSpec.list().then(setSpecs).catch(() => {});
                                if (activeWorkspaceId) {
                                    void api()
                                        .agents.list(activeWorkspaceId)
                                        .then(setAgentRecord)
                                        .catch(() => {});
                                }
                            }}
                        />
                    </div>
                </div>
            )}

            {agentEditSpec && agentEditSpec.meta?.agent && (
                <AgentSettingsModal
                    spec={agentEditSpec}
                    workspaces={workspaces}
                    onClose={() => setAgentEditSpec(null)}
                    onSaved={() => {
                        setAgentEditSpec(null);
                        // The broker re-emits presence; re-fetch specs so the row's
                        // purpose sub-label reflects the edit immediately.
                        void api().terminalSpec.list().then(setSpecs).catch(() => {});
                    }}
                    record={agentRecord?.agents.find(
                        (a) =>
                            agentRecord.runtimes.some(
                                (r) => r.agentId === a.id && r.terminalSpecId === agentEditSpec.id,
                            ),
                    )}
                    onRecordChanged={() => {
                        const ws = agentEditSpec.workspace_id;
                        if (ws) void api().agents.list(ws).then(setAgentRecord).catch(() => {});
                    }}
                />
            )}
        </div>
    );
}

/**
 * Edit modal for a specialized (agent) terminal's AgentInbox identity — the same
 * purpose / scope / command form as create, pre-filled from the spec's meta and
 * persisted via `agentInbox.updateChannel` (which re-emits presence). Opened from the
 * spec context menu's "Agent settings…" item.
 */
function AgentSettingsModal({
    spec,
    workspaces,
    onClose,
    onSaved,
    record,
    onRecordChanged,
}: {
    spec: TerminalSpec;
    workspaces: WorkspaceRow[];
    onClose: () => void;
    onSaved: () => void;
    /** This agent's RECORD, when Genie has one. The modal used to describe the
     *  terminal only — title `claude · moic`, no drivers, no designation — which
     *  is the model that no longer exists. The manager reads the agent's
     *  runtimes itself (`agents.managerState`), so they are not passed in. */
    record?: AgentRecordSpec;
    onRecordChanged?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const agent = (spec.meta?.agent ?? 'custom') as AgentType;
    const meta = spec.meta ?? {};

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    /* The IDENTITY controls — workspace default, purpose, reachability,
       IssueWatch. Kept as they were: Tynn #709 REPLACES this surface, it does
       not shrink it. They are the manager's first tab, beside the driver,
       prompt, MCP and sidecar tabs.

       The DRIVER picker used to sit here as a popover trigger and is now the
       Driver tab (genie#463) — a real control that lists every provider, says
       which hold a parked conversation, and refuses the ones this agent's
       AGENT.md excludes, none of which fits in an icon. Moved, not copied: two
       driver controls in one modal is how they drift. */
    const identityPanel = (
        <>
            {record && (
                <div className="agent-settings-record">
                    <label className="agent-form-wake">
                        <input
                            type="checkbox"
                            checked={record.role === 'workspace'}
                            onChange={(e) => {
                                // The WORKSPACE AGENT is a designation, not an
                                // agent named 'workspace'. Unticking clears it
                                // rather than moving it to someone else.
                                void api()
                                    .agents.setDefault(
                                        spec.workspace_id ?? '',
                                        e.target.checked ? record.id : null,
                                    )
                                    .then(() => onRecordChanged?.())
                                    .catch(() => {});
                            }}
                        />
                        <span className="agent-form-wake-text">
                            <span className="agent-form-label">
                                Default agent for this workspace
                            </span>
                            <span className="agent-form-scope-desc">
                                Boots from the workspace root and is the default target for
                                actions that do not name an agent. One per workspace.
                            </span>
                        </span>
                    </label>
                </div>
            )}
            <AgentTerminalForm
                agent={agent}
                workspaces={workspaces}
                ownWorkspaceId={spec.workspace_id}
                initial={{
                    // The persisted meta uses the `whisper_*` keys (see
                    // createAgentTerminal / agentInbox:update-channel); read those, not the
                    // bare `purpose`/`scope`, or the edit pre-fill is blank and Save
                    // silently resets the agent's purpose→general and scope→self.
                    purpose:
                        typeof meta.whisper_purpose === 'string' ? meta.whisper_purpose : '',
                    scope: (meta.whisper_scope as AgentInboxScope | undefined) ?? 'self',
                    scopeWorkspaces: Array.isArray(meta.whisper_workspaces)
                        ? (meta.whisper_workspaces as string[])
                        : [],
                    command: typeof meta.agent_command === 'string' ? meta.agent_command : '',
                    issuewatchHandle: meta.issuewatch_handle === true,
                }}
                submitLabel="Save"
                busy={busy}
                error={error}
                onCancel={onClose}
                onSubmit={async (v) => {
                    setBusy(true);
                    setError(null);
                    try {
                        const res = await api().agentInbox.updateChannel(spec.id, {
                            purpose: v.purpose,
                            scope: v.scope,
                            scope_workspaces:
                                v.scope === 'specific' ? v.scopeWorkspaces : [],
                            issuewatch_handle: v.issuewatchHandle,
                        });
                        if (res.ok) onSaved();
                        else setError(res.error || 'Could not update the agent.');
                    } catch {
                        setError('Could not update the agent.');
                    } finally {
                        setBusy(false);
                    }
                }}
            />
        </>
    );

    return (
        <div className="ctx-scrim" onMouseDown={onClose}>
            <div
                className={`agent-settings-modal${
                    // The manager needs room for a tab strip and a prompt
                    // editor; an orphaned spec still gets the narrow dialog.
                    record ? ' agent-settings-modal-manager' : ''
                }`}
                role="dialog"
                aria-label="Agent settings"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="agent-settings-head">
                    {/* The agent's NAME. It used to be `spec.label` --
                        `claude · moic` -- which puts the driver in the
                        identity, the exact model this removed. */}
                    <span className="agent-settings-title">
                        Agent settings — {record?.name ?? spec.label}
                    </span>
                </div>
                {record ? (
                    <AgentManager
                        agentId={record.id}
                        identity={identityPanel}
                        onChanged={() => onRecordChanged?.()}
                    />
                ) : (
                    /* An ORPHANED spec — a terminal no agent record owns. It
                       has no AGENT.md, no MCP set of its own and no sidecar,
                       so it gets the identity form alone rather than three
                       tabs that would each have nothing to show. */
                    identityPanel
                )}
            </div>
        </div>
    );
}

/**
 * Header update pill. Lives in the title bar and only renders while an update is
 * pending (available → downloading → ready-to-restart). It's ONE-WAY: a single
 * "Upgrade" click commits, after which the button is REPLACED by a
 * non-interactive progress display (downloading → installing → Restarting…) that
 * drives the existing updater calls (apply = downloadUpdate, then restart =
 * quitAndInstall) automatically — no second clickable button to mis-/double-click.
 * Hovering (pre-commit) reveals a popover of the incoming changes + the
 * pty-host-restart warning, so the user sees what they're committing to.
 */
function UpdatePill() {
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    // The drain holding this restart, if one is (genie#565). Pushed, never
    // polled — the label has to stop saying "Restarting…" at the instant the
    // gate decides to ask the agents instead, not up to an interval later.
    const [drain, setDrain] = useState<DrainSnapshot | null>(null);
    // What the user has decided about this upgrade lives in a store, not here
    // (genie#622): the window is a sibling component, the header control is
    // what opens it, and BOTH can start the restart — so the decisions have to
    // sit somewhere the two of them can see.
    const { committed, restartDriven } = useUpgradeView();
    const [changelog, setChangelog] = useState<Changelog | null>(null);
    const [hover, setHover] = useState(false);
    // Each step fires at most once after the user commits.
    const appliedRef = useRef(false);
    // Which updater backend is active — decides whether the FRONTEND drives the
    // restart or the backend auto-restarts itself (see shouldDriveRestart).
    const modeRef = useRef<'phase1' | 'phase2' | null>(null);

    useEffect(() => {
        let alive = true;
        void api()
            .updater.status()
            .then((s) => alive && setStatus(s))
            .catch(() => {});
        void api()
            .updater.mode()
            .then((m) => {
                if (alive) modeRef.current = m;
            })
            .catch(() => {});
        const off = api().on.updaterStatus((s) => setStatus(s));
        const offDrain = api().on.drainChanged((s) => setDrain(s));
        return () => {
            alive = false;
            off();
            offDrain();
        };
    }, []);

    const pending = updateIsPending(status?.state);

    // Fetch the changelog once we know a version is on offer. Cached in
    // main, so re-fetches across status ticks are cheap.
    useEffect(() => {
        if (!pending || !status?.latestVersion) return;
        let alive = true;
        void api()
            .updater.changelog(status.latestVersion)
            .then((c) => alive && setChangelog(c))
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [pending, status?.latestVersion]);

    // After the user commits (one Upgrade click), carry the whole sequence
    // through hands-free: download the update, then auto-restart once it's
    // staged. The refs guard each step to a single fire; planCommitStep decides
    // the step — including 'reset', which disarms a commit whose update died
    // (errored download / now up-to-date) so the pill can't wedge committed.
    useEffect(() => {
        if (!committed || !status) return;
        const step = planCommitStep({
            state: status.state,
            committed,
            applied: appliedRef.current,
            // Shared, not a ref: the upgrade window's held-restart button can
            // have driven one already, and a ref private to this component
            // could not see it (genie#622).
            restarted: restartDriven,
            // A manual-download update must NOT auto-apply — electron-updater
            // can't install it on this build. The pill shows a Download button
            // instead (handled in the render).
            manualDownloadUrl: status.manualDownloadUrl ?? null,
            // The backend HELD the hands-free apply because a restart would kill
            // live agent chats — don't auto-drive it; the render shows a confirm.
            interruptionPending:
                status.state === 'ready-to-restart' &&
                (status.interruption?.terminals ?? 0) > 0,
            // The shape a CANCELLED drain leaves behind — rows, but neither
            // running nor complete. The same test `upgradeModalPlan` uses to
            // take the modal off screen, so the two agree on what "abandoned"
            // means rather than each carrying its own idea.
            drainCancelled:
                !!drain && drain.rows.length > 0 && !drain.active && !drain.complete,
        });
        if (step === 'reset') {
            appliedRef.current = false;
            resetUpgradeCommit();
        } else if (step === 'apply') {
            appliedRef.current = true;
            void (async () => {
                const r = await api()
                    .updater.apply() // downloadUpdate
                    .catch((e) => ({
                        ok: false,
                        error: e instanceof Error ? e.message : String(e),
                    }));
                // A refused apply must hand the pill back, not wedge it: with
                // the ref left armed and committed still true, the pill showed
                // "Upgrading…" with no driver and no button forever.
                if (!r.ok) {
                    appliedRef.current = false;
                    resetUpgradeCommit();
                }
            })();
        } else if (step === 'restart') {
            markRestartDriven();
            // Only drive the restart when the backend WON'T auto-restart itself.
            // On a fresh phase-2 apply, downloadAndInstall() armed installWhenReady
            // so the backend already runs quitAndInstall on update-downloaded —
            // calling restart() here too would double-fire it. (Default mode to
            // phase2 in the rare window before mode loads: only the pre-staged /
            // phase-1 paths — where appliedThisCommit is false — drive a restart,
            // and those resolve to `true` regardless of the assumed mode.)
            if (
                shouldDriveRestart({
                    mode: modeRef.current ?? 'phase2',
                    appliedThisCommit: appliedRef.current,
                })
            ) {
                void (async () => {
                    const r = await api().updater.restart(); // quitAndInstall
                    // Phase-1 (git checkout) restarts manually — quit so relaunch
                    // picks up the new code.
                    if (!r.ok) await api().app.quit();
                })();
            }
            // else: the phase-2 backend applies via installWhenReady; the progress
            // display just rides its states to "Restarting…".
        }
        // `drain` is a dependency because a cancelled drain is one of the ways
        // this commit ends, and it arrives on the drain stream rather than the
        // updater's.
    }, [committed, status?.state, drain]);

    const version = status?.latestVersion ?? '';
    const ready = status?.state === 'ready-to-restart';
    // A manual-download update (auto-apply can't run on this build — e.g. a Linux
    // AppImage launched without APPIMAGE) links out to the release page instead
    // of running the in-app Upgrade flow.
    const manualUrl = status?.manualDownloadUrl ?? null;
    const interruption = status?.interruption ?? null;
    const heldTerminals = interruption?.terminals ?? 0;
    const heldChats = interruption?.agentChats ?? 0;

    // What the label says, and therefore what it is. Decided in updater-flow so
    // the states — and there are more of them than a reader would guess — are
    // asserted without a DOM.
    const label = headerUpdateLabel({
        state: status?.state ?? null,
        currentVersion: status?.currentVersion ?? '',
        latestVersion: status?.latestVersion ?? null,
        manualDownloadUrl: manualUrl,
        committed,
        progress: typeof status?.progress === 'number' ? status.progress : null,
        heldTerminals,
        heldChats,
        draining: drain
            ? {
                  active: drain.active,
                  total: drain.rows.length,
                  // The SAME green count the roster flyout renders, so the label
                  // and the list it is summarising can never disagree.
                  green: drainRosterSummary(drain).green,
              }
            : null,
    });

    const heldNoun =
        heldChats > 0
            ? `${heldChats} active agent chat${heldChats === 1 ? '' : 's'}`
            : `${heldTerminals} terminal${heldTerminals === 1 ? '' : 's'}`;

    // Before the first status lands there is no version to state, so the label
    // is the plain wordmark rather than a blank space that fills in a beat later.
    if (!status) return <span className="glogo-text">Genie</span>;

    // NOTHING TO INSTALL — the label states what you are running. This is the
    // half of genie#565 that makes the wordmark worth clicking on: it is never
    // idle chrome, it is either the version or the offer.
    if (label.kind === 'version') {
        return (
            <>
                <span className="glogo-text">Genie</span>
                <span className="glogo-version" title={`Genie ${label.text}`}>
                    {label.text}
                </span>
            </>
        );
    }

    return (
        <span
            className="update-pill-wrap"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            {label.kind === 'download' ? (
                <button
                    type="button"
                    className="update-pill ready"
                    title="Auto-update isn't available on this build — download the new version"
                    onClick={() =>
                        manualUrl &&
                        void api().shell.openExternal(manualUrl).catch(() => {})
                    }
                >
                    <span className="up-dot" />
                    <span className="up-label">{label.text}</span>
                </button>
            ) : label.kind === 'held' ? (
                // Held for confirmation: restarting now would close live agent
                // chats. The click OPENS the window — what is in the upgrade,
                // and who it would interrupt — and the decision is made there
                // (genie#622). Nothing restarts from the header.
                <button
                    type="button"
                    className="update-pill ready"
                    title={`Updating to v${version} closes ${heldNoun}. Genie asks each agent to finish and write a handoff first, and shows you who it is waiting on.`}
                    onClick={openUpgradeView}
                >
                    <span className="up-dot" />
                    <span className="up-label">{label.text}</span>
                </button>
            ) : label.kind === 'upgrade' ? (
                <button
                    type="button"
                    className="update-pill ready"
                    title={`Genie ${version} is available — you are running v${status.currentVersion}. See what is in it.`}
                    onClick={openUpgradeView}
                >
                    <span className="up-dot" />
                    <span className="up-label">{label.text}</span>
                </button>
            ) : (
                // Under way. The click cannot mis-fire the apply — the effect
                // above is what carries it through install → restart — so it
                // does the one useful thing left: puts the window back up, for
                // a user who closed it and wants to watch again (genie#622).
                <button
                    type="button"
                    className="update-pill is-progress"
                    aria-live="polite"
                    title="Show what is in this upgrade, and who it is waiting on"
                    onClick={openUpgradeView}
                >
                    <span className="up-dot" />
                    <span className="up-label">{label.text}</span>
                </button>
            )}
            {hover && (
                <UpdatePopover
                    version={version}
                    changelog={changelog}
                    ready={ready}
                    willRestartPtyHost={!!status.willRestartPtyHost}
                    hostDriftNote={status.hostDriftNote}
                    heldChats={heldChats}
                    heldTerminals={heldTerminals}
                />
            )}
        </span>
    );
}


/**
 * THE UPGRADE MODAL (genie#565).
 *
 * *"When an upgrade is in progress, I should see a big wide modal with a blurry
 * backdrop that shows me what is in this upgrade on the left side and the agent
 * shutdown list on the right that shows all agents status in a clean list."*
 *
 * The roster used to be a small dialog in the corner, which is the wrong weight
 * for what is happening: the user is being asked to decide about their own
 * running work, and the two things they need to weigh — what they GAIN by
 * restarting, and what it COSTS right now — were on opposite sides of the
 * screen from each other. So the notes and the roster are two panes of one
 * sheet, and the backdrop goes quiet behind them.
 *
 * ## The per-row thumb is still what makes this shippable
 *
 * An agent can wedge — mid-tool-call, or with a dead harness — and a drain that
 * could only end when every agent cooperates would hang forever on one of them,
 * which is worse than the kill it replaces. So the user shuts that one down by
 * hand and presses its thumb, and the drain proceeds.
 *
 * ## And Force Restart is here, not elsewhere
 *
 * This is the screen where a person decides they are not waiting, so it is
 * where the button belongs — under the list that names who is holding things
 * up, which is the evidence for the decision. There is no auto-dismiss and no
 * timeout. Cancel abandons the upgrade rather than applying it; a roster that
 * gave up and installed anyway would be the kill again, wearing a delay.
 *
 * ## It is a WINDOW now, not a projection of the drain (genie#622)
 *
 * The owner: *"If I cancel an upgrade I am unable to open the upgrade window
 * again. I should be able to open that window and close it without starting the
 * whole process over again."*
 *
 * It was a projection: `open` came entirely from the drain, so the only control
 * that dismissed it was **Cancel the upgrade** — closing the window WAS
 * cancelling it — and cancelling clears the roster, so nothing left in the UI
 * could put it back. Three things changed, and none of them touch the drain:
 *
 *  - **Opening** is the header control's job, for as long as an upgrade is
 *    staged. With no drain the sheet is the release notes alone, which is the
 *    preview somebody wants before deciding.
 *  - **Closing** is ✕, Esc and the backdrop, matching `WhatsNewModal`. It sets
 *    view state and NOTHING else: a drain in flight keeps draining, its roster
 *    is untouched, and reopening shows it again mid-flight.
 *  - **Cancel the upgrade** stays, as the one deliberate button that abandons
 *    it — and `cancelUpgradeDrain` is still a no-op once the drain is no longer
 *    running, so a late click cannot delete the restore list of an upgrade that
 *    is already applying.
 */
function UpgradeModal() {
    const [snapshot, setSnapshot] = useState<DrainSnapshot | null>(null);
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    const [changelog, setChangelog] = useState<Changelog | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    // Whether the USER is looking at this — the half that is not the drain's to
    // decide (genie#622).
    const view = useUpgradeView();
    // One held restart per press. The button is the door to the drain, and
    // opening it twice would nudge every agent twice.
    const startingRef = useRef(false);
    // Genie's top layer (genie#114). A rung number alone is not enough: it only
    // outranks the Fancy layer while EVERY ancestor is stacking-context-free,
    // and one `transform` / `filter` / `contain` anywhere above traps the
    // subtree silently. `position: fixed` has the same problem — a transformed
    // ancestor becomes its containing block, so a "full-screen" backdrop would
    // cover only part of the window. The overlay root is a direct child of
    // <body> and carries the token scope, so `var(--card)` resolves to a real
    // surface rather than transparent.
    const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setOverlayRoot(ensureOverlayRoot<HTMLElement>(document));
    }, []);

    useEffect(() => {
        let alive = true;
        void api()
            .drain.snapshot()
            .then((s) => alive && setSnapshot(s))
            .catch(() => {});
        void api()
            .updater.status()
            .then((s) => alive && setStatus(s))
            .catch(() => {});
        // PUSHED, never polled: a thumb has to fill at the instant it lands, or
        // the user is watching a roster that lies for as long as the interval.
        const off = api().on.drainChanged((s) => setSnapshot(s));
        const offStatus = api().on.updaterStatus((s) => setStatus(s));
        return () => {
            alive = false;
            off();
            offStatus();
        };
    }, []);

    const plan = upgradeModalPlan({
        drain: snapshot,
        latestVersion: status?.latestVersion ?? null,
        view,
        // The floor under an explicit open: the header control offers this
        // window only while an upgrade is staged, so a stale intent must not
        // leave a full-screen sheet over nothing.
        upgradePending: updateIsPending(status?.state),
    });

    // DISMISS THE VIEW, and nothing else (genie#622). The drain on screen is
    // named so that a LATER drain still puts itself up — genie#565's gate is
    // not something one ✕ may disarm for good.
    const startedAt = snapshot?.startedAt ?? null;
    const dismiss = useCallback(() => {
        closeUpgradeView(startedAt);
    }, [startedAt]);

    // Esc closes it, as it does every other modal in this window.
    useEffect(() => {
        if (!plan.open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') dismiss();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [plan.open, dismiss]);

    // The notes for the version being APPLIED. Cached in main, so the fetch is
    // cheap and re-runs across status ticks cost nothing.
    useEffect(() => {
        if (!plan.open || !plan.version) return;
        let alive = true;
        void api()
            .updater.changelog(plan.version)
            .then((c) => alive && setChangelog(c))
            .catch(() => alive && setChangelog(null));
        return () => {
            alive = false;
        };
    }, [plan.open, plan.version]);

    if (!plan.open || !overlayRoot) return null;

    // Only while a drain is running — with none, the sheet is the release notes
    // alone, which is the preview somebody wants before deciding.
    const summary = plan.roster && snapshot ? drainRosterSummary(snapshot) : null;
    const rows = plan.roster && snapshot ? snapshot.rows : [];
    const press = (agentId: string) => {
        setBusy(agentId);
        void api()
            .drain.satisfy(agentId)
            .then((s) => setSnapshot(s))
            .catch(() => {})
            .finally(() => setBusy(null));
    };

    const groups = changelog?.groups ?? [];
    const anyNotes = groups.some((group) => group.changes.length > 0);

    // What the sheet offers when no drain is running: the same decision the
    // header control used to take on the user's behalf the instant they clicked
    // it, moved to where they can see what they are deciding about.
    const manualUrl = status?.manualDownloadUrl ?? null;
    const heldTerminals = status?.interruption?.terminals ?? 0;
    const heldChats = status?.interruption?.agentChats ?? 0;
    const held = status?.state === 'ready-to-restart' && heldTerminals > 0;
    const heldNoun =
        heldChats > 0
            ? `${heldChats} active agent chat${heldChats === 1 ? '' : 's'}`
            : `${heldTerminals} terminal${heldTerminals === 1 ? '' : 's'}`;
    const startHeldRestart = (): void => {
        // One per press. This button is the door to the drain, and opening it
        // twice would nudge every agent twice.
        if (startingRef.current) return;
        startingRef.current = true;
        void (async () => {
            // A REJECTED call and a REFUSED one are different, and only the
            // second is a reason to quit. `!ok` is phase-1 saying it has no
            // installer, where quitting so the user relaunches is the honest
            // fallback; a rejection is the IPC failing, and quitting Genie over
            // that would turn a transient error into lost work. Leave the
            // button clickable instead.
            const r = await api().updater.restart().catch(() => null);
            // genie#389 — `draining` means nothing restarted: the agents are
            // being asked to finish and hand off first, and the roster is now on
            // screen. The apply follows on its own when it clears, so the press
            // is disarmed again — a cancelled drain must leave this clickable.
            if (!r || r.draining) {
                startingRef.current = false;
                return;
            }
            // It really is restarting. Say so where the pill's driver can see
            // it, or that driver asks for a second one and quitAndInstall fires
            // twice (genie#622 — it used to be a ref private to the pill, back
            // when the pill was also the only thing that could start one).
            markRestartDriven();
            if (!r.ok) await api().app.quit();
        })();
    };

    const versioned = plan.version ? ` to v${plan.version}` : '';
    const title = summary ? `Updating Genie${versioned}` : `Upgrade Genie${versioned}`;
    const subtitle = summary
        ? summary.headline
        : held
          ? `Installing it closes ${heldNoun}. Genie asks each agent to finish and write a handoff first.`
          : status?.currentVersion
            ? `You are running v${status.currentVersion}.`
            : 'Here is what it contains.';

    return createPortal(
        // Backdrop dismiss, matching WhatsNewModal — and `onMouseDown` rather
        // than `onClick` so a drag that STARTS inside the sheet and ends on the
        // backdrop (selecting release-note text to the edge) does not close it.
        <div className="upgrade-modal-backdrop" role="presentation" onMouseDown={dismiss}>
            <div
                className={`upgrade-modal${plan.roster ? '' : ' is-preview'}`}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header className="um-head">
                    <div className="um-head-text">
                        <strong>{title}</strong>
                        <span className="um-sub">{subtitle}</span>
                    </div>
                    {/* CLOSING IS NOT CANCELLING (genie#622). It takes the view
                        away and touches nothing else: a drain in flight keeps
                        draining, its restore roster is untouched, and the header
                        control puts this back up in one click. */}
                    <button
                        type="button"
                        className="gicon"
                        aria-label="Close"
                        title="Close this window. The upgrade is not cancelled."
                        onClick={dismiss}
                    >
                        <IconX size={18} />
                    </button>
                </header>

                <section className="um-notes" aria-label="What is in this upgrade">
                    <h3>What is in this upgrade</h3>
                    {anyNotes ? (
                        <div className="um-notes-scroll">
                            {groups.map((group) => (
                                <div className="um-group" key={group.version}>
                                    <div className="um-group-v">v{group.version}</div>
                                    <ul>
                                        {group.changes.map((change, i) => (
                                            <li key={`${group.version}-${i}`}>{change}</li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                            {changelog?.partial && (
                                // Say so rather than presenting a short list as
                                // the whole story — the notes come over the
                                // network and the upgrade does not wait for them.
                                <p className="um-partial">
                                    Some release notes could not be fetched. This list may
                                    be incomplete.
                                </p>
                            )}
                        </div>
                    ) : (
                        <p className="um-empty">
                            {changelog
                                ? 'No release notes were published for this version.'
                                : 'Fetching the release notes…'}
                        </p>
                    )}
                </section>

                {/* Only while a drain is running. With none there is nobody to
                    list, and an empty "Agents" pane beside the notes would be
                    saying something about the user's agents that is not true. */}
                {plan.roster && summary && (
                    <section className="um-agents" aria-label="Agent shutdown list">
                        <h3>
                            Agents
                            <span className="um-count">
                                {summary.green}/{rows.length} ready
                            </span>
                        </h3>
                        <ul className="dr-rows">
                            {rows.map((row) => {
                                const icon = drainRowIcon(row);
                                const canPress = canSatisfyDrainRow(row);
                                return (
                                    <li key={row.agentId} className={`dr-row is-${icon}`}>
                                        <button
                                            type="button"
                                            className="dr-thumb"
                                            disabled={!canPress || busy === row.agentId}
                                            onClick={() => press(row.agentId)}
                                            title={
                                                canPress
                                                    ? `Mark ${row.name} as done — use this after you have shut it down yourself`
                                                    : drainRowStatusLabel(row)
                                            }
                                            aria-label={`${row.name}: ${drainRowStatusLabel(row)}`}
                                        >
                                            <IconThumbUp size={14} />
                                        </button>
                                        <div className="dr-who">
                                            <span className="dr-name">{row.name}</span>
                                            <span className="dr-note">
                                                {drainRowStatusLabel(row)}
                                            </span>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                        {summary.stuck > 0 && (
                            <div className="dr-warn" role="alert">
                                {summary.stuck === 1
                                    ? 'One agent has'
                                    : `${summary.stuck} agents have`}{' '}
                                stopped answering. Shut {summary.stuck === 1 ? 'it' : 'them'} down
                                yourself, then press the thumb to let the upgrade go ahead.
                            </div>
                        )}
                    </section>
                )}

                <footer className="um-actions">
                    {summary ? (
                        <>
                            {/* THE ESCAPE. The drain deliberately never resolves
                                on a clock, so the only way past an agent that has
                                stopped answering is a person deciding to lose what
                                it was doing. It sits under the list that names who,
                                so the choice is informed rather than a guess — and
                                it says what it costs. */}
                            <button
                                type="button"
                                className="um-force"
                                onClick={() => {
                                    void api()
                                        .updater.restart({ force: true })
                                        .catch(() => {});
                                }}
                                disabled={summary.done}
                                title={
                                    summary.done
                                        ? 'Every agent has answered — the upgrade is applying now'
                                        : `Restart now without waiting. ${
                                              summary.pending === 1
                                                  ? 'The agent that has not answered loses'
                                                  : `The ${summary.pending} agents that have not answered lose`
                                          } whatever they were part-way through, and no handoff is written for them.`
                                }
                            >
                                Force restart now
                            </button>
                            {/* ABANDON THE UPGRADE — a different act from closing
                                the window, and the only control here that is. It
                                dismisses the view as well, because a user who has
                                just stopped the upgrade is done looking at it; the
                                header control still offers it, so coming back is
                                one click (genie#622). */}
                            <button
                                type="button"
                                className="um-cancel"
                                onClick={() => {
                                    void api()
                                        .drain.cancel()
                                        .then((s) => setSnapshot(s))
                                        .catch(() => {});
                                    dismiss();
                                }}
                                disabled={summary.done}
                                title="Leave the update staged and go back to work. Nothing is installed."
                            >
                                Cancel the upgrade
                            </button>
                        </>
                    ) : (
                        <>
                            {/* NO DRAIN: this is the preview, so it carries the
                                decision the header control used to take the
                                instant it was clicked. "Not now" is the same
                                dismissal as ✕ — it starts nothing and stops
                                nothing. */}
                            <button type="button" className="um-cancel" onClick={dismiss}>
                                Not now
                            </button>
                            {manualUrl ? (
                                <button
                                    type="button"
                                    className="um-go"
                                    title="Auto-update isn't available on this build — download the new version"
                                    onClick={() => {
                                        void api()
                                            .shell.openExternal(manualUrl)
                                            .catch(() => {});
                                    }}
                                >
                                    Download{plan.version ? ` v${plan.version}` : ''}
                                </button>
                            ) : held ? (
                                <button
                                    type="button"
                                    className="um-go"
                                    title={`Genie asks ${heldNoun} to finish and write a handoff first, and shows you who it is waiting on. Nothing restarts until they are done or you say so.`}
                                    onClick={startHeldRestart}
                                >
                                    Install it
                                </button>
                            ) : view.committed ? (
                                // Already under way. The header narrates it and
                                // the notes are here to read; a second button
                                // would only be a way to fire the apply twice.
                                <span className="um-progress" role="status" aria-live="polite">
                                    Upgrading…
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    className="um-go"
                                    title={
                                        status?.currentVersion
                                            ? `Install this upgrade. You are running v${status.currentVersion}.`
                                            : 'Install this upgrade.'
                                    }
                                    onClick={commitUpgrade}
                                >
                                    Upgrade{plan.version ? ` to v${plan.version}` : ''}
                                </button>
                            )}
                        </>
                    )}
                </footer>
            </div>
        </div>,
        overlayRoot,
    );
}

function UpdatePopover({
    version,
    changelog,
    ready,
    willRestartPtyHost,
    hostDriftNote,
    heldChats = 0,
    heldTerminals = 0,
}: {
    version: string;
    changelog: Changelog | null;
    ready: boolean;
    willRestartPtyHost: boolean;
    hostDriftNote?: string;
    heldChats?: number;
    heldTerminals?: number;
}) {
    const held = heldTerminals > 0;
    return (
        <div className="update-popover" role="tooltip">
            <div className="up-head">
                <strong>Genie v{version}</strong>
                <span>
                    {held
                        ? 'downloaded — waiting for you'
                        : ready
                            ? 'downloaded — restart to install'
                            : 'available'}
                </span>
            </div>
            {held ? (
                // The build is downloaded but HELD — a restart would close live
                // agent chats, so it won't apply on its own.
                <div className="up-warn" role="alert">
                    This update is downloaded and waiting. Installing it restarts
                    Genie and closes{' '}
                    {heldChats > 0
                        ? `${heldChats} active agent chat${heldChats === 1 ? '' : 's'}`
                        : `${heldTerminals} terminal${heldTerminals === 1 ? '' : 's'}`}
                    . It won't restart on its own — click{' '}
                    <strong>Drain &amp; update</strong> and Genie asks each agent to
                    stop and write a handoff first, showing you who it is waiting
                    on. Everything it stops comes back afterwards.
                </div>
            ) : willRestartPtyHost ? (
                <div className="up-warn" role="alert">
                    Applying this update restarts your background terminals.
                    Running sessions will be restored from a snapshot (command
                    history is kept; live processes stop). Save or close anything
                    important first.
                </div>
            ) : hostDriftNote ? (
                /* The opposite case, and the one that used to say nothing at all.
                   This host does NOT restart on update — which is why the
                   terminals survive — so it keeps running older code until
                   somebody restarts it. Saying nothing here reads as "nothing to
                   know", and a host-level fix in this update has not landed. */
                <div className="up-warn" role="alert">
                    {hostDriftNote}
                </div>
            ) : null}
            {!changelog ? (
                <div className="up-muted">Loading changes…</div>
            ) : changelog.groups.length === 0 ? (
                <div className="up-muted">
                    {changelog.partial
                        ? "Couldn't load release notes (offline?). The update is still safe to install."
                        : 'No notable changes listed.'}
                </div>
            ) : (
                <div className="up-groups">
                    {changelog.groups.map((g) => (
                        <div key={g.version} className="up-group">
                            <div className="up-ver">v{g.version}</div>
                            <ul>
                                {g.changes.map((c, i) => (
                                    <li key={i}>{c}</li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * The window's top-LEFT corner: the macOS traffic-light pad plus the Genie
 * wordmark.
 *
 * In the master layout the rail + sidebar run header-to-footer, so the LEFT
 * column owns that corner and renders this at the top of its drag strip. The
 * signed-out screen has no left column, so its TitleBar spans the full width
 * and renders the corner inline instead (`cornerInRail` omitted). Either way
 * exactly ONE of them paints it, and it always sits over the real traffic
 * lights on macOS.
 */
function isMacPlatform(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        /Mac/i.test(navigator.platform ?? navigator.userAgent ?? '')
    );
}

function AppCorner({
    tynnHealth,
    tynnChecking = false,
    onRecheckTynn,
}: {
    /** The active workspace's last Tynn MCP probe (see TynnHealthIndicator). */
    tynnHealth?: TynnHealth | null;
    tynnChecking?: boolean;
    /** Omitted on the signed-out screen, where there is no workspace to probe —
     *  the logo then renders bare, with no health affordance to mislead. */
    onRecheckTynn?: () => void;
}) {
    const isMac = isMacPlatform();
    {
        /* The PNG ships in resources/logo.png; Next copies it into
           renderer/public at build time. Use the relative path so it works
           under file:// (packaged) and http://localhost (dev). */
    }
    const logo = <img className="lamp" src="./logo.png" alt="" width={22} height={22} />;
    return (
        <>
            {/* macOS: the REAL traffic lights overlay this corner — reserve
                their space rather than painting fakes. */}
            {isMac && <span className="traffic-pad" />}
            <span className="glogo">
                {onRecheckTynn ? (
                    <TynnHealthIndicator
                        health={tynnHealth ?? null}
                        checking={tynnChecking}
                        onRecheck={onRecheckTynn}
                    >
                        {logo}
                    </TynnHealthIndicator>
                ) : (
                    logo
                )}
                {/* THE ONE UPDATE CONTROL (genie#565). Not a pill beside
                    the wordmark and a banner underneath — the label itself,
                    which reads the running version until there is something to
                    install and then reads "Upgrade to v…". */}
                <UpdatePill />
            </span>
        </>
    );
}

function TitleBar({
    isStage,
    stageWorkspaceName,
    onShowDocs,
    onShowAppStore,
    cornerInRail = false,
    setupIncomplete = false,
    onShowGenieOs,
    tynnAccount = null,
    onSignInTynn,
}: {
    isStage: boolean;
    stageWorkspaceName?: string;
    /**
     * FOURTEEN PROPS ARE GONE with the icon cluster: `onShowAgentInbox`, `agentInboxLag`,
     * `onShowSharing`, `questionCount`, `onShowLists`, `listsUserCount`, `onShowKnowledge`,
     * `onShowFlows`, `flowsBusy`, `onShowIssueWatch`, `issueWatchUnread`, `issueWatchUnknown`,
     * `githubNeedsResolve`, `onShowGithubCaps`, `genieOsActive`, and the Genie OS open flag.
     *
     * Every one of them existed to render or badge an icon. The features are reached through ⌘K
     * (`FEATURE_SURFACES`, with a CI guard), and the four that were also live SIGNALS —
     * a running Flow, agent mail nobody collected, GitHub blocking features, the OS agent
     * working — are on the Deck now (`stationSignals`). Owner: *"move the signals to the Deck,
     * then delete the icons."*
     *
     * The three that remain are the ones this bar still does something with.
     */
    /** A system-MENU item, not an icon. */
    onShowDocs?: () => void;
    /** The App Tray's "open the store" — the tray lists installed GApps and stays. */
    onShowAppStore?: () => void;
    /** Shows "Continue workstation setup" in the menu while first-run is unfinished. */
    setupIncomplete?: boolean;
    onShowGenieOs?: () => void;
    /** The signed-in Tynn account's name, or null. Named in the menu, because a workstation can be
     *  signed into the WRONG account and nothing else says so. */
    tynnAccount?: string | null;
    onSignInTynn?: () => void;
    /**
     * True in the master layout, where this bar is the RIGHT column's header
     * and the LEFT column already owns the window's top-left corner (traffic
     * pad + wordmark). False (default) when the bar spans the full width and
     * must paint the corner itself.
     */
    cornerInRail?: boolean;
}) {
    const isMac = isMacPlatform();
    const [systemMenuOpen, setSystemMenuOpen] = useState(false);
    const [whatsNewOpen, setWhatsNewOpen] = useState(false);
    const [whatsNewVersion, setWhatsNewVersion] = useState('');
    const [whatsNewPrevious, setWhatsNewPrevious] = useState<string | undefined>();
    const [whatsNewChangelog, setWhatsNewChangelog] = useState<Changelog | null>(null);

    const openWhatsNew = useCallback(async (automatic = false) => {
        const askedAt = Date.now();
        const [status, settings] = await Promise.all([
            api().updater.status(),
            api().settings.get(),
        ]);
        const current = status.currentVersion;
        const previous = (settings as Record<string, string | undefined>)
            .whats_new_seen_version;
        // An automatic announcement may only open while the window is still
        // settling. These two round-trips are unbounded, and a full-screen
        // backdrop that arrives afterwards lands on top of whatever the user is
        // doing and eats the click they were making. Past the budget we skip it
        // for this session -- the header menu still opens it on demand.
        if (
            automatic &&
            !autoOpenWhatsNew({ previous, current, elapsedMs: Date.now() - askedAt })
        )
            return;
        setWhatsNewVersion(current);
        setWhatsNewPrevious(previous);
        setWhatsNewOpen(true);
        setSystemMenuOpen(false);
        void api().settings.set({ whats_new_seen_version: current }).catch(() => {});
        void api().updater
            .changelog(current, previous)
            .then(setWhatsNewChangelog)
            .catch(() => setWhatsNewChangelog(null));
    }, []);

    useEffect(() => {
        void openWhatsNew(true).catch(() => {});
    }, [openWhatsNew]);

    return (
        <>
        <div className="titlebar">
            {/* The native title bar is hidden (titleBarStyle: 'hidden') — this
                row IS the window chrome: it drags the window and pads right for
                the native min/max/close overlay. */}
            {!cornerInRail && <AppCorner />}
            {/* macOS + left column: the real traffic lights are ~78px wide but
                a COLLAPSED rail is only 56px, so they spill past the column and
                onto this bar. A drag region over them swallows their clicks
                (see .traffic-pad), so pad the spill no-drag here too — the
                column's own pad covers the rest. */}
            {cornerInRail && isMac && <span className="traffic-pad" />}
            <RemoteIndicator />
            <HostSessionOverlay />
            {/* No internal view codenames in the UI — a Stage window shows its
                pinned workspace name, the master window shows nothing extra. */}
            {isStage && stageWorkspaceName && (
                <span className="ttl">{stageWorkspaceName}</span>
            )}
            <span className="spacer" />
            {/* App Tray — left of the Genie icons, growing LEFTWARD into the
                spacer, so installing an app never shifts the icons the user aims
                at. Its own layout is row-reverse; see AppTray. */}
            {!isStage && <AppTray onOpenStore={() => onShowAppStore?.()} />}
            {/* THE ICON CLUSTER IS GONE — ten of them (Genie OS, Sites, Hosts, the GitHub
                warning, Knowledge, Flows, AgentInbox, Sharing, Lists, IssueWatch).

                P7: "8 icons → 0 icons, 0 features lost". The features are reached through ⌘K,
                built from `FEATURE_SURFACES` with a CI guard that refuses to let one become
                unreachable — so that half was already true and is checked.

                The half that was NOT true is that several icons also carried a live SIGNAL:
                Flows animated while one ran, AgentInbox badged mail agents had not collected,
                the GitHub glyph warned that permissions were switching features off, Genie OS
                pulsed while the operator was producing output, IssueWatch could say "cannot
                tell". A palette row says none of that. Owner decision, asked directly: *"move
                the signals to the Deck, then delete the icons"* — so they are on the Deck
                (`stationSignals`, silent unless something is true, each still a door through
                the same `activateFeature` the palette uses), and only then did these come out.

                The APP TRAY above stays: it lists the GApps this workstation has installed,
                which is content rather than a feature door. The menu below stays for the same
                reason it always did — Settings, Docs and What's New live in it. */}
            <div className="system-menu-wrap">
                <button
                    type="button"
                    className="gicon"
                    title="Genie menu"
                    aria-label="Genie menu"
                    aria-expanded={systemMenuOpen}
                    onClick={() => setSystemMenuOpen((open) => !open)}
                >
                    <IconMenu />
                </button>
                {systemMenuOpen && (
                    <div className="system-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => {
                            setSystemMenuOpen(false);
                            void api().app.showSettings(isRemoteWindow()).catch(() => {});
                        }}>Settings</button>
                        <button type="button" role="menuitem" onClick={() => {
                            setSystemMenuOpen(false);
                            onShowDocs?.();
                        }}>Help &amp; documentation</button>
                        <button type="button" role="menuitem" onClick={() => void openWhatsNew()}>
                            What&apos;s new
                        </button>
                        {/* THE ACCOUNT. Tynn is optional (owner, 2026-10-08), so this is the one
                            place a person goes to connect it rather than a wall in front of the
                            app. It names the account when there is one, because a workstation can
                            be signed into the wrong one and that is otherwise invisible. */}
                        {tynnAccount ? (
                            <button type="button" role="menuitem" disabled>
                                Tynn: {tynnAccount}
                            </button>
                        ) : (
                            <button type="button" role="menuitem" onClick={() => {
                                setSystemMenuOpen(false);
                                onSignInTynn?.();
                            }}>Sign in to Tynn…</button>
                        )}
                        {/* Workstation setup lives in the MENU, not as a chip
                            floating over the header. It only appears while setup
                            is unfinished, so it disappears once it is done
                            rather than becoming permanent furniture. */}
                        {setupIncomplete && onShowGenieOs && (
                            <button type="button" role="menuitem" onClick={() => {
                                setSystemMenuOpen(false);
                                onShowGenieOs();
                            }}>Continue workstation setup</button>
                        )}
                    </div>
                )}
            </div>
        </div>
        {whatsNewOpen && (
            <WhatsNewModal
                version={whatsNewVersion}
                previousVersion={whatsNewPrevious}
                changelog={whatsNewChangelog}
                onClose={() => setWhatsNewOpen(false)}
            />
        )}
        </>
    );
}

function WhatsNewModal({
    version,
    previousVersion,
    changelog,
    onClose,
}: {
    version: string;
    previousVersion?: string;
    changelog: Changelog | null;
    onClose: () => void;
}) {
    return (
        <div className="whats-new-backdrop" role="presentation" onMouseDown={onClose}>
            <section
                className="whats-new-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="whats-new-title"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header>
                    <div>
                        <span className="whats-new-kicker">Genie updated</span>
                        <h2 id="whats-new-title">What&apos;s new in v{version}</h2>
                    </div>
                    <button type="button" className="gicon" aria-label="Close" onClick={onClose}>
                        <IconX size={18} />
                    </button>
                </header>
                <div className="whats-new-body">
                    {!changelog ? (
                        <p className="up-muted">Loading release notes…</p>
                    ) : changelog.groups.length > 0 ? (
                        changelog.groups.map((group) => (
                            <section key={group.version}>
                                <h3>v{group.version}</h3>
                                <ul>{group.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
                            </section>
                        ))
                    ) : (
                        <p className="up-muted">
                            {previousVersion
                                ? 'No user-facing release notes were published for this update.'
                                : 'This is the first version tracked by What’s new. Future upgrades will show their release notes here.'}
                        </p>
                    )}
                </div>
                <footer>
                    <button type="button" className="btn primary" onClick={onClose}>Got it</button>
                </footer>
            </section>
        </div>
    );
}

/**
 * Title-bar remote-session indicator. When this Genie is driving a HOST over
 * Tailscale, shows a loud red "● REMOTE — <host>" badge + a one-click disconnect,
 * so it's always obvious you're controlling another machine. Nothing locally.
 */
function RemoteIndicator() {
    const [status, setStatus] = useState<RemoteStatus | null>(null);
    const isHostWindow =
        typeof window !== 'undefined' && /[?&]host=/.test(window.location.search);
    const wasConnectedRef = useRef(false);
    useEffect(() => {
        api().remote.status().then(setStatus).catch(() => {});
        return api().remote.onStatus(setStatus);
    }, []);
    useEffect(() => {
        if (status?.connected) wasConnectedRef.current = true;
        // A HOST window whose connection has dropped (the user disconnected, or the
        // host token expired) is a dead remote Floor — close it rather than show a
        // broken view. Guarded by wasConnected so a boot-time race can't false-close.
        if (isHostWindow && wasConnectedRef.current && status && !status.connected) {
            window.close();
        }
    }, [status, isHostWindow]);
    if (!status?.connected || !status.host) return null;
    const host = status.host;
    return (
        <span
            title={`Controlling ${host.hostname} (${host.ip}) over Tailscale`}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#b91c1c',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.03em',
                padding: '2px 6px 2px 9px',
                borderRadius: 999,
                marginLeft: 10,
            }}
        >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: '#fff' }} />
            REMOTE — {host.hostname}
            <button
                type="button"
                className="gicon"
                title="Disconnect — back to your local desktop"
                aria-label="Disconnect remote session"
                onClick={() => void api().remote.disconnect().catch(() => {})}
                style={{ color: '#fff', width: 18, height: 18, fontSize: 13, lineHeight: 1 }}
            >
                ×
            </button>
        </span>
    );
}

function SitesPanel({ onClose }: { onClose: () => void }) {
    const [data, setData] = useState<GenSitesAll | null>(null);

    useEffect(() => {
        let alive = true;
        void api()
            .sites.all()
            .then((d) => alive && setData(d))
            .catch(() => alive && setData({ local: [], hosts: [] }));
        return () => {
            alive = false;
        };
    }, []);

    const openSite = (genName: string) => {
        void api().sites.open(genName).catch(() => {});
        onClose();
    };

    const empty = data !== null && data.local.length === 0;

    const rowStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: 7,
        padding: '6px 8px',
        cursor: 'pointer',
        color: 'var(--fg-2)',
    };

    const Row = ({
        keyId,
        name,
        sub,
        onClick,
        title,
    }: {
        keyId: string;
        name: string;
        sub: string;
        onClick: () => void;
        title: string;
    }) => (
        <button
            key={keyId}
            type="button"
            style={rowStyle}
            title={title}
            onClick={onClick}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
            <span style={{ fontWeight: 600 }}>{name}</span>
            <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{sub}</span>
        </button>
    );

    return (
        <div
            role="menu"
            aria-label=".gen sites"
            style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                zIndex: 61,
                width: 300,
                maxHeight: 420,
                overflowY: 'auto',
                background: 'var(--bg-1)',
                border: '1px solid var(--border-1)',
                borderRadius: 10,
                boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                padding: 8,
                fontSize: 12,
                color: 'var(--fg-2)',
            }}
        >
            <div style={{ padding: '4px 6px 2px' }}>
                <strong style={{ fontSize: 11, letterSpacing: '0.04em', color: 'var(--fg-3)' }}>
                    DEV SITES
                </strong>
            </div>
            {data === null ? (
                <div style={{ padding: '10px 6px', color: 'var(--fg-3)' }}>Finding .gen sites…</div>
            ) : empty ? (
                <div style={{ padding: '10px 6px', color: 'var(--fg-3)', lineHeight: 1.5 }}>
                    No enabled <code>.gen</code> sites. Host one from a workspace&apos;s
                    <em> Hosting</em> panel.
                </div>
            ) : (
                <>
                    {data.local.map((s) => (
                        <Row
                            key={`site:${s.genName}`}
                            keyId={`site:${s.genName}`}
                            name={s.genName}
                            sub={s.hostname}
                            title={`Open ${s.genName} in the Genie browser`}
                            onClick={() => openSite(s.genName)}
                        />
                    ))}
                </>
            )}
        </div>
    );
}

interface HostRow {
    ip: string;
    port: number;
    hostname: string;
    name?: string;
    hostId?: string;
    dnsName?: string;
    connKey: string;
    /** Known (persisted, can Forget) vs only just discovered on the tailnet. */
    known: boolean;
    connected: boolean;
    activeTerminals: boolean;
    online: boolean;
}

function HostsPanel({ onClose }: { onClose: () => void }) {
    const [rows, setRows] = useState<HostRow[]>([]);
    const [workstations, setWorkstations] = useState<ConnectableWorkstation[]>([]);
    const [loading, setLoading] = useState(true);
    const [pinFor, setPinFor] = useState<string | null>(null);
    const [pin, setPin] = useState('');
    /** The sentence explaining WHY the PIN field is showing. */
    const [pinWhy, setPinWhy] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            const [known, discovered, ws, settings] = await Promise.all([
                api().remote.known().catch(() => [] as KnownHost[]),
                api().workmode.discoverHosts().catch(() => [] as GenieHost[]),
                api().workstations.connectable().catch(() => [] as ConnectableWorkstation[]),
                api().settings.get().catch(() => ({})),
            ]);
            const byKey = new Map<string, HostRow>();
            for (const k of known) {
                byKey.set(k.connKey, {
                    ip: k.ip,
                    port: k.port,
                    hostname: k.hostname,
                    name: k.name,
                    hostId: k.hostId,
                    dnsName: k.dnsName,
                    connKey: k.connKey,
                    known: true,
                    connected: k.connected,
                    activeTerminals: k.activeTerminals,
                    online: false,
                });
            }
            for (const d of discovered) {
                // Merge on the stable connKey (host:<hostId> when identified, else
                // ip:port) so a discovered host already remembered — even at a new
                // IP — updates its row instead of showing as a duplicate.
                const existing = byKey.get(d.connKey);
                if (existing) {
                    existing.online = true;
                    // Refresh the dial address from the live beacon.
                    existing.ip = d.ip;
                    existing.port = d.port;
                    if (d.hostId) existing.hostId = d.hostId;
                    if (d.dnsName) existing.dnsName = d.dnsName;
                } else
                    byKey.set(d.connKey, {
                        ip: d.ip,
                        port: d.port,
                        hostname: d.hostname,
                        hostId: d.hostId,
                        dnsName: d.dnsName,
                        connKey: d.connKey,
                        known: false,
                        connected: false,
                        activeTerminals: false,
                        online: true,
                    });
            }
            const nextRows = [...byKey.values()];
            setRows(nextRows);
            setWorkstations(
                unifiedCloudWorkstations(
                    ws,
                    nextRows,
                    (settings as { workstation_id?: string }).workstation_id,
                ),
            );
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openHost = async (row: HostRow, withPin?: string) => {
        setErr(null);
        setBusy(row.connKey);
        try {
            const res = await api().remote.open(
                {
                    ip: row.ip,
                    port: row.port,
                    hostname: row.hostname,
                    hostId: row.hostId,
                    dnsName: row.dnsName,
                },
                withPin,
            );
            if (res.ok) {
                setPinFor(null);
                setPin('');
                setPinWhy(null);
                onClose();
            } else if (res.needsPin) {
                setPinFor(row.connKey);
                // SAY why the PIN is back. Showing a bare PIN box for a rejected
                // or unreadable token is what made genie#578 unexplainable: the
                // user sees a first-time pair and has no way to know otherwise.
                setPinWhy(
                    withPin
                        ? 'That PIN was rejected — check the host and try again.'
                        : pairingPrompt(res.pinReason, row.name || row.hostname),
                );
            } else {
                setErr(res.error ?? 'Could not connect.');
            }
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    const openWorkstation = async (ws: ConnectableWorkstation) => {
        setErr(null);
        setBusy(`ws:${ws.id}`);
        try {
            const res = await api().workstations.open(ws.id, ws.name);
            if (res.ok) onClose();
            else setErr(res.error ?? 'Could not connect to the workstation.');
        } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    const forget = async (row: HostRow) => {
        await api().remote.forget(row.connKey).catch(() => {});
        void load();
    };

    return (
        <>
            {/* click-away */}
            <div
                onClick={onClose}
                style={{ position: 'fixed', inset: 0, zIndex: 60 }}
                aria-hidden
            />
            <div
                role="menu"
                style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    zIndex: 61,
                    width: 320,
                    maxHeight: 420,
                    overflowY: 'auto',
                    background: 'var(--bg-1)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 10,
                    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                    padding: 8,
                    fontSize: 12,
                    color: 'var(--fg-2)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 8px' }}>
                    <strong style={{ fontSize: 11, letterSpacing: '0.04em', color: 'var(--fg-3)' }}>HOSTS</strong>
                    <button type="button" className="gicon" title="Rescan the tailnet" onClick={() => void load()} aria-label="Refresh hosts" style={{ width: 20, height: 20 }}>⟳</button>
                </div>
                {loading && <div style={{ padding: '8px 6px', color: 'var(--fg-3)' }}>Scanning…</div>}
                {!loading && rows.length === 0 && workstations.length === 0 && (
                    <div style={{ padding: '8px 6px', color: 'var(--fg-3)', lineHeight: 1.4 }}>
                        No hosts or workstations found. Enable Work Mode on another Genie on your
                        tailnet, or get access to a Virtual Workstation in Tynn, then rescan.
                    </div>
                )}
                {err && <div style={{ padding: '6px', color: '#f87171' }}>{err}</div>}
                {rows.map((row) => (
                    <div key={row.connKey} style={{ borderRadius: 8, padding: '7px 8px', marginBottom: 2, background: 'var(--card)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 999, flex: '0 0 auto', background: row.connected ? '#22c55e' : row.online ? '#eab308' : 'var(--fg-4)' }} title={row.connected ? 'Connected' : row.online ? 'Online' : 'Offline / not on the tailnet now'} />
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                <span style={{ fontWeight: 600 }}>{row.name || row.hostname}</span>
                                <span style={{ color: 'var(--fg-3)', marginLeft: 6 }}>{row.ip}:{row.port}</span>
                            </span>
                            <button
                                type="button"
                                className="gbtn gbtn-sm"
                                disabled={busy === row.connKey}
                                onClick={() => void openHost(row)}
                                style={{ flex: '0 0 auto' }}
                            >
                                {row.connected ? 'Focus' : busy === row.connKey ? '…' : 'Open'}
                            </button>
                            {row.known && (
                                <button type="button" className="gicon" title="Forget this host (drops the saved pairing)" aria-label="Forget host" onClick={() => void forget(row)} style={{ width: 20, height: 20, flex: '0 0 auto' }}>×</button>
                            )}
                        </div>
                        {pinFor === row.connKey && (
                            <>
                            {pinWhy && (
                                <div style={{ marginTop: 6, color: 'var(--fg-3)', lineHeight: 1.4 }}>{pinWhy}</div>
                            )}
                            <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                                <input
                                    autoFocus
                                    value={pin}
                                    onChange={(e) => setPin(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void openHost(row, pin); }}
                                    placeholder="Pairing PIN from the host"
                                    inputMode="numeric"
                                    style={{ flex: 1, background: 'var(--bg-0)', border: '1px solid var(--border-1)', borderRadius: 6, color: 'var(--fg-1)', padding: '5px 8px', fontSize: 12 }}
                                />
                                <button type="button" className="gbtn gbtn-sm" disabled={!pin.trim() || busy === row.connKey} onClick={() => void openHost(row, pin)}>Pair</button>
                            </div>
                            </>
                        )}
                    </div>
                ))}
                {workstations.map((ws) => {
                            // Gate Connect on the GCC/Tynn readiness `status`, not just
                            // Tynn's `connectable` flag — a down host must never offer a
                            // Connect that ends in "relay handshake timed out".
                            const st = workstationConnectState(ws);
                            const liveRow = rows.find((row) =>
                                row.connected &&
                                [row.name, row.hostname]
                                    .filter(Boolean)
                                    .some((name) => name!.trim().toLocaleLowerCase() === ws.name.trim().toLocaleLowerCase()),
                            );
                            const visual = cloudHostVisual(ws, !!liveRow, liveRow?.activeTerminals ?? false);
                            return (
                            <div key={`ws:${ws.id}`} style={{ borderRadius: 8, padding: '7px 8px', marginBottom: 2, background: 'var(--card)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span
                                        title={visual.title}
                                        aria-label={`Cloud host — ${visual.title}`}
                                        className={`hosts-cloud-icon is-${visual.color}${visual.pulse ? ' is-pulsing' : ''}`}
                                    >☁</span>
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        <span style={{ fontWeight: 600 }}>{ws.name}</span>
                                        {ws.capability && <span style={{ color: 'var(--fg-3)', marginLeft: 6 }}>{ws.capability}</span>}
                                        {ws.source && ws.source !== 'owner' && <span style={{ color: 'var(--fg-4)', marginLeft: 6 }}>via {ws.source}</span>}
                                    </span>
                                    {st.showRetry && (
                                        <button type="button" className="gicon" title="Rescan for this workstation" aria-label="Retry workstation" onClick={() => void load()} style={{ width: 20, height: 20, flex: '0 0 auto' }}>⟳</button>
                                    )}
                                    <button
                                        type="button"
                                        className="gbtn gbtn-sm"
                                        disabled={!st.canConnect || busy === `ws:${ws.id}`}
                                        onClick={() => void openWorkstation(ws)}
                                        title={st.title}
                                        style={{ flex: '0 0 auto' }}
                                    >
                                        {busy === `ws:${ws.id}` ? '…' : st.label}
                                    </button>
                                </div>
                            </div>
                            );
                        })}
            </div>
        </>
    );
}

/**
 * Remote-side VIEW-ONLY banner. Shown in a host window when SOMEONE ELSE holds
 * that host's baton — the owner at the desktop, or another member driving the same
 * workstation, which is why it names them when the host says who. It's the mirror
 * of the host's HostSessionOverlay: it makes it obvious WHY keystrokes do nothing
 * here (the remote-bridge drops them), so control never silently diverges from
 * what's shown. Clears the instant control comes back (the `control:changed` push).
 */
function RemoteViewOnlyBanner({
    holder,
}: {
    holder?: { emoji?: string | null; name?: string | null } | null;
}) {
    return (
        <div
            style={{
                position: 'fixed',
                top: 40,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 13px',
                borderRadius: 10,
                background: 'rgba(180,83,9,0.96)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
                pointerEvents: 'none',
            }}
        >
            <span
                style={{ width: 8, height: 8, borderRadius: 999, background: '#fbbf24' }}
            />
            <span>
                {holder?.name
                    ? `View only — ${holder.emoji ?? ''} ${holder.name} has control`.replace(
                          /\s+/g,
                          ' ',
                      )
                    : 'View only — someone else has control'}
            </span>
        </div>
    );
}

/**
 * Host-side remote-session overlay — WHO is on this machine and who is driving.
 *
 * Several people can be connected to one workstation, so the banner lists every
 * connected user with the emoji their actions are signed with, marks the ONE
 * holding the baton, and lets the host hand it over (click a user) or TAKE it
 * back (the desktop is an owner, so it always can — the session stays CONNECTED,
 * not killed). "End session" still drops the pairing outright.
 */
function HostSessionOverlay() {

    const [peers, setPeers] = useState<MobilePeer[]>([]);
    const [participants, setParticipants] = useState<BatonParticipant[]>([]);
    const [holder, setHolder] = useState<string | null>(null);
    const [locked, setLocked] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        const poll = () =>
            api()
                .mobile.status()
                .then((s) => {
                    if (!alive) return;
                    setPeers(s.peers ?? []);
                    setParticipants(s.participants ?? []);
                    setHolder(s.control?.holder ?? null);
                    setLocked(s.locked);
                })
                .catch(() => {});
        void poll();
        const t = setInterval(() => void poll(), 3000);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, []);

    if (peers.length === 0) return null;

    const act = async (
        fn: () => Promise<{
            peers: MobilePeer[];
            participants?: BatonParticipant[];
            control?: { holder: string | null };
            locked: boolean;
        }>,
    ) => {
        setBusy(true);
        try {
            const s = await fn();
            setPeers(s.peers ?? []);
            setParticipants(s.participants ?? []);
            setHolder(s.control?.holder ?? null);
            setLocked(s.locked);
        } finally {
            setBusy(false);
        }
    };

    // The people on the other end, with what each guest reaches (genie#681).
    const users = hostSessionRoster(participants, peers, locked);
    const driver = participants.find((p) => p.id === holder) ?? null;
    const status = locked
        ? 'Paused — you have control'
        : driver
          ? `${driver.emoji} ${driver.name} has control`
          : 'Connected — nobody is driving yet';
    const btn = {
        background: 'rgba(255,255,255,0.18)',
        color: '#fff',
        border: '1px solid rgba(255,255,255,0.35)',
        borderRadius: 6,
        padding: '3px 9px',
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
    } as const;

    return (
        <div
            style={{
                position: 'fixed',
                top: 40,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 13px',
                borderRadius: 10,
                background: locked ? 'rgba(180,83,9,0.96)' : 'rgba(2,132,199,0.96)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
            }}
        >
            <span
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: locked ? '#fbbf24' : '#7dd3fc',
                }}
            />
            <span>{status}</span>
            {/* Everyone connected, with the emoji their actions are signed with.
                While the desktop holds the baton, clicking a user hands it to them. */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {users.map((u) => (
                    <span key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button
                            type="button"
                            disabled={busy || !u.canReceiveControl}
                            onClick={() => void act(() => api().mobile.giveControl(u.id))}
                            title={
                                u.holdsControl
                                    ? `${u.name} is driving — every action is signed ${u.emoji}`
                                    : u.readonly
                                      ? `${u.name} has read-only access and cannot drive`
                                      : u.canReceiveControl
                                        ? `Hand control to ${u.name}`
                                        : `${u.name} is connected (signs actions ${u.emoji})`
                            }
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                background: u.holdsControl
                                    ? 'rgba(255,255,255,0.3)'
                                    : 'rgba(255,255,255,0.1)',
                                color: '#fff',
                                border: u.holdsControl
                                    ? '1px solid rgba(255,255,255,0.75)'
                                    : '1px solid rgba(255,255,255,0.25)',
                                borderRadius: 999,
                                padding: '2px 8px',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: u.canReceiveControl ? 'pointer' : 'default',
                            }}
                        >
                            <span aria-hidden>{u.emoji}</span>
                            <span>{u.name}</span>
                            {u.isOwner && <span title="Workstation owner">★</span>}
                            {u.accessLabel && (
                                <span style={{ fontWeight: 500, opacity: 0.85 }}>{u.accessLabel}</span>
                            )}
                        </button>
                        {u.canDisconnect && (
                            <button
                                type="button"
                                disabled={busy}
                                aria-label={`Disconnect ${u.name}`}
                                title={`Disconnect ${u.name}. This ends their live session; their access stays until it is revoked in Tynn.`}
                                onClick={() => void act(() => api().mobile.disconnectGuest(u.id))}
                                style={{ ...btn, padding: '1px 6px' }}
                            >
                                Disconnect
                            </button>
                        )}
                    </span>
                ))}
            </span>
            <button
                type="button"
                disabled={busy}
                style={btn}
                title={
                    locked
                        ? 'Release control — whoever drives next picks it up'
                        : 'Take the baton off whoever is driving, without disconnecting them'
                }
                onClick={() => void act(() => api().mobile.lock(!locked))}
            >
                {locked ? 'Release control' : 'Take control'}
            </button>
            <button
                type="button"
                disabled={busy}
                style={btn}
                title="Disconnect everyone, including your own paired devices"
                onClick={() => void act(() => api().mobile.revokeSessions())}
            >
                End session
            </button>
        </div>
    );
}

interface ToolbarProps {
    activeWorkspace?: WorkspaceRow;
    /** All workspaces — the split button's `specific`-scope multiselect + slug preview. */
    workspaces: WorkspaceRow[];
    layoutMode: LayoutMode;
    onLayoutMode: (m: LayoutMode) => void;
    onAddView: (type: ViewType) => void;
    /** Launchable plugin panels (Add-view menu) + the open trigger. */
    pluginPanels: PluginPanelView[];
    onAddPluginPanel: (panel: PluginPanelView) => void;
    addDisabled?: boolean;
    addDisabledReason?: string;
    /** Open the "Run a recipe" launcher for the active workspace. */
    onRunRecipe: () => void;
    /** Split Add-Terminal button: last-used type + its persistence + agent create. */
    lastTerminalType: TerminalTypeId;
    onLastTerminalType: (id: TerminalTypeId) => void;
    onAgentCreated: (spec: TerminalSpec) => void;
    agentCustomCommand?: string;
}

function Toolbar({
    activeWorkspace,
    workspaces,
    layoutMode,
    onLayoutMode,
    onAddView,
    pluginPanels,
    onAddPluginPanel,
    addDisabled,
    addDisabledReason,
    onRunRecipe,
    lastTerminalType,
    onLastTerminalType,
    onAgentCreated,
    agentCustomCommand,
}: ToolbarProps) {
    return (
        <div className="gtoolbar">
            <span className="active-ws">
                {activeWorkspace ? (
                    <>
                        <span className="active-ws-dot" />
                        <span className="active-ws-name">
                            {activeWorkspace.project_name}
                        </span>
                    </>
                ) : (
                    <span className="active-ws-name muted">No active workspace</span>
                )}
            </span>
            <span className="spacer" />
            <div className="seg">
                <button
                    type="button"
                    className={layoutMode === 'auto' ? 'on' : ''}
                    onClick={() => onLayoutMode('auto')}
                    title="Auto layout"
                >
                    <IconLayoutGrid />
                </button>
                <button
                    type="button"
                    className={layoutMode === 'focus-stack' ? 'on' : ''}
                    onClick={() => onLayoutMode('focus-stack')}
                    title="Focus + stack"
                >
                    <IconPanelLeft />
                </button>
                <button
                    type="button"
                    className={layoutMode === '2x2' ? 'on' : ''}
                    onClick={() => onLayoutMode('2x2')}
                    title="2×2 grid"
                >
                    <IconLayoutGrid />
                </button>
                <button
                    type="button"
                    className={layoutMode === 'columns' ? 'on' : ''}
                    onClick={() => onLayoutMode('columns')}
                    title="3 columns"
                >
                    <IconColumns />
                </button>
            </div>
            <button
                type="button"
                className="gicon"
                title={
                    canRunRecipe(activeWorkspace)
                        ? 'Run a recipe'
                        : 'Run a recipe (activate a workspace first)'
                }
                aria-label="Run a recipe"
                disabled={!canRunRecipe(activeWorkspace)}
                onClick={onRunRecipe}
            >
                <IconWand />
            </button>
            <button type="button" className="gicon" title="Maximize window">
                <IconMaximize />
            </button>
            <TerminalTypeSplitButton
                disabled={!activeWorkspace || !!addDisabled}
                disabledReason={!activeWorkspace ? undefined : addDisabledReason}
                workspaceId={activeWorkspace?.id ?? null}
                workspaces={workspaces}
                lastType={lastTerminalType}
                onLastTypeChange={onLastTerminalType}
                onAddView={onAddView}
                pluginPanels={pluginPanels}
                onAddPluginPanel={onAddPluginPanel}
                onAgentCreated={onAgentCreated}
                customCommand={agentCustomCommand}
                includeFiles
                panelLauncher
                iconOnly
            />
        </div>
    );
}

