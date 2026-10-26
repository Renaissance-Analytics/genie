import { FlowEditor, FlowViewer, getNodeKind, type FlowEditorApi, type FlowGraph } from '@particle-academy/fancy-flow';
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

export function FlowEditorWindow({ flowId, workspaceId, data, workspaces, act, Editor = FlowEditor as unknown as AnyComponent, Viewer = FlowViewer as unknown as AnyComponent, now = Date.now(), onSaved }: FlowEditorWindowProps) {
    const flows = data.flows?.flows ?? null;
    // GENIE'S TOOLS AS STEPS (genie#1204): their kinds arrive in the snapshot and are registered BEFORE any graph is read
    // or the canvas mounts — a canvas that mounted first would draw them as bare boxes (Genie 1's lesson,
    // FlowEditorPanel.tsx:43-54). Idempotent, so every render may call it.
    if (data.flows?.toolKinds) registerToolKinds(data.flows.toolKinds);
    const flow = flowId !== null ? flows?.find((f) => f.id === flowId) ?? null : null;
    const [graph, setGraph] = useState<FlowGraph | null>(() => (flows === null ? null : flowId === null ? documentToGraph(starterDocument()) : flow ? documentToGraph(flow.document) : null));
    const [name, setName] = useState(flow?.name ?? '');
    const [serverProblems, setServerProblems] = useState<readonly FlowProblem[]>([]);
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [viewing, setViewing] = useState<number | null>(null);
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
        if (typeof document !== 'undefined') document.title = `${name || 'New flow'} — Flow`;
    }, [name]);
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

    if (flowId !== null && flows !== null && !flow) return <WindowMessage>That flow no longer exists.</WindowMessage>;
    if (flowId === null && !ws) return <WindowMessage>This window was opened without a workspace for the new flow.</WindowMessage>;
    if (graph === null || value === null) return <WindowMessage>Opening…</WindowMessage>;

    const save = async () => {
        if (!ws || !document_) return;
        setBusy(true);
        setNote(null);
        try {
            const answer = await act({ kind: 'flows.saveGraph', ...(flowId !== null ? { flowId } : {}), workspaceId: ws, name, document: document_ });
            const saved = answer.flows?.saved;
            if (!saved) setNote('Genie did not say whether it saved.');
            else if (!saved.ok) { setServerProblems(saved.problems); setNote('Not saved: fix what is marked on the canvas.'); }
            else {
                setServerProblems([]);
                setNote(saved.disarmed ? 'Saved, and DISARMED: you changed what it does. Arm it again from Flows when it is right.' : 'Saved.');
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
        <div data-flow-editor={flowId ?? 'new'} className="flex h-screen min-h-0 flex-col bg-[var(--bg-1)] text-[var(--fg-1)]">
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
                <button type="button" disabled={busy || run !== null} onClick={() => void save()} className="rounded-lg bg-[var(--primary)] px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
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
                    <FlowRunOverlay flow={flow} run={run} Viewer={Viewer} />
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
        </div>
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

const OUTCOME_WORDS: Record<string, string> = { ran: 'ran', failed: 'failed', held: 'held back', skipped: 'skipped (its branch was not taken)', 'not reached': 'not reached', stopped: 'stopped (Genie quit)', running: 'running' };

/**
 * A RUN ON THE CANVAS, READ-ONLY (genie#1204 item 6; Genie 1's FlowManagerFlyout drew the last run's statuses on
 * `<FlowViewer>`, "read-only by construction"). The flow's own graph, each node marked with what it did in that run, and
 * the same outcomes listed in words beneath it.
 */
export function FlowRunOverlay({ flow, run, Viewer = FlowViewer as unknown as AnyComponent }: { flow: FlowRecord; run: FlowRun; Viewer?: AnyComponent }) {
    const graph = useMemo(() => documentToGraph(flow.document), [flow.document]);
    const nodes = run.nodes ?? {};
    const listed = graph.nodes.filter((n) => nodes[n.id] !== undefined);
    return (
        <div data-flow-run-overlay className="flex h-full min-h-0 flex-col">
            <p className="shrink-0 px-4 py-1 text-xs text-[var(--fg-2)]">
                {new Date(run.at).toLocaleString()} · {run.trigger === 'manual' ? 'run now' : run.trigger === 'file' ? `when ${run.file ?? 'a file'} was added` : 'on schedule'} · {run.outcome}
                {run.reason ? <> — {run.reason}</> : null}
            </p>
            <div className="min-h-0 flex-1">
                <Viewer graph={graph} statuses={viewerStatuses(nodes)} height="100%" zoomOnWheel showMinimap={graph.nodes.length > 12} />
            </div>
            {listed.length > 0 ? (
                <ol className="max-h-40 shrink-0 overflow-auto border-t border-[var(--border-1)] px-4 py-1 text-xs">
                    {listed.map((n) => (
                        <li key={n.id} data-flow-node={n.id} data-flow-node-outcome={nodes[n.id]}>{nodeName(graph, n.id)}: {OUTCOME_WORDS[nodes[n.id]!] ?? nodes[n.id]}</li>
                    ))}
                </ol>
            ) : null}
            {run.log && run.log.length > 0 ? (
                <pre data-flow-run-log className="max-h-32 shrink-0 overflow-auto border-t border-[var(--border-1)] px-4 py-1 font-mono text-xs">{run.log.join('\n')}</pre>
            ) : null}
        </div>
    );
}
