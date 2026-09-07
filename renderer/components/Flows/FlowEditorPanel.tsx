import { useCallback, useEffect, useRef, useState } from 'react';
import { FlowEditor } from '@particle-academy/fancy-flow';
import '@particle-academy/fancy-flow/styles.css';
import { paletteKindFilter, registerFlowKinds } from '../../lib/flow-kinds';
import {
    flowEditorPanes,
    flowPaneLabel,
    flowPaneToggles,
    type FlowPaneName,
} from '../../lib/flow-editor-layout';
import {
    api,
    type FlowAdmissionView,
    type FlowRunOutcomeView,
    type FlowScope,
} from '../../lib/genie';

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
 *
 * ## It measures ITSELF, and never learns where it is
 *
 * Two surfaces render this: the Flow editor WINDOW (`pages/flow-editor.tsx`) and
 * a GApp window's Flows tab. Neither tells it which it is, and it must not ask —
 * the layout question is "how wide am I", and the answer is the same wherever
 * that width came from. So a `ResizeObserver` on its own shell feeds
 * `flow-editor-layout.ts`, which decides which side panes fit; the ones that do
 * not become overlays with a toolbar toggle each.
 *
 * That is also why fancy-flow's own responsive rules are overruled rather than
 * used: they are viewport media queries, and this component is never the
 * viewport. See `renderer/styles/master.css`, `the graph editor's panes`.
 *
 * ## Every call goes through `api()`
 *
 * Not `window.genie` directly, which is what this used to do. The difference is
 * invisible today — `makeRemoteBridge` overrides no flow call, so both resolve
 * to local IPC — and stops being invisible the moment flows reach the remote
 * bridge (genie#415): the editor's own chrome asks through `api()`, and a panel
 * still asking `window.genie` would then be editing the CLIENT's flow inside a
 * window titled after the HOST. That is genie#473 exactly, and it costs one
 * accessor to never have.
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
     * The editor's own width, and which side pane the user has floated over the
     * canvas.
     *
     * The panel measures ITSELF rather than reading the window: it is a tab in a
     * GApp window in one caller and the body of its own window in another, and
     * asking the viewport would be answering about a width it never had. That is
     * also the bug in fancy-flow's own media queries — see
     * `renderer/lib/flow-editor-layout.ts`, which holds the decision this
     * measurement feeds.
     */
    const shellRef = useRef<HTMLDivElement | null>(null);
    const [shellWidth, setShellWidth] = useState(0);
    const [openPane, setOpenPane] = useState<FlowPaneName | null>(null);

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

        void api().flows
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
        void api().flows.get(flowId).then((flow) => {
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
                void api().flows.check(scope, next).then(setAdmission);
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
            await api().flows.save({ id: flowId, title, scope, graph });
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
                await api().flows.save({ id: flowId, title, scope, graph });
            }
            setRun(await api().flows.run(flowId));
        } catch (e) {
            setRun({ ok: false, error: e instanceof Error ? e.message : 'The run failed.' });
        } finally {
            setBusy(false);
        }
    }, [enabled, flowId, graph, scope, title]);

    const ready = !!graph && kindsReady;

    // Re-observe when the editor actually mounts: the shell does not exist while
    // the palette is still loading, so an observer attached on the first render
    // would be watching nothing for the whole of it.
    useEffect(() => {
        const el = shellRef.current;
        if (!ready || !el || typeof ResizeObserver === 'undefined') return;
        setShellWidth(Math.round(el.getBoundingClientRect().width));
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width;
            if (typeof w === 'number') setShellWidth(Math.round(w));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [ready]);

    if (!graph || !kindsReady) {
        return <div className="p-4 text-sm opacity-70">{error ?? 'Loading…'}</div>;
    }

    const refusals = admission?.refusals ?? [];
    const panes = flowEditorPanes(shellWidth, openPane);
    const toggles = flowPaneToggles(shellWidth);

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

            {/*
              The shell is what gets MEASURED, and what an overlaid pane is
              positioned against. `data-overlay` is the one thing the stylesheet
              needs to know: which pane, if any, is currently floating over the
              canvas rather than sitting in the grid.
            */}
            <div
                ref={shellRef}
                className="floweditor-shell min-h-0 flex-1"
                data-overlay={panes.overlay ?? undefined}
            >
                <FlowEditor
                    value={graph as never}
                    onChange={onChange as never}
                    // Fill the box the container gives us. `<FlowEditor>` sets
                    // `style={{ height: props.height ?? 720, ...props.style }}`
                    // on its root, so without this the editor is a fixed 720px
                    // whatever the surrounding layout says — and `height` is
                    // typed `number`, so the percentage has to arrive via
                    // `style`, which is spread last and therefore wins.
                    //
                    // Every caller gives it a real height: the editor window's
                    // body, and the GApp Flows tab, through their own
                    // `flex: 1; min-height: 0` column.
                    //
                    // `gridTemplateColumns` names only the panes that are
                    // DOCKED. It has to arrive inline for the same reason the
                    // height does — `.ff-editor`'s own rule is a fixed
                    // `216px 1fr 300px` whatever `showPalette`/`showPanel` say,
                    // so turning a pane off without this leaves the canvas in a
                    // 216px column and an empty 300px one beside it. Raised
                    // upstream as Particle-Academy/fancy-flow#16.
                    style={{ height: '100%', gridTemplateColumns: panes.columns }}
                    showPalette={panes.showPalette}
                    showPanel={panes.showPanel}
                    // No `executors` prop, and the built-in Run is off — see the
                    // note at the top. Running belongs to the main process.
                    builtins={{ run: false }}
                    // Offers only steps Genie can actually run — the predicate
                    // asks `refusalFor`, the same function the executor's door
                    // asks. It removes the TRAP: you cannot drag on a node that
                    // would hang or fail the run. It is NOT the enforcement —
                    // the refusals at admission, save and run stay, because a
                    // graph can arrive hand-authored, imported, or from an
                    // agent, and this filter never sees one that did.
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
                        // The way BACK to a pane the width pushed out of the
                        // grid. Without these, a narrow editor is not responsive
                        // — it is amputated: no palette means no way to add a
                        // step at all, which is what fancy-flow's own media
                        // queries leave behind.
                        ...toggles.map((pane) => ({
                            id: `genie-pane-${pane}`,
                            label: flowPaneLabel(pane),
                            title:
                                pane === 'palette'
                                    ? 'Show the steps palette over the canvas'
                                    : 'Show the selected step’s settings over the canvas',
                            placement: 'start' as const,
                            // Toggling one CLOSES the other: the canvas is
                            // underneath, and two overlays at this width would
                            // cover the thing they exist to edit.
                            onSelect: () =>
                                setOpenPane((current) => (current === pane ? null : pane)),
                        })),
                    ]}
                    showFeed={false}
                />
            </div>
        </div>
    );
}
