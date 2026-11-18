import { Badge, Button, Icon } from '@particle-academy/react-fancy';
import { Flash } from './Flash.js';
import { FlowCanvas, FlowEditor, buildNodeTypes, getNodeKind, type FlowEditorApi, type FlowGraph } from '@particle-academy/fancy-flow';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
    canonicalKind,
    documentToGraph,
    ensureGenieKinds,
    graphToDocument,
    paletteKindFilter,
    registerToolKinds,
    saveProblems,
    starterDocument,
    viewerStatuses,
    withProblems,
    type FlowProblem,
} from '../../core/flow-canvas.js';
import { flowEditorPanes, flowPaneLabel, type FlowPaneName } from '../../core/flow-editor-layout.js';
import { NOT_RECORDED, formatDuration, runCanvasGraph, runHeader, runRows, type RunRow } from '../../core/flow-run-review.js';
import { stepLabel } from '../../core/flow-reach.js';
import { SCHEDULE_PRESETS, nextRunWords } from '../../core/flow-schedule.js';
import type { FlowRecord, FlowRun } from '../../main/flow-store.js';
import type { FeatureAction, FeatureData } from '../features.js';

/**
 * THE FLOW EDITOR, IN A WINDOW OF ITS OWN (genie#1204 item 1). Genie 1's editor (renderer/pages/flow-editor.tsx and
 * components/Flows/FlowEditorPanel.tsx at v0.7.0-beta.342) — ported, and made to work where it did not:
 *
 * - **fancy-flow's canvas** (`<FlowEditor>`): palette, nodes and edges, the inspector. Genie's kinds are registered when
 *   this module loads, before any canvas mounts — Genie 1 fetched them over IPC and had to hold the canvas back until
 *   they arrived, because a canvas that mounts first draws Genie's nodes as bare boxes. Here they are local, so there is
 *   no race to lose.
 * - **The palette is what runs** (`paletteKindFilter`, core/flow-canvas.ts): every kind it offers has an executor and a
 *   test; Genie 1 offered kinds that could never run.
 * - **The canvas never runs a flow.** Its built-in Run is off and no executors are passed (Genie 1's rule,
 *   FlowEditorPanel.tsx:24-33): one execution path, in the main process. Run now asks it.
 * - **Problems are drawn ON the node** — fancy-flow's error ring and the reason under the title — while the flow is
 *   drawn (the rules the renderer can check) and after a save main refused (the rest: agents, the engine's door).
 *   Saving is refused rather than storing a flow that cannot run (Genie 1 saved anything and said so beside it).
 * - **Saving never arms**; a change to what an armed flow does disarms it, said here before it happens (main decides).
 * - **It measures itself** (core/flow-editor-layout.ts, Genie 1's genie#505): panes yield to the canvas when narrow.
 * - **A run on the canvas**, read-only (`FlowRunOverlay`): which node ran, failed, was held or was not reached.
 */

ensureGenieKinds();

type AnyComponent = ComponentType<Record<string, unknown>>;

export interface FlowEditorWindowProps {
    /** The flow to open; `null` = a new one, in `workspaceId`. */
    readonly flowId: string | null;
    readonly workspaceId: string | null;
    /** Tynn #860: open on this run's review (its index in the flow's runs). */
    readonly run?: number | null;
    readonly hibernated?: boolean;
    readonly data: FeatureData;
    readonly workspaces: readonly { id: string; path: string; name?: string | undefined }[];
    readonly act: (action: FeatureAction) => Promise<FeatureData>;
    /** fancy-flow's editor; a test hands a stand-in. */
    readonly Editor?: AnyComponent;
    readonly Viewer?: AnyComponent;
    readonly now?: number;
    /** After a NEW flow's first save: this window now holds that flow (the route moves to it). */
    readonly onSaved?: (flowId: string) => void;
}

export function FlowEditorWindow({ flowId, workspaceId, run: openRun = null, hibernated = false, data, workspaces, act, Editor = FlowEditor as unknown as AnyComponent, Viewer = RunCanvas as unknown as AnyComponent, now = Date.now(), onSaved }: FlowEditorWindowProps) {
    const flows = data.flows?.flows ?? null;
    // GENIE'S TOOLS AS STEPS (genie#1204): their kinds arrive in the snapshot and are registered BEFORE any graph is read
    // or the canvas mounts — a canvas that mounted first would draw them as bare boxes (Genie 1's lesson,
    // FlowEditorPanel.tsx:43-54). Idempotent, so every render may call it.
    if (data.flows?.toolKinds) registerToolKinds(data.flows.toolKinds);
    const reportedFlow = flowId !== null ? flows?.find((f) => f.id === flowId) ?? null : null;
    const remembered = useRef(reportedFlow);
    if (reportedFlow) remembered.current = reportedFlow;
    const flow = reportedFlow ?? (hibernated && remembered.current?.id === flowId ? remembered.current : null);
    const [graph, setGraph] = useState<FlowGraph | null>(() => (flows === null ? null : flowId === null ? documentToGraph(starterDocument()) : flow ? documentToGraph(flow.document) : null));
    const [name, setName] = useState(flow?.name ?? '');
    const [serverProblems, setServerProblems] = useState<readonly FlowProblem[]>([]);
    const [note, setNote] = useState<string | null>(null);
    // "Saved" is a Flash on the Save button, never a bar (the owner, 2026-11-16); a warning stays a note.
    const [savedFlash, setSavedFlash] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Opened on a run (Tynn #860: a run's Review in Flows), its review shows first; a later link moves to its run.
    const [viewing, setViewing] = useState<number | null>(openRun);
    useEffect(() => { if (openRun !== null) setViewing(openRun); }, [openRun]);
    const [opened, setOpened] = useState<FlowPaneName | null>(null);
    const [width, setWidth] = useState(0);
    const shell = useRef<HTMLDivElement | null>(null);

    // The flow arrives with the first snapshot when the window opens before it: take its graph and name once.
    useEffect(() => {
        if (graph !== null || flows === null) return;
        if (flow) {
            setGraph(documentToGraph(flow.document));
            setName(flow.name);
        } else if (flowId === null) {
            setGraph(documentToGraph(starterDocument()));
        }
    }, [flow, flows, flowId, graph]);
    useEffect(() => {
        if (typeof document !== 'undefined') document.title = hibernated ? 'Hibernated workspace — Flow' : `${name || 'New flow'} — Flow`;
    }, [name, hibernated]);
    useEffect(() => {
        const el = shell.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        setWidth(Math.round(el.getBoundingClientRect().width));
        const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (typeof w === 'number') setWidth(Math.round(w)); });
        ro.observe(el);
        return () => ro.disconnect();
    }, [graph === null, viewing]);

    const ws = flow?.workspaceId ?? workspaceId;
    const document_ = useMemo(() => (graph ? graphToDocument(graph) : null), [graph]);
    const live = useMemo(
        () => (document_ ? saveProblems(document_, { workspaces: workspaces.map((w) => w.id), agentProblem: () => null }) : []),
        [document_, workspaces],
    );
    const problems = useMemo(() => {
        const all = [...live];
        for (const p of serverProblems) if (!all.some((q) => q.nodeId === p.nodeId && q.message === p.message)) all.push(p);
        return all;
    }, [live, serverProblems]);
    const value = useMemo(() => (graph ? withProblems(graph, problems) : null), [graph, problems]);

    const notice = <WindowMessage>This workspace is hibernated. Redock it to continue; your unsaved graph is kept.</WindowMessage>;
    if (hibernated && !flow && flowId !== null) return notice;
    if (flowId !== null && flows !== null && !flow) return <WindowMessage>That flow no longer exists.</WindowMessage>;
    if (flowId === null && !ws) return <WindowMessage>This window was opened without a workspace for the new flow.</WindowMessage>;
    if (graph === null || value === null) return <WindowMessage>Opening…</WindowMessage>;

    const save = async () => {
        if (!ws || !document_) return;
        setBusy(true);
        setNote(null);
        setSavedFlash(null);
        try {
            const answer = await act({ kind: 'flows.saveGraph', ...(flowId !== null ? { flowId } : {}), workspaceId: ws, name, document: document_ });
            const saved = answer.flows?.saved;
            if (!saved) setNote('Genie did not say whether it saved.');
            else if (!saved.ok) { setServerProblems(saved.problems); setNote('Not saved: fix what is marked on the canvas.'); }
            else {
                setServerProblems([]);
                if (saved.disarmed) setNote('Saved, and DISARMED: you changed what it does. Arm it again from Flows when it is right.'); else setSavedFlash('Saved');
                if (flowId === null) onSaved?.(saved.flowId);
            }
        } catch (error) {
            setNote(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const runs = flow?.runs ?? [];
    const run = viewing !== null ? runs[viewing] ?? null : null;
    const panes = flowEditorPanes(width, opened);
    const nameOf = (id: string | undefined) => (id === undefined ? 'the flow' : nodeName(graph, id));

    return (
        <><div hidden={hibernated} inert={hibernated} data-flow-editor={flowId ?? 'new'} className="flex h-screen min-h-0 flex-col bg-[var(--bg-1)] text-[var(--fg-1)]">
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border-1)] px-4 py-2">
                <input
                    aria-label="Flow name"
                    placeholder="Name this flow"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="min-w-48 flex-1 rounded-md border border-[var(--border-1)] bg-[var(--bg-2)] px-2 py-1 text-sm"
                />
                {ws ? <span className="font-mono text-xs text-[var(--fg-4)]">{ws}</span> : null}
                {flow?.armed ? <span data-flow-armed className="text-xs text-[var(--fg-3)]">Armed. Saving a change to what it does disarms it; moving or renaming does not.</span> : null}
                {runs.length > 0 ? (
                    <select
                        aria-label="Show a run on the canvas"
                        value={viewing === null ? '' : String(viewing)}
                        onChange={(e) => setViewing(e.target.value === '' ? null : Number(e.target.value))}
                        className="rounded-md border border-[var(--border-1)] bg-[var(--bg-2)] px-2 py-1 text-xs"
                    >
                        <option value="">Editing</option>
                        {runs.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => (
                            <option key={`${i}:${r.at}`} value={String(i)}>Run {new Date(r.at).toLocaleString()} · {r.outcome}</option>
                        ))}
                    </select>
                ) : null}
                <Flash note={savedFlash}><Button size="xs" type="button" disabled={busy || run !== null} onClick={() => void save()} className="rounded-lg bg-[var(--primary)] px-3 py-1 text-sm text-white disabled:opacity-50">Save</Button></Flash>
            </div>
            {note ? <p data-flow-note className="shrink-0 border-b border-[var(--border-1)] px-4 py-1 text-xs text-[var(--fg-2)]">{note}</p> : null}
            {problems.length > 0 && run === null ? (
                <ul data-flow-problems className="shrink-0 border-b border-[var(--border-1)] px-4 py-1 text-xs text-[var(--danger)]">
                    {problems.map((p) => (
                        <li key={`${p.nodeId ?? '-'}:${p.message}`} data-flow-problem={p.nodeId ?? 'flow'}>
                            <span className="font-medium">{nameOf(p.nodeId)}</span>: {p.message}
                        </li>
                    ))}
                </ul>
            ) : null}
            <div ref={shell} className="min-h-0 flex-1">
                {run !== null && flow ? (
                    <FlowRunOverlay
                        key={`${viewing}:${run.at}`}
                        flow={flow}
                        run={run}
                        Viewer={Viewer}
                        onRerun={flowId !== null ? () => { void act({ kind: 'flows.runNow', flowId }).catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error))); } : undefined}
                        // Stop (Tynn #833): the run going now ends; recorded "stopped by you".
                        onStop={flowId !== null ? () => { void act({ kind: 'flows.stop', flowId }).catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error))); } : undefined}
                        onPrevious={viewing !== null && viewing > 0 ? () => setViewing(viewing - 1) : undefined}
                        onNext={viewing !== null && viewing < runs.length - 1 ? () => setViewing(viewing + 1) : undefined}
                    />
                ) : (
                    <Editor
                        value={value}
                        onChange={(next: FlowGraph) => { setGraph(next); setServerProblems([]); setNote(null); }}
                        kindFilter={paletteKindFilter}
                        builtins={{ run: false }}
                        showFeed={false}
                        showPalette={panes.showPalette}
                        showPanel={panes.showPanel}
                        style={{ height: '100%', gridTemplateColumns: panes.columns }}
                        actions={[
                            ...(flowId !== null ? [{ id: 'genie-run-now', label: 'Run now', title: 'Run the SAVED flow once now, in Genie', placement: 'start' as const, disabled: () => busy, onSelect: () => { void act({ kind: 'flows.runNow', flowId }).catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error))); } }] : []),
                            ...panes.toggles.map((pane) => ({ id: `genie-pane-${pane}`, label: flowPaneLabel(pane), placement: 'start' as const, onSelect: () => setOpened((c) => (c === pane ? null : pane)) })),
                        ]}
                        slots={{
                            panelFooter: (api: FlowEditorApi) => {
                                const selected = api.selected;
                                if (!selected) return null;
                                const data = (selected.data ?? {}) as { kind?: string; config?: Record<string, unknown> };
                                const mine = problems.filter((p) => p.nodeId === selected.id);
                                const schedule = canonicalKind(String(data.kind ?? selected.type ?? '')) === '@particle-academy/schedule_trigger';
                                return (
                                    <div className="flex flex-col gap-2 p-2">
                                        {schedule ? (
                                            <ScheduleInspector
                                                cron={typeof data.config?.cron === 'string' ? data.config.cron : ''}
                                                now={now}
                                                onCron={(cron) => api.updateNode({ ...selected, data: { ...data, config: { ...(data.config ?? {}), cron } } } as never)}
                                            />
                                        ) : null}
                                        {mine.map((p) => <p key={p.message} className="text-xs text-[var(--danger)]">{p.message}</p>)}
                                    </div>
                                );
                            },
                        }}
                    />
                )}
            </div>
        </div>{hibernated ? notice : null}</>
    );
}

function WindowMessage({ children }: { children: React.ReactNode }) {
    return <p className="p-6 text-sm text-[var(--fg-3)]">{children}</p>;
}

/** A node in words: Genie's steps say what they do; others their label or kind; else the id. */
function nodeName(graph: FlowGraph, id: string): string {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return id;
    const data = (node.data ?? {}) as { kind?: string; label?: string; config?: Record<string, unknown> };
    const kind = canonicalKind(String(data.kind ?? node.type ?? ''));
    if (kind.startsWith('genie/') && !/file_added$/.test(kind)) return stepLabel({ kind, config: data.config });
    return data.label ?? getNodeKind(kind)?.label ?? id;
}

/**
 * THE SCHEDULE TRIGGER'S INSPECTOR (genie#1204): presets a person picks instead of five cron fields, and when it next runs
 * (this machine's local time). What used to be the form's schedule field now lives on the trigger node.
 */
export function ScheduleInspector({ cron, now, onCron }: { cron: string; now: number; onCron: (cron: string) => void }) {
    const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron.trim());
    return (
        <div data-flow-schedule className="flex flex-col gap-1 text-xs">
            <label className="flex flex-col gap-1">
                <span className="text-[var(--fg-3)]">Preset</span>
                <select
                    value={preset ? preset.cron : ''}
                    onChange={(e) => { if (e.target.value !== '') onCron(e.target.value); }}
                    className="rounded-md border border-[var(--border-1)] bg-[var(--bg-2)] px-2 py-1"
                >
                    <option value="">Custom (the Cron field)</option>
                    {SCHEDULE_PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
                </select>
            </label>
            <span data-flow-next-run className="text-[var(--fg-2)]">{nextRunWords(cron, now)}</span>
        </div>
    );
}

const OUTCOME_WORDS: Record<string, string> = { ran: 'ran', failed: 'failed', held: 'held back', skipped: 'skipped (its branch was not taken)', 'not reached': 'not reached', stopped: 'stopped (by you, an agent, or Genie quitting)', running: 'running', queued: 'queued behind the agent’s current turn', paused: 'paused at the agent’s provider limit', delivered: 'delivered to the agent', waiting: 'waiting: kept for the agent’s next run' };

type BadgeColor = 'green' | 'red' | 'amber' | 'sky' | 'violet' | 'zinc';
const OUTCOME_COLOR: Record<string, BadgeColor> = { ran: 'green', delivered: 'sky', failed: 'red', stopped: 'red', held: 'amber', paused: 'amber', queued: 'amber', running: 'sky', waiting: 'violet', skipped: 'zinc', 'not reached': 'zinc' };

/** Each step's kind as an icon (lucide names, through react-fancy's Icon). */
function kindIcon(kind: string): string {
    if (kind === '@particle-academy/schedule_trigger') return 'clock';
    if (/trigger$/.test(kind)) return 'play';
    if (kind === 'genie/file_added') return 'file-plus';
    if (kind === 'genie/terminal_run') return 'terminal';
    if (kind === 'genie/agent_prompt') return 'message-square';
    if (kind === 'genie/knowledge_add') return 'brain';
    if (kind === 'genie/file_move') return 'folder-input';
    if (/branch$/.test(kind)) return 'git-branch';
    if (/switch_case$/.test(kind)) return 'git-fork';
    if (/log$/.test(kind)) return 'scroll-text';
    if (/wait$/.test(kind)) return 'timer';
    return 'circle';
}

const clock = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const lastLines = (text: string, n: number): string => text.replace(/\n$/, '').split('\n').slice(-n).join('\n');
/** How many of a command's last lines a row shows before "Whole output". */
const TAIL_LINES = 8;

export interface FlowRunOverlayProps {
    readonly flow: FlowRecord;
    readonly run: FlowRun;
    /** The canvas the run is drawn on (`RunCanvas`); a test hands a stand-in. */
    readonly Viewer?: AnyComponent;
    /** Run the flow again (the person's Run now). */
    readonly onRerun?: (() => void) | undefined;
    /** Stop the run going now (Tynn #833); absent where this build cannot stop one. */
    readonly onStop?: (() => void) | undefined;
    /** The run before / after this one; absent at either end. */
    readonly onPrevious?: (() => void) | undefined;
    readonly onNext?: (() => void) | undefined;
}

/**
 * THE RUN'S CANVAS (Tynn #839): fancy-flow's FlowCanvas — React Flow underneath — at the PIXEL height its box measures.
 * The blank canvas the owner saw was FlowViewer handed `height="100%"` inside a box with no height of its own: React Flow
 * drew into zero pixels. FlowViewer's canvas also ignores its `statuses` and selection (fancy-flow 0.81), so the run's
 * colours and the picked step are put on the nodes themselves (`runCanvasGraph`) and drawn here. Read-only: nothing drags,
 * connects or deletes; a click picks a step.
 */
export function RunCanvas({ graph, selectedNodeId = null, onSelectNode, Canvas = FlowCanvas as unknown as AnyComponent }: { graph: FlowGraph; statuses?: unknown; selectedNodeId?: string | null; onSelectNode?: (node: { id: string }) => void; Canvas?: AnyComponent }) {
    const box = useRef<HTMLDivElement | null>(null);
    // Before the first measure (and in a test's static render) a sane height; the box's own as soon as it has one.
    const [height, setHeight] = useState(360);
    useEffect(() => {
        const el = box.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const take = (h: number) => { if (h > 0) setHeight(Math.round(h)); };
        take(el.getBoundingClientRect().height);
        const ro = new ResizeObserver((entries) => take(entries[0]?.contentRect.height ?? 0));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const nodeTypes = useMemo(() => buildNodeTypes(), []);
    const nodes = useMemo(() => graph.nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })), [graph.nodes, selectedNodeId]);
    return (
        <div ref={box} data-run-canvas className="h-full min-h-0 w-full overflow-hidden">
            <Canvas
                nodes={nodes}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                height={height}
                fitView
                showControls
                showMinimap={graph.nodes.length > 12}
                zoomOnWheel
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={Boolean(onSelectNode)}
                edgesFocusable={false}
                elementsSelectable={Boolean(onSelectNode)}
                deleteKeyCode={null}
                selectionKeyCode={null}
                multiSelectionKeyCode={null}
                connectOnClick={false}
                onNodeClick={onSelectNode ? (_event: unknown, node: { id: string }) => onSelectNode(node) : undefined}
            />
        </div>
    );
}

/**
 * REVIEWING A RUN (Tynn #839; genie#1204 item 6 drew the run on the canvas; the owner, 2026-11-17: "reviewing flow runs
 * needs to give me more info than this. and why waste so much space?"). The window's whole body:
 *
 * - a HEADER: what started it, started → finished, how long, how it ended, who pressed it; Re-run, Stop (a run going
 *   now), and the run before and after, to compare runs one click apart;
 * - the flow DRAWN AS THE RUN (`RunCanvas`): each node coloured by its outcome, the path it took highlighted;
 * - the STEP TIMELINE beside it: each step's kind, outcome, start and duration, and what it did — a command's exit code
 *   and output (its last lines; the whole on expand; the process that keeps the log), a prompt's recipient, exact text,
 *   delivery and reply, a branch's condition and the way it went, an error in full.
 *
 * Picking a step on either side picks it on the other. A run recorded before #839 says "not recorded" for what it lacks.
 */
export function FlowRunOverlay({ flow, run, Viewer = RunCanvas as unknown as AnyComponent, onRerun, onStop, onPrevious, onNext }: FlowRunOverlayProps) {
    const graph = useMemo(() => documentToGraph(flow.document), [flow.document]);
    const [selected, setSelected] = useState<string | null>(null);
    const drawn = useMemo(() => runCanvasGraph(graph as unknown as { nodes: Array<{ id: string; data?: unknown }>; edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null }> }, run, selected) as unknown as FlowGraph, [graph, run, selected]);
    const rows = useMemo(() => runRows(graph.nodes.map((n) => n.id), run), [graph, run]);
    const header = runHeader(run);
    const rowRefs = useRef(new Map<string, HTMLLIElement>());
    useEffect(() => {
        const el = selected !== null ? rowRefs.current.get(selected) : undefined;
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }, [selected]);
    const pick = (id: string) => setSelected((c) => (c === id ? null : id));
    const kindOf = (id: string) => {
        const n = graph.nodes.find((x) => x.id === id);
        return canonicalKind(String(((n?.data ?? {}) as { kind?: string }).kind ?? n?.type ?? ''));
    };
    const configOf = (id: string) => (((graph.nodes.find((x) => x.id === id)?.data ?? {}) as { config?: Record<string, unknown> }).config ?? {});

    return (
        <div data-flow-run-overlay className="flex h-full min-h-0 flex-col">
            <div data-run-header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border-1)] px-4 py-1.5 text-xs">
                <Badge size="sm" variant="soft" color={OUTCOME_COLOR[header.outcome] ?? 'zinc'}><span data-run-status="">{header.outcome}</span></Badge>
                <span className="text-[var(--fg-3)]">Started by <span data-run-trigger="" className="text-[var(--fg-1)]">{header.trigger}</span></span>
                <span className="text-[var(--fg-3)]">Who <span data-run-started-by="" className="text-[var(--fg-1)]">{header.startedBy}</span></span>
                <span className="text-[var(--fg-3)]">
                    <span data-run-started={header.startedAt} className="text-[var(--fg-1)]">{new Date(header.startedAt).toLocaleString()}</span>
                    {' → '}
                    <span data-run-finished={header.endedAt} className="text-[var(--fg-1)]">{clock(header.endedAt)}</span>
                </span>
                <span className="text-[var(--fg-3)]">Took <span data-run-duration="" className="font-mono text-[var(--fg-1)]">{formatDuration(header.durationMs)}</span></span>
                {run.stoppedBy ? <span className="text-[var(--fg-3)]">Stopped by <span data-run-stopped-by="" className="text-[var(--fg-1)]">{run.stoppedBy}</span></span> : null}
                {run.resumed ? <span className="text-[var(--fg-3)]">Resumed after Genie restarted</span> : null}
                <span className="ml-auto flex items-center gap-1.5">
                    {flow.inFlight ? (
                        <Button size="xs" type="button" data-run-stop="" disabled={!onStop} title={onStop ? 'Stop the run going now' : 'Stopping a run is not in this build yet'} onClick={() => onStop?.()}>
                            <Icon name="square" size="xs" /> Stop the run going now
                        </Button>
                    ) : null}
                    <Button size="xs" type="button" data-run-previous="" disabled={!onPrevious} title="The run before this one" onClick={() => onPrevious?.()}><Icon name="chevron-left" size="xs" /> Earlier</Button>
                    <Button size="xs" type="button" data-run-next="" disabled={!onNext} title="The run after this one" onClick={() => onNext?.()}>Later <Icon name="chevron-right" size="xs" /></Button>
                    <Button size="xs" type="button" data-run-rerun="" disabled={!onRerun} title="Run the saved flow again now" onClick={() => onRerun?.()}><Icon name="rotate-cw" size="xs" /> Run again</Button>
                </span>
                {header.reason ? <p data-run-reason="" className="basis-full text-[var(--danger)]">{header.reason}</p> : null}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(180px,45%)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(380px,42%)] lg:grid-rows-1">
                <div className="min-h-0 min-w-0">
                    <Viewer graph={drawn} statuses={viewerStatuses(run.nodes ?? {})} selectedNodeId={selected} onSelectNode={(n: { id: string }) => setSelected(n.id)} />
                </div>
                <ol data-run-timeline className="min-h-0 overflow-auto border-t border-[var(--border-1)] text-xs lg:border-l lg:border-t-0">
                    {rows.map((r) => (
                        <li
                            key={r.nodeId}
                            data-flow-node={r.nodeId}
                            data-flow-node-outcome={r.outcome}
                            aria-current={selected === r.nodeId ? 'true' : undefined}
                            ref={(el) => { if (el) rowRefs.current.set(r.nodeId, el); else rowRefs.current.delete(r.nodeId); }}
                            className={`border-b border-[var(--border-1)] px-3 py-1.5 ${selected === r.nodeId ? 'bg-[var(--bg-2)] shadow-[inset_3px_0_0_var(--primary)]' : ''}`}
                        >
                            {/* The step's line is a real button (react-fancy): it picks the step, and its node on the canvas. */}
                            <Button
                                variant="ghost"
                                size="xs"
                                labelClassName="contents"
                                type="button"
                                data-step-pick={r.nodeId}
                                aria-pressed={selected === r.nodeId}
                                title={`Show “${nodeName(graph, r.nodeId)}” on the canvas`}
                                onClick={() => pick(r.nodeId)}
                                className="flex w-full items-center justify-start gap-2 rounded px-0 py-0 text-left hover:bg-[var(--bg-2)]"
                            >
                                <Icon name={kindIcon(kindOf(r.nodeId))} size="xs" className="shrink-0 text-[var(--fg-3)]" />
                                <span className="min-w-0 flex-1 truncate font-medium">{nodeName(graph, r.nodeId)}</span>
                                <Badge size="sm" variant="soft" color={OUTCOME_COLOR[r.outcome] ?? 'zinc'} title={OUTCOME_WORDS[r.outcome] ?? r.outcome}><span data-step-outcome="">{r.outcome}</span></Badge>
                                <span data-step-start={r.startedAt ?? ''} className="w-16 shrink-0 text-right font-mono text-[var(--fg-3)]">{r.startedAt !== null ? clock(r.startedAt) : '—'}</span>
                                <span data-step-duration="" className="w-20 shrink-0 text-right font-mono text-[var(--fg-2)]">{formatDuration(r.durationMs)}</span>
                            </Button>
                            <StepDetail row={r} kind={kindOf(r.nodeId)} config={configOf(r.nodeId)} reason={r.outcome === 'failed' || r.outcome === 'held' ? run.reason : undefined} />
                        </li>
                    ))}
                    {run.log && run.log.length > 0 ? (
                        <li className="px-3 py-1.5">
                            <span className="text-[var(--fg-3)]">Log lines</span>
                            <pre data-flow-run-log className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{run.log.join('\n')}</pre>
                        </li>
                    ) : null}
                </ol>
            </div>
        </div>
    );
}

/** What one step did, by its kind (Tynn #839); what an older run lacks says "not recorded". */
function StepDetail({ row, kind, config, reason }: { row: RunRow; kind: string; config: Record<string, unknown>; reason: string | undefined }) {
    const d = row.detail;
    const error = d?.error ?? reason;
    const muted = 'text-[var(--fg-3)]';
    const block = 'mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-2)] px-2 py-1 font-mono';
    const reached = row.outcome !== 'skipped' && row.outcome !== 'not reached';
    const parts: React.ReactNode[] = [];
    if (kind === 'genie/terminal_run' && reached) {
        const c = d?.command;
        const output = c?.output;
        parts.push(
            <div key="cmd" className="flex flex-wrap gap-x-3">
                <span className={muted}>Command <code data-step-command="" className="text-[var(--fg-1)]">{c?.command ?? String(config.command ?? NOT_RECORDED)}</code></span>
                <span className={muted}>Exit code <span data-step-exit="" className={`font-mono ${c?.exitCode !== undefined && c.exitCode !== 0 ? 'text-[var(--danger)]' : 'text-[var(--fg-1)]'}`}>{c?.exitCode ?? NOT_RECORDED}</span></span>
            </div>,
        );
        if (output !== undefined && output !== '') {
            parts.push(<pre key="tail" data-step-output="tail" className={block}>{lastLines(output, TAIL_LINES)}</pre>);
            parts.push(
                <details key="full" data-step-full-log="" className="mt-1">
                    <summary className={`cursor-pointer ${muted}`}>Whole output of this run ({output.replace(/\n$/, '').split('\n').length} lines{c?.outputCut ? `; the first ${c.outputCut} characters were not kept` : ''})</summary>
                    <pre data-step-output="full" className={`${block} max-h-96`}>{output}</pre>
                </details>,
            );
        } else {
            parts.push(<p key="noout" className={muted}>Output: {output === '' ? 'none' : NOT_RECORDED}</p>);
        }
        parts.push(<p key="proc" className={muted}>Every run’s output is kept as process <code data-step-process="" className="text-[var(--fg-1)]">{c?.processId ?? NOT_RECORDED}</code> (Hosting → Processes)</p>);
    }
    if (kind === 'genie/agent_prompt' && reached) {
        const p = d?.prompt;
        parts.push(
            <div key="to" className="flex flex-wrap gap-x-3">
                <span className={muted}>To <span data-step-recipient="" className="text-[var(--fg-1)]">{p?.agent ?? String(config.agent ?? NOT_RECORDED)}</span></span>
                <span className={muted}>Delivered <span data-step-delivered={p?.deliveredAt ?? ''} className="text-[var(--fg-1)]">{p?.deliveredAt ? `${clock(p.deliveredAt)}${p.delivery ? ` (${p.delivery})` : ''}` : NOT_RECORDED}</span></span>
            </div>,
        );
        parts.push(<div key="sent"><span className={muted}>Prompt sent</span><pre data-step-prompt="" className={block}>{p?.text ?? NOT_RECORDED}</pre></div>);
        parts.push(
            p?.reply !== undefined
                ? <div key="reply"><span className={muted}>Reply</span><pre data-step-reply="" className={block}>{p.reply}</pre></div>
                : <p key="reply" className={muted}>Reply: {d && config.waitForReply !== true ? 'the step did not wait for one (it is in the agent’s chat)' : NOT_RECORDED}</p>,
        );
    }
    if (reached && (d?.route || /(branch|switch_case)$/.test(kind))) {
        const route = d?.route;
        const why = route === undefined ? '' : route.port === 'true' ? ' (the condition held)' : route.port === 'false' ? ' (the condition did not hold)' : '';
        parts.push(
            <p key="route" className={muted}>
                Condition <code className="text-[var(--fg-1)]">{route?.condition ?? NOT_RECORDED}</code>{' → went '}
                <span data-step-route="" className="font-medium text-[var(--fg-1)]">{route?.port ?? NOT_RECORDED}</span>{why}
            </p>,
        );
    }
    if (error) parts.push(<p key="err" data-step-error="" className="mt-1 whitespace-pre-wrap text-[var(--danger)]">{error}</p>);
    return parts.length > 0 ? <div className="mt-1 pl-5">{parts}</div> : null;
}
