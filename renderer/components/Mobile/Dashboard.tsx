import { useEffect, useState } from 'react';
import { Action, Icon, Text } from '@particle-academy/react-fancy';
import UploadToAi from './Upload';
import type { ProcessListItem, ProcessStatus } from '../../lib/genie';
import {
    checkUpdate,
    getUpdateStatus,
    installUpdate,
    listProcesses,
    MobileApiError,
    processAction,
    type MobileEvent,
    type MobileState,
    type MobileUpdateStatus,
    type MobileWorkspace,
    type ProcessAction,
} from '../../lib/mobile-client';

/**
 * The phone's home view — data-first. It leads with the LIVE state of the rig:
 * every workspace with its agent-activity pulse (imDone glow / `workspace:pulse`)
 * and the Upload-to-`.ai/_dirty` control, then every background process with its
 * status + start/stop/restart. The two critical TOOLS sit up top in a tight
 * strip: "Upgrade Genie" (mirrors the desktop updater — tap to restart & apply a
 * downloaded build) and Upload (surfaced per workspace, where the file lands).
 *
 * Bootstraps from the `GET /api/state` snapshot the shell passes in, then patches
 * itself live from `/ws/events`:
 *   - `workspace:pulse {workspaceId}` — activity in a workspace; we flash it.
 *   - `process:status {id,status}` — patch the process row's status in place.
 *   - `update:changed {…}` — the desktop updater advanced; the Upgrade tool tracks it.
 *   - `workspaces:changed` / `terminal-spec:changed` — refetch the relevant list.
 *
 * `events` is the live stream owned by the shell; we subscribe via `subscribe`
 * so a single WS feeds every tab. Layout is deliberately DENSE — tight cards,
 * minimal chrome — to fit a phone without wasting vertical space.
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

    const runningCount = processes.filter(
        (p) => p.status === 'running' || p.status === 'restarting',
    ).length;

    return (
        <div className="m-scroll m-dash">
            {/* Tools strip — the one global tool (Upgrade); Upload is per-workspace. */}
            <UpgradeGenie subscribe={subscribe} onLocked={onLocked} />

            <section className="m-section">
                <div className="m-section-head">
                    <Icon name="layout-grid" size="xs" />
                    <Text size="xs" className="m-section-title">
                        Workspaces
                    </Text>
                    {workspaces.length > 0 && (
                        <span className="m-count">{workspaces.length}</span>
                    )}
                </div>
                {workspaces.length === 0 ? (
                    <Text size="sm" className="text-zinc-500 m-empty">
                        No workspaces.
                    </Text>
                ) : (
                    <div className="m-list">
                        {workspaces.map((ws) => {
                            const active = pulsing.has(ws.id);
                            return (
                                <div
                                    key={ws.id}
                                    className={`m-card m-ws${active ? ' m-pulse' : ''}`}
                                >
                                    <div className="m-ws-top">
                                        <span
                                            className={`m-dot${active ? ' m-dot-live' : ''}`}
                                            style={{
                                                background: active
                                                    ? 'var(--violet-500)'
                                                    : 'var(--fg-4)',
                                            }}
                                            title={active ? 'Active' : 'Idle'}
                                        />
                                        <div className="m-ws-main">
                                            <Text size="sm" style={{ fontWeight: 600 }} className="m-truncate">
                                                {ws.name}
                                            </Text>
                                            <Text size="xs" className="text-zinc-500 m-mono m-truncate">
                                                {ws.path}
                                            </Text>
                                        </div>
                                        {active && (
                                            <span className="m-attn" title="Active">
                                                <Icon name="sparkles" size="xs" />
                                            </span>
                                        )}
                                    </div>
                                    <UploadToAi workspaceId={ws.id} onLocked={onLocked} />
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            <section className="m-section">
                <div className="m-section-head">
                    <Icon name="activity" size="xs" />
                    <Text size="xs" className="m-section-title">
                        Processes
                    </Text>
                    {processes.length > 0 && (
                        <span className="m-count">
                            {runningCount}/{processes.length}
                        </span>
                    )}
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
                                            <Text size="sm" style={{ fontWeight: 600 }} className="m-truncate">
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

/**
 * "Upgrade Genie" — the phone's view of the desktop self-updater. It reads the
 * current state from `GET /api/update/status` on mount and tracks it live via the
 * `update:changed` push, so a newly-found update surfaces here without a refresh.
 * When one is available (or already staged) it becomes a single CTA: tap →
 * `POST /api/update/install` runs the SAME hands-free desktop flow (download if
 * needed → quitAndInstall), then Genie restarts into the new version. Up-to-date
 * is a slim, unobtrusive line so the tool never wastes space until it has
 * something to say.
 */
function UpgradeGenie({
    subscribe,
    onLocked,
}: {
    subscribe: (cb: (e: MobileEvent) => void) => () => void;
    onLocked: () => void;
}) {
    const [status, setStatus] = useState<MobileUpdateStatus | null>(null);
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refetch = () =>
        getUpdateStatus()
            .then(setStatus)
            .catch(() => {});

    // On open, ASK the host to check — it never auto-downloads, so a pending
    // update isn't visible until we tell it to look. (Errors just leave the last
    // status; the host's 'checking' state shows progress via update:changed.)
    const check = () =>
        checkUpdate()
            .then(setStatus)
            .catch(() => {});

    useEffect(() => {
        void check();
    }, []);

    // Live updater state — once the user taps Update the desktop advances
    // available → downloading → ready-to-restart → restart; mirror each tick here.
    useEffect(() => {
        const off = subscribe((e: MobileEvent) => {
            if (e.type === 'update:changed' && e.payload) {
                setStatus(e.payload as MobileUpdateStatus);
            }
        });
        return off;
    }, [subscribe]);

    const onInstall = async () => {
        if (installing) return;
        setInstalling(true);
        setError(null);
        try {
            await installUpdate();
            // The desktop quits ~200ms later to apply; hold the "restarting" copy.
        } catch (e) {
            setInstalling(false);
            if (e instanceof MobileApiError && e.isLocked) {
                onLocked();
                return;
            }
            // 409 ⇒ nothing staged (raced the state); re-sync and show the latest.
            if (e instanceof MobileApiError && e.status === 409) {
                void refetch();
                return;
            }
            setError(e instanceof Error ? e.message : 'Update failed');
        }
    };

    if (!status) return null;

    const ready = status.readyToInstall;
    // A found-but-not-yet-downloaded update. We do NOT background-download, so
    // 'available' is a CTA — tapping "Update" runs the hands-free
    // download → install → restart (POST /api/update/install) — not a progress
    // state.
    const available = status.state === 'available';
    const downloading = status.state === 'downloading' || status.state === 'applying';
    const checking = status.state === 'checking';
    const version = status.latestVersion ?? status.currentVersion;

    // Installing → restarting copy; ready → CTA; downloading/checking → progress;
    // else a slim "up to date" line.
    let body: React.ReactNode;
    if (installing) {
        body = (
            <div className="m-tool-main">
                <Icon name="loader" size="xs" className="m-spin" />
                <Text size="sm" style={{ fontWeight: 600 }}>
                    Updating…
                </Text>
            </div>
        );
    } else if (ready) {
        body = (
            <>
                <div className="m-tool-main">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        Update ready
                    </Text>
                    <Text size="xs" className="m-mono" style={{ color: 'inherit', opacity: 0.85 }}>
                        v{version}
                    </Text>
                </div>
                <button type="button" className="m-tool-cta" onClick={() => void onInstall()}>
                    <Icon name="rotate-cw" size="xs" />
                    Restart &amp; update
                </button>
            </>
        );
    } else if (available) {
        body = (
            <>
                <div className="m-tool-main">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        Update available
                    </Text>
                    <Text size="xs" className="m-mono" style={{ color: 'inherit', opacity: 0.85 }}>
                        v{version}
                    </Text>
                </div>
                <button type="button" className="m-tool-cta" onClick={() => void onInstall()}>
                    <Icon name="download" size="xs" />
                    Update
                </button>
            </>
        );
    } else if (downloading) {
        body = (
            <div className="m-tool-main">
                <Icon name="download" size="xs" />
                <Text size="sm" style={{ fontWeight: 600 }}>
                    Downloading v{version}…
                </Text>
            </div>
        );
    } else if (checking) {
        body = (
            <div className="m-tool-main">
                <Icon name="loader" size="xs" className="m-spin" />
                <Text size="sm" className="text-zinc-500">
                    Checking for updates…
                </Text>
            </div>
        );
    } else {
        body = (
            <div className="m-tool-main">
                <Icon name="check" size="xs" className="text-emerald-500" />
                <Text size="sm" className="text-zinc-500">
                    Up to date
                </Text>
                <Text size="xs" className="m-mono text-zinc-500">
                    v{status.currentVersion}
                </Text>
                <button
                    type="button"
                    onClick={() => void check()}
                    title="Check the host for updates"
                    style={{
                        marginLeft: 'auto',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--fg-3)',
                        cursor: 'pointer',
                        font: 'inherit',
                        fontSize: 12,
                        padding: '4px 6px',
                    }}
                >
                    <Icon name="refresh-cw" size="xs" />
                    Check
                </button>
            </div>
        );
    }

    return (
        <div className={`m-tool${ready ? ' m-tool-ready' : ''}`}>
            <span className="m-tool-icon">
                <Icon name="sparkles" size="sm" />
            </span>
            {body}
            {error && (
                <Text size="xs" className="text-rose-500 m-truncate">
                    {error}
                </Text>
            )}
        </div>
    );
}
