import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Chooser from '../components/Master/Chooser';
import ProjectContextMenu from '../components/Master/ProjectContextMenu';
import SpecContextMenu from '../components/Master/SpecContextMenu';
import { PromptHost, showPrompt } from '../components/Master/Prompt';
import QuitTerminalsModal, {
    type QuitTerminal,
} from '../components/Master/QuitTerminalsModal';
import TerminalGrid, {
    type LayoutMode,
} from '../components/Master/TerminalGrid';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import DocsFlyout from '../components/Master/DocsFlyout';
import SignInPrompt from '../components/SignInPrompt';
import type { BackendUser, ViewType } from '../lib/genie';
import { resolveShortcut } from '../lib/master-shortcuts';
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
    IconSettings,
} from '../components/Master/icons';
import {
    api,
    hasGenieBridge,
    ulid,
    type Changelog,
    type TerminalSpec,
    type UpdaterStatus,
    type WorkspaceRow,
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

    if (!ready) {
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
                Waiting for preload bridge…
            </div>
        );
    }

    return <MasterInner />;
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
    // Docs flyout (the ? titlebar button toggles this in-window panel rather
    // than opening a separate BrowserWindow).
    const [docsOpen, setDocsOpen] = useState(false);
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

    // Customization: play a short two-note chime when an agent calls imDone
    // (gated by Settings → Customization → notify_sound on the main side).
    // Synthesized via Web Audio so no audio asset has to ship.
    useEffect(() => {
        return api().on.notifySound(() => {
            try {
                const Ctx =
                    window.AudioContext ||
                    (window as unknown as { webkitAudioContext?: typeof AudioContext })
                        .webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const now = ctx.currentTime;
                const tone = (freq: number, start: number, dur: number) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    gain.gain.setValueAtTime(0.0001, now + start);
                    gain.gain.exponentialRampToValueAtTime(0.18, now + start + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
                    osc.connect(gain).connect(ctx.destination);
                    osc.start(now + start);
                    osc.stop(now + start + dur);
                };
                tone(660, 0, 0.18); // E5
                tone(880, 0.16, 0.24); // A5
                setTimeout(() => void ctx.close().catch(() => {}), 700);
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

    const workspacesById = useMemo(() => {
        const m = new Map<string, WorkspaceRow>();
        for (const w of workspaces) m.set(w.id, w);
        return m;
    }, [workspaces]);

    const refresh = useCallback(async () => {
        const [ws, sp] = await Promise.all([
            api().workspaces.list(),
            api().terminalSpec.list(),
        ]);
        setWorkspaces(ws);
        setSpecs(sp);
    }, []);

    /**
     * Persist a user-defined sidebar order (full ordered list of workspace
     * ids from the flyout drag). Reorder locally first so the rail + flyout
     * update instantly, then persist; main re-sorts on the next list().
     */
    const reorderWorkspaces = useCallback((ids: string[]) => {
        setWorkspaces((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            const next = ids
                .map((id) => byId.get(id))
                .filter((w): w is WorkspaceRow => !!w);
            // Append any workspaces not present in the id list (defensive).
            for (const w of prev) if (!ids.includes(w.id)) next.push(w);
            return next;
        });
        void api().workspaces.reorder(ids).catch(() => {});
    }, []);

    // Stage windows arrive with ?stage=<workspaceId>. Read it once on mount
    // and seed the selection with that workspace's terminals so the user
    // sees something useful immediately.
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

    useEffect(() => {
        if (!stageSeedWorkspace || specs.length === 0 || selected.size > 0) return;
        const ids = specs
            .filter((s) => s.workspace_id === stageSeedWorkspace && s.enabled !== false)
            .map((s) => s.id);
        if (ids.length > 0) setSelected(new Set(ids));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [specs.length, stageSeedWorkspace]);

    // Seed the active workspace ONCE, after workspaces load. Stage windows
    // pin to their `?stage=` workspace; otherwise read the persisted
    // `active_workspace` setting, falling back to the most-recent workspace
    // (workspaces already sort last_opened_at DESC). Selecting a workspace
    // selects its views so the grid shows something immediately.
    useEffect(() => {
        if (seededActiveRef.current || workspaces.length === 0) return;
        seededActiveRef.current = true;
        (async () => {
            let target: string | null = null;
            if (stageSeedWorkspace && workspaces.some((w) => w.id === stageSeedWorkspace)) {
                target = stageSeedWorkspace;
            } else {
                try {
                    const s = await api().settings.get();
                    const saved = s.active_workspace;
                    if (saved && workspaces.some((w) => w.id === saved)) target = saved;
                } catch {
                    /* settings unavailable — fall through to most-recent */
                }
                if (!target) target = workspaces[0]?.id ?? null;
            }
            if (!target) return;
            setActiveWorkspaceId(target);
            // Seed selection with this workspace's views unless a stage seed
            // already populated it.
            setSelected((prev) => {
                if (prev.size > 0) return prev;
                return new Set(
                    specs
                        .filter((s) => s.workspace_id === target && s.enabled !== false)
                        .map((s) => s.id),
                );
            });
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaces.length]);

    // Active-workspace views drive the grid layout + counts. Processes are
    // headless services — they never surface in the main grid.
    const selectedSpecs = useMemo(
        () =>
            specs.filter(
                (s) =>
                    s.type !== 'process' &&
                    s.workspace_id === activeWorkspaceId &&
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
                    s.workspace_id !== activeWorkspaceId &&
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
            const existing = specs.filter((s) => s.workspace_id === workspaceId);
            const baseLabel = ws.project_name.toLowerCase().replace(/\s+/g, '-');
            // Editor views get an `-editor` label so they read distinctly in
            // the tree alongside terminals.
            const root = type === 'code' ? `${baseLabel}-editor` : baseLabel;
            const sameType = existing.filter((s) => s.type === type);
            const label = sameType.length === 0 ? root : `${root}-${sameType.length + 1}`;
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: workspaceId,
                label,
                cwd: ws.path,
                type,
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
     * Create a Process (background service runner) for a workspace. Headless —
     * it does NOT surface in the main grid; it's managed from the workspace's
     * inline process panel in the nav. Autostart is OFF by default (starts
     * idle); auto-restart-on-crash is on.
     */
    const addProcess = useCallback(
        async (workspaceId: string, command: string, label?: string, cwd?: string) => {
            const ws = workspacesById.get(workspaceId);
            if (!ws || !command.trim()) return;
            const cmd = command.trim();
            const fallback = cmd.split(/\s+/).slice(0, 3).join(' ');
            const created = await api().terminalSpec.create({
                id: ulid(),
                workspace_id: workspaceId,
                label: (label?.trim() || fallback).slice(0, 60),
                // cwd defaults to the envelope root; the Add Process UX can point
                // it at a specific repo (e.g. <root>/repos/tynn).
                cwd: cwd?.trim() || ws.path,
                type: 'process',
                meta: { command: cmd, autostart: false, restart_on_exit: true },
            });
            // Not added to `selected` — processes aren't grid panels.
            setSpecs((prev) => [...prev, created]);
        },
        [workspacesById],
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
     * replays scrollback (no restart). Clears retention so a later plain close
     * kills it as usual. Blocked when re-enabling would exceed Max Views, with
     * the same hint as the Add affordances.
     */
    const enableSpec = useCallback(
        async (id: string) => {
            const spec = specs.find((s) => s.id === id);
            if (!spec) return;
            // Activate the spec's workspace if it isn't already active, so the
            // re-enabled panel lands in the visible grid.
            const wsId = spec.workspace_id;
            const targetActive = wsId ?? activeWorkspaceId;
            // Count what's already visible in the workspace we're enabling into.
            const visibleInWs = specs.filter(
                (s) => s.workspace_id === targetActive && selected.has(s.id),
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
                    if (s.workspace_id === workspaceId && s.enabled !== false) {
                        next.add(s.id);
                    }
                }
                return next;
            });
            setFocusId(null);
            setMaximizedId(null);
            void api()
                .settings.set({ active_workspace: workspaceId })
                .catch(() => {});
        },
        [specs],
    );

    /** Close every view in the ACTIVE workspace (deselect; PTYs detach on unmount). */
    const clearSelection = useCallback(() => {
        setSelected((prev) => {
            const next = new Set(prev);
            for (const s of specs) {
                if (s.workspace_id === activeWorkspaceId) next.delete(s.id);
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

    // Global keyboard shortcuts (advertised in the footer hint):
    //   ⌘/Ctrl + 1–9  → focus the Nth visible panel of the active workspace.
    //   ⌘/Ctrl + \\   → toggle the pinned tree/chooser.
    //   ⌘/Ctrl + W    → close the currently focused panel (same as its X).
    //
    // Guard against stealing keystrokes while the user is typing in a real text
    // input — the in-app prompt modal, the editor's fields, any <input>/<textarea>/
    // contenteditable. The xterm surface uses a hidden `.xterm-helper-textarea`;
    // that one is fine to act over (the shortcuts aren't terminal keystrokes), so
    // it's explicitly exempt from the guard.
    useEffect(() => {
        const isTextEntry = (el: Element | null): boolean => {
            if (!el || !(el instanceof HTMLElement)) return false;
            // xterm's hidden input is a textarea but is NOT a real text field for
            // our purposes — shortcuts should still work while a terminal is focused.
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
            // Never steal keystrokes from a real text field (the in-app prompt,
            // the editor, any input). The xterm helper textarea is exempt.
            if (isTextEntry(document.activeElement)) return;

            const intent = resolveShortcut(e);
            if (!intent) return;

            if (intent.kind === 'close') {
                // Close the focused panel (NOT the window). No-op + DON'T
                // preventDefault when nothing is focused, so ⌘W stays inert
                // rather than swallowed.
                if (focusId) {
                    e.preventDefault();
                    closeSelected(focusId);
                }
                return;
            }

            if (intent.kind === 'pin') {
                e.preventDefault();
                setChooserPinned((p) => !p);
                return;
            }

            // focus: index into the visible grid order (selectedSpecs).
            // Out-of-range → no-op (and don't preventDefault).
            const target = selectedSpecs[intent.index];
            if (target) {
                e.preventDefault();
                setFocusId(target.id);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedSpecs, focusId, closeSelected]);

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
                />
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
                        workspaces={workspaces}
                        specs={specs}
                        selected={selected}
                        activeIds={activeIds}
                        attentionIds={attentionIds}
                        activeWorkspaceId={activeWorkspaceId}
                        pinned={chooserPinned}
                        onTogglePin={() => setChooserPinned((p) => !p)}
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
                        onAddProcess={(wsId, command, label, cwd) =>
                            void addProcess(wsId, command, label, cwd)
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
                        onToggleMcp={() => {
                            const next = !ws.mcp_enabled;
                            setWorkspaces((prev) =>
                                prev.map((w) =>
                                    w.id === ws.id
                                        ? { ...w, mcp_enabled: next ? 1 : 0 }
                                        : w,
                                ),
                            );
                            void api().workspaces.setMcp(ws.id, next).catch(() => {});
                        }}
                        onRemove={() => void removeWorkspaceRow(ws.id)}
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
 * Header update pill. Lives in the title bar and only renders while an
 * update is pending (available → downloading → ready-to-restart). One
 * click walks the updater's state machine: Install (download) → Restart.
 * Hovering reveals a popover of the incoming changes — commit subjects
 * between the installed and latest version, grouped per version so a
 * user several releases behind sees them stacked newest-first.
 */
function UpdatePill() {
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [changelog, setChangelog] = useState<Changelog | null>(null);
    const [hover, setHover] = useState(false);

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

    if (!status || !pending) return null;

    const version = status.latestVersion ?? '';
    const working = status.state === 'downloading' || status.state === 'applying';
    const ready = status.state === 'ready-to-restart';
    const pct =
        status.state === 'downloading' && typeof status.progress === 'number'
            ? Math.round(status.progress * 100)
            : null;

    const label = ready
        ? 'Restart to update'
        : working
            ? `Installing…${pct !== null ? ` ${pct}%` : ''}`
            : 'Install update';

    const act = async () => {
        if (working) return;
        setBusy(true);
        try {
            if (status.state === 'available') {
                await api().updater.apply();
            } else if (ready) {
                const r = await api().updater.restart();
                // Phase-1 (git checkout) restarts manually — quitting is the
                // honest fallback so relaunch picks up the new code.
                if (!r.ok) await api().app.quit();
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="update-pill-wrap"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            <button
                type="button"
                className={`update-pill${ready ? ' ready' : ''}`}
                onClick={act}
                disabled={busy || working}
            >
                <span className="up-dot" />
                {label}
            </button>
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
}: {
    isStage: boolean;
    stageWorkspaceName?: string;
    onShowDocs?: () => void;
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
            {/* No internal view codenames in the UI — a Stage window shows its
                pinned workspace name, the master window shows nothing extra. */}
            {isStage && stageWorkspaceName && (
                <span className="ttl">{stageWorkspaceName}</span>
            )}
            <span className="spacer" />
            <UpdatePill />
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
            <span className="spacer" />
            <span className="si mono">⌘1–9 focus · ⌘\ pin tree · ⌘W close panel</span>
        </div>
    );
}
