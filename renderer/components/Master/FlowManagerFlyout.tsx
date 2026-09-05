import { useCallback, useEffect, useState } from 'react';
import { Action, Badge, Button, Switch, Text } from '@particle-academy/react-fancy';
import { IconAlert, IconChevronDown, IconFlow, IconPlus, IconTrash, IconX } from './icons';
import FlowEditorModal from './FlowEditorModal';
import {
    api,
    hasGenieBridge,
    isRemoteWindow,
    type FlowListPayload,
    type FlowRunLog,
    type FlowRunRecord,
    type FlowSummary,
} from '../../lib/genie';
import {
    describeClause,
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
 * The editor (`FlowEditorModal`) is reached from the header and from the empty
 * state. It creates a Flow switched OFF, every time — arming is the switch on
 * the row, behind a confirmation that states what the body does. Nothing about
 * authoring may become a way around that, so this surface never turns a Flow on
 * as a side effect of saving it.
 *
 * ## Live state is pushed, never polled
 *
 * The list fetches once on open and then subscribes to `flowActivity` and
 * `flowsChanged`. The fetch is not redundant with the subscription: a broadcast
 * has no persistence and nothing replays it, so a window that opened after the
 * last push would otherwise sit blank until something else happened to run.
 *
 * ## Not `renderer/components/Flows/`
 *
 * That is a GApp's node-graph canvas — a different thing at a different scope,
 * reached through `api().gappFlows`.
 */
export default function FlowManagerFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [payload, setPayload] = useState<FlowListPayload | null>(null);
    const [running, setRunning] = useState<readonly string[]>([]);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [history, setHistory] = useState<Record<string, FlowRunRecord[]>>({});
    const [pending, setPending] = useState<string | null>(null);
    const [result, setResult] = useState<FlowRunLog | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** The Flow awaiting an explicit "yes, arm it" — see {@link ArmConfirm}. */
    const [confirming, setConfirming] = useState<FlowSummary | null>(null);
    /** The host this window drives, for the "whose Flows are these" note. */
    const [hostName, setHostName] = useState<string | undefined>(undefined);
    /** Open on a Flow to edit it, on `null` to create one, closed otherwise. */
    const [editing, setEditing] = useState<{ flow: FlowSummary | null } | null>(null);
    /** The Flow awaiting an explicit "yes, delete it". */
    const [deleting, setDeleting] = useState<FlowSummary | null>(null);
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
            const next = await api().flows.list();
            setPayload(next);
            setRunning(next.running);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    // Fetch on open, then subscribe. Both halves are needed — see the note above.
    useEffect(() => {
        if (!open) return;
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
                setPayload((prev) =>
                    prev
                        ? {
                              ...prev,
                              flows: prev.flows.map((f) =>
                                  f.id === finished.flowId ? { ...f, lastRun: finished } : f,
                              ),
                          }
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
            // The editor and the confirmations own Escape while they are up:
            // closing the whole flyout out from under a half-written Flow
            // would throw the work away without asking.
            if (e.key === 'Escape' && !editing && !confirming && !deleting) {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, editing, confirming, deleting]);

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
    const toggle = (flow: FlowSummary) => {
        if (!flow.enabled && flow.consequence) {
            setConfirming(flow);
            return;
        }
        void setEnabled(flow, !flow.enabled);
    };

    const setEnabled = async (flow: FlowSummary, enabled: boolean) => {
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

    const runNow = async (flow: FlowSummary) => {
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

    const remove = async (flow: FlowSummary) => {
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

    const showHistory = async (flow: FlowSummary) => {
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
    const flows = payload?.flows ?? [];
    const groups = groupByPurpose(flows);
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
                    {payload && (
                        <button
                            type="button"
                            className="gicon flowmgr-new"
                            onClick={() => setEditing({ flow: null })}
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
                    ) : payload === null ? (
                        <div className="iw-muted">Reading your Flows…</div>
                    ) : flows.length === 0 ? (
                        <EmptyState
                            events={payload.events.length}
                            onCreate={() => setEditing({ flow: null })}
                        />
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
                                        result={result?.flowId === flow.id ? result : null}
                                        onToggle={() => toggle(flow)}
                                        onRun={() => void runNow(flow)}
                                        onExpand={() => void showHistory(flow)}
                                        onEdit={() => setEditing({ flow })}
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
        {editing && payload && (
            <FlowEditorModal
                payload={payload}
                editing={editing.flow}
                onClose={() => setEditing(null)}
                onSaved={(result) => {
                    // A save that turned an armed Flow OFF must say so. A
                    // switch moving on its own is exactly the kind of silent
                    // change this surface exists to prevent.
                    setNotice(
                        result.disarmed
                            ? `“${result.flow.title}” was switched off: what it does or where it acts changed, so it needs turning on again.`
                            : `Saved “${result.flow.title}”.`,
                    );
                    void reload();
                }}
            />
        )}
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
    flow: FlowSummary;
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
                    <p className="flowmgr-consequence">{flow.consequence}</p>
                    <p>
                        It will run on its own whenever its trigger fires
                        {flow.scope.kind === 'workspace'
                            ? ` in ${flow.scopeLabel}`
                            : flow.scope.kind === 'system'
                              ? ' anywhere on this machine'
                              : ''}
                        , without asking again. You can turn it off at any time.
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
function EmptyState({ events, onCreate }: { events: number; onCreate: () => void }) {
    return (
        <div className="flowmgr-empty">
            <IconFlow size={22} />
            <Text size="sm" style={{ fontWeight: 600 }}>
                No Flows yet
            </Text>
            <Text size="xs" className="text-zinc-500">
                A Flow is a recipe, the triggers that start it, and the scope it may
                touch. Genie&rsquo;s automation runs them; nothing has been set up on
                this machine.
            </Text>
            <Text size="xs" className="text-zinc-500">
                {events === 0
                    ? 'No triggers are registered, so there is nothing for a Flow to react to yet.'
                    : `${events} trigger${events === 1 ? '' : 's'} ${
                          events === 1 ? 'is' : 'are'
                      } registered and ready for one.`}
            </Text>
            <Button size="sm" className="flowmgr-empty-new" onClick={onCreate}>
                <IconPlus size={12} /> New Flow
            </Button>
        </div>
    );
}

/**
 * Deleting asks, and arming asks — for opposite reasons.
 *
 * Arming is dangerous because the machine starts doing something. Deleting is
 * not dangerous at all; it is IRREVERSIBLE, and the thing lost is a
 * configuration with conditions in it that somebody worked out once. The run
 * history goes with it, which is the part people do not expect.
 */
function DeleteConfirm({
    flow,
    busy,
    onCancel,
    onConfirm,
}: {
    flow: FlowSummary;
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
    flow: FlowSummary;
    running: boolean;
    busy: boolean;
    expanded: boolean;
    history?: FlowRunRecord[];
    result: FlowRunLog | null;
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
                                color={t.kind === 'event' && !t.known ? 'orange' : undefined}
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
                    {flow.manuallyRunnable && (
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
            {!flow.enabled && flow.consequence && (
                <div className="flowmgr-off">
                    Off — {flow.consequence}
                </div>
            )}

            {/* A Flow that looks armed and cannot fire. The one thing a list
                would never tell you, so it is stated on the row rather than
                left to be deduced from a badge colour. */}
            {flow.enabled && !flow.canEverFire && (
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
                    <Badge size="sm" color={describeOutcome(result.outcome).color}>
                        {describeOutcome(result.outcome).label}
                    </Badge>
                    <span>{result.reason ?? 'The Flow ran to completion.'}</span>
                </div>
            )}

            {expanded && (
                <div className="flowmgr-history">
                    {flow.triggers.some((t) => t.kind === 'event' && t.clauses.length > 0) && (
                        <>
                            <div className="iw-subhead">Conditions</div>
                            <ul className="flowmgr-clauses">
                                {flow.triggers.flatMap((t) =>
                                    t.kind === 'event'
                                        ? t.clauses.map((c, i) => (
                                              <li key={`${t.event}-${i}`}>{describeClause(c)}</li>
                                          ))
                                        : [],
                                )}
                            </ul>
                        </>
                    )}
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
function whyItCannotFire(flow: FlowSummary): string {
    if (flow.scope.kind === 'workspace' && flow.scopeLabel.startsWith('A workspace that')) {
        return 'the workspace it is scoped to no longer exists';
    }
    if (flow.scope.kind === 'gapp' && flow.scopeLabel.startsWith('An app that')) {
        return 'the app that owns it is no longer installed';
    }
    const dead = flow.triggers.filter((t) => t.kind === 'event' && !t.known);
    if (dead.length > 0) {
        return `nothing emits ${dead
            .map((t) => (t.kind === 'event' ? t.event : ''))
            .join(', ')} any more`;
    }
    return 'it has no trigger anything can reach';
}

/** Grouped by purpose, in the order main already sorted them. */
function groupByPurpose(flows: readonly FlowSummary[]): [string, FlowSummary[]][] {
    const out = new Map<string, FlowSummary[]>();
    for (const flow of flows) {
        const bucket = out.get(flow.purpose);
        if (bucket) bucket.push(flow);
        else out.set(flow.purpose, [flow]);
    }
    return [...out.entries()];
}
