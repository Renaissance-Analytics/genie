import { useEffect, useRef, type CSSProperties } from 'react';
import XTerm from '../Terminal/XTerm';
import { IconMaximize, IconMinimize, IconX } from './icons';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    onClose: () => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    focused?: boolean;
    maximized?: boolean;
    style?: CSSProperties;
    onMarkActive: () => void;
    onMarkInactive: () => void;
}

/**
 * One terminal tile in the workspace grid.
 *
 *   - Render-stable: this component owns the XTerm and the pty. It
 *     stays mounted across layout-mode changes (the parent TerminalGrid
 *     keeps its key stable in `.pgrid`). Hiding via display: none on
 *     `style` is fine — xterm.js re-fits when visibility flips back.
 *   - The maximize button toggles a `maximizedId` upstream; when
 *     `maximized` is true, the icon switches to "minimize" so the user
 *     can restore the tiled view.
 */
export default function TerminalPanel({
    spec,
    workspace,
    onClose,
    onMaximize,
    onMinimize,
    focused,
    maximized,
    style,
    onMarkActive,
    onMarkInactive,
}: Props) {
    // Fire onMarkActive exactly once on mount, regardless of how many
    // times the panel rerenders. Cleaner than wiring this into XTerm.
    const firedRef = useRef(false);
    useEffect(() => {
        if (firedRef.current) return;
        firedRef.current = true;
        onMarkActive();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <section
            className={`tpanel${focused ? ' focus' : ''}`}
            style={style}
        >
            <div className="tpanel-head">
                <span className="pdot" style={{ background: '#10b981' }} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                </span>
                {workspace && (
                    <span className="ploc">
                        {workspace.project_name} · {workspace.backend}
                    </span>
                )}
                <span className="grow" />
                <span className="pa">
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
                <XTerm
                    id={spec.id}
                    cwd={spec.cwd}
                    shell={spec.shell ?? undefined}
                    args={spec.args}
                    env={spec.env}
                    onExit={onMarkInactive}
                />
            </div>
        </section>
    );
}
