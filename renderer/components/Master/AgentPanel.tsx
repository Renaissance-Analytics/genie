import { useEffect, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import TerminalPanel from './TerminalPanel';
import { IconRefresh, IconSettings } from './icons';

type Props = ComponentProps<typeof TerminalPanel> & {
    onAgentSettings?: () => void;
    onRestartAgent?: () => void;
};

/**
 * A first-class Floor surface for an AMS agent. The PTY remains the agent's live
 * transport, but the surrounding UX is deliberately agent chrome: identity,
 * purpose and provider styling, with no shell switcher that could accidentally
 * turn the saved agent into an ordinary terminal.
 */
export default function AgentPanel(props: Props) {
    const provider = String(props.spec.meta.agent ?? 'custom');
    const { style, onAgentSettings, onRestartAgent, ...terminalProps } = props;
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
            <TerminalPanel {...terminalProps} surface="agent" />
            {onRestartAgent && (
                <button type="button" className="agent-panel-restart" title="Restart agent" aria-label="Restart agent" onClick={onRestartAgent}>
                    <IconRefresh size={14} />
                </button>
            )}
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
