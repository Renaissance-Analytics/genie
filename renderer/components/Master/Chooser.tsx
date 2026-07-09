import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    IconAlert,
    IconBox,
    IconChevronDown,
    IconCode,
    IconEye,
    IconEyeOff,
    IconCpu,
    IconGlobe,
    IconHome,
    IconMonitorCog,
    IconPanelLeftOpen,
    IconPause,
    IconPin,
    IconPlay,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconTerminal,
    IconTrash,
    IconTynn,
} from './icons';
import { showPrompt } from './Prompt';
import TerminalTypeSplitButton from './TerminalTypeSplitButton';
import { terminalTypeForAgent, type TerminalTypeId } from '../../lib/terminal-types';
import { workspaceNeedsAttention } from '../../lib/attention';
import {
    enterableWorkspaceIds,
    newlyAddedWorkspaceIds,
} from '../../lib/workspace-enter';
import {
    api,
    detectedShells,
    isSystemWorkspace,
    SYSTEM_WORKSPACE_ID,
    type McpStatus,
    type ProcessStatus,
    type WatchTypeCounts,
    type ShellDetection,
    type StructureDocStatus,
    type TerminalSpec,
    type ViewType,
    type WorkspaceRow,
} from '../../lib/genie';

interface Props {
    workspaces: WorkspaceRow[];
    specs: TerminalSpec[];
    selected: Set<string>;
    activeIds: Set<string>;
    /** Agent-integration MCP: terminals pulsing for attention (imDone). */
    attentionIds: Set<string>;
    activeWorkspaceId: string | null;
    pinned: boolean;
    onTogglePin: () => void;
    /** Whether the synthetic System Workspace is currently shown in the list. */
    systemRevealed: boolean;
    /** Toggle the System Workspace's visibility (the sidebar chip button). */
    onToggleSystemWorkspace: () => void;
    onActivateWorkspace: (workspaceId: string) => void;
    onToggleSpec: (id: string) => void;
    onAddSpec: (workspaceId: string, type: ViewType) => void;
    onDestroySpec: (id: string) => void;
    /** Tier 2: suspend a terminal (keep pty, hide panel). */
    onDisableSpec: (id: string) => void;
    /** Tier 2: resume a suspended terminal (reattach to the live session). */
    onEnableSpec: (id: string) => void;
    onOpenContextMenu: (specId: string, position: { x: number; y: number }) => void;
    onOpenProjectMenu: (workspaceId: string, position: { x: number; y: number }) => void;
    onAddWorkspace: () => void;
    /** Persist a new sidebar order (full ordered list of workspace ids). */
    onReorderWorkspaces: (ids: string[]) => void;
    /** Create a Process (background service runner) for a workspace. `cwd`
     *  targets a specific repo (or the envelope root when omitted); `shell`
     *  picks the interpreter (empty → default shell). */
    onAddProcess: (
        workspaceId: string,
        command: string,
        label?: string,
        cwd?: string,
        shell?: string,
    ) => void;
    /** Edit an existing Process (right-click → Edit). Restarts it if running. */
    onUpdateProcess: (
        id: string,
        patch: { command: string; label?: string; cwd?: string; shell?: string },
        wasRunning: boolean,
    ) => void;
    /** Issue Watch: per-workspace unread counts by type (the 3-dot pill). */
    issueWatchCounts?: Record<string, WatchTypeCounts>;
    /** Open the Issue Watch flyout for a specific workspace (the pill click). */
    onShowIssueWatch: (workspaceId: string) => void;
    /** Split Add-Terminal button: last-used type + its persistence. */
    lastTerminalType: TerminalTypeId;
    onLastTerminalType: (id: TerminalTypeId) => void;
    /** A specialized (agent) terminal was created — select it into view. */
    onAgentCreated: (spec: TerminalSpec) => void;
    /** The configured custom-agent command (create-form placeholder). */
    agentCustomCommand?: string;
}

/**
 * Left chooser: 56px icon rail (always visible) + a 282px flyout that
 * either hovers in or stays pinned to the side. Tree groups terminal
 * specs by workspace. The icon rail also shows aggregate counts per
 * workspace so you can navigate without expanding the flyout.
 */
export default function Chooser({
    workspaces,
    specs,
    selected,
    activeIds,
    attentionIds,
    activeWorkspaceId,
    pinned,
    onTogglePin,
    systemRevealed,
    onToggleSystemWorkspace,
    onActivateWorkspace,
    onToggleSpec,
    onAddSpec,
    onDestroySpec,
    onDisableSpec,
    onEnableSpec,
    onOpenContextMenu,
    onOpenProjectMenu,
    onAddWorkspace,
    onReorderWorkspaces,
    onAddProcess,
    onUpdateProcess,
    issueWatchCounts = {},
    onShowIssueWatch,
    lastTerminalType,
    onLastTerminalType,
    onAgentCreated,
    agentCustomCommand,
}: Props) {
    // Inline Add-Process form: which workspace's form is open, its fields, and
    // the cached repo list (root + repos/<name>) for the cwd picker. When
    // editProcId is set the form edits that process instead of creating one.
    const [addProcFor, setAddProcFor] = useState<string | null>(null);
    const [editProcId, setEditProcId] = useState<string | null>(null);
    // Right-click context menu for a process row.
    const [procMenu, setProcMenu] = useState<{
        spec: TerminalSpec;
        x: number;
        y: number;
    } | null>(null);
    const [procLabel, setProcLabel] = useState('');
    const [procCommand, setProcCommand] = useState('');
    const [procCwd, setProcCwd] = useState(''); // '' = envelope root
    const [procShell, setProcShell] = useState(''); // '' = default shell
    const [procRepos, setProcRepos] = useState<string[]>([]);
    const [procShells, setProcShells] = useState<ShellDetection[]>([]);
    // System processes aren't tied to a repo — `procDir` holds the absolute
    // directory the user picked (via the native picker). Only used when the
    // open form belongs to the System Workspace; '' = not yet chosen.
    const [procDir, setProcDir] = useState('');

    const loadProcFormMeta = (ws: WorkspaceRow) => {
        setProcRepos([]);
        // The System Workspace has no repos — skip the (meaningless) repo fetch.
        if (!isSystemWorkspace(ws)) {
            void api()
                .workspaces.repos(ws.id)
                .then(setProcRepos)
                .catch(() => setProcRepos([]));
        }
        void detectedShells()
            .then(({ shells }) => setProcShells(shells))
            .catch(() => setProcShells([]));
    };

    const openAddProcess = (ws: WorkspaceRow) => {
        setEditProcId(null);
        setAddProcFor(ws.id);
        setProcLabel('');
        setProcCommand('');
        setProcCwd('');
        // Default the picked dir to the System Workspace's home path.
        setProcDir(isSystemWorkspace(ws) ? ws.path : '');
        setProcShell('');
        loadProcFormMeta(ws);
    };

    const openEditProcess = (ws: WorkspaceRow, s: TerminalSpec) => {
        setEditProcId(s.id);
        setAddProcFor(ws.id);
        setProcLabel(s.label);
        setProcCommand(s.meta?.command ?? '');
        if (isSystemWorkspace(ws)) {
            // System process: the cwd IS the absolute picked directory.
            setProcCwd('');
            setProcDir(s.cwd || ws.path);
        } else {
            // Reverse-map the absolute cwd back to a repo name (or '' = root).
            const prefix = `${ws.path}/repos/`;
            setProcCwd(s.cwd?.startsWith(prefix) ? s.cwd.slice(prefix.length) : '');
            setProcDir('');
        }
        setProcShell(s.shell ?? '');
        loadProcFormMeta(ws);
    };

    // Open the native directory picker for a System Workspace process, seeded at
    // the System Workspace's home path. Keeps the current pick on cancel.
    const pickProcDir = (ws: WorkspaceRow) => {
        void api()
            .settings.chooseFolder('Choose a directory for this process', procDir || ws.path)
            .then((dir) => {
                if (dir) setProcDir(dir);
            })
            .catch(() => {});
    };

    const submitAddProcess = (ws: WorkspaceRow) => {
        const cmd = procCommand.trim();
        if (!cmd) return;
        const system = isSystemWorkspace(ws);
        // System process: cwd is the picked absolute directory (required).
        // Workspace process: procCwd holds a repo name → <root>/repos/<name>,
        // or '' = envelope root (undefined lets the handler default to root).
        if (system && !procDir) return;
        const cwd = system
            ? procDir
            : procCwd
              ? `${ws.path}/repos/${procCwd}`
              : undefined;
        if (editProcId) {
            const wasRunning = ['running', 'restarting'].includes(
                processStatus.get(editProcId) ?? 'stopped',
            );
            onUpdateProcess(
                editProcId,
                {
                    command: cmd,
                    label: procLabel.trim() || undefined,
                    cwd,
                    shell: procShell || undefined,
                },
                wasRunning,
            );
        } else {
            onAddProcess(
                ws.id,
                cmd,
                procLabel.trim() || undefined,
                cwd,
                procShell || undefined,
            );
        }
        setAddProcFor(null);
        setEditProcId(null);
    };

    const [search, setSearch] = useState('');
    const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
        () => new Set(),
    );
    // Persisted sidebar expand/collapse: seed from the `collapsed_workspaces`
    // setting (a JSON string[] of workspace ids) on mount so the state survives
    // restarts. Toggling a row writes it back (see toggleCollapse below).
    useEffect(() => {
        let alive = true;
        void api()
            .settings.get()
            .then((s) => {
                if (!alive) return;
                try {
                    const ids = JSON.parse(s?.collapsed_workspaces ?? '[]');
                    if (Array.isArray(ids)) setCollapsedWorkspaces(new Set(ids));
                } catch {
                    /* ignore malformed value */
                }
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, []);

    // Drag-to-reorder (flyout only). `dragOrder` is a live preview of the id
    // order while a drag is in flight; the rail + flyout both render from it
    // so the rail "updates based on the flyout". Committed on drop.
    const [dragOrder, setDragOrder] = useState<string[] | null>(null);
    const draggingId = useRef<string | null>(null);

    const baseOrder = dragOrder
        ? (dragOrder
              .map((id) => workspaces.find((w) => w.id === id))
              .filter((w): w is WorkspaceRow => !!w))
        : workspaces;
    // Pin the System Workspace to the top — it's fixed (non-draggable) and must
    // never be shuffled down by a reorder of the real workspaces.
    const orderedWorkspaces = (() => {
        const i = baseOrder.findIndex(isSystemWorkspace);
        if (i <= 0) return baseOrder;
        const next = [...baseOrder];
        const [sys] = next.splice(i, 1);
        next.unshift(sys);
        return next;
    })();

    const reorderPreview = (overId: string) => {
        const id = draggingId.current;
        if (!id || id === overId) return;
        setDragOrder((cur) => {
            const list = cur ?? workspaces.map((w) => w.id);
            const from = list.indexOf(id);
            const to = list.indexOf(overId);
            if (from === -1 || to === -1 || from === to) return list;
            const next = [...list];
            next.splice(from, 1);
            next.splice(to, 0, id);
            return next;
        });
    };

    const commitReorder = () => {
        const list = dragOrder;
        draggingId.current = null;
        setDragOrder(null);
        if (list) onReorderWorkspaces(list);
    };

    // Background-process status (the headless supervisor in main is the source
    // of truth). The workspace-row indicator + the inline manager read from
    // this; processes keep running regardless of whether a row is expanded.
    const [processStatus, setProcessStatus] = useState<
        Map<string, ProcessStatus>
    >(() => new Map());
    const [expandedProcs, setExpandedProcs] = useState<Set<string>>(
        () => new Set(),
    );

    useEffect(() => {
        let alive = true;
        void api()
            .process.statuses()
            .then((m) => {
                if (alive)
                    setProcessStatus(
                        new Map(Object.entries(m) as [string, ProcessStatus][]),
                    );
            })
            .catch(() => {});
        const off = api().on.processStatus(({ id, status }) =>
            setProcessStatus((prev) => {
                const next = new Map(prev);
                next.set(id, status);
                return next;
            }),
        );
        return () => {
            alive = false;
            off();
        };
    }, []);

    // Agent-integration MCP: a terminal called imDone → briefly pulse its
    // WORKSPACE row (rail button + flyout row) as a sidebar-level "something
    // finished here" cue. Distinct from the persistent terminal attention glow.
    // Each pulse adds the id to `pulsingWs` for PULSE_MS, then clears it; a fresh
    // pulse for the same workspace resets its timer so re-pulses don't truncate.
    const PULSE_MS = 1500;
    const [pulsingWs, setPulsingWs] = useState<Set<string>>(() => new Set());
    const pulseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
        new Map(),
    );
    useEffect(() => {
        const timers = pulseTimers.current;
        const off = api().on.workspacePulse(({ workspaceId }) => {
            if (!workspaceId) return;
            setPulsingWs((prev) => {
                if (prev.has(workspaceId)) return prev;
                const next = new Set(prev);
                next.add(workspaceId);
                return next;
            });
            const existing = timers.get(workspaceId);
            if (existing) clearTimeout(existing);
            timers.set(
                workspaceId,
                setTimeout(() => {
                    timers.delete(workspaceId);
                    setPulsingWs((prev) => {
                        if (!prev.has(workspaceId)) return prev;
                        const next = new Set(prev);
                        next.delete(workspaceId);
                        return next;
                    });
                }, PULSE_MS),
            );
        });
        return () => {
            off();
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
        };
    }, []);

    // AgentPulse: SUSTAINED per-workspace terminal activity (distinct from the
    // one-shot imDone pulse above). `activeWs` drives a live glow on the rail icon
    // + workspace bar while a terminal is receiving bytes; `pulseRings` holds a
    // rolling 60×1s byte ring per workspace that draws the 1-minute sparkline
    // behind each bar. Backfilled once from a snapshot, advanced by pushed
    // `agent-pulse` events, and shifted by a 1s timer that SELF-SUSPENDS when all
    // rings go quiet (no idle polling — it restarts on the next pulse).
    const [activeWs, setActiveWs] = useState<Set<string>>(() => new Set());
    const pulseRings = useRef<Map<string, number[]>>(new Map());
    const [, setPulseTick] = useState(0);
    const pulseTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => {
        const bump = () => setPulseTick((t) => (t + 1) % 1_000_000);
        const stopTimer = () => {
            if (pulseTimer.current) {
                clearInterval(pulseTimer.current);
                pulseTimer.current = null;
            }
        };
        const ensureTimer = () => {
            if (pulseTimer.current) return;
            pulseTimer.current = setInterval(() => {
                let anyData = false;
                for (const ring of pulseRings.current.values()) {
                    ring.shift();
                    ring.push(0);
                    if (!anyData && ring.some((v) => v > 0)) anyData = true;
                }
                bump();
                if (!anyData) stopTimer();
            }, 1000);
        };

        let cancelled = false;
        void api()
            .agentPulse.snapshot()
            .then(({ pulses }) => {
                if (cancelled) return;
                let any = false;
                for (const [wsId, arr] of Object.entries(pulses)) {
                    pulseRings.current.set(wsId, arr.slice(-60));
                    if (arr.some((v) => v > 0)) any = true;
                }
                bump();
                if (any) ensureTimer();
            })
            .catch(() => {});

        const off = api().on.agentPulse(({ workspaceId, active, bytes }) => {
            if (!workspaceId) return;
            setActiveWs((prev) => {
                if (active === prev.has(workspaceId)) return prev;
                const next = new Set(prev);
                if (active) next.add(workspaceId);
                else next.delete(workspaceId);
                return next;
            });
            if (bytes > 0) {
                let ring = pulseRings.current.get(workspaceId);
                if (!ring) {
                    ring = new Array(60).fill(0);
                    pulseRings.current.set(workspaceId, ring);
                }
                ring[ring.length - 1] += bytes;
                bump();
                ensureTimer();
            }
        });
        return () => {
            cancelled = true;
            off();
            stopTimer();
        };
    }, []);

    // AgentPulse per-terminal LIGHT: the sparkline above is workspace-level and
    // only draws for a COLLAPSED workspace (see the render below); an EXPANDED
    // workspace instead lights a small dot on each terminal ROW for that
    // terminal's OWN activity. Reuses the exact `terminal:data` push
    // Terminal.tsx already consumes to feed its own xterm — no new IPC/polling.
    // `streamingTerms` briefly holds a spec id, cleared TERM_LIGHT_MS after its
    // last byte (a fresh byte resets the timer), so the dot reads as "receiving
    // bytes right now", distinct from `activeIds` (the pty is alive/live).
    const TERM_LIGHT_MS = 1200;
    const [streamingTerms, setStreamingTerms] = useState<Set<string>>(
        () => new Set(),
    );
    const termLightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
        new Map(),
    );
    useEffect(() => {
        const timers = termLightTimers.current;
        const off = api().on.terminalData(({ id }) => {
            setStreamingTerms((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
            const existing = timers.get(id);
            if (existing) clearTimeout(existing);
            timers.set(
                id,
                setTimeout(() => {
                    timers.delete(id);
                    setStreamingTerms((prev) => {
                        if (!prev.has(id)) return prev;
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                }, TERM_LIGHT_MS),
            );
        });
        return () => {
            off();
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
        };
    }, []);

    // New-workspace ENTRY animation: when a genuinely-new workspace id appears in
    // the (host-sourced) list — e.g. one a workstation auto-provisioned and
    // pushed to this REMOTE session over the bridge — fade/slide its rail button
    // + flyout row IN instead of popping. `seenWsRef` is the id baseline as of
    // the last commit; a null baseline (first render) animates NOTHING, so the
    // INITIAL list never animates — only genuine later arrivals do. The class is
    // dropped after ENTER_MS, mirroring the `pulsing` one-shot, so existing rows
    // never re-animate on a re-render/reorder/rename. NO polling — this reacts to
    // the list the renderer already refreshes on the host's broadcast.
    const ENTER_MS = 640;
    const [enteringWs, setEnteringWs] = useState<Set<string>>(() => new Set());
    const seenWsRef = useRef<Set<string> | null>(null);
    const enterTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
        new Map(),
    );
    // useLayoutEffect (not useEffect): the setState it schedules is flushed
    // BEFORE the browser paints, so the freshly-mounted row gets `ws-enter` on
    // its first painted frame (animation starts at opacity 0) — no pop-then-fade.
    useLayoutEffect(() => {
        const current = enterableWorkspaceIds(workspaces, SYSTEM_WORKSPACE_ID);
        const fresh = newlyAddedWorkspaceIds(seenWsRef.current, current);
        seenWsRef.current = current;
        if (fresh.length === 0) return;
        setEnteringWs((prev) => {
            const next = new Set(prev);
            for (const id of fresh) next.add(id);
            return next;
        });
        const timers = enterTimers.current;
        for (const id of fresh) {
            const existing = timers.get(id);
            if (existing) clearTimeout(existing);
            timers.set(
                id,
                setTimeout(() => {
                    timers.delete(id);
                    setEnteringWs((prev) => {
                        if (!prev.has(id)) return prev;
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                }, ENTER_MS),
            );
        }
    }, [workspaces]);
    useEffect(() => {
        const timers = enterTimers.current;
        return () => {
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
        };
    }, []);

    // Which workspaces' `.agi` envelopes declare a Tynn MCP server. The Tynn
    // glyph on a spec reflects REAL Tynn-MCP presence (a server named `tynn` in
    // the envelope's .mcp.json / .cursor/mcp.json), not the product backend
    // (ws.backend). Only .agi envelopes have an mcpStatus; a simple workspace
    // never gets the glyph. Re-runs when the set of .agi workspace paths
    // changes (refetch is cheap; mcpStatus is a small file read in main).
    const [tynnMcpWs, setTynnMcpWs] = useState<Set<string>>(() => new Set());
    const agiPathsKey = workspaces
        .filter((w) => w.shape === 'agi')
        .map((w) => `${w.id}:${w.path}`)
        .join('|');
    useEffect(() => {
        let alive = true;
        const agi = workspaces.filter((w) => w.shape === 'agi');
        void Promise.all(
            agi.map((w) =>
                api()
                    .agi.mcpStatus(w.path)
                    .then((m) => {
                        // Match the server named `tynn` (case-insensitive) in
                        // either the repo-sourced or envelope-root servers.
                        const names = [...m.repoServers, ...m.rootServers];
                        const has = names.some((n) => n.toLowerCase() === 'tynn');
                        return [w.id, has] as const;
                    })
                    .catch(() => [w.id, false] as const),
            ),
        ).then((pairs) => {
            if (!alive) return;
            setTynnMcpWs(new Set(pairs.filter(([, has]) => has).map(([id]) => id)));
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agiPathsKey]);

    const toggleProcs = (wsId: string) =>
        setExpandedProcs((prev) => {
            const next = new Set(prev);
            if (next.has(wsId)) next.delete(wsId);
            else next.add(wsId);
            return next;
        });

    /** Aggregate a workspace's process statuses into the row indicator colour. */
    const wsProcStatus = (
        procSpecs: TerminalSpec[],
    ): 'none' | 'idle' | 'running' | 'crashed' => {
        if (!procSpecs.length) return 'none';
        let running = false;
        for (const s of procSpecs) {
            const st = processStatus.get(s.id) ?? 'stopped';
            if (st === 'crashed' || st === 'failed') return 'crashed';
            if (st === 'running' || st === 'restarting') running = true;
        }
        return running ? 'running' : 'idle';
    };

    const deleteProcess = async (s: TerminalSpec) => {
        const ok = await showPrompt({
            title: 'Delete process',
            body: `Delete "${s.label}"? It will be stopped and removed.`,
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (ok !== null) onDestroySpec(s.id);
    };

    // Hover log popover for processes — fetch the recent output tail and show it
    // anchored to the right of the hovered row. Cleared on mouse-leave.
    const [procLog, setProcLog] = useState<{
        id: string;
        label: string;
        command: string;
        text: string;
        top: number;
        left: number;
    } | null>(null);

    // Delay-hide so the user can move the cursor INTO the (now interactive)
    // popover to use its Copy/Download buttons without it vanishing.
    const procLogHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelProcLogHide = () => {
        if (procLogHideRef.current) {
            clearTimeout(procLogHideRef.current);
            procLogHideRef.current = null;
        }
    };
    // The popover displays only the last N lines (tail) — a chatty process would
    // otherwise render tens of thousands of lines into one <pre>. Copy/Download
    // still fetch the FULL buffer separately, so nothing is lost by capping the view.
    const LOG_TAIL_LINES = 500;
    const tailLines = (text: string): string => {
        const lines = text.split('\n');
        return lines.length > LOG_TAIL_LINES ? lines.slice(-LOG_TAIL_LINES).join('\n') : text;
    };
    const showProcLog = (e: React.MouseEvent, s: TerminalSpec) => {
        cancelProcLogHide();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        // Clamp the popover's top so a row near the bottom of the panel doesn't get
        // its log cut off by the viewport edge — shift it UP to fit. The popover is
        // ~340px tall (head + a 240px-max scrolling body + foot); keep a small margin.
        const POP_MAX_H = 340;
        const MARGIN = 12;
        const top = Math.max(MARGIN, Math.min(r.top, window.innerHeight - POP_MAX_H - MARGIN));
        setProcLog({
            id: s.id,
            label: s.label,
            command: s.meta?.command ?? '',
            text: '',
            top,
            left: r.right + 8,
        });
        void api()
            .process.log(s.id)
            .then((text) =>
                setProcLog((cur) =>
                    cur && cur.id === s.id ? { ...cur, text: tailLines(text) } : cur,
                ),
            )
            .catch(() => {});
    };
    const scheduleHideProcLog = (id: string) => {
        cancelProcLogHide();
        procLogHideRef.current = setTimeout(() => {
            setProcLog((cur) => (cur && cur.id === id ? null : cur));
        }, 250);
    };
    const copyProcLogTail = (text: string) => {
        const tail = text.split('\n').slice(-100).join('\n');
        void navigator.clipboard.writeText(tail).catch(() => {});
    };
    const downloadProcLog = (id: string, label: string) => {
        void api()
            .process.log(id)
            .then((text) => {
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${(label || 'process').replace(/[^\w.-]+/g, '_')}.log`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            })
            .catch(() => {});
    };
    // Clear a process's recorded output — drop the backing buffer (main) AND the
    // displayed text. New output refills as the process keeps running (next poll).
    const clearProcLog = (id: string) => {
        void api().process.clearLog(id).catch(() => {});
        setProcLog((cur) => (cur && cur.id === id ? { ...cur, text: '' } : cur));
    };

    // Keep the open popover LIVE: while it's showing a process, re-fetch its tail
    // on a short interval so output appears in place (the buffer only refreshed on
    // hover before). Keyed on the open process id — NOT the whole procLog object,
    // which changes each poll — so the interval isn't torn down and recreated every
    // tick. Cleared on close/unmount / when a different row opens.
    const openProcLogId = procLog?.id ?? null;
    useEffect(() => {
        if (!openProcLogId) return;
        const iv = setInterval(() => {
            void api()
                .process.log(openProcLogId)
                .then((text) =>
                    setProcLog((cur) =>
                        cur && cur.id === openProcLogId ? { ...cur, text: tailLines(text) } : cur,
                    ),
                )
                .catch(() => {});
        }, 1000);
        return () => clearInterval(iv);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openProcLogId]);

    const byWorkspace = new Map<string, TerminalSpec[]>();
    for (const ws of workspaces) byWorkspace.set(ws.id, []);
    const orphaned: TerminalSpec[] = [];
    // System Workspace specs persist UNATTACHED (workspace_id: null) but carry a
    // `meta.system` tag — route them to the System Workspace bucket when that
    // row is present (revealed). They are NEVER orphaned, so they don't leak
    // into the Unattached group when the System Workspace is hidden.
    const systemWs = workspaces.find(isSystemWorkspace);
    for (const s of specs) {
        const isSystemSpec = s.workspace_id === null && s.meta?.system === true;
        if (isSystemSpec) {
            if (systemWs) byWorkspace.get(systemWs.id)!.push(s);
            continue;
        }
        if (s.workspace_id && byWorkspace.has(s.workspace_id)) {
            byWorkspace.get(s.workspace_id)!.push(s);
        } else {
            orphaned.push(s);
        }
    }

    // The search box now filters the WORKSPACE list (the sidebar is more than
    // terminals). Match on the project name or path; empty query shows all.
    const workspaceMatches = (ws: WorkspaceRow): boolean => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
            ws.project_name.toLowerCase().includes(q) ||
            ws.path.toLowerCase().includes(q)
        );
    };
    // Orphaned (unattached) terminals are still filtered by the query so the
    // box stays useful for that bucket; matches on label or cwd.
    const orphanMatches = (s: TerminalSpec): boolean => {
        if (!search) return true;
        const q = search.toLowerCase();
        return s.label.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q);
    };

    return (
        <>
        <div className={`chooser${pinned ? ' pinned' : ''}`}>
            <aside className="chooser-rail">
                <button
                    type="button"
                    className="crail-toggle"
                    onClick={onTogglePin}
                    title={pinned ? 'Unpin terminals panel' : 'Pin terminals panel'}
                >
                    {pinned ? <IconPin size={18} /> : <IconPanelLeftOpen size={18} />}
                </button>
                <span className="crail-sep" />
                {orderedWorkspaces.map((ws) => {
                    const wsSpecs = byWorkspace.get(ws.id) ?? [];
                    const live = wsSpecs.filter((s) => activeIds.has(s.id)).length;
                    const wsAttention = workspaceNeedsAttention(wsSpecs, attentionIds);
                    const isActive = ws.id === activeWorkspaceId;
                    return (
                        <button
                            key={ws.id}
                            type="button"
                            className={`crail-btn${live > 0 ? ' active' : ''}${
                                isActive ? ' is-active' : ''
                            }${wsAttention ? ' attention' : ''}${
                                pulsingWs.has(ws.id) ? ' pulsing' : ''
                            }${activeWs.has(ws.id) ? ' agent-active' : ''}${
                                enteringWs.has(ws.id) ? ' ws-enter' : ''
                            }`}
                            onClick={() => onActivateWorkspace(ws.id)}
                            title={`${ws.project_name}${live > 0 ? ` · ${live} live` : ''}`}
                        >
                            {workspaceIcon(ws)}
                            {live > 0 && <span className="cnt">{live}</span>}
                            {(() => {
                                const c = issueWatchCounts[ws.id];
                                const n = c ? c.issue + c.pr + c.security : 0;
                                return n > 0 ? (
                                    <span
                                        className="iw-rail-dot"
                                        title={`${n} unread issue/PR/alert`}
                                    />
                                ) : null;
                            })()}
                        </button>
                    );
                })}
                <span className="crail-sep" />
                <button
                    type="button"
                    className="crail-btn"
                    title="Add workspace"
                    onClick={onAddWorkspace}
                >
                    <IconPlus size={18} />
                </button>
            </aside>

            <aside className="chooser-flyout">
                {/* Top row: the System Workspace toggle (its chip icon mirrors
                    how regular workspaces render in the sidebar) + the search
                    box, on a single line. The old "Terminals" title + subtext +
                    pin lived here; the side rail already owns the pin, so this
                    reclaims the space. */}
                <div className="rail-head">
                    <button
                        type="button"
                        className={`gicon rail-system-toggle${
                            systemRevealed ? ' on' : ''
                        }`}
                        onClick={onToggleSystemWorkspace}
                        title={
                            systemRevealed
                                ? 'Hide System Workspace'
                                : 'Show System Workspace'
                        }
                        aria-label={
                            systemRevealed
                                ? 'Hide System Workspace'
                                : 'Show System Workspace'
                        }
                        aria-pressed={systemRevealed}
                    >
                        <IconMonitorCog size={16} />
                    </button>
                    <div className="rail-search">
                        <IconSearch />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search workspaces…"
                        />
                    </div>
                </div>

                <div className="rail-scroll">
                    <button
                        type="button"
                        className="tproj-add"
                        onClick={onAddWorkspace}
                    >
                        <IconPlus size={13} />
                        <span>Add workspace…</span>
                    </button>

                    {workspaces.length === 0 && (
                        <div
                            style={{
                                padding: '12px 8px',
                                fontSize: 12,
                                color: 'var(--fg-4)',
                                lineHeight: 1.5,
                            }}
                        >
                            No workspaces yet. Click <strong>Add workspace…</strong>{' '}
                            above to register a project folder.
                        </div>
                    )}

                    {orderedWorkspaces.filter(workspaceMatches).map((ws) => {
                        const system = isSystemWorkspace(ws);
                        const wsAll = byWorkspace.get(ws.id) ?? [];
                        const wsSpecs = wsAll.filter((s) => s.type !== 'process');
                        const wsProcs = wsAll.filter((s) => s.type === 'process');
                        const collapsed = collapsedWorkspaces.has(ws.id);
                        // Same derivation the rail uses: any terminal in the
                        // workspace flagged for attention → the ROW glows, so a
                        // COLLAPSED workspace shows it's ready without expanding.
                        const wsAttention = workspaceNeedsAttention(wsAll, attentionIds);
                        const isActive = ws.id === activeWorkspaceId;
                        const dragging = draggingId.current === ws.id;
                        const toggleCollapse = () =>
                            setCollapsedWorkspaces((prev) => {
                                const next = new Set(prev);
                                if (collapsed) next.delete(ws.id);
                                else next.add(ws.id);
                                // Persist so the expand/collapse state survives a
                                // restart (JSON string[], k/v values are text).
                                void api()
                                    .settings.set({
                                        collapsed_workspaces: JSON.stringify([...next]),
                                    })
                                    .catch(() => {});
                                return next;
                            });
                        return (
                            <div
                                key={ws.id}
                                className={`tproj${collapsed ? ' collapsed' : ''}${
                                    isActive ? ' is-active' : ''
                                }${dragging ? ' dragging' : ''}${
                                    ws.shape === 'agi' ? ' agi' : ''
                                }${wsAttention ? ' attention' : ''}${
                                    pulsingWs.has(ws.id) ? ' pulsing' : ''
                                }${activeWs.has(ws.id) ? ' agent-active' : ''}${
                                    enteringWs.has(ws.id) ? ' ws-enter' : ''
                                }`}
                                onDragOver={(e) => {
                                    if (!draggingId.current) return;
                                    e.preventDefault();
                                    reorderPreview(ws.id);
                                }}
                                onDrop={(e) => {
                                    if (!draggingId.current) return;
                                    e.preventDefault();
                                    commitReorder();
                                }}
                            >
                                {/* AgentPulse: last-60s activity sparkline drawn
                                    BEHIND the row content — COLLAPSED workspaces
                                    only. An expanded workspace shows its own
                                    terminals' rows instead, each with its own
                                    per-terminal activity light (SpecRow below). */}
                                {collapsed && (
                                    <AgentPulseSparkline
                                        ring={pulseRings.current.get(ws.id)}
                                        active={activeWs.has(ws.id)}
                                    />
                                )}
                                <button
                                    type="button"
                                    className="tproj-head"
                                    title={
                                        system
                                            ? 'System Workspace — click to activate'
                                            : 'Click to activate · drag to reorder'
                                    }
                                    onClick={() => onActivateWorkspace(ws.id)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        // The System Workspace has no project
                                        // menu (no settings / remove / browser).
                                        if (system) return;
                                        onOpenProjectMenu(ws.id, {
                                            x: e.clientX,
                                            y: e.clientY,
                                        });
                                    }}
                                    // The whole row is the drag handle (a plain click
                                    // still activates; a drag reorders). No leading
                                    // grip element — that pushed the header content in
                                    // past the view rows. The System Workspace is
                                    // never reordered (always last), so it's fixed.
                                    draggable={!system}
                                    onDragStart={(e) => {
                                        if (system) return;
                                        draggingId.current = ws.id;
                                        setDragOrder(workspaces.map((w) => w.id));
                                        e.dataTransfer.effectAllowed = 'move';
                                        // Firefox needs data set to start a drag.
                                        e.dataTransfer.setData('text/plain', ws.id);
                                    }}
                                    onDragEnd={() => commitReorder()}
                                >
                                    <span
                                        className="chev"
                                        role="button"
                                        tabIndex={-1}
                                        title={collapsed ? 'Expand' : 'Collapse'}
                                        onClick={(e) => {
                                            // Chevron toggles collapse WITHOUT
                                            // activating the workspace.
                                            e.stopPropagation();
                                            toggleCollapse();
                                        }}
                                    >
                                        <IconChevronDown />
                                    </span>
                                    <span className="pico">
                                        {workspaceIcon(ws, 14)}
                                        {wsSpecs.length > 1 && (
                                            <span
                                                className="pico-count"
                                                title={`${wsSpecs.length} views`}
                                            >
                                                {wsSpecs.length}
                                            </span>
                                        )}
                                    </span>
                                    <span className="pname">{ws.project_name}</span>
                                    {ws.shape === 'agi' && <AgiHealth ws={ws} />}
                                    {/* Issue Watch is GitHub-scoped — not for the
                                        synthetic System Workspace. */}
                                    {!system && (
                                        <span
                                            className="iw-pill"
                                            role="button"
                                            tabIndex={-1}
                                            title="Issue Watch — Issues · PRs · Security alerts (click to open)"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onShowIssueWatch(ws.id);
                                            }}
                                        >
                                            <i
                                                className={`iw-dot iw-dot-issue${
                                                    (issueWatchCounts[ws.id]?.issue ?? 0) > 0
                                                        ? ' on'
                                                        : ''
                                                }`}
                                                title="Issues"
                                            />
                                            <i
                                                className={`iw-dot iw-dot-pr${
                                                    (issueWatchCounts[ws.id]?.pr ?? 0) > 0
                                                        ? ' on'
                                                        : ''
                                                }`}
                                                title="PRs"
                                            />
                                            <i
                                                className={`iw-dot iw-dot-security${
                                                    (issueWatchCounts[ws.id]?.security ?? 0) > 0
                                                        ? ' on'
                                                        : ''
                                                }`}
                                                title="Security alerts (Dependabot · Code scanning · Secret scanning)"
                                            />
                                        </span>
                                    )}
                                    <span
                                        className={`proc-ind proc-${wsProcStatus(
                                            wsProcs,
                                        )}${
                                            expandedProcs.has(ws.id) ? ' open' : ''
                                        }`}
                                        role="button"
                                        tabIndex={-1}
                                        title={
                                            wsProcs.length
                                                ? `Background processes (${wsProcs.length})`
                                                : 'Background processes'
                                        }
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleProcs(ws.id);
                                        }}
                                    >
                                        <IconCpu size={13} />
                                    </span>
                                </button>
                                <div className="tproj-body">
                                    {wsSpecs.map((s) => (
                                        <SpecRow
                                            key={s.id}
                                            spec={s}
                                            checked={selected.has(s.id)}
                                            live={activeIds.has(s.id)}
                                            pulse={streamingTerms.has(s.id)}
                                            attention={attentionIds.has(s.id)}
                                            suspended={s.enabled === false}
                                            hasTynnMcp={tynnMcpWs.has(ws.id)}
                                            onToggle={() => onToggleSpec(s.id)}
                                            onDestroy={() => onDestroySpec(s.id)}
                                            onDisable={() => onDisableSpec(s.id)}
                                            onEnable={() => onEnableSpec(s.id)}
                                            onActivate={() => onActivateWorkspace(ws.id)}
                                            onContextMenu={(p) =>
                                                onOpenContextMenu(s.id, p)
                                            }
                                        />
                                    ))}
                                    <div className="tproj-adds">
                                        <TerminalTypeSplitButton
                                            variant="row"
                                            disabled={false}
                                            workspaceId={ws.id}
                                            workspaces={workspaces}
                                            lastType={lastTerminalType}
                                            onLastTypeChange={onLastTerminalType}
                                            onAddView={(type) => onAddSpec(ws.id, type)}
                                            onAgentCreated={onAgentCreated}
                                            customCommand={agentCustomCommand}
                                        />
                                        {/* "Add Files…" stays a distinct action next to the
                                            terminal-type split button. */}
                                        <button
                                            type="button"
                                            className="tterm tterm-add"
                                            onClick={() => onAddSpec(ws.id, 'code')}
                                        >
                                            <span className="pick" />
                                            <IconCode size={12} />
                                            <span className="tname">Add Files…</span>
                                        </button>
                                    </div>
                                    {expandedProcs.has(ws.id) && (
                                        <div className="tproj-procs">
                                            <div className="tproj-subhead">
                                                <IconCpu size={12} />
                                                <span>Processes</span>
                                            </div>
                                            {wsProcs.length === 0 && (
                                                <div className="proc-empty">
                                                    No background processes yet.
                                                </div>
                                            )}
                                            {wsProcs.map((s) => {
                                                const st =
                                                    processStatus.get(s.id) ?? 'stopped';
                                                const live =
                                                    st === 'running' ||
                                                    st === 'restarting';
                                                return (
                                                    <div
                                                        key={s.id}
                                                        className="proc-row"
                                                        onMouseEnter={(e) =>
                                                            showProcLog(e, s)
                                                        }
                                                        onMouseLeave={() =>
                                                            scheduleHideProcLog(s.id)
                                                        }
                                                        onContextMenu={(e) => {
                                                            e.preventDefault();
                                                            setProcLog(null);
                                                            setProcMenu({
                                                                spec: s,
                                                                x: e.clientX,
                                                                y: e.clientY,
                                                            });
                                                        }}
                                                    >
                                                        <span
                                                            className={`proc-dot proc-${st}`}
                                                        />
                                                        <span className="proc-name">
                                                            {s.label}
                                                        </span>
                                                        {live ? (
                                                            <button
                                                                type="button"
                                                                className="proc-act"
                                                                title="Stop"
                                                                onClick={() =>
                                                                    void api().process.stop(
                                                                        s.id,
                                                                    )
                                                                }
                                                            >
                                                                <IconPause size={12} />
                                                            </button>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                className="proc-act proc-go"
                                                                title="Start"
                                                                onClick={() =>
                                                                    void api().process.start(
                                                                        s.id,
                                                                    )
                                                                }
                                                            >
                                                                <IconPlay size={12} />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="proc-act"
                                                            title="Restart"
                                                            onClick={() =>
                                                                void api().process.restart(
                                                                    s.id,
                                                                )
                                                            }
                                                        >
                                                            <IconRefresh size={12} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="proc-act proc-del"
                                                            title="Delete process"
                                                            onClick={() =>
                                                                void deleteProcess(s)
                                                            }
                                                        >
                                                            <IconTrash size={12} />
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                            {addProcFor === ws.id ? (
                                                <div className="proc-add-form">
                                                    <input
                                                        className="input"
                                                        autoFocus
                                                        value={procCommand}
                                                        onChange={(e) =>
                                                            setProcCommand(e.target.value)
                                                        }
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter')
                                                                submitAddProcess(ws);
                                                            if (e.key === 'Escape')
                                                                setAddProcFor(null);
                                                        }}
                                                        placeholder="Command e.g. php artisan queue:work"
                                                    />
                                                    <input
                                                        className="input"
                                                        value={procLabel}
                                                        onChange={(e) =>
                                                            setProcLabel(e.target.value)
                                                        }
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter')
                                                                submitAddProcess(ws);
                                                            if (e.key === 'Escape')
                                                                setAddProcFor(null);
                                                        }}
                                                        placeholder="Label (optional)"
                                                    />
                                                    {system ? (
                                                        // System process: no repo —
                                                        // pick an arbitrary directory
                                                        // (native picker, seeded at ~/).
                                                        <button
                                                            type="button"
                                                            className="input proc-add-dir"
                                                            onClick={() => pickProcDir(ws)}
                                                            title={
                                                                procDir ||
                                                                'Choose a directory for this process'
                                                            }
                                                        >
                                                            <IconBox size={12} />
                                                            <span className="proc-add-dir-path">
                                                                {procDir ||
                                                                    'Choose directory…'}
                                                            </span>
                                                        </button>
                                                    ) : (
                                                        <select
                                                            className="input proc-add-cwd"
                                                            value={procCwd}
                                                            onChange={(e) =>
                                                                setProcCwd(e.target.value)
                                                            }
                                                            title="Where the process runs"
                                                        >
                                                            <option value="">
                                                                Workspace root
                                                            </option>
                                                            {procRepos.map((r) => (
                                                                <option key={r} value={r}>
                                                                    repos/{r}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    )}
                                                    <select
                                                        className="input proc-add-cwd"
                                                        value={procShell}
                                                        onChange={(e) =>
                                                            setProcShell(e.target.value)
                                                        }
                                                        title="Which shell runs the command"
                                                    >
                                                        <option value="">
                                                            Default shell
                                                        </option>
                                                        {procShells.map((sh) => (
                                                            <option
                                                                key={sh.id}
                                                                value={sh.command}
                                                            >
                                                                {sh.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <div className="proc-add-actions">
                                                        <button
                                                            type="button"
                                                            className="proc-add-btn"
                                                            onClick={() => {
                                                                setAddProcFor(null);
                                                                setEditProcId(null);
                                                            }}
                                                        >
                                                            Cancel
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="proc-add-btn proc-add-go"
                                                            disabled={
                                                                !procCommand.trim() ||
                                                                (system && !procDir)
                                                            }
                                                            onClick={() =>
                                                                submitAddProcess(ws)
                                                            }
                                                        >
                                                            {editProcId ? 'Save' : 'Create'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="tterm tterm-add"
                                                    onClick={() => openAddProcess(ws)}
                                                >
                                                    <span className="pick" />
                                                    <IconPlus size={12} />
                                                    <span className="tname">
                                                        Add Process…
                                                    </span>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {orphaned.length > 0 && (
                        <div className="tproj">
                            <div className="tproj-head">
                                <span className="chev">
                                    <IconChevronDown />
                                </span>
                                <span className="pico">
                                    <IconTerminal size={14} />
                                </span>
                                <span className="pname">Unattached</span>
                                <span className="pcount">{orphaned.length}</span>
                            </div>
                            <div className="tproj-body">
                                {orphaned.filter(orphanMatches).map((s) => (
                                    <SpecRow
                                        key={s.id}
                                        spec={s}
                                        checked={selected.has(s.id)}
                                        live={activeIds.has(s.id)}
                                        pulse={streamingTerms.has(s.id)}
                                        attention={attentionIds.has(s.id)}
                                        suspended={s.enabled === false}
                                        onToggle={() => onToggleSpec(s.id)}
                                        onDestroy={() => onDestroySpec(s.id)}
                                        onDisable={() => onDisableSpec(s.id)}
                                        onEnable={() => onEnableSpec(s.id)}
                                        onActivate={() => {
                                            // Orphaned specs may have no workspace;
                                            // activate one only when attached.
                                            if (s.workspace_id) {
                                                onActivateWorkspace(s.workspace_id);
                                            }
                                        }}
                                        onContextMenu={(p) =>
                                            onOpenContextMenu(s.id, p)
                                        }
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </aside>
        </div>
        {procLog &&
            typeof document !== 'undefined' &&
            createPortal(
                <div
                    className="proc-log-pop"
                    style={{ top: procLog.top, left: procLog.left }}
                    role="tooltip"
                    onMouseEnter={cancelProcLogHide}
                    onMouseLeave={() => setProcLog(null)}
                >
                    <div className="proc-log-head">
                        <span className="proc-log-name">{procLog.label}</span>
                        {procLog.command && (
                            <code className="proc-log-cmd">{procLog.command}</code>
                        )}
                    </div>
                    <pre className="proc-log-body">
                        {procLog.text.trim() || 'No output captured yet.'}
                    </pre>
                    <div className="proc-log-foot">
                        <button
                            type="button"
                            className="proc-log-btn"
                            onClick={() => copyProcLogTail(procLog.text)}
                            disabled={!procLog.text.trim()}
                        >
                            Copy last 100 lines
                        </button>
                        <button
                            type="button"
                            className="proc-log-btn"
                            onClick={() => downloadProcLog(procLog.id, procLog.label)}
                        >
                            Download log
                        </button>
                        <button
                            type="button"
                            className="proc-log-btn"
                            onClick={() => clearProcLog(procLog.id)}
                            disabled={!procLog.text.trim()}
                        >
                            Clear log
                        </button>
                    </div>
                </div>,
                document.body,
            )}
        {procMenu &&
            typeof document !== 'undefined' &&
            createPortal(
                <>
                    <div
                        className="proc-menu-scrim"
                        onMouseDown={() => setProcMenu(null)}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            setProcMenu(null);
                        }}
                    />
                    <div
                        className="proj-popover ctx-menu proc-ctx-menu"
                        style={{ top: procMenu.y, left: procMenu.x }}
                    >
                        <button
                            type="button"
                            className="proj-popover-item"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                const ws = workspaces.find(
                                    (w) => w.id === procMenu.spec.workspace_id,
                                );
                                if (ws) openEditProcess(ws, procMenu.spec);
                                setProcMenu(null);
                            }}
                        >
                            <span className="lbl">Edit process…</span>
                        </button>
                        <button
                            type="button"
                            className="proj-popover-item is-destructive"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                const s = procMenu.spec;
                                setProcMenu(null);
                                void deleteProcess(s);
                            }}
                        >
                            <span className="lbl">Delete process</span>
                        </button>
                    </div>
                </>,
                document.body,
            )}
        </>
    );
}

function workspaceIcon(ws: WorkspaceRow, size = 18) {
    // The synthetic System Workspace gets a distinct home glyph.
    if (isSystemWorkspace(ws)) return <IconHome size={size} />;
    if (ws.backend === 'aionima') return <IconCpu size={size} />;
    if (ws.shape === 'agi') return <IconBox size={size} />;
    return <IconGlobe size={size} />;
}

/** Slug an envelope folder back to its base name (drops the .agi suffix). */
function envelopeSlug(ws: WorkspaceRow): string {
    const leaf = (ws.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    return leaf.replace(/\.agi$/i, '') || ws.project_name;
}

/**
 * Health dot for an .agi envelope: checks whether the structure docs
 * (README/AGENTS/CLAUDE) are present. When any are missing it shows an
 * amber alert that opens a popover explaining + a one-click "Add &
 * push" that backfills, commits, and pushes them. Stops the propagation
 * to the collapse toggle since it lives inside the header button.
 */
function AgiHealth({ ws }: { ws: WorkspaceRow }) {
    const [status, setStatus] = useState<StructureDocStatus | null>(null);
    const [mcp, setMcp] = useState<McpStatus | null>(null);
    const [open, setOpen] = useState(false);
    const [docsBusy, setDocsBusy] = useState(false);
    const [mcpBusy, setMcpBusy] = useState(false);
    const [done, setDone] = useState<string | null>(null);
    const [mcpDone, setMcpDone] = useState<string | null>(null);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const anchorRef = useRef<HTMLSpanElement>(null);
    const popRef = useRef<HTMLDivElement>(null);

    const refresh = () => {
        void api()
            .agi.docStatus(ws.path)
            .then(setStatus)
            .catch(() => setStatus(null));
        void api()
            .agi.mcpStatus(ws.path)
            .then(setMcp)
            .catch(() => setMcp(null));
    };
    useEffect(refresh, [ws.path]);

    // Position the portaled popover under the alert dot, clamped to the
    // viewport. Recomputed on open; closed on scroll/resize so it never
    // drifts away from its anchor.
    const place = () => {
        const r = anchorRef.current?.getBoundingClientRect();
        if (!r) return;
        const width = 268;
        const left = Math.min(
            Math.max(8, r.right - width),
            window.innerWidth - width - 8,
        );
        setCoords({ top: r.bottom + 6, left });
    };

    useEffect(() => {
        if (!open) return;
        place();
        const onAway = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onScrollResize = () => setOpen(false);
        document.addEventListener('mousedown', onAway);
        window.addEventListener('resize', onScrollResize);
        // Capture scroll on any ancestor (the sidebar list scrolls).
        window.addEventListener('scroll', onScrollResize, true);
        return () => {
            document.removeEventListener('mousedown', onAway);
            window.removeEventListener('resize', onScrollResize);
            window.removeEventListener('scroll', onScrollResize, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const docsMissing = !!status && status.isEnvelope && status.missing;
    const mcpPending = !!mcp && mcp.needsConsolidation;
    // Show the alert only for a real envelope with at least one issue.
    if (!status || !status.isEnvelope || (!docsMissing && !mcpPending)) return null;

    const missingList = [
        !status.hasReadme && 'README.md',
        !status.hasAgents && 'AGENTS.md',
        !status.hasClaude && 'CLAUDE.md',
    ].filter(Boolean) as string[];

    const add = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setDocsBusy(true);
        setDone(null);
        try {
            const r = await api().agi.addDocs(ws.path, ws.project_name, envelopeSlug(ws));
            setDone(
                r.pushed
                    ? `Added + pushed ${r.added.length} file${r.added.length === 1 ? '' : 's'}.`
                    : r.committed
                        ? `Added + committed. Push skipped${r.pushError ? `: ${r.pushError}` : ' (no remote).'}`
                        : 'Nothing to add.',
            );
            refresh();
        } catch (err) {
            setDone(err instanceof Error ? err.message : String(err));
        } finally {
            setDocsBusy(false);
        }
    };

    const doConsolidateMcp = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setMcpBusy(true);
        setMcpDone(null);
        try {
            const r = await api().agi.consolidateMcp(ws.path);
            const n = r.servers.length;
            setMcpDone(
                r.gitignored
                    ? `Wrote config for ${n} server${n === 1 ? '' : 's'} to the envelope root. Local sessions use it now; not committed — these files are gitignored (they can hold MCP tokens).`
                    : !r.committed
                        ? 'MCP config already up to date.'
                        : r.pushed
                            ? `Consolidated ${n} server${n === 1 ? '' : 's'} + pushed.`
                            : `Consolidated ${n} server${n === 1 ? '' : 's'}. Push skipped${r.pushError ? `: ${r.pushError}` : ' (no remote).'}`,
            );
            refresh();
        } catch (err) {
            setMcpDone(err instanceof Error ? err.message : String(err));
        } finally {
            setMcpBusy(false);
        }
    };

    return (
        <span className="agi-health" ref={anchorRef}>
            <span
                className="agi-health-dot"
                role="button"
                tabIndex={0}
                title="Envelope is missing structure docs"
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => !o);
                }}
            >
                <IconAlert size={13} />
            </span>
            {open &&
                coords &&
                createPortal(
                    <div
                        ref={popRef}
                        className="agi-health-pop"
                        role="tooltip"
                        style={{ top: coords.top, left: coords.left }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="ahp-title">Envelope needs attention</div>

                        {docsMissing && (
                            <div className="ahp-section">
                                <div className="ahp-body">
                                    Missing structure docs:{' '}
                                    {missingList.map((m, i) => (
                                        <span key={m}>
                                            {i > 0 ? ', ' : ''}
                                            <code>{m}</code>
                                        </span>
                                    ))}
                                    . They explain the monorepo to humans (README)
                                    and agents (AGENTS/CLAUDE). Existing files are
                                    left untouched.
                                </div>
                                {done ? (
                                    <div className="ahp-done">{done}</div>
                                ) : (
                                    <button
                                        type="button"
                                        className="ahp-btn"
                                        onClick={add}
                                        disabled={docsBusy}
                                    >
                                        {docsBusy
                                            ? 'Working…'
                                            : status.hasRemote
                                                ? 'Add docs, commit & push'
                                                : 'Add docs & commit'}
                                    </button>
                                )}
                            </div>
                        )}

                        {mcpPending && (
                            <div className="ahp-section">
                                <div className="ahp-body">
                                    {mcp!.missingAtRoot.length > 0 ? (
                                        <>
                                            MCP server
                                            {mcp!.missingAtRoot.length === 1 ? '' : 's'}{' '}
                                            {mcp!.missingAtRoot.map((s, i) => (
                                                <span key={s}>
                                                    {i > 0 ? ', ' : ''}
                                                    <code>{s}</code>
                                                </span>
                                            ))}{' '}
                                            defined in repos aren't surfaced at the
                                            envelope root.
                                        </>
                                    ) : (
                                        <>
                                            The envelope's <code>.mcp.json</code> and{' '}
                                            <code>.cursor/mcp.json</code> are out of
                                            sync.
                                        </>
                                    )}{' '}
                                    Consolidate so sessions opened on the monorepo
                                    pick them up.
                                </div>
                                {mcpDone ? (
                                    <div className="ahp-done">{mcpDone}</div>
                                ) : (
                                    <button
                                        type="button"
                                        className="ahp-btn"
                                        onClick={doConsolidateMcp}
                                        disabled={mcpBusy}
                                    >
                                        {mcpBusy ? 'Working…' : 'Consolidate MCP config'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>,
                    document.body,
                )}
        </span>
    );
}

interface SpecRowProps {
    spec: TerminalSpec;
    checked: boolean;
    live: boolean;
    /** AgentPulse: this terminal is RECEIVING BYTES right now (distinct from
     *  `live`, which just means the pty is alive). Drives the row's activity
     *  light — the per-terminal replacement for the sparkline once its
     *  workspace is expanded. */
    pulse?: boolean;
    /** Agent-integration MCP: this terminal is pulsing for attention (imDone). */
    attention?: boolean;
    /** Tier 2: this spec is disabled-but-retained (suspended). */
    suspended: boolean;
    /** The workspace's `.agi` envelope declares a Tynn MCP server (a `tynn`
     *  server in its .mcp.json) — gates the Tynn brand glyph. Reflects real
     *  Tynn-MCP presence, not the product backend. */
    hasTynnMcp?: boolean;
    onToggle: () => void;
    onDestroy: () => void;
    onDisable: () => void;
    onEnable: () => void;
    /** Activate this view's workspace on row-click (jump to it in the master view). */
    onActivate: () => void;
    onContextMenu: (position: { x: number; y: number }) => void;
}

/**
 * One terminal row in the tree. The whole row is the toggle target; the
 * trash button on the right is a separate button that stops event
 * propagation so clicking it destroys the spec without also toggling
 * selection. A confirm guard fires for the destroy path because it
 * removes the spec from the DB and can't be undone.
 *
 * Tier 2: a SUSPENDED row (disabled-but-retained) reads greyed with a
 * "Suspended" badge; clicking it (or its Resume button) re-enables and
 * reattaches to the live pty. An ENABLED terminal row offers a Suspend
 * button next to Delete so disabling is reachable from the tree too.
 */
function SpecRow({
    spec,
    checked,
    live,
    pulse,
    attention,
    suspended,
    hasTynnMcp,
    onToggle,
    onDestroy,
    onDisable,
    onEnable,
    onActivate,
    onContextMenu,
}: SpecRowProps) {
    const handleDestroy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const ok = await showPrompt({
            title: 'Delete terminal',
            body: `Delete "${spec.label}"? Its saved spec is removed and any running shell is killed.`,
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (ok !== null) onDestroy();
    };
    const isTerminal = spec.type !== 'code';
    // Specialized (agent) terminal: mark the row with the agent glyph + a purpose
    // sub-label so the sidebar reads which AI is running and what it's for.
    const agentDef = spec.meta?.agent ? terminalTypeForAgent(spec.meta.agent) : null;
    const AgentIcon = agentDef?.icon;
    const purposeStr =
        typeof spec.meta?.purpose === 'string' ? (spec.meta.purpose as string) : '';
    // Clicking a view ALWAYS activates its workspace (jump to it), matching a
    // click on the workspace row. On top of that: suspended rows resume; a
    // hidden row is shown; a visible row stays put (the eyeball is the dedicated
    // hide toggle — row-click never hides).
    const onRowClick = () => {
        onActivate();
        if (suspended) onEnable();
        else if (!checked) onToggle();
    };
    return (
        <div
            className={`tterm${checked ? ' on sel' : ''}${suspended ? ' suspended' : ''}${attention ? ' attention' : ''}`}
            role="button"
            tabIndex={0}
            onClick={onRowClick}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick();
                }
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu({ x: e.clientX, y: e.clientY });
            }}
            style={{ cursor: 'pointer' }}
        >
            <button
                type="button"
                className={`pick eye-toggle${checked ? ' on' : ''}`}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                title={checked ? 'Hide from grid' : 'Show in grid'}
                aria-label={`${checked ? 'Hide' : 'Show'} ${spec.label}`}
            >
                {suspended ? null : checked ? (
                    <IconEye size={12} />
                ) : (
                    <IconEyeOff size={12} />
                )}
            </button>
            {spec.type === 'code' ? (
                <span className="srow-ico code" title="Files">
                    <IconCode size={12} />
                </span>
            ) : agentDef && AgentIcon ? (
                <span
                    // A retained pty (hidden OR suspended) is still ALIVE, so status
                    // follows `live` (the pty), not the suspended/hidden view state.
                    className={`srow-ico agent ${live ? 'run' : 'idle'}`}
                    title={agentDef.label}
                >
                    <AgentIcon size={12} />
                </span>
            ) : (
                <span className={`sdot ${live ? 'run' : 'idle'}`} />
            )}
            {/* AgentPulse light: lights up while THIS terminal is receiving
                bytes, dim otherwise. Terminal rows only — a 'code' (editor)
                row has no pty to stream from. */}
            {isTerminal && (
                <span
                    className={`term-pulse${pulse ? ' on' : ''}`}
                    title={pulse ? 'Receiving activity' : 'No recent activity'}
                    aria-hidden="true"
                />
            )}
            {agentDef && purposeStr ? (
                <span className="tname srow-hasub">
                    <span className="srow-name">{spec.label}</span>
                    <span className="srow-sub">{purposeStr}</span>
                </span>
            ) : (
                <span className="tname">{spec.label}</span>
            )}
            {suspended && (
                <span className="susp-badge" title="Suspended — pty still running">
                    Suspended
                </span>
            )}
            {suspended ? (
                <button
                    type="button"
                    className="tterm-act"
                    onClick={(e) => {
                        e.stopPropagation();
                        onEnable();
                    }}
                    title="Resume — reattach to the live session"
                    aria-label={`Resume ${spec.label}`}
                >
                    <IconPlay size={12} />
                </button>
            ) : (
                isTerminal && (
                    <button
                        type="button"
                        className="tterm-act"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDisable();
                        }}
                        title="Suspend — keep running, hide panel"
                        aria-label={`Suspend ${spec.label}`}
                    >
                        <IconPause size={12} />
                    </button>
                )
            )}
            <button
                type="button"
                className="tterm-trash"
                onClick={handleDestroy}
                title="Delete terminal"
                aria-label={`Delete ${spec.label}`}
            >
                <IconTrash size={13} />
            </button>
            {/* Trailing Tynn indicator: the workspace's .agi envelope declares
                a Tynn MCP server. Terminal views only — never on editor/code
                rows — and pinned to the far-right end of the row as a trailing
                marker, not inline near the host label. */}
            {isTerminal && hasTynnMcp && (
                <span className="srow-tynn" title="Tynn MCP" aria-label="Tynn MCP">
                    <IconTynn size={12} />
                </span>
            )}
        </div>
    );
}

/**
 * AgentPulse sparkline — a faint 1-minute activity trace drawn as a background
 * layer behind a workspace row. `ring` is 60 one-second byte counts (oldest→
 * newest); each is normalized to the ring's own peak so a quiet workspace still
 * reads. Renders nothing when there's no activity. `active` brightens it while a
 * terminal is currently streaming. Pointer-events-none so it never blocks the
 * row's own clicks/drag.
 */
function AgentPulseSparkline({ ring, active }: { ring?: number[]; active: boolean }) {
    if (!ring || ring.length === 0) return null;
    const max = Math.max(...ring);
    if (max <= 0) return null;

    const w = 100;
    const h = 100;
    const n = ring.length;
    const step = n > 1 ? w / (n - 1) : w;
    const pts = ring.map((v, i) => {
        const x = i * step;
        const y = h - (v / max) * (h - 6) - 3;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const line = pts.join(' ');
    const area = `0,${h} ${line} ${w},${h}`;

    return (
        <svg
            className={`agent-pulse-spark${active ? ' active' : ''}`}
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <polygon className="aps-fill" points={area} />
            <polyline className="aps-line" points={line} />
        </svg>
    );
}
