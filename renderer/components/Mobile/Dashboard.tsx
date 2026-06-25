import { useEffect, useState } from 'react';
import { Action, Icon, Text } from '@particle-academy/react-fancy';
import type { ProcessListItem, ProcessStatus } from '../../lib/genie';
import {
    listProcesses,
    MobileApiError,
    processAction,
    type MobileEvent,
    type MobileState,
    type MobileWorkspace,
    type ProcessAction,
} from '../../lib/mobile-client';

/**
 * The phone's home view: every workspace with its live agent state, and every
 * background process with start/stop/restart controls. Bootstraps from the
 * `GET /api/state` snapshot passed in by the shell, then patches itself live
 * from `/ws/events`:
 *   - `terminal:attention {id,on}` — an agent called imDone (the glow). We can't
 *     map a terminal id → workspace from this alone, so the glow is surfaced as
 *     a transient "needs attention" pulse on the workspace via `workspace:pulse`.
 *   - `workspace:pulse {workspaceId}` — activity in a workspace; we flash it.
 *   - `process:status {id,status}` — patch the process row's status in place.
 *   - `workspaces:changed` / `terminal-spec:changed` — refetch the relevant list.
 *
 * `events` is the live event stream owned by the shell; we subscribe via the
 * `subscribe` prop so a single WS feeds every tab.
 */

const PROCESS_STATUS_COLOR: Record<ProcessStatus, string> = {
    running: 'var(--emerald-500)',
    restarting: 'var(--amber-500)',
    stopped: 'var(--fg-4)',
    crashed: 'var(--rose-500)',
    failed: 'var(--rose-500)',
};

export default function Dashboard({
    state,
    subscribe,
    onLocked,
}: {
    state: MobileState;
    subscribe: (cb: (e: MobileEvent) => void) => () => void;
    onLocked: () => void;
}) {
    const [workspaces, setWorkspaces] = useState<MobileWorkspace[]>(state.workspaces);
    const [processes, setProcesses] = useState<ProcessListItem[]>(state.processes);
    // Workspace ids flashing right now (pulse / attention). Value = expiry timer.
    const [pulsing, setPulsing] = useState<Set<string>>(new Set());
    // Process ids with an in-flight start/stop/restart (disables the buttons).
    const [busy, setBusy] = useState<Set<string>>(new Set());

    // Re-seed when the shell hands us a fresh bootstrap (e.g. after re-pair).
    useEffect(() => {
        setWorkspaces(state.workspaces);
        setProcesses(state.processes);
    }, [state]);

    const flash = (workspaceId: string) => {
        setPulsing((prev) => {
            const next = new Set(prev);
            next.add(workspaceId);
            return next;
        });
        window.setTimeout(() => {
            setPulsing((prev) => {
                const next = new Set(prev);
                next.delete(workspaceId);
                return next;
            });
        }, 1_500);
    };

    useEffect(() => {
        const off = subscribe((e: MobileEvent) => {
            switch (e.type) {
                case 'workspace:pulse':
                    if (e.payload?.workspaceId) flash(e.payload.workspaceId);
                    break;
                case 'process:status':
                    setProcesses((prev) =>
                        prev.map((p) =>
                            p.id === e.payload?.id
                                ? { ...p, status: e.payload.status as ProcessStatus }
                                : p,
                        ),
                    );
                    break;
                case 'workspaces:changed':
                    // No phone-side workspaces refetch endpoint beyond /api/state's
                    // list; pull the full state's workspaces via /api/workspaces.
                    void (async () => {
                        try {
                            const { listWorkspaces } = await import('../../lib/mobile-client');
                            setWorkspaces(await listWorkspaces());
                        } catch {
                            /* transient — next bootstrap fixes it */
                        }
                    })();
                    break;
                case 'terminal-spec:changed':
                    void listProcesses()
                        .then(setProcesses)
                        .catch(() => {});
                    break;
                default:
                    break;
            }
        });
        return off;
    }, [subscribe]);

    const runAction = async (id: string, action: ProcessAction) => {
        setBusy((prev) => new Set(prev).add(id));
        try {
            setProcesses(await processAction(id, action));
        } catch (e) {
            if (e instanceof MobileApiError && e.isLocked) onLocked();
            // Other errors: the live process:status push will reconcile us.
        } finally {
            setBusy((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    return (
        <div className="m-scroll">
            <section className="m-section">
                <div className="m-section-head">
                    <Icon name="layout-grid" size="xs" />
                    <Text size="xs" className="m-section-title">
                        Workspaces
                    </Text>
                </div>
                {workspaces.length === 0 ? (
                    <Text size="sm" className="text-zinc-500 m-empty">
                        No workspaces.
                    </Text>
                ) : (
                    <div className="m-list">
                        {workspaces.map((ws) => (
                            <div
                                key={ws.id}
                                className={`m-card m-ws${pulsing.has(ws.id) ? ' m-pulse' : ''}`}
                            >
                                <div className="m-ws-main">
                                    <Text size="sm" style={{ fontWeight: 600 }}>
                                        {ws.name}
                                    </Text>
                                    <Text size="xs" className="text-zinc-500 m-mono m-truncate">
                                        {ws.path}
                                    </Text>
                                </div>
                                {pulsing.has(ws.id) && (
                                    <span className="m-attn" title="Active">
                                        <Icon name="sparkles" size="xs" />
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section className="m-section">
                <div className="m-section-head">
                    <Icon name="activity" size="xs" />
                    <Text size="xs" className="m-section-title">
                        Processes
                    </Text>
                </div>
                {processes.length === 0 ? (
                    <Text size="sm" className="text-zinc-500 m-empty">
                        No background processes.
                    </Text>
                ) : (
                    <div className="m-list">
                        {processes.map((p) => {
                            const isBusy = busy.has(p.id);
                            const running =
                                p.status === 'running' || p.status === 'restarting';
                            return (
                                <div key={p.id} className="m-card m-proc">
                                    <div className="m-proc-main">
                                        <div className="m-proc-title">
                                            <span
                                                className="m-dot"
                                                style={{
                                                    background:
                                                        PROCESS_STATUS_COLOR[p.status] ??
                                                        'var(--fg-4)',
                                                }}
                                            />
                                            <Text size="sm" style={{ fontWeight: 600 }}>
                                                {p.label}
                                            </Text>
                                        </div>
                                        <Text
                                            size="xs"
                                            className="text-zinc-500 m-truncate"
                                        >
                                            {p.workspace} · {p.status}
                                        </Text>
                                    </div>
                                    <div className="m-proc-actions">
                                        {running ? (
                                            <>
                                                <Action
                                                    size="sm"
                                                    variant="ghost"
                                                    icon="rotate-cw"
                                                    disabled={isBusy}
                                                    onClick={() =>
                                                        void runAction(p.id, 'restart')
                                                    }
                                                    aria-label="Restart"
                                                />
                                                <Action
                                                    size="sm"
                                                    variant="ghost"
                                                    color="rose"
                                                    icon="square"
                                                    disabled={isBusy}
                                                    onClick={() =>
                                                        void runAction(p.id, 'stop')
                                                    }
                                                    aria-label="Stop"
                                                />
                                            </>
                                        ) : (
                                            <Action
                                                size="sm"
                                                color="emerald"
                                                icon="play"
                                                disabled={isBusy}
                                                onClick={() =>
                                                    void runAction(p.id, 'start')
                                                }
                                                aria-label="Start"
                                            />
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
}
