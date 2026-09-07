import { useCallback, useEffect, useState } from 'react';
import { Action, Badge, Button, Switch, Text } from '@particle-academy/react-fancy';
import { IconAlert, IconChevronDown, IconFlow, IconPlus, IconTrash, IconX } from './icons';
import {
    api,
    hasGenieBridge,
    isRemoteWindow,
    type FlowRunOutcomeView,
    type FlowRunRecord,
    type FlowSummaryView,
} from '../../lib/genie';
import {
    describeFlowSource,
    describeOutcome,
    describeTrigger,
    relativeTime,
} from '../../lib/flow-view';

/**
 * The Flow Manager — the first surface Genie's automation system has ever had.
 *
 * `main/flows/` shipped a complete model, store and runtime with no IPC and no
 * UI: nothing in the app could see a Flow, arm one, or find out whether one had
 * ever run. This is that surface.
 *
 * ## What it is for
 *
 * Not a browser. An automation system's manager exists to answer ONE question —
 * why did, or did not, this happen — and everything here serves it:
 *
 *  - the last run's OUTCOME, refusals included, because "the loop guard held it"
 *    is the answer somebody is looking for and a list of successes hides it;
 *  - a standing warning on a Flow that CANNOT FIRE, which otherwise looks
 *    completely normal — enabled, titled, and pointing at an event nothing emits
 *    or a workspace that has been removed;
 *  - the run history behind each row, so "it worked yesterday" is checkable.
 *
 * ## Creating one, and what creation is NOT
 *
 * New flows are minted by main with a starter graph, switched OFF, every time —
 * arming is the switch on the row, behind a confirmation that states what the
 * flow does. Nothing about authoring may become a way around that, so this
 * surface never turns a flow on as a side effect of saving it.
 *
 * ## The canvas, and why the list is not one
 *
 * Editing opens `<FlowEditor>` — the real one — in a WINDOW of its own
 * (genie#505). It used to open in a card over this one, and a card is not a
 * place to pan and zoom a graph with a palette down one side and an inspector
 * down the other. This surface therefore owns no editor state at all: it asks
 * main to open the window and hears about the result on `flows:changed` like any
 * other change.
 *
 * The LIST does not open an editor: it uses
 * `<FlowViewer variant="list">`, which is read-only by construction rather than
 * by a prop, because a viewer that can be switched into an editor is a viewer
 * somebody eventually switches into an editor by accident. Passing the last
 * run's statuses to that same component is how "why did this not fire" is
 * answered — by showing which node stopped, instead of prose reconstructing a
 * condition.
 *
 * ## Live state is pushed, never polled
 *
 * The list fetches once on open and then subscribes to `flowActivity` and
 * `flowsChanged`. The fetch is not redundant with the subscription: a broadcast
 * has no persistence and nothing replays it, so a window that opened after the
 * last push would otherwise sit blank until something else happened to run.
 *
 * ## There is only one kind of flow
 *
 * A GApp's flow is a flow whose SCOPE is `gapp`. It uses this manager, this
 * table and this editor; the GApp window's own Flows tab is the same components
 * filtered to that app. Genie used to have two systems under this name, and the
 * cost was two answers to "which flows are there".
 */
export default function FlowManagerFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [flows, setFlows] = useState<FlowSummaryView[] | null>(null);
    const [running, setRunning] = useState<readonly string[]>([]);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [history, setHistory] = useState<Record<string, FlowRunRecord[]>>({});
    const [pending, setPending] = useState<string | null>(null);
    const [result, setResult] = useState<FlowRunOutcomeView | null>(null);
    /** Which row `result` belongs to — the outcome itself does not say. */
    const [lastRunFor, setLastRunFor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** The Flow awaiting an explicit "yes, arm it" — see {@link ArmConfirm}. */
    const [confirming, setConfirming] = useState<FlowSummaryView | null>(null);
    /** The host this window drives, for the "whose Flows are these" note. */
    const [hostName, setHostName] = useState<string | undefined>(undefined);
    /** The Flow awaiting an explicit "yes, delete it". */
    const [deleting, setDeleting] = useState<FlowSummaryView | null>(null);
    /** Said out loud when a save turned an armed Flow off, or one was deleted. */
    const [notice, setNotice] = useState<string | null>(null);
    const remote = isRemoteWindow();

    // A remote window's Flow Manager reads THIS workstation, because `flows.*`
    // is not routed over the bridge. Naming the host it is NOT showing needs the
    // host's name, so fetch it — only in the case that uses it.
    useEffect(() => {
        if (!open || !remote || !hasGenieBridge()) return;
        let alive = true;
        api()
            .remote.status()
            .then((s) => {
                if (alive) setHostName(s.host?.hostname);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [open, remote]);

    const reload = useCallback(async () => {
        if (!hasGenieBridge()) return;
        try {
            // The MACHINE's vantage: every flow, at every scope. A GApp window
            // asks the same channel with its own vantage and gets its own.
            setFlows(await api().flows.list({ kind: 'system' }));
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    // Fetch on open, then subscribe. Both halves are needed — see the note above.
    useEffect(() => {
        if (!open) return;
        // The flyout is hidden by a class rather than unmounted, so last
        // session's "Saved …" would still be sitting there on reopening — a
        // notice about something that happened before the user left the room.
        setNotice(null);
        void reload();
    }, [open, reload]);

    useEffect(() => {
        if (!open || !hasGenieBridge()) return;
        const offActivity = api().on.flowActivity((p) => {
            setRunning(p.running);
            // The closing run rides along, so a finished row updates its outcome
            // without a round trip.
            if (p.finished) {
                const finished = p.finished;
                setFlows((prev) =>
                    prev
                        ? prev.map((f) =>
                              f.id === finished.flowId ? { ...f, lastRun: finished } : f,
                          )
                        : prev,
                );
                setHistory((prev) =>
                    prev[finished.flowId]
                        ? {
                              ...prev,
                              [finished.flowId]: [
                                  finished,
                                  ...prev[finished.flowId]!.filter(
                                      (r) => r.runId !== finished.runId,
                                  ),
                              ],
                          }
                        : prev,
                );
            }
        });
        const offChanged = api().on.flowsChanged(() => void reload());
        return () => {
            offActivity();
            offChanged();
        };
    }, [open, reload]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            // The confirmations own Escape while they are up. The EDITOR no
            // longer needs to: it is a separate window with its own key
            // handling, so a keystroke there never reaches this one.
            if (e.key === 'Escape' && !confirming && !deleting) {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, confirming, deleting]);

    /**
     * Arming asks first; disarming never does.
     *
     * The asymmetry is the point. Turning a Flow OFF cannot surprise anybody —
     * the machine does less. Turning one ON hands it standing permission to act
     * unattended, and `genie.relocate-file` acting unattended means the user's
     * files move. A switch with a title beside it says what the Flow is CALLED;
     * it does not say that. So a body that declares a consequence gets a
     * confirmation that states it, and one that declares none arms straight
     * away rather than manufacturing ceremony out of nothing.
     */
    const toggle = (flow: FlowSummaryView) => {
        if (!flow.enabled && flow.consequence.length > 0) {
            setConfirming(flow);
            return;
        }
        void setEnabled(flow, !flow.enabled);
    };

    /**
     * Mint a flow and open its canvas — in its OWN WINDOW (genie#505).
     *
     * System-scoped, because that is what "new flow" means from the machine's
     * own manager. It arrives DISARMED — creating and arming are different
     * decisions, and this surface never turns one on as a side effect.
     *
     * The list does not need refreshing when that window saves: `flows:save`
     * pushes `flows:changed`, which this flyout already subscribes to.
     */
    const create = async () => {
        try {
            // `{ scope }`, not the scope itself — main reads `input.scope`, and
            // passing the bare object made `parseFlowScope` see `undefined`,
            // return null, and the handler hand back no flow at all. Nothing
            // threw; the canvas simply never opened.
            const flow = await api().flows.create({ scope: { kind: 'system' } });
            await reload();
            if (flow) await api().flows.openWindow(flow.id);
            else setError('Genie could not create a flow.');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const setEnabled = async (flow: FlowSummaryView, enabled: boolean) => {
        setPending(flow.id);
        try {
            await api().flows.setEnabled(flow.id, enabled);
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(null);
            setConfirming(null);
        }
    };

    const runNow = async (flow: FlowSummaryView) => {
        setPending(flow.id);
        setResult(null);
        try {
            // The LOG comes back, not `{ ok }`: "this Flow has no manual
            // trigger" and "its body needs the wizard" are the useful answers,
            // and a generic failure would hide both.
            setResult(await api().flows.run(flow.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(null);
        }
    };

    const remove = async (flow: FlowSummaryView) => {
        setPending(flow.id);
        try {
            await api().flows.remove(flow.id);
            setNotice(`Deleted “${flow.title}”.`);
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(null);
            setDeleting(null);
        }
    };

    const showHistory = async (flow: FlowSummaryView) => {
        if (expanded === flow.id) {
            setExpanded(null);
            return;
        }
        setExpanded(flow.id);
        if (history[flow.id]) return;
        try {
            const runs = await api().flows.runs(flow.id, 20);
            setHistory((prev) => ({ ...prev, [flow.id]: runs }));
        } catch {
            setHistory((prev) => ({ ...prev, [flow.id]: [] }));
        }
    };

    const sourceNote = describeFlowSource({ remote, hostName });
    const rows = flows ?? [];
    const groups = groupByPurpose(rows);
    const liveCount = running.length;

    return (
        <>
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout iw-flyout"
                role="dialog"
                aria-label="Flows"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span
                        className="docs-title"
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        <IconFlow size={15} />
                        Flows
                    </span>
                    {liveCount > 0 && (
                        <Badge color="blue" size="sm">
                            {liveCount} running
                        </Badge>
                    )}
                    <span className="grow" />
                    {flows && (
                        <button
                            type="button"
                            className="gicon flowmgr-new"
                            onClick={() => void create()}
                            title="New Flow"
                            aria-label="New Flow"
                        >
                            <IconPlus />
                        </button>
                    )}
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        title="Close"
                        aria-label="Close"
                    >
                        <IconX />
                    </button>
                </div>

                <div className="iw-body">
                    {/* Named before anything is listed, because the list is the
                        thing that would otherwise mislead. A remote window's
                        Flow Manager looks identical to a local one and is about
                        a different computer. */}
                    {sourceNote && <div className="flowmgr-source">{sourceNote}</div>}
                    {notice && (
                        <div className="flowmgr-notice" role="status">
                            {notice}
                        </div>
                    )}
                    {!hasGenieBridge() ? (
                        <div className="iw-muted">This runs inside Genie.</div>
                    ) : error ? (
                        <div className="iw-muted">{error}</div>
                    ) : flows === null ? (
                        <div className="iw-muted">Reading your Flows…</div>
                    ) : rows.length === 0 ? (
                        <EmptyState onCreate={() => void create()} />
                    ) : (
                        groups.map(([purpose, rows]) => (
                            <div key={purpose}>
                                <div className="iw-section-head">{purpose}</div>
                                {rows.map((flow) => (
                                    <FlowRow
                                        key={flow.id}
                                        flow={flow}
                                        running={running.includes(flow.id)}
                                        busy={pending === flow.id}
                                        expanded={expanded === flow.id}
                                        history={history[flow.id]}
                                        result={lastRunFor === flow.id ? result : null}
                                        onToggle={() => toggle(flow)}
                                        onRun={() => void runNow(flow)}
                                        onExpand={() => void showHistory(flow)}
                                        onEdit={() => void api().flows.openWindow(flow.id)}
                                        onDelete={() => setDeleting(flow)}
                                    />
                                ))}
                            </div>
                        ))
                    )}
                </div>
            </aside>
        </div>
        {/* OUTSIDE the flyout root, deliberately, for two reasons that both bite.
            `.docs-flyout-root` sets `pointer-events: none` and hands it back only
            to the aside and its scrim — a modal nested inside it renders
            perfectly and cannot be clicked. And the root is `position: fixed`
            with `z-index: 60`, so it opens a stacking context that would scope
            `.prompt-scrim`'s z-index 100 INSIDE it, quietly breaking the layer
            ladder documented at the top of master.css. */}
        {deleting && (
            <DeleteConfirm
                flow={deleting}
                busy={pending === deleting.id}
                onCancel={() => setDeleting(null)}
                onConfirm={() => void remove(deleting)}
            />
        )}
        {confirming && (
            <ArmConfirm
                flow={confirming}
                busy={pending === confirming.id}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void setEnabled(confirming, true)}
            />
        )}
        </>
    );
}

/**
 * The one place in this surface with deliberate friction.
 *
 * It states what the Flow will DO, in the recipe's own words, at the moment the
 * user is arming it — not in a doc, not in a tooltip they may never open. A
 * switch flipped without reading is how "Genie moved my files" becomes a support
 * ticket, and the sentence that prevents it has to be in front of the click.
 *
 * The confirm button says what will happen rather than "OK", so the last thing
 * read before committing is still the action and not an acknowledgement.
 */
function ArmConfirm({
    flow,
    busy,
    onCancel,
    onConfirm,
}: {
    flow: FlowSummaryView;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div className="prompt-scrim" onMouseDown={onCancel}>
            <div
                className="prompt-card"
                role="dialog"
                aria-modal="true"
                aria-label={`Turn on ${flow.title}`}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="prompt-title">
                    <IconAlert size={15} />
                    Turn on “{flow.title}”?
                </div>
                <div className="prompt-body">
                    {/* Derived from the graph, so the sentence a person agrees
                        to cannot drift from what the flow does. An empty list
                        renders as SILENCE — never as an invented "this is safe",
                        which would be a promise nobody made. */}
                    {flow.consequence.length > 0 && (
                        <p className="flowmgr-consequence">
                            It will be able to use: {flow.consequence.join(', ')}.
                        </p>
                    )}
                    {/* WHAT THE SCOPE GRANTS, in words, at the moment of arming.
                        "System" is a value in a dropdown; what it MEANS is that
                        the flow acts as the workstation operator, in every
                        workspace, with nobody watching. A user who has read the
                        graph still has not agreed to that, because the scope is
                        not visible IN the graph — so it is said here or it is
                        not said at all. */}
                    <p>{describeArming(flow)}</p>
                </div>
                <div className="prompt-actions">
                    <button
                        type="button"
                        className="prompt-btn"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    {/* Primary, not destructive-red. Arming destroys nothing at
                        the moment of the click, and a red button that cries wolf
                        is a red button the user stops reading. The friction here
                        is the SENTENCE above it. */}
                    <button
                        type="button"
                        className="prompt-btn prompt-btn-primary"
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        {busy ? 'Turning on…' : 'Turn it on'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * The empty state, and the way out of it.
 *
 * Genie ships with no Flows, so this is the first thing most people see here.
 * It says what a Flow IS before offering to make one — an empty list with a
 * lone Add button teaches nothing about what is about to be created.
 */
function EmptyState({ onCreate }: { onCreate: () => void }) {
    return (
        <div className="flowmgr-empty">
            <IconFlow size={22} />
            <Text size="sm" style={{ fontWeight: 600 }}>
                No flows yet
            </Text>
            <Text size="xs" className="text-zinc-500">
                A flow is a diagram of steps and what starts them. Draw one on the
                canvas, and Genie runs it — on a schedule, when something happens,
                or when you press Run.
            </Text>
            <Text size="xs" className="text-zinc-500">
                New flows arrive switched off, so you can see what one does before
                letting it act on its own.
            </Text>
            <Button size="sm" className="flowmgr-empty-new" onClick={onCreate}>
                <IconPlus size={12} /> New flow
            </Button>
        </div>
    );
}

function DeleteConfirm({
    flow,
    busy,
    onCancel,
    onConfirm,
}: {
    flow: FlowSummaryView;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div className="prompt-scrim" onMouseDown={onCancel}>
            <div
                className="prompt-card"
                role="dialog"
                aria-modal="true"
                aria-label={`Delete ${flow.title}`}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="prompt-title">
                    <IconTrash size={15} />
                    Delete “{flow.title}”?
                </div>
                <div className="prompt-body">
                    <p>
                        Its triggers, conditions and settings go with it, and so does its run
                        history. Nothing it has already done is undone.
                    </p>
                </div>
                <div className="prompt-actions">
                    <button
                        type="button"
                        className="prompt-btn"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="prompt-btn prompt-btn-destructive"
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        {busy ? 'Deleting…' : 'Delete it'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function FlowRow({
    flow,
    running,
    busy,
    expanded,
    history,
    result,
    onToggle,
    onRun,
    onExpand,
    onEdit,
    onDelete,
}: {
    flow: FlowSummaryView;
    running: boolean;
    busy: boolean;
    expanded: boolean;
    history?: FlowRunRecord[];
    result: FlowRunOutcomeView | null;
    onToggle: () => void;
    onRun: () => void;
    onExpand: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const last = flow.lastRun;
    const lastDesc = last ? describeOutcome(last.outcome) : null;

    return (
        <div className={`flowmgr-row${running ? ' is-running' : ''}`}>
            <div className="flowmgr-main">
                <button
                    type="button"
                    className={`flowmgr-disclose${expanded ? ' open' : ''}`}
                    onClick={onExpand}
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Hide run history' : 'Show run history'}
                    title="Run history"
                >
                    <IconChevronDown size={13} />
                </button>

                <div className="flowmgr-identity">
                    <div className="flowmgr-title">
                        {flow.title}
                        {running && <span className="flowmgr-live" aria-label="Running now" />}
                    </div>
                    {flow.description && (
                        <div className="flowmgr-desc">{flow.description}</div>
                    )}
                    <div className="flowmgr-chips">
                        <Badge size="sm" variant="soft">
                            {flow.scopeLabel}
                        </Badge>
                        {flow.triggers.map((t, i) => (
                            <Badge
                                key={i}
                                size="sm"
                                variant="soft"
                                color={
                                    // Orange marks a trigger that cannot fire —
                                    // a schedule with no time, an event with
                                    // nothing chosen. The badge is the only
                                    // place a half-finished trigger is visible
                                    // without opening the canvas.
                                    (t.kind === 'event' && (!t.event || t.known === false)) ||
                                    (t.kind === 'schedule' && !t.cron) ||
                                    t.kind === 'webhook'
                                        ? 'orange'
                                        : undefined
                                }
                            >
                                {describeTrigger(t)}
                            </Badge>
                        ))}
                    </div>
                </div>

                <div className="flowmgr-state">
                    {last && lastDesc ? (
                        <span className="flowmgr-last" title={last.reason ?? undefined}>
                            <Badge size="sm" color={lastDesc.color}>
                                {lastDesc.label}
                            </Badge>
                            <span className="flowmgr-when">
                                {relativeTime(last.finishedAt)}
                            </span>
                        </span>
                    ) : (
                        <span className="flowmgr-when">Never run</span>
                    )}
                </div>

                <div className="flowmgr-actions">
                    <Action
                        variant="ghost"
                        size="xs"
                        icon="pencil"
                        disabled={busy}
                        onClick={onEdit}
                        title="Edit"
                        aria-label={`Edit ${flow.title}`}
                    />
                    <Action
                        variant="ghost"
                        size="xs"
                        icon="trash"
                        disabled={busy}
                        onClick={onDelete}
                        title="Delete"
                        aria-label={`Delete ${flow.title}`}
                    />
                    {flow.readable && (
                        <Action
                            variant="ghost"
                            size="xs"
                            icon="play"
                            disabled={busy || running}
                            onClick={onRun}
                            title="Run now"
                            aria-label={`Run ${flow.title} now`}
                        />
                    )}
                    <Switch
                        checked={flow.enabled}
                        disabled={busy}
                        onCheckedChange={onToggle}
                        aria-label={`${flow.enabled ? 'Disable' : 'Enable'} ${flow.title}`}
                    />
                </div>
            </div>

            {/* Off, and what turning it on would mean. A row that says only
                "disabled" is a switch; a row that says what the switch DOES is
                a decision the user can actually make. */}
            {!flow.enabled && flow.consequence.length > 0 && (
                <div className="flowmgr-off">
                    Off — turning it on lets it use: {flow.consequence.join(', ')}.
                </div>
            )}

            {/* A Flow that looks armed and cannot fire. The one thing a list
                would never tell you, so it is stated on the row rather than
                left to be deduced from a badge colour. */}
            {flow.enabled && !canEverFire(flow) && (
                <div className="flowmgr-warn">
                    <IconAlert size={13} />
                    <span>
                        This Flow is on but nothing can start it —{' '}
                        {whyItCannotFire(flow)}.
                    </span>
                </div>
            )}

            {result && (
                <div className="flowmgr-result">
                    <Badge size="sm" color={describeOutcome(result.ok ? 'ran' : 'failed').color}>
                        {describeOutcome(result.ok ? 'ran' : 'failed').label}
                    </Badge>
                    <span>{result.error ?? 'The flow ran to completion.'}</span>
                    {/* Every step that would be turned away, NAMED. A refusal
                        that says only "not permitted" sends somebody to guess
                        which of nine steps it meant. */}
                    {result.refusals && result.refusals.length > 0 && (
                        <ul className="flowmgr-clauses">
                            {result.refusals.map((r) => (
                                <li key={r.nodeId}>
                                    <code>{r.label ?? r.nodeId}</code> — {r.reason}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {expanded && (
                <div className="flowmgr-history">
                    <div className="iw-subhead">Recent runs</div>
                    {history === undefined ? (
                        <div className="iw-muted">Reading…</div>
                    ) : history.length === 0 ? (
                        <div className="iw-muted">This Flow has never run.</div>
                    ) : (
                        <ul className="flowmgr-runs">
                            {history.map((run) => {
                                const d = describeOutcome(run.outcome);
                                return (
                                    <li key={run.runId} className="flowmgr-run">
                                        <Badge size="sm" color={d.color}>
                                            {d.label}
                                        </Badge>
                                        <span className="flowmgr-when">
                                            {relativeTime(run.finishedAt)}
                                        </span>
                                        {run.event && (
                                            <span className="flowmgr-run-event">{run.event}</span>
                                        )}
                                        {run.reason && (
                                            <span className="flowmgr-run-reason">
                                                {run.reason}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

/** The specific reason, never a generic "misconfigured". */
/**
 * Can anything actually start this flow?
 *
 * A flow that looks armed and cannot fire is the one thing a list would never
 * tell you — enabled, titled, and pointing at a trigger nothing reaches. So it
 * is stated on the row rather than left to be deduced.
 *
 * A MANUAL trigger counts: a person can start it, which is a way to fire.
 */
function canEverFire(flow: FlowSummaryView): boolean {
    if (!flow.readable) return false;
    return flow.triggers.some((t) => {
        if (t.kind === 'manual') return true;
        if (t.kind === 'schedule') return !!t.cron;
        // An event trigger fires only if something still EMITS its event.
        if (t.kind === 'event') return !!t.event && t.known !== false;
        return false;
    });
}

/**
 * What arming this flow lets it reach, said plainly.
 *
 * The consent has to name the SCOPE and what the scope confers, not just where
 * the flow lives. A confirmation that says "anywhere on this machine" describes
 * a location; the thing being agreed to is an authority — acting as the
 * workstation operator, unattended, until somebody turns it off.
 */
function describeArming(flow: FlowSummaryView): string {
    const ending = ' It keeps doing that until you turn it off.';

    if (flow.scope?.kind === 'workspace') {
        return (
            `It will run on its own whenever its trigger fires, without asking again — ` +
            `acting only inside ${flow.scopeLabel}, and never on another project's files.` +
            ending
        );
    }
    if (flow.scope?.kind === 'gapp') {
        return (
            `It will run on its own whenever its trigger fires, without asking again — ` +
            `as “${flow.scopeLabel}”, limited to exactly what you granted that app when you ` +
            `installed it. It can never do more than the app itself can.` + ending
        );
    }
    if (flow.scope?.kind === 'system') {
        return (
            `It will run on its own whenever its trigger fires, without asking again — ` +
            `as YOU, on the whole machine. That means every workspace, not just this one, ` +
            `with the same reach the workstation operator has.` + ending
        );
    }
    // An unreadable scope. Genie will refuse to run it anyway, and saying so is
    // better than a sentence that implies somewhere specific.
    return 'Genie cannot read where this flow belongs, so it will not run until that is fixed.';
}

function whyItCannotFire(flow: FlowSummaryView): string {
    if (!flow.readable) return 'Genie cannot read its graph or its scope';
    if (flow.triggers.length === 0) return 'it has no trigger at all';
    const schedule = flow.triggers.find((t) => t.kind === 'schedule' && !t.cron);
    if (schedule) return 'its schedule has no time set';
    const unchosen = flow.triggers.find((t) => t.kind === 'event' && !t.event);
    if (unchosen) return 'its trigger has no event chosen';
    const dead = flow.triggers.filter((t) => t.kind === 'event' && t.known === false);
    if (dead.length > 0) {
        return `nothing emits ${dead.map((t) => t.event).join(', ')} any more`;
    }
    const webhook = flow.triggers.find((t) => t.kind === 'webhook');
    if (webhook) return webhook.unsupported ?? 'Genie cannot arm a webhook yet';
    return 'it has no trigger anything can reach';
}

/** Grouped by purpose, in the order main already sorted them. */
function groupByPurpose(flows: readonly FlowSummaryView[]): [string, FlowSummaryView[]][] {
    const out = new Map<string, FlowSummaryView[]>();
    for (const flow of flows) {
        const bucket = out.get(flow.purpose);
        if (bucket) bucket.push(flow);
        else out.set(flow.purpose, [flow]);
    }
    return [...out.entries()];
}
