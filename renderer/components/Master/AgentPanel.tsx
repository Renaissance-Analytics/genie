import { useEffect, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import TerminalPanel from './TerminalPanel';
import { IconRefresh, IconSettings } from './icons';
import AgentTuiSwitcher from './AgentTuiSwitcher';
import type { AgentRuntimeSpec } from '../../lib/ams-grid';

type Props = ComponentProps<typeof TerminalPanel> & {
    onAgentSettings?: () => void;
    onRestartAgent?: () => void;
    /** This agent's record id + the TUIs it may run under — drives the panel's
     *  driver switcher. Absent for a panel whose agent has no record yet. */
    agentId?: string;
    runtimes?: AgentRuntimeSpec[];
    onRuntimesChanged?: () => void;
};

/**
 * A first-class Floor surface for an AMS agent. The PTY remains the agent's live
 * transport, but the surrounding UX is deliberately agent chrome: identity,
 * purpose and provider styling, with no shell switcher that could accidentally
 * turn the saved agent into an ordinary terminal.
 */
export default function AgentPanel(props: Props) {
    const provider = String(props.spec.meta.agent ?? 'custom');
    const { style, onAgentSettings, onRestartAgent, agentId, runtimes, onRuntimesChanged,
        ...terminalProps } = props;
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!menu) return;
        const close = (event: globalThis.MouseEvent) => {
            if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) setMenu(null);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [menu]);
    const openMenu = (event: MouseEvent) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
    };
    return (
        <div
            className={`agent-panel-shell agent-provider-${provider}`}
            data-agent-provider={provider}
            style={style}
            onContextMenu={openMenu}
        >
            {/* The restart control rides in the panel's OWN actions row. It was
                absolutely positioned at a hard-coded `right: 72px`, which
                overlapped the panel's buttons -- a fixed offset cannot survive
                the control set changing, and it had already stopped fitting. */}
            <TerminalPanel
                {...terminalProps}
                surface="agent"
                headerActions={
                    <>
                        {/* Driver + sidecars, where the agent actually is. */}
                        {agentId && (
                            <AgentTuiSwitcher
                                agentId={agentId}
                                runtimes={runtimes ?? []}
                                onChanged={() => onRuntimesChanged?.()}
                            />
                        )}
                        {onRestartAgent && (
                            <button
                                type="button"
                                className="pctl"
                                title="Restart agent"
                                aria-label="Restart agent"
                                onClick={onRestartAgent}
                            >
                                <IconRefresh size={14} />
                            </button>
                        )}
                    </>
                }
            />
            {menu && createPortal(
                <div ref={menuRef} className="proj-popover ctx-menu agent-panel-menu" role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y }}>
                    {onAgentSettings && <button type="button" role="menuitem" onClick={() => { setMenu(null); onAgentSettings(); }}><IconSettings size={14} /> Agent settings…</button>}
                    {onRestartAgent && <button type="button" role="menuitem" onClick={() => { setMenu(null); onRestartAgent(); }}><IconRefresh size={14} /> Restart agent</button>}
                </div>,
                document.body,
            )}
        </div>
    );
}
