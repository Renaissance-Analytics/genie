import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ShellProfile } from '@particle-academy/fancy-term';
import Terminal from '../Terminal/Terminal';
import { IconMaximize, IconMinimize, IconPause, IconX } from './icons';
import {
    api,
    detectedShells,
    type ShellDetection,
    type TerminalSpec,
    type WorkspaceRow,
} from '../../lib/genie';

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    onClose: () => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    /**
     * Tier 2: suspend this terminal — hide the panel but keep the pty running
     * so re-enabling resumes the live session. Distinct from onClose (which
     * detaches) and Delete (which kills + removes the spec).
     */
    onDisable?: () => void;
    focused?: boolean;
    /** Agent-integration MCP: pulse the panel border (imDone) until focused. */
    attention?: boolean;
    /** Clear the attention glow when the user focuses this panel's xterm. */
    onAttentionClear?: () => void;
    maximized?: boolean;
    style?: CSSProperties;
    onMarkActive: () => void;
    onMarkInactive: () => void;
}

function toProfile(s: ShellDetection): ShellProfile {
    return { id: s.id, label: s.label, command: s.command, args: s.args };
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
 *   - Shell switching: fancy-term's switcher fires onShellChange; we
 *     persist the choice on the spec, then remount the XTerm (key
 *     change). Unmount detaches the old pty (last detach kills it) and
 *     the remount spawns a fresh one with the chosen shell.
 */
export default function TerminalPanel({
    spec,
    workspace,
    onClose,
    onMaximize,
    onMinimize,
    onDisable,
    focused,
    attention,
    onAttentionClear,
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

    // null until detection resolves. The XTerm render WAITS for this:
    // fancy-term reshapes its DOM tree when showShellBar flips, which
    // would detach the xterm.js-mounted canvas mid-session. Resolving
    // shells first (cached, one IPC) keeps the tree stable for the
    // terminal's whole life.
    const [shellOptions, setShellOptions] = useState<ShellProfile[] | null>(null);
    // The live shell override (command + args). Starts from the spec;
    // switching updates it locally + persists to the spec row.
    const [shell, setShell] = useState<{
        command: string | null;
        args: string[] | undefined;
        id: string | null;
    }>({ command: spec.shell ?? null, args: spec.args, id: null });

    useEffect(() => {
        let alive = true;
        void detectedShells().then(({ shells, defaultId }) => {
            if (!alive) return;
            setShellOptions(shells.map(toProfile));
            // Resolve the active switcher id: explicit spec shell → match by
            // command; otherwise the detection default.
            const match = spec.shell
                ? shells.find((s) => s.command === spec.shell)
                : shells.find((s) => s.id === defaultId);
            if (match) setShell((cur) => ({ ...cur, id: match.id }));
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onShellChange = async (id: string, profile: ShellProfile): Promise<void> => {
        // Kill the pty BEFORE remounting. The remount reuses spec.id (the
        // multi-attach key Stage windows join on); without the explicit
        // kill, the new mount's create() would attach to the still-running
        // old-shell pty and the old mount's detach would then kill it.
        await api().terminal.kill(spec.id).catch(() => {});
        setShell({ command: profile.command ?? null, args: profile.args, id });
        // Persist on the spec so the choice survives restarts. Fire and
        // forget — a failed write only loses the persistence, not the
        // live switch.
        void api()
            .terminalSpec.update(spec.id, {
                shell: profile.command ?? null,
                args: profile.args ?? [],
            })
            .catch(() => {});
    };

    return (
        <section
            className={`tpanel${focused ? ' focus' : ''}${attention ? ' attention' : ''}`}
            style={style}
            // Clear this terminal's imDone glow on ANY real interaction with the
            // panel — focusin (onFocus), a click anywhere in it (onMouseDown), or
            // a keystroke (onKeyDownCapture). onFocus alone misses the common
            // case where the terminal was ALREADY focused when imDone fired (the
            // agent finished while you were in it): no focus transition occurs, so
            // only the next click/keypress acknowledges it. Gated on `attention`
            // so we don't fire a clear IPC on every interaction otherwise.
            // Capture phase so xterm's own handlers (which may stopPropagation)
            // can't swallow these before the glow clears.
            onFocusCapture={attention ? onAttentionClear : undefined}
            onMouseDownCapture={attention ? onAttentionClear : undefined}
            onKeyDownCapture={attention ? onAttentionClear : undefined}
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
                    {onDisable && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onDisable}
                            title="Suspend — keep running, hide panel"
                        >
                            <IconPause />
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
                {shellOptions !== null && (
                    <Terminal
                        key={`${spec.id}:${shell.command ?? 'default'}`}
                        id={spec.id}
                        // Tier 1: a fresh shell starts where the old one was —
                        // the OSC-7-tracked live_cwd wins over the static spec
                        // cwd when present, falling back when cwd tracking is
                        // off / unavailable.
                        cwd={spec.live_cwd ?? spec.cwd}
                        shell={shell.command ?? undefined}
                        args={shell.args}
                        env={spec.env}
                        // Relay REMOTE: tag the term `open` frame with the
                        // terminal's workspace so the host scopes it to the
                        // grant. Null (System/unattached) → undefined → the host
                        // falls back to requiring host:all.
                        workspaceId={spec.workspace_id ?? undefined}
                        onExit={onMarkInactive}
                        shells={shellOptions}
                        activeShell={shell.id ?? undefined}
                        onShellChange={onShellChange}
                    />
                )}
            </div>
        </section>
    );
}
