import { useCallback, useEffect, useRef, useState } from 'react';
import { FlowEditor } from '@particle-academy/fancy-flow';
import '@particle-academy/fancy-flow/styles.css';
import { paletteKindFilter, registerFlowKinds } from '../../lib/flow-kinds';
import type { FlowAdmissionView, FlowRunOutcomeView, FlowScope } from '../../lib/genie';

/**
 * Authoring a Genie App's workflow.
 *
 * Fancy's `FlowEditor` draws the canvas, the palette and the config panel; Genie
 * supplies the graph, saves it, and owns the two things the editor must not do.
 *
 * ## The editor never RUNS the flow
 *
 * `FlowEditor` has a built-in Run that executes the graph in the browser against
 * an `executors` prop. That is turned OFF here, and no executors are passed.
 *
 * This is not a UI preference. A run in the renderer would either do nothing (the
 * renderer cannot reach Genie's tools) or — much worse, if someone later handed
 * it a registry — become a SECOND execution path that never passed through
 * `decideFlowAdmission` or `dispatchAppCall`. There is one way to run a flow, it
 * is in the main process, and the toolbar's Run button asks it politely.
 *
 * ## Saving is not authorising
 *
 * A graph reaching past what the app was granted saves perfectly happily — an
 * author is allowed to be mid-edit, and a canvas that refused to save an
 * unfinished flow would be unusable. What the panel does instead is CHECK
 * continuously and show the refusals inline, so the problem is visible while it
 * is being made rather than at 3am on the first scheduled fire.
 *
 * ## The palette is fetched, and the canvas WAITS for it
 *
 * fancy-flow's node registry is per-process, so Genie's steps have to be
 * registered here or the palette shows only Fancy's builtins — every one of
 * which the executor refuses. That is exactly what shipped: the kinds existed in
 * main, on an IPC channel nothing called.
 *
 * The editor is not rendered until they are registered. `<FlowEditor>` builds
 * its node-type map on mount, so a canvas that mounted first would draw every
 * Genie node as a bare default box and keep doing so until something forced it
 * to rebuild — which looks like a rendering bug and is really a race.
 */

interface Props {
    flowId: string;
    /**
     * Whose flow this is.
     *
     * Drives the palette and the admission check — the two things that differ
     * between a machine-wide flow and one owned by an app. It is a PARAMETER
     * because there is one editor for all three scopes: a GApp's flow is a flow
     * whose scope is `gapp`, not a different surface.
     */
    scope: FlowScope;
}

/** Debounce for the admission check — it follows keystrokes in the config panel. */
const CHECK_DELAY_MS = 400;

export default function FlowEditorPanel({ flowId, scope }: Props) {
    const [title, setTitle] = useState('');
    const [graph, setGraph] = useState<{ nodes: unknown[]; edges: unknown[] } | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [admission, setAdmission] = useState<FlowAdmissionView | null>(null);
    const [run, setRun] = useState<FlowRunOutcomeView | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [kindsReady, setKindsReady] = useState(false);
    const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Register the steps this app may author with, then let the canvas mount.
     *
     * The set registered IS the palette, for Genie's own steps: a GApp window is
     * its own renderer process acting for one app, so registering only what the
     * grant covers means the canvas cannot offer a Genie step certain to be
     * refused at run time.
     *
     * Fancy's own builtins are not Genie's to withhold — the package registers
     * them itself — so the one that must not be offered is hidden at render
     * time instead, by `kindFilter` on the editor below.
     */
    useEffect(() => {
        let undo: (() => void) | null = null;
        let live = true;

        void window.genie.flows
            .palette(scope)
            .then((palette) => {
                if (!live) return;
                undo = registerFlowKinds(palette.available);
            })
            .catch(() => {
                // A palette that failed to load must not leave a blank panel.
                // Fancy's own steps still work, and the message says what is
                // missing rather than letting the author wonder why the Genie
                // steps are absent.
                if (live) setError('Genie’s own steps could not be loaded, so the palette is incomplete.');
            })
            .finally(() => {
                if (live) setKindsReady(true);
            });

        return () => {
            live = false;
            undo?.();
        };
    }, [scope]);

    useEffect(() => {
        let live = true;
        void window.genie.flows.get(flowId).then((flow) => {
            if (!live) return;
            if (!flow) {
                setError('That flow no longer exists.');
                return;
            }
            setTitle(flow.title);
            setEnabled(flow.enabled);
            // A corrupt stored graph opens as an empty canvas rather than blanking
            // the panel — the row is still editable, and the alternative is a
            // flow the user can neither see nor repair.
            const stored = flow.graph as { nodes?: unknown[]; edges?: unknown[] } | null;
            setGraph({
                nodes: Array.isArray(stored?.nodes) ? stored.nodes : [],
                edges: Array.isArray(stored?.edges) ? stored.edges : [],
            });
            if (!stored || !Array.isArray(stored.nodes)) {
                setError('This flow’s saved graph could not be read, so the canvas opened empty.');
            }
        });
        return () => {
            live = false;
        };
    }, [flowId]);

    /** Ask main what this graph WOULD be allowed to do. Never runs anything. */
    const check = useCallback(
        (next: unknown) => {
            if (checkTimer.current) clearTimeout(checkTimer.current);
            checkTimer.current = setTimeout(() => {
                void window.genie.flows.check(scope, next).then(setAdmission);
            }, CHECK_DELAY_MS);
        },
        [scope],
    );

    useEffect(() => {
        if (graph) check(graph);
        return () => {
            if (checkTimer.current) clearTimeout(checkTimer.current);
        };
    }, [graph, check]);

    const onChange = useCallback((next: { nodes: unknown[]; edges: unknown[] }) => {
        setGraph(next);
        // A change invalidates the last run's verdict; leaving it on screen would
        // claim a result for a graph that no longer exists.
        setRun(null);
    }, []);

    const save = useCallback(async () => {
        if (!graph) return;
        setBusy(true);
        try {
            await window.genie.flows.save({ id: flowId, title, scope, graph });
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save this flow.');
        } finally {
            setBusy(false);
        }
    }, [enabled, flowId, graph, scope, title]);

    /** Save, then ask MAIN to run it. The renderer never executes a flow. */
    const runNow = useCallback(async () => {
        setBusy(true);
        try {
            if (graph) {
                await window.genie.flows.save({ id: flowId, title, scope, graph });
            }
            setRun(await window.genie.flows.run(flowId));
        } catch (e) {
            setRun({ ok: false, error: e instanceof Error ? e.message : 'The run failed.' });
        } finally {
            setBusy(false);
        }
    }, [enabled, flowId, graph, scope, title]);

    if (!graph || !kindsReady) {
        return <div className="p-4 text-sm opacity-70">{error ?? 'Loading…'}</div>;
    }

    const refusals = admission?.refusals ?? [];

    return (
        <div className="flex h-full flex-col gap-2 p-2">
            <div className="flex items-center gap-2">
                <input
                    className="flex-1 rounded border px-2 py-1 text-sm"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Flow name"
                    aria-label="Flow name"
                />
                {/* Arming is NOT here. It is the switch in the Flow Manager,
                    behind a confirmation stating what the flow will be able to
                    do — and saving an edit must never be a way around it. A
                    checkbox beside Save is exactly that way around. */}
                <button
                    type="button"
                    className="rounded border px-2 py-1 text-sm"
                    onClick={() => void save()}
                    disabled={busy}
                >
                    Save
                </button>
            </div>

            {error ? <div className="rounded border px-2 py-1 text-xs">{error}</div> : null}

            {/*
              What this flow may do, as it is being drawn. `capabilities` is the
              honest summary a consent-shaped surface would show; `refusals` is
              every step that would be turned away, named.
            */}
            {admission && !admission.allowed ? (
                <div className="rounded border px-2 py-1 text-xs" role="status">
                    <strong>This flow will not run as drawn.</strong>
                    {admission.reason ? <div>{admission.reason}</div> : null}
                    <ul className="ml-4 list-disc">
                        {refusals.map((r) => (
                            <li key={r.nodeId}>
                                <code>{r.label ?? r.nodeId}</code> — {r.reason}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {admission?.allowed && admission.capabilities.length > 0 ? (
                <div className="text-xs opacity-70">
                    Uses: {admission.capabilities.join(', ')}
                </div>
            ) : null}

            {run ? (
                <div className="rounded border px-2 py-1 text-xs" role="status">
                    {run.ok ? 'Last run finished.' : `Last run failed: ${run.error ?? 'unknown'}`}
                </div>
            ) : null}

            <div className="min-h-0 flex-1">
                <FlowEditor
                    value={graph as never}
                    onChange={onChange as never}
                    // No `executors` prop, and the built-in Run is off — see the
                    // note at the top. Running belongs to the main process.
                    builtins={{ run: false }}
                    // Hides the steps that would park a run Genie cannot
                    // resume. It removes the TRAP — you cannot drag on a node
                    // that will hang. It is NOT the enforcement: the refusals at
                    // admission, save and run stay, because a graph can arrive
                    // hand-authored, imported, or from an agent, and this filter
                    // never sees one that did.
                    kindFilter={paletteKindFilter}
                    actions={[
                        {
                            id: 'genie-run',
                            label: 'Run',
                            title: 'Save and run this flow in Genie',
                            placement: 'start',
                            disabled: () => busy || admission?.allowed === false,
                            onSelect: () => void runNow(),
                        },
                    ]}
                    showFeed={false}
                />
            </div>
        </div>
    );
}
