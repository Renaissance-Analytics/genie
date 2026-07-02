import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Chooser from '../components/Master/Chooser';
import ProjectContextMenu from '../components/Master/ProjectContextMenu';
import WorkspaceSettingsModal from '../components/Master/WorkspaceSettingsModal';
import SpecContextMenu from '../components/Master/SpecContextMenu';
import { PromptHost, showPrompt } from '../components/Master/Prompt';
import QuitTerminalsModal, {
    type QuitTerminal,
} from '../components/Master/QuitTerminalsModal';
import TerminalGrid, {
    type LayoutMode,
} from '../components/Master/TerminalGrid';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import BootScreen from '../components/Master/BootScreen';
import HostUpgradeOverlay from '../components/Master/HostUpgradeOverlay';
import HostBuildNudge from '../components/Master/HostBuildNudge';
import DocsFlyout from '../components/Master/DocsFlyout';
import IssueWatchFlyout from '../components/Master/IssueWatchFlyout';
import TaskManagerFlyout from '../components/Master/TaskManagerFlyout';
import GithubCapabilitiesFlyout from '../components/Master/GithubCapabilitiesFlyout';
import { useGithubCapabilities } from '../lib/githubCapabilities';
import SignInPrompt from '../components/SignInPrompt';
import type { BackendUser, ViewType } from '../lib/genie';
import { resolveShortcut } from '../lib/master-shortcuts';
import { computeLaunchSelection } from '../lib/launch-restore';
import { shouldDriveRestart } from '../lib/updater-flow';
import { pickReusePanel, emitOpenInPanel } from '../lib/editor-open';
import {
    IconBox,
    IconChevronDown,
    IconCode,
    IconColumns,
    IconLayoutGrid,
    IconMaximize,
    IconPanelLeft,
    IconPlus,
    IconHelp,
    IconEye,
    IconCpu,
    IconSettings,
    IconAlert,
    IconX,
} from '../components/Master/icons';
import {
    api,
    hasGenieBridge,
    isSystemWorkspace,
    makeSystemWorkspace,
    SYSTEM_WORKSPACE_ID,
    ulid,
    type Changelog,
    type WatchTypeCounts,
    type TerminalSpec,
    type UpdaterStatus,
    type WorkspaceRow,
    type RemoteStatus,
    type RemoteLinkState,
    type MobilePeer,
    type KnownHost,
    type GenieHost,
    type ConnectableWorkstation,
} from '../lib/genie';

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
    const [hosts, setHosts] = useState<{ tynn: string; aionima: string }>({
        tynn: 'https://tynn.ai',
        aionima: '',
    });
    const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
    const [specs, setSpecs] = useState<TerminalSpec[]>([]);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    // The workspace whose views fill the grid. Persisted as the
    // `active_workspace` setting; seeded on launch from that setting (or the
    // most-recent workspace). Stage windows seed from `?stage=`.
    const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
    // Guards the one-time seed so a later refresh() doesn't reset the user's
    // active workspace back to most-recent.
    const seededActiveRef = useRef(false);
    const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
    // Agent-integration MCP: terminals that called imDone and want attention.
    // Cleared when the terminal gets focus.
    const [attentionIds, setAttentionIds] = useState<Set<string>>(() => new Set());
    const [focusId, setFocusId] = useState<string | null>(null);
    const [maximizedId, setMaximizedId] = useState<string | null>(null);
    const [chooserPinned, setChooserPinned] = useState(true);
    // System Workspace — a synthetic, never-persisted sidebar entry rooted at
    // the user's home dir, hosting system (non-workspace) processes. Hidden by
    // default; the sidebar's chip button toggles `systemRevealed`. `homeDir`
    // comes from main on mount.
    const [homeDir, setHomeDir] = useState<string | null>(null);
    const [systemRevealed, setSystemRevealed] = useState(false);
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
    // Docs flyout (the ? titlebar button toggles this in-window panel rather
    // than opening a separate BrowserWindow).
    const [docsOpen, setDocsOpen] = useState(false);
    // Issue Watch: the flyout (scoped to a chosen workspace) + per-workspace
    // unread counts by type (the sidebar 3-dot pill: Issues · PRs · Dependabot).
    const [issueWatchOpen, setIssueWatchOpen] = useState(false);
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
        setIssueWatchOpen(true);
    }, []);
    // Task Manager: cross-workspace view of every spawned background process.
    const [taskManagerOpen, setTaskManagerOpen] = useState(false);
    // Opening from the tray sends a one-shot event; mirror it into the flyout.
    useEffect(() => {
        return api().on.openTaskManager?.(() => setTaskManagerOpen(true));
    }, []);
    // GitHub capability gate: which GitHub-powered features are unavailable
    // because the App is missing permissions on the user's installation. Drives
    // a persistent header warning + a resolve flyout (also auto-shown once on
    // boot when something's missing).
    const { caps: githubCaps, hasMissing: githubNeedsResolve } =
        useGithubCapabilities();
    const [githubCapsOpen, setGithubCapsOpen] = useState(false);
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
        setGithubCapsOpen(true);
    }, [githubNeedsResolve]);
    // Max panels visible per workspace (Settings → max_views, default 4).
    const [maxViews, setMaxViews] = useState(4);
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

    // Customization: play the notification sound when an agent calls imDone or
    // ForceTheQuestion (gated by Settings → Customization on the main side). The
    // payload carries a `sound` descriptor resolved per-alert: 'synth' keeps the
    // built-in Web Audio chime (distinct per kind), 'asset' plays a bundled wav
    // from ./sounds/<name>.wav (relative to the page, resolves under file://),
    // 'data' plays a custom file the main side read into a data-URL. A legacy
    // payload with no descriptor falls back to synth. All best-effort.
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
                // 'synth' (or a legacy descriptor-less payload): synthesize a
                // distinct per-kind chime via Web Audio so no asset is needed.
                const Ctx =
                    window.AudioContext ||
                    (window as unknown as { webkitAudioContext?: typeof AudioContext })
                        .webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const now = ctx.currentTime;
                const tone = (freq: number, start: number, dur: number, type: OscillatorType = 'sine') => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = type;
                    osc.frequency.value = freq;
                    gain.gain.setValueAtTime(0.0001, now + start);
                    gain.gain.exponentialRampToValueAtTime(0.18, now + start + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
                    osc.connect(gain).connect(ctx.destination);
                    osc.start(now + start);
                    osc.stop(now + start + dur);
                };
                if (payload?.kind === 'force-question') {
                    // Distinct, more urgent motif: a fast triple-knock on a
                    // brighter triangle wave (A5 ×3) so it's unmistakably NOT the
                    // gentle imDone rise — "someone needs you NOW".
                    tone(880, 0, 0.1, 'triangle');
                    tone(880, 0.14, 0.1, 'triangle');
                    tone(1175, 0.28, 0.26, 'triangle'); // D6 lift on the last knock
                    setTimeout(() => void ctx.close().catch(() => {}), 900);
                } else {
                    // imDone: gentle rising two-note chime.
                    tone(660, 0, 0.18); // E5
                    tone(880, 0.16, 0.24); // A5
                    setTimeout(() => void ctx.close().catch(() => {}), 700);
                }
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
    const [quitTerminals, setQuitTerminals] = useState<QuitTerminal[] | null>(
        null,
    );
    useEffect(() => {
        return api().on.confirmQuitTerminals((p) => {
            setQuitTerminals(p.terminals ?? []);
        });
    }, []);
    const decideQuit = useCallback(
        (decision: { confirmed: boolean; keepIds: string[] }) => {
            setQuitTerminals(null);
            api().app.quitDecision(decision);
        },
        [],
    );

    // The synthetic System Workspace row (null until the home dir resolves).
    // Built in-memory — never persisted, never in `workspaces`/the DB.
    const systemWorkspace = useMemo(
        () => (homeDir ? makeSystemWorkspace(homeDir) : null),
        [homeDir],
    );

    // Workspaces shown in the sidebar: the persisted list, with the System
    // Workspace pinned to the TOP when revealed. It's fixed (never draggable /
    // reorderable) so it always sits first and doesn't shuffle the user's order.
    const displayWorkspaces = useMemo(() => {
        if (systemRevealed && systemWorkspace) {
            return [systemWorkspace, ...workspaces];
        }
        return workspaces;
    }, [workspaces, systemRevealed, systemWorkspace]);

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
        // Restore the launch grid ONCE, computed from the FRESHLY-FETCHED arrays
        // (not React state read through an effect closure). The previous seed
        // effect fired on `[workspaces.length]` but read `specs` via closure and
        // latched a one-shot guard; if it ever ran before the target's specs
        // landed in state it seeded an empty selection and never retried, so the
        // grid came up empty across a quit+relaunch. Seeding from `sp`/`ws`
        // directly removes that race — the specs are always in hand here.
        if (!seededActiveRef.current && ws.length > 0) {
            seededActiveRef.current = true;
            const { activeWorkspaceId: target, selectedIds } = computeLaunchSelection({
                specs: sp,
                workspaces: ws,
                savedActiveWorkspace: settings?.active_workspace ?? null,
                stageSeedWorkspace,
                systemWorkspaceId: SYSTEM_WORKSPACE_ID,
            });
            if (target) {
                setActiveWorkspaceId(target);
                // A Stage window's `?stage=` seed may already have populated the
                // selection — don't clobber it.
                setSelected((prev) => (prev.size > 0 ? prev : new Set(selectedIds)));
            }
        }
    }, [stageSeedWorkspace]);

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

    const refreshAuth = useCallback(async () => {
        const [t, a, tHost, aHostInfo] = await Promise.all([
            api().auth.whoami('tynn'),
            api().auth.whoami('aionima'),
            api().tynnHost.get(),
            api().aionima.hostInfo(),
        ]);
        setHosts({ tynn: tHost, aionima: aHostInfo });
        const any = !!(t as BackendUser | null) || !!(a as BackendUser | null);
        setSignedIn(any);
        return any;
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const any = await refreshAuth();
            if (cancelled) return;
            setAuthChecked(true);
            if (any) await refresh();
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

    // Load the max_views setting and keep it fresh — the Settings screen is
    // a separate window, so re-read whenever this window regains focus.
    useEffect(() => {
        const load = () => {
            void api()
                .settings.get()
                .then((s) => {
                    const n = parseInt(String(s.max_views ?? '4'), 10);
                    if (Number.isFinite(n) && n > 0) setMaxViews(n);
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
            specs.filter(
                (s) =>
                    s.type !== 'process' &&
                    specWorkspaceId(s) === activeWorkspaceId &&
                    selected.has(s.id),
            ),
        [specs, selected, activeWorkspaceId],
    );

    // Selected views in OTHER workspaces — rendered mounted-hidden so their
    // PTYs survive a workspace switch (Decision 1: keep-alive).
    const backgroundSpecs = useMemo(
        () =>
            specs.filter(
                (s) =>
                    s.type !== 'process' &&
                    specWorkspaceId(s) !== activeWorkspaceId &&
                    selected.has(s.id),
            ),
        [specs, selected, activeWorkspaceId],
    );

    const toggleSpec = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const addSpec = useCallback(
        async (workspaceId: string, type: ViewType = 'terminal') => {
            const ws = workspacesById.get(workspaceId);
            if (!ws) return;
            // The System Workspace is synthetic: its specs persist UNATTACHED
            // (workspace_id: null — `__system__` has no DB row) and carry a
            // `meta.system` tag so the sidebar groups them under it. Real
            // workspaces persist their own id.
            const system = isSystemWorkspace(ws);
            const persistedWsId = system ? null : workspaceId;
            const existing = specs.filter((s) =>
                system
                    ? s.workspace_id === null && s.meta?.system === true
                    : s.workspace_id === workspaceId,
            );
            const baseLabel = ws.project_name.toLowerCase().replace(/\s+/g, '-');
            // Editor views get an `-editor` label so they read distinctly in
            // the tree alongside terminals.
            const root = type === 'code' ? `${baseLabel}-editor` : baseLabel;
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

    /**
     * Create a Process (background service runner). Headless — it does NOT
     * surface in the main grid; it's managed from the workspace's inline
     * process panel in the nav. Autostart is OFF by default (starts idle);
     * auto-restart-on-crash is on.
     *
     * For a real workspace the `cwd` targets the envelope root or a repo. For
     * the System Workspace it's a SYSTEM PROCESS: not tied to any project, so
     * the cwd is an arbitrary directory the user picked (required) and the spec
     * persists unattached (workspace_id: null + meta.system).
     */
    const addProcess = useCallback(
        async (
            workspaceId: string,
            command: string,
            label?: string,
            cwd?: string,
            shell?: string,
        ) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws || !command.trim()) return;
            const system = isSystemWorkspace(ws);
            // A system process MUST have a picked directory — there's no
            // workspace root to fall back to. Bail rather than silently run in
            // the home dir.
            if (system && !cwd?.trim()) return;
            const cmd = command.trim();
            const fallback = cmd.split(/\s+/).slice(0, 3).join(' ');
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: system ? null : workspaceId,
                label: (label?.trim() || fallback).slice(0, 60),
                // cwd defaults to the envelope root; the Add Process UX can point
                // it at a specific repo (e.g. <root>/repos/tynn). A system
                // process always carries an explicit picked directory.
                cwd: cwd?.trim() || ws.path,
                // shell lets the user pick the interpreter the command runs in —
                // e.g. pwsh, where `php` is on PATH, vs Git Bash where it isn't.
                // Empty → the supervisor falls back to the default shell.
                shell: shell?.trim() || null,
                type: 'process',
                meta: {
                    command: cmd,
                    autostart: false,
                    restart_on_exit: true,
                    ...(system ? { system: true } : {}),
                },
            });
            // Not added to `selected` — processes aren't grid panels.
            setSpecs((prev) => [...prev, created]);
        },
        [workspacesById],
    );

    // Edit an existing Process in place (right-click → Edit). Updates the spec,
    // then restarts it if it's currently running so the new shell/command/cwd
    // take effect immediately (the supervisor reads these at (re)start).
    const editProcess = useCallback(
        async (
            id: string,
            patch: { command: string; label?: string; cwd?: string; shell?: string },
            wasRunning: boolean,
        ) => {
            const spec = specs.find((s) => s.id === id);
            if (!spec) return;
            const updated = await api().terminalSpec.update(id, {
                label: (patch.label?.trim() || spec.label).slice(0, 60),
                cwd: patch.cwd?.trim() || spec.cwd,
                shell: patch.shell?.trim() || null,
                meta: { ...spec.meta, command: patch.command.trim() },
            });
            if (updated) {
                setSpecs((prev) => prev.map((s) => (s.id === id ? updated : s)));
            }
            if (wasRunning) await api().process.restart(id).catch(() => {});
        },
        [specs],
    );

    const closeSelected = useCallback((id: string) => {
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
    }, []);

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
            setActiveIds((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
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
     * Activate a workspace: it becomes the grid's focus. Its views are
     * selected (so they fill the grid) WITHOUT clearing selections in other
     * workspaces — those stay mounted-hidden so their PTYs keep running
     * (Decision 1: keep-alive). The choice is persisted so the next launch
     * reopens here.
     */
    const activateWorkspace = useCallback(
        (workspaceId: string) => {
            setActiveWorkspaceId(workspaceId);
            setSelected((prev) => {
                const next = new Set(prev);
                for (const s of specs) {
                    // Disabled (suspended) terminals stay out of the grid until
                    // explicitly re-enabled — activating a workspace doesn't
                    // resurrect them.
                    if (specWorkspaceId(s) === workspaceId && s.enabled !== false) {
                        next.add(s.id);
                    }
                }
                return next;
            });
            setFocusId(null);
            setMaximizedId(null);
            // Don't persist the synthetic System Workspace as the active one —
            // it isn't a real workspace and shouldn't be reopened on launch.
            if (workspaceId !== SYSTEM_WORKSPACE_ID) {
                void api()
                    .settings.set({ active_workspace: workspaceId })
                    .catch(() => {});
            }
        },
        [specs],
    );

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
        return api().on.editorOpenFile?.(({ requestId, workspaceId, root, relPath, line }) => {
            const system = workspaceId === SYSTEM_WORKSPACE_ID;
            const reuseId = pickReusePanel(
                specsRef.current,
                { workspaceId, root },
                focusIdRef.current,
                selectedRef.current,
                workspacesByIdRef.current,
            );
            if (reuseId) {
                if (system) setSystemRevealed(true);
                activateWorkspaceRef.current(workspaceId);
                setFocusId(reuseId);
                // Forward the target line so the live panel scrolls to + reveals
                // it (re-revealing if the file is already open at another line).
                emitOpenInPanel(reuseId, relPath, line);
                void api().editor.openFileResult(requestId, { reused: true, opened: false });
                return;
            }
            // No open editor panel for this workspace → create one seeded with the
            // file (its mount-seed opens the tab), select + surface it. For the
            // System workspace the spec is unattached (workspace_id null + system)
            // and roots at the file's directory (its cwd), so absolute/system
            // paths resolve under the panel root.
            void (async () => {
                try {
                    const wsRow = workspacesByIdRef.current.get(workspaceId);
                    const base = (wsRow?.project_name ?? 'system')
                        .toLowerCase()
                        .replace(/\s+/g, '-');
                    const existingCode = specsRef.current.filter(
                        (s) => specWorkspaceId(s) === workspaceId && s.type === 'code',
                    ).length;
                    const label =
                        existingCode === 0 ? `${base}-editor` : `${base}-editor-${existingCode + 1}`;
                    const created = await api().terminalSpec.create({
                        id: ulid(),
                        workspace_id: system ? null : workspaceId,
                        label,
                        cwd: root,
                        type: 'code',
                        meta: {
                            ...(system ? { system: true } : {}),
                            open_files: [relPath],
                            active_file: relPath,
                            file_path: relPath,
                            // Transient: the new panel reveals this line on mount,
                            // then clears it (see CodePanel's mount-seed).
                            ...(typeof line === 'number' ? { reveal_line: line } : {}),
                        },
                    });
                    setSpecs((prev) => [...prev, created]);
                    setSelected((prev) => new Set(prev).add(created.id));
                    if (system) setSystemRevealed(true);
                    activateWorkspaceRef.current(workspaceId);
                    void api().editor.openFileResult(requestId, { reused: false, opened: true });
                } catch {
                    void api().editor.openFileResult(requestId, { reused: false, opened: false });
                }
            })();
        });
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
            if (!ws) return;
            void api().tynn.openInBrowser('/dashboard', ws.backend);
        },
        [workspacesById],
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
    const atMaxViews = selectedSpecs.length >= maxViews;
    const maxViewsReason = `Max views reached (${maxViews}) — raise it in Settings`;

    // Global keyboard shortcut: ⌘/Ctrl + , opens Settings. Fires on a WINDOW
    // keydown listener, so it works anywhere — including while a terminal is
    // focused (xterm doesn't claim this combo). The old focus/pin/close shortcuts
    // (⌘1–9 / ⌘\ / ⌘W) were removed: a focused terminal swallowed them, so they
    // were unreliable and their status-bar hint misled.
    //
    // Guard against stealing the keystroke while the user is typing in a real text
    // input — the in-app prompt modal, the editor's fields, any <input>/<textarea>/
    // contenteditable. The xterm surface uses a hidden `.xterm-helper-textarea`;
    // that one is exempt so ⌘, still opens Settings from a focused terminal.
    useEffect(() => {
        const isTextEntry = (el: Element | null): boolean => {
            if (!el || !(el instanceof HTMLElement)) return false;
            // xterm's hidden input is a textarea but is NOT a real text field for
            // our purposes — ⌘, should still open Settings from a focused terminal.
            if (
                el.classList.contains('xterm-helper-textarea') ||
                el.closest('.xterm')
            ) {
                return false;
            }
            const tag = el.tagName;
            return (
                tag === 'INPUT' ||
                tag === 'TEXTAREA' ||
                el.isContentEditable
            );
        };

        const onKeyDown = (e: KeyboardEvent) => {
            // Never steal the keystroke from a real text field (the in-app prompt,
            // the editor, any input). The xterm helper textarea is exempt.
            if (isTextEntry(document.activeElement)) return;

            const intent = resolveShortcut(e);
            if (intent?.kind === 'settings') {
                e.preventDefault();
                api().app.showSettings().catch(() => {});
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    if (authChecked && !signedIn) {
        return (
            <div className="gwrap" id="app">
                <div className="winframe">
                    <TitleBar isStage={false} />
                    <div
                        style={{
                            flex: 1,
                            minHeight: 0,
                            display: 'grid',
                            placeItems: 'center',
                            background: 'var(--bg-0)',
                        }}
                    >
                        <div style={{ maxWidth: 720, width: '100%' }}>
                            <SignInPrompt
                                tynnHost={hosts.tynn}
                                aionimaHost={hosts.aionima}
                                onSignedIn={async () => {
                                    await refreshAuth();
                                    await refresh();
                                }}
                            />
                        </div>
                    </div>
                </div>
                <PromptHost />
            </div>
        );
    }

    if (!authChecked) {
        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'grid',
                    placeItems: 'center',
                    background: '#0a0a0c',
                    color: '#a1a1aa',
                    fontSize: 13,
                }}
            >
                Checking sign-in…
            </div>
        );
    }

    return (
        <div className="gwrap" id="app">
            <div className="winframe">
                <TitleBar
                    isStage={isStage}
                    stageWorkspaceName={
                        stageSeedWorkspace
                            ? workspacesById.get(stageSeedWorkspace)?.project_name
                            : undefined
                    }
                    onShowDocs={() => setDocsOpen((o) => !o)}
                    onShowTaskManager={() => setTaskManagerOpen((o) => !o)}
                    onShowIssueWatch={() =>
                        activeWorkspaceId && openIssueWatch(activeWorkspaceId)
                    }
                    issueWatchUnread={(() => {
                        const c = activeWorkspaceId
                            ? issueWatchCounts[activeWorkspaceId]
                            : undefined;
                        return c ? c.issue + c.pr + c.security : 0;
                    })()}
                    githubNeedsResolve={githubNeedsResolve}
                    onShowGithubCaps={() => setGithubCapsOpen((o) => !o)}
                />
                <UpdateReadyBanner />
                <Toolbar
                    activeWorkspace={
                        activeWorkspaceId
                            ? workspacesById.get(activeWorkspaceId)
                            : undefined
                    }
                    layoutMode={layoutMode}
                    onLayoutMode={setLayoutMode}
                    onAddView={(type) =>
                        activeWorkspaceId && void addSpec(activeWorkspaceId, type)
                    }
                    addDisabled={atMaxViews}
                    addDisabledReason={maxViewsReason}
                />
                <div className="gbody">
                    <Chooser
                        workspaces={displayWorkspaces}
                        specs={specs}
                        selected={selected}
                        activeIds={activeIds}
                        attentionIds={attentionIds}
                        issueWatchCounts={issueWatchCounts}
                        onShowIssueWatch={openIssueWatch}
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
                                    const fallback = workspaces[0]?.id ?? null;
                                    if (fallback) activateWorkspace(fallback);
                                    else setActiveWorkspaceId(null);
                                }
                                return next;
                            });
                        }}
                        onActivateWorkspace={activateWorkspace}
                        onToggleSpec={toggleSpec}
                        onAddSpec={(wsId, type) => void addSpec(wsId, type)}
                        onDestroySpec={(id) => void destroySpec(id)}
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
                        onAddProcess={(wsId, command, label, cwd, shell) =>
                            void addProcess(wsId, command, label, cwd, shell)
                        }
                        onUpdateProcess={(id, patch, wasRunning) =>
                            void editProcess(id, patch, wasRunning)
                        }
                    />
                    <TerminalGrid
                        specs={selectedSpecs}
                        backgroundSpecs={backgroundSpecs}
                        workspacesById={workspacesById}
                        activeWorkspaceId={activeWorkspaceId}
                        addDisabled={atMaxViews}
                        addDisabledReason={maxViewsReason}
                        focusId={focusId}
                        attentionIds={attentionIds}
                        onAttentionClear={clearAttention}
                        maximizedId={maximizedId}
                        onClose={closeSelected}
                        onFocus={(id) => setFocusId((cur) => (cur === id ? null : id))}
                        onToggleMaximize={toggleMaximize}
                        onDisable={(id) => void disableSpec(id)}
                        onAddTerminal={() =>
                            activeWorkspaceId && void addSpec(activeWorkspaceId, 'terminal')
                        }
                        onAddCode={() =>
                            activeWorkspaceId && void addSpec(activeWorkspaceId, 'code')
                        }
                        onMarkActive={markActive}
                        onMarkInactive={markInactive}
                        layoutMode={layoutMode}
                    />
                </div>
                <StatusBar
                    panelCount={selectedSpecs.length}
                    projectCount={projectsActive.size}
                    activeCount={activeIds.size}
                />
            </div>

            <DocsFlyout open={docsOpen} onClose={() => setDocsOpen(false)} />
            <IssueWatchFlyout
                open={issueWatchOpen}
                workspaceId={issueWatchWsId}
                onClose={() => setIssueWatchOpen(false)}
                onResolveGithub={() => {
                    setIssueWatchOpen(false);
                    setGithubCapsOpen(true);
                }}
            />
            <TaskManagerFlyout
                open={taskManagerOpen}
                onClose={() => setTaskManagerOpen(false)}
            />
            <GithubCapabilitiesFlyout
                open={githubCapsOpen}
                caps={githubCaps}
                onClose={() => setGithubCapsOpen(false)}
            />

            <PromptHost />

            {quitTerminals && (
                <QuitTerminalsModal
                    terminals={quitTerminals}
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
                    }}
                />
            )}

            {projectMenu && (() => {
                const ws = workspacesById.get(projectMenu.workspaceId);
                if (!ws) return null;
                return (
                    <ProjectContextMenu
                        position={{ x: projectMenu.x, y: projectMenu.y }}
                        workspace={ws}
                        onClose={() => setProjectMenu(null)}
                        onAddTerminal={() => void addSpec(ws.id)}
                        onOpenStage={() => openProjectInStage(ws.id)}
                        onOpenInBrowser={() => openProjectInBrowser(ws.id)}
                        onSettings={() => setSettingsWorkspaceId(ws.id)}
                        onRemove={() => void removeWorkspaceRow(ws.id)}
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
    const [committed, setCommitted] = useState(false);
    const [changelog, setChangelog] = useState<Changelog | null>(null);
    const [hover, setHover] = useState(false);
    // Each step fires at most once after the user commits.
    const appliedRef = useRef(false);
    const restartedRef = useRef(false);
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
        return () => {
            alive = false;
            off();
        };
    }, []);

    const pending =
        status &&
        ['available', 'downloading', 'applying', 'ready-to-restart'].includes(
            status.state,
        );

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
    // staged. The refs guard each step to a single fire.
    useEffect(() => {
        if (!committed || !status) return;
        // A manual-download update (manualDownloadUrl set) must NOT auto-apply —
        // electron-updater can't download/install it on this build. The pill shows
        // a Download button instead (handled in the render).
        if (status.state === 'available' && !status.manualDownloadUrl && !appliedRef.current) {
            appliedRef.current = true;
            void api().updater.apply(); // downloadUpdate
        } else if (status.state === 'ready-to-restart' && !restartedRef.current) {
            restartedRef.current = true;
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
    }, [committed, status?.state]);

    if (!status || !pending) return null;

    const version = status.latestVersion ?? '';
    const ready = status.state === 'ready-to-restart';
    // A manual-download update (auto-apply can't run on this build — e.g. a Linux
    // AppImage launched without APPIMAGE) surfaces a Download button → the release
    // page, instead of the in-app Upgrade flow.
    const manualUrl = status.manualDownloadUrl ?? null;
    const pct =
        status.state === 'downloading' && typeof status.progress === 'number'
            ? Math.round(status.progress * 100)
            : null;

    // Pre-commit, an actionable update shows ONE button. A pre-staged ready
    // build is just as actionable — one click commits to the restart. (A
    // background working state, which the one-click path shouldn't produce,
    // falls through to the progress display.)
    const actionable = !committed && !manualUrl && (status.state === 'available' || ready);

    const progressLabel =
        status.state === 'ready-to-restart'
            ? 'Restarting…'
            : status.state === 'applying'
                ? 'Installing…'
                : status.state === 'downloading'
                    ? `Downloading…${pct !== null ? ` ${pct}%` : ''}`
                    : 'Upgrading…';

    return (
        <div
            className="update-pill-wrap"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            {manualUrl ? (
                <button
                    type="button"
                    className="update-pill ready"
                    title="Auto-update isn't available on this build — download the new version"
                    onClick={() => void api().shell.openExternal(manualUrl).catch(() => {})}
                >
                    <span className="up-dot" />
                    Download{version ? ` v${version}` : ''}
                </button>
            ) : actionable ? (
                <button
                    type="button"
                    className="update-pill ready"
                    onClick={() => setCommitted(true)}
                >
                    <span className="up-dot" />
                    Upgrade
                </button>
            ) : (
                // One-way progress: no button, no second click — the effect
                // above carries it through install → restart.
                <div
                    className="update-pill is-progress"
                    role="status"
                    aria-live="polite"
                >
                    <span className="up-dot" />
                    {progressLabel}
                </div>
            )}
            {hover && (
                <UpdatePopover
                    version={version}
                    changelog={changelog}
                    ready={ready}
                    willRestartPtyHost={!!status.willRestartPtyHost}
                />
            )}
        </div>
    );
}

/**
 * Slim, dismissible "Restart & update" banner — a FALLBACK affordance for the
 * rare case a build is downloaded but left staged (state 'ready-to-restart')
 * without auto-applying. We don't download in the background: the one-click
 * "Update" path (downloadAndInstall) applies the build hands-free the instant it
 * lands, so it normally never rests here. If it does (e.g. a download we didn't
 * initiate), one click runs the SAME quitAndInstall path as the header pill
 * (isQuittingForUpdate → two-phase teardown → installer). Dismiss leaves the
 * title-bar pill in place, so nothing is lost.
 */
function UpdateReadyBanner() {
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    // The version the user dismissed. A LATER staged build (different version)
    // re-shows the banner; re-broadcasts of the same version stay muted.
    const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        void api()
            .updater.status()
            .then((s) => alive && setStatus(s))
            .catch(() => {});
        const off = api().on.updaterStatus((s) => setStatus(s));
        return () => {
            alive = false;
            off();
        };
    }, []);

    if (
        !status ||
        status.state !== 'ready-to-restart' ||
        (status.latestVersion != null && dismissedVersion === status.latestVersion)
    )
        return null;

    const restart = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await api().updater.restart();
            // Phase-1 (git checkout) has no installer; quitting is the honest
            // fallback so a manual relaunch picks up the new code.
            if (!r.ok) await api().app.quit();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="update-banner" role="status">
            <span className="ub-dot" />
            <span className="ub-text">
                Genie v{status.latestVersion} is ready.
                {status.willRestartPtyHost
                    ? ' Applying it restarts your background terminals (restored from a snapshot).'
                    : ''}
            </span>
            <button
                type="button"
                className="ub-action"
                onClick={() => void restart()}
                disabled={busy}
            >
                Restart &amp; update
            </button>
            <button
                type="button"
                className="ub-dismiss"
                onClick={() => setDismissedVersion(status.latestVersion)}
                aria-label="Dismiss"
                title="Dismiss (the update stays ready in the title bar)"
            >
                <IconX size={14} />
            </button>
        </div>
    );
}

function UpdatePopover({
    version,
    changelog,
    ready,
    willRestartPtyHost,
}: {
    version: string;
    changelog: Changelog | null;
    ready: boolean;
    willRestartPtyHost: boolean;
}) {
    return (
        <div className="update-popover" role="tooltip">
            <div className="up-head">
                <strong>Genie v{version}</strong>
                <span>{ready ? 'downloaded — restart to install' : 'available'}</span>
            </div>
            {willRestartPtyHost && (
                <div className="up-warn" role="alert">
                    Applying this update restarts your background terminals.
                    Running sessions will be restored from a snapshot (command
                    history is kept; live processes stop). Save or close anything
                    important first.
                </div>
            )}
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

function TitleBar({
    isStage,
    stageWorkspaceName,
    onShowDocs,
    onShowTaskManager,
    onShowIssueWatch,
    issueWatchUnread = 0,
    githubNeedsResolve = false,
    onShowGithubCaps,
}: {
    isStage: boolean;
    stageWorkspaceName?: string;
    onShowDocs?: () => void;
    onShowTaskManager?: () => void;
    onShowIssueWatch?: () => void;
    issueWatchUnread?: number;
    /** True when GitHub permissions are missing — shows a persistent warning. */
    githubNeedsResolve?: boolean;
    onShowGithubCaps?: () => void;
}) {
    const isMac =
        typeof navigator !== 'undefined' &&
        /Mac/i.test(navigator.platform ?? navigator.userAgent ?? '');
    return (
        <div className="titlebar">
            {/* The native title bar is hidden (titleBarStyle: 'hidden') — this
                row IS the window chrome. On macOS the REAL traffic lights
                overlay the top-left corner, so pad past them rather than
                painting fakes. */}
            {isMac && <span className="traffic-pad" />}
            <span className="glogo">
                {/* The PNG ships in resources/logo.png; Next copies it into
                    renderer/public at build time. Use the relative path so it
                    works under file:// (packaged) and http://localhost (dev). */}
                <img className="lamp" src="./logo.png" alt="" width={22} height={22} />
                Genie
            </span>
            <RemoteIndicator />
            <HostSessionOverlay />
            {/* No internal view codenames in the UI — a Stage window shows its
                pinned workspace name, the master window shows nothing extra. */}
            {isStage && stageWorkspaceName && (
                <span className="ttl">{stageWorkspaceName}</span>
            )}
            <span className="spacer" />
            <HostsButton />
            <UpdatePill />
            {githubNeedsResolve && (
                <button
                    type="button"
                    className="gicon gh-warn-btn"
                    title="GitHub permissions needed — some features are disabled. Click to resolve."
                    aria-label="Resolve GitHub permissions"
                    onClick={() => onShowGithubCaps?.()}
                >
                    <IconAlert size={16} />
                </button>
            )}
            <button
                type="button"
                className="gicon"
                title="Task Manager — every background process"
                onClick={() => onShowTaskManager?.()}
            >
                <IconCpu size={16} />
            </button>
            <button
                type="button"
                className="gicon iw-btn"
                title="Issue Watch — GitHub issues, PRs & Dependabot"
                onClick={() => onShowIssueWatch?.()}
            >
                <IconEye />
                {issueWatchUnread > 0 && (
                    <span className="iw-btn-badge">
                        {issueWatchUnread > 99 ? '99+' : issueWatchUnread}
                    </span>
                )}
            </button>
            <button
                type="button"
                className="gicon"
                title="Documentation"
                onClick={() => onShowDocs?.()}
            >
                <IconHelp />
            </button>
            <button
                type="button"
                className="gicon"
                title="Settings"
                onClick={() => api().app.showSettings().catch(() => {})}
            >
                <IconSettings />
            </button>
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

/**
 * Hosts picker (LOCAL window only). A titlebar affordance to open OTHER machines'
 * native Genie Floors — each host gets its OWN window driven over the remote
 * bridge, while THIS local window keeps full local functionality. Lists tailnet-
 * discovered hosts + the persisted known-hosts list; first-time pairs collect a
 * PIN inline. Hidden inside a host window (a remote Floor doesn't open further
 * hosts from here).
 */
function HostsButton() {
    const isHostWindow =
        typeof window !== 'undefined' && /[?&]host=/.test(window.location.search);
    const [open, setOpen] = useState(false);
    if (isHostWindow) return null;
    return (
        <div style={{ position: 'relative', display: 'inline-flex' }}>
            <button
                type="button"
                className="gicon"
                title="Connect to a host Genie — opens its desktop in a new window"
                aria-label="Hosts"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                {/* stacked-servers glyph */}
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="18" height="7" rx="1.5" />
                    <rect x="3" y="14" width="18" height="7" rx="1.5" />
                    <line x1="7" y1="6.5" x2="7.01" y2="6.5" />
                    <line x1="7" y1="17.5" x2="7.01" y2="17.5" />
                </svg>
            </button>
            {open && <HostsPanel onClose={() => setOpen(false)} />}
        </div>
    );
}

interface HostRow {
    ip: string;
    port: number;
    hostname: string;
    name?: string;
    connKey: string;
    /** Known (persisted, can Forget) vs only just discovered on the tailnet. */
    known: boolean;
    connected: boolean;
    online: boolean;
}

function HostsPanel({ onClose }: { onClose: () => void }) {
    const [rows, setRows] = useState<HostRow[]>([]);
    const [workstations, setWorkstations] = useState<ConnectableWorkstation[]>([]);
    const [loading, setLoading] = useState(true);
    const [pinFor, setPinFor] = useState<string | null>(null);
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            const [known, discovered, ws] = await Promise.all([
                api().remote.known().catch(() => [] as KnownHost[]),
                api().workmode.discoverHosts().catch(() => [] as GenieHost[]),
                api().workstations.connectable().catch(() => [] as ConnectableWorkstation[]),
            ]);
            setWorkstations(ws);
            const byKey = new Map<string, HostRow>();
            for (const k of known) {
                byKey.set(k.connKey, {
                    ip: k.ip,
                    port: k.port,
                    hostname: k.hostname,
                    name: k.name,
                    connKey: k.connKey,
                    known: true,
                    connected: k.connected,
                    online: false,
                });
            }
            for (const d of discovered) {
                const key = `${d.ip}:${d.port}`;
                const existing = byKey.get(key);
                if (existing) existing.online = true;
                else
                    byKey.set(key, {
                        ip: d.ip,
                        port: d.port,
                        hostname: d.hostname,
                        connKey: key,
                        known: false,
                        connected: false,
                        online: true,
                    });
            }
            setRows([...byKey.values()]);
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
                { ip: row.ip, port: row.port, hostname: row.hostname },
                withPin,
            );
            if (res.ok) {
                setPinFor(null);
                setPin('');
                onClose();
            } else if (res.needsPin) {
                setPinFor(row.connKey);
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
                    background: '#141418',
                    border: '1px solid #2a2a33',
                    borderRadius: 10,
                    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                    padding: 8,
                    fontSize: 12,
                    color: '#e4e4e7',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 8px' }}>
                    <strong style={{ fontSize: 11, letterSpacing: '0.04em', color: '#a1a1aa' }}>HOSTS</strong>
                    <button type="button" className="gicon" title="Rescan the tailnet" onClick={() => void load()} aria-label="Refresh hosts" style={{ width: 20, height: 20 }}>⟳</button>
                </div>
                {loading && <div style={{ padding: '8px 6px', color: '#71717a' }}>Scanning…</div>}
                {!loading && rows.length === 0 && workstations.length === 0 && (
                    <div style={{ padding: '8px 6px', color: '#71717a', lineHeight: 1.4 }}>
                        No hosts or workstations found. Enable Work Mode on another Genie on your
                        tailnet, or get access to a Virtual Workstation in Tynn, then rescan.
                    </div>
                )}
                {err && <div style={{ padding: '6px', color: '#f87171' }}>{err}</div>}
                {rows.map((row) => (
                    <div key={row.connKey} style={{ borderRadius: 8, padding: '7px 8px', marginBottom: 2, background: '#1b1b21' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 999, flex: '0 0 auto', background: row.connected ? '#22c55e' : row.online ? '#eab308' : '#52525b' }} title={row.connected ? 'Connected' : row.online ? 'Online' : 'Offline / not on the tailnet now'} />
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                <span style={{ fontWeight: 600 }}>{row.name || row.hostname}</span>
                                <span style={{ color: '#71717a', marginLeft: 6 }}>{row.ip}:{row.port}</span>
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
                            <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                                <input
                                    autoFocus
                                    value={pin}
                                    onChange={(e) => setPin(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void openHost(row, pin); }}
                                    placeholder="Pairing PIN from the host"
                                    inputMode="numeric"
                                    style={{ flex: 1, background: '#0f0f13', border: '1px solid #2a2a33', borderRadius: 6, color: '#e4e4e7', padding: '5px 8px', fontSize: 12 }}
                                />
                                <button type="button" className="gbtn gbtn-sm" disabled={!pin.trim() || busy === row.connKey} onClick={() => void openHost(row, pin)}>Pair</button>
                            </div>
                        )}
                    </div>
                ))}
                {workstations.length > 0 && (
                    <>
                        <div style={{ padding: '8px 6px 6px', fontSize: 11, letterSpacing: '0.04em', color: '#a1a1aa' }}>WORKSTATIONS</div>
                        {workstations.map((ws) => (
                            <div key={`ws:${ws.id}`} style={{ borderRadius: 8, padding: '7px 8px', marginBottom: 2, background: '#1b1b21' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ width: 7, height: 7, borderRadius: 999, flex: '0 0 auto', background: ws.connectable ? '#22c55e' : '#52525b' }} title={ws.connectable ? 'Connectable over the Tynn relay' : `Unavailable (${ws.status})`} />
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        <span style={{ fontWeight: 600 }}>{ws.name}</span>
                                        {ws.capability && <span style={{ color: '#71717a', marginLeft: 6 }}>{ws.capability}</span>}
                                        {ws.source && ws.source !== 'owner' && <span style={{ color: '#52525b', marginLeft: 6 }}>via {ws.source}</span>}
                                    </span>
                                    <button
                                        type="button"
                                        className="gbtn gbtn-sm"
                                        disabled={!ws.connectable || busy === `ws:${ws.id}`}
                                        onClick={() => void openWorkstation(ws)}
                                        title={ws.connectable ? 'Connect to this workstation over the Tynn relay' : `Unavailable — ${ws.status}`}
                                        style={{ flex: '0 0 auto' }}
                                    >
                                        {busy === `ws:${ws.id}` ? '…' : 'Connect'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </>
    );
}

/**
 * Host-side remote-session overlay. When a REMOTE is currently controlling THIS
 * machine, a loud banner makes that obvious + shows where it's from, and lets the
 * host TAKE BACK CONTROL (pauses the remote's input via the kill-switch — the
 * session stays CONNECTED, not killed) or END the session outright.
 */
function HostSessionOverlay() {
    const [peers, setPeers] = useState<MobilePeer[]>([]);
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

    const from = peers.map((p) => p.ip.replace(/^::ffff:/, '')).join(', ');
    const act = async (fn: () => Promise<{ peers: MobilePeer[]; locked: boolean }>) => {
        setBusy(true);
        try {
            const s = await fn();
            setPeers(s.peers ?? []);
            setLocked(s.locked);
        } finally {
            setBusy(false);
        }
    };
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
            <span>
                {locked
                    ? `Remote paused — you have control (from ${from})`
                    : `Remote session active — controlling from ${from}`}
            </span>
            <button
                type="button"
                disabled={busy}
                style={btn}
                title={
                    locked
                        ? 'Hand control back to the remote (it stayed connected)'
                        : 'Pause the remote and take control — without disconnecting it'
                }
                onClick={() => void act(() => api().mobile.lock(!locked))}
            >
                {locked ? 'Resume remote' : 'Take control'}
            </button>
            <button
                type="button"
                disabled={busy}
                style={btn}
                title="Disconnect the remote session entirely"
                onClick={() => void act(() => api().mobile.revokeSessions())}
            >
                End session
            </button>
        </div>
    );
}

interface ToolbarProps {
    activeWorkspace?: WorkspaceRow;
    layoutMode: LayoutMode;
    onLayoutMode: (m: LayoutMode) => void;
    onAddView: (type: ViewType) => void;
    addDisabled?: boolean;
    addDisabledReason?: string;
}

function Toolbar({
    activeWorkspace,
    layoutMode,
    onLayoutMode,
    onAddView,
    addDisabled,
    addDisabledReason,
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
            <button type="button" className="gicon" title="Maximize window">
                <IconMaximize />
            </button>
            <AddViewButton
                disabled={!activeWorkspace || !!addDisabled}
                disabledReason={!activeWorkspace ? undefined : addDisabledReason}
                onAddTerminal={() => onAddView('terminal')}
                onAddCode={() => onAddView('code')}
            />
        </div>
    );
}

/**
 * Split button: primary [Add Terminal] + a chevron that opens a tiny menu
 * with [Add Editor]. Both target the active workspace; disabled when no
 * workspace is active. Closes on outside-click / Escape.
 */
function AddViewButton({
    disabled,
    disabledReason,
    onAddTerminal,
    onAddCode,
}: {
    disabled: boolean;
    disabledReason?: string;
    onAddTerminal: () => void;
    onAddCode: () => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onAway = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
        document.addEventListener('mousedown', onAway);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onAway);
            document.removeEventListener('keydown', onEsc);
        };
    }, [open]);

    return (
        <div className="addview-split" ref={ref} title={disabled ? disabledReason : undefined}>
            <button
                type="button"
                className="gbtn accent addview-main"
                onClick={onAddTerminal}
                disabled={disabled}
                title={disabled ? disabledReason : undefined}
            >
                <IconPlus /> Add Terminal
            </button>
            <button
                type="button"
                className="gbtn accent addview-caret"
                onClick={() => setOpen((o) => !o)}
                disabled={disabled}
                title="Add another view type"
                aria-label="Add another view type"
            >
                <IconChevronDown size={13} />
            </button>
            {open && (
                <div className="addview-menu" role="menu">
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            onAddTerminal();
                        }}
                    >
                        <IconPlus size={13} /> Add Terminal
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            onAddCode();
                        }}
                    >
                        <IconCode size={13} /> Add Editor
                    </button>
                </div>
            )}
        </div>
    );
}

interface StatusBarProps {
    panelCount: number;
    projectCount: number;
    activeCount: number;
}

function StatusBar({ panelCount, projectCount, activeCount }: StatusBarProps) {
    return (
        <div className="gstatus">
            <span className="si">
                <IconLayoutGrid size={13} /> {panelCount} panel
                {panelCount === 1 ? '' : 's'}
            </span>
            <span className="si">
                <IconBox size={13} />
                {projectCount === 0
                    ? 'No project'
                    : projectCount === 1
                      ? '1 project'
                      : `${projectCount} projects`}
            </span>
            <span className="si">
                <span className="sdot" style={{ background: '#10b981' }} />
                {activeCount} live
            </span>
        </div>
    );
}
