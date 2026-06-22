import { useCallback, useEffect, useState } from 'react';
import { IconX, IconPlay, IconPause, IconRefresh } from './icons';
import {
    api,
    hasGenieBridge,
    type ProcessListItem,
    type ProcessStatus,
} from '../../lib/genie';

/**
 * Task Manager flyout. Right-side slide-in (reuses the Docs/IssueWatch flyout
 * chrome) listing EVERY background process Genie has spawned across ALL
 * workspaces plus the synthetic System Workspace — each row tagged with the
 * workspace that spawned it ("System" for system-workspace processes). It is a
 * cross-workspace view over the same headless process supervisor the
 * per-workspace Processes feature uses, with the same stop / restart controls.
 */

const STATUS_LABEL: Record<ProcessStatus, string> = {
    running: 'running',
    stopped: 'stopped',
    crashed: 'crashed',
    restarting: 'restarting',
    failed: 'failed',
};

/** A running/restarting process is "live" — stop is the relevant action. */
function isLive(status: ProcessStatus): boolean {
    return status === 'running' || status === 'restarting';
}

export default function TaskManagerFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [procs, setProcs] = useState<ProcessListItem[]>([]);
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        if (!hasGenieBridge()) return;
        setLoading(true);
        try {
            const list = await api().process.list().catch(() => []);
            setProcs(list);
        } finally {
            setLoading(false);
        }
    }, []);

    // Load on open, and keep statuses live while open via the supervisor's
    // broadcast (process:status). A status change can also reveal a new
    // process spec, so re-fetch the whole list rather than patching one row.
    useEffect(() => {
        if (!open) return;
        void refresh();
        const off = api().on.processStatus(() => void refresh());
        return off;
    }, [open, refresh]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const stop = async (id: string) => {
        await api().process.stop(id).catch(() => {});
        await refresh();
    };
    const start = async (id: string) => {
        await api().process.start(id).catch(() => {});
        await refresh();
    };
    const restart = async (id: string) => {
        await api().process.restart(id).catch(() => {});
        await refresh();
    };

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout tm-flyout"
                role="dialog"
                aria-label="Task Manager"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span className="docs-title">Task Manager</span>
                    <span className="grow" />
                    <button
                        type="button"
                        className="gicon"
                        onClick={() => void refresh()}
                        title="Refresh"
                        aria-label="Refresh process list"
                    >
                        <IconRefresh />
                    </button>
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        title="Close Task Manager"
                        aria-label="Close Task Manager"
                    >
                        <IconX />
                    </button>
                </div>

                <div className="tm-body">
                    {!hasGenieBridge() ? (
                        <div className="iw-muted">Task Manager runs inside Genie.</div>
                    ) : (
                        <>
                            <div className="iw-section-head">
                                Processes
                                {loading && <span className="iw-muted"> · refreshing…</span>}
                            </div>
                            {procs.length === 0 ? (
                                <div className="iw-muted">
                                    No background processes anywhere. Add one from a
                                    workspace's Processes panel.
                                </div>
                            ) : (
                                <ul className="tm-list">
                                    {procs.map((p) => {
                                        const live = isLive(p.status);
                                        return (
                                            <li key={p.id} className="tm-row">
                                                <span
                                                    className={`tm-dot tm-${p.status}`}
                                                    title={STATUS_LABEL[p.status]}
                                                />
                                                <div className="tm-main">
                                                    <div className="tm-label">
                                                        {p.label || p.command || p.id}
                                                    </div>
                                                    {p.command && (
                                                        <div
                                                            className="tm-cmd"
                                                            title={p.command}
                                                        >
                                                            {p.command}
                                                        </div>
                                                    )}
                                                </div>
                                                <span
                                                    className="tm-ws"
                                                    title={`Spawned by ${p.workspace}`}
                                                >
                                                    {p.workspace}
                                                </span>
                                                <span className="tm-status">
                                                    {STATUS_LABEL[p.status]}
                                                </span>
                                                <span className="tm-actions">
                                                    {live ? (
                                                        <button
                                                            type="button"
                                                            className="gicon"
                                                            title="Stop"
                                                            onClick={() => void stop(p.id)}
                                                        >
                                                            <IconPause />
                                                        </button>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="gicon"
                                                            title="Start"
                                                            onClick={() => void start(p.id)}
                                                        >
                                                            <IconPlay />
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className="gicon"
                                                        title="Restart"
                                                        onClick={() => void restart(p.id)}
                                                    >
                                                        <IconRefresh />
                                                    </button>
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}
