import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import XTerm from '../Terminal/XTerm';
import {
    IconMaximize,
    IconMinimize,
    IconPause,
    IconPlay,
    IconRefresh,
    IconX,
} from './icons';
import { api, type TerminalSpec, type WorkspaceRow } from '../../lib/genie';
import { decideOnExit, type ProcessStatus } from '../../lib/process-supervisor';

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    onClose: () => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    focused?: boolean;
    /** Agent-integration MCP: pulse the panel border (imDone) until focused. */
    attention?: boolean;
    maximized?: boolean;
    style?: CSSProperties;
    onMarkActive: () => void;
    onMarkInactive: () => void;
}

const STATUS_LABEL: Record<ProcessStatus, string> = {
    running: 'Running',
    restarting: 'Restarting…',
    stopped: 'Stopped',
    crashed: 'Crashed',
    failed: 'Failed',
};

/**
 * A Process tile — a background service runner (e.g. `php artisan queue:work`).
 *
 * Reuses the terminal pty + XTerm output view, but runs the spec's
 * `meta.command` non-interactively (the arg shaping happens in main's
 * terminal:create) and adds service controls: start / stop / restart, a live
 * status badge, optional autostart, and auto-restart-on-crash with exponential
 * backoff (decideOnExit / restartDelay).
 *
 * The pty is killed on stop but the SPEC is kept — restart respawns it. Like
 * terminals, a process panel stays mounted (hidden) across workspace switches,
 * so its supervisor keeps running until the panel closes or the app quits.
 */
export default function ProcessPanel({
    spec,
    workspace,
    onClose,
    onMaximize,
    onMinimize,
    focused,
    attention,
    maximized,
    style,
    onMarkActive,
    onMarkInactive,
}: Props) {
    const command = spec.meta?.command ?? '';
    const restartOnExit = spec.meta?.restart_on_exit !== false;
    const autostart = spec.meta?.autostart !== false;

    const [status, setStatus] = useState<ProcessStatus>('stopped');
    const [started, setStarted] = useState(false);
    const [runKey, setRunKey] = useState(0);
    const attemptRef = useRef(0);
    const userStoppedRef = useRef(false);
    const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTimer = () => {
        if (restartTimer.current) {
            clearTimeout(restartTimer.current);
            restartTimer.current = null;
        }
    };

    const launch = useCallback(() => {
        clearTimer();
        userStoppedRef.current = false;
        setRunKey((k) => k + 1);
        setStarted(true);
        setStatus('running');
        onMarkActive();
    }, [onMarkActive]);

    const start = useCallback(() => {
        attemptRef.current = 0;
        launch();
    }, [launch]);

    const stop = useCallback(async () => {
        clearTimer();
        userStoppedRef.current = true;
        attemptRef.current = 0;
        setStarted(false);
        setStatus('stopped');
        await api().terminal.kill(spec.id).catch(() => {});
        onMarkInactive();
    }, [spec.id, onMarkInactive]);

    const restart = useCallback(async () => {
        attemptRef.current = 0;
        await api().terminal.kill(spec.id).catch(() => {});
        launch();
    }, [spec.id, launch]);

    // Autostart once on mount; clean up the restart timer on unmount.
    const didInit = useRef(false);
    useEffect(() => {
        if (didInit.current) return;
        didInit.current = true;
        if (autostart) start();
        return () => clearTimer();
    }, [autostart, start]);

    const handleExit = useCallback(
        (info: { exitCode: number }) => {
            onMarkInactive();
            const d = decideOnExit({
                userStopped: userStoppedRef.current,
                restartOnExit,
                exitCode: info.exitCode,
                attempt: attemptRef.current,
            });
            attemptRef.current = d.nextAttempt;
            setStarted(false);
            setStatus(d.status);
            if (d.restartInMs !== null) {
                restartTimer.current = setTimeout(() => launch(), d.restartInMs);
            }
        },
        [restartOnExit, onMarkInactive, launch],
    );

    const isLive = status === 'running' || status === 'restarting';

    return (
        <section
            className={`tpanel${focused ? ' focus' : ''}${attention ? ' attention' : ''}`}
            style={style}
        >
            <div className="tpanel-head">
                <span className={`pdot proc-dot proc-${status}`} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                    <span className={`proc-status proc-${status}`}>
                        {STATUS_LABEL[status]}
                    </span>
                </span>
                {command && (
                    <span className="ploc" title={command}>
                        {command}
                    </span>
                )}
                <span className="grow" />
                <span className="pa">
                    {isLive ? (
                        <button
                            type="button"
                            className="pctl"
                            onClick={() => void stop()}
                            title="Stop process"
                        >
                            <IconPause />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="pctl proc-start"
                            onClick={start}
                            title="Start process"
                        >
                            <IconPlay />
                        </button>
                    )}
                    <button
                        type="button"
                        className="pctl"
                        onClick={() => void restart()}
                        title="Restart process"
                    >
                        <IconRefresh />
                    </button>
                    {onMinimize && !maximized && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onMinimize}
                            title="Send to side stack"
                        >
                            <IconMinimize />
                        </button>
                    )}
                    {onMaximize && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onMaximize}
                            title={maximized ? 'Restore tiled view' : 'Maximize panel'}
                        >
                            {maximized ? <IconMinimize /> : <IconMaximize size={13} />}
                        </button>
                    )}
                    <button
                        type="button"
                        className="pctl"
                        onClick={onClose}
                        title="Close panel"
                    >
                        <IconX />
                    </button>
                </span>
            </div>
            <div className="term-host">
                {started ? (
                    <XTerm
                        key={`${spec.id}:${runKey}`}
                        id={spec.id}
                        cwd={spec.live_cwd ?? spec.cwd}
                        env={spec.env}
                        onExit={handleExit}
                    />
                ) : (
                    <div className="proc-idle">
                        <span className={`proc-idle-status proc-${status}`}>
                            {STATUS_LABEL[status]}
                        </span>
                        {command && <code className="proc-idle-cmd">{command}</code>}
                        <button
                            type="button"
                            className="proc-idle-start"
                            onClick={start}
                        >
                            <IconPlay size={12} /> Start
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}
