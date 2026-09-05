import { useEffect, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayRoot } from '../../lib/use-overlay-root';
import { clampPopoverToViewport } from '../../lib/anchored-popover';
import TerminalPanel from './TerminalPanel';
import { IconRefresh, IconSettings } from './icons';
import AgentTuiSwitcher from './AgentTuiSwitcher';
import type { AgentRuntimeSpec } from '../../lib/ams-grid';
import { restartOptionsFor, type RestartMode } from '../../../main/agents/restart-options';

type Props = ComponentProps<typeof TerminalPanel> & {
    onAgentSettings?: () => void;
    /** Restart this agent — `'resume'` continues the conversation, `'fresh'`
     *  relaunches from scratch. The panel decides WHICH it can offer from the
     *  spec (genie#443); the caller performs whichever it is handed. */
    onRestartAgent?: (mode: RestartMode) => void;
    /** This agent's record id + the TUIs it may run under — drives the panel's
     *  driver switcher. Absent for a panel whose agent has no record yet. */
    agentId?: string;
    /** This agent's own mark, so the avatar field opens showing what is set. */
    agentAvatar?: string | null;
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
    // Portal target: NEVER document.body -- Genie's surface tokens live on
    // .gwrap/.genie-overlay-root, and a portal outside that subtree resolves
    // them to nothing and paints transparent (genie #114).
    const overlayRoot = useOverlayRoot();
    const provider = String(props.spec.meta.agent ?? 'custom');
    const { style, onAgentSettings, onRestartAgent, agentId, agentAvatar, runtimes, onRuntimesChanged,
        ...terminalProps } = props;
    // WHICH restarts this agent can be offered, from the same resolver the host
    // reasons with. The header button takes the one that preserves the most:
    // resume when there is a conversation to keep, fresh otherwise — so the
    // control is never the button that only ever refuses, which is what it was
    // for every provider with no resume grammar (genie#443).
    const restartOptions = restartOptionsFor(props.spec);
    const primaryRestart: RestartMode = restartOptions.canResume ? 'resume' : 'fresh';
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
    // Keep the menu on screen. Right-clicking a panel near the bottom or right
    // of the window opened it at the cursor with no clamp at all, so its items
    // ran off the edge -- the same defect the sibling context menus had fixed
    // by hand and this one had never had (genie#416). Measured after mount, so
    // the height reflects which items actually rendered.
    useEffect(() => {
        const el = menuRef.current;
        if (!menu || !el) return;
        const rect = el.getBoundingClientRect();
        const { left, top } = clampPopoverToViewport({
            left: menu.x,
            top: menu.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
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
                                avatar={agentAvatar}
                                runtimes={runtimes ?? []}
                                onChanged={() => onRuntimesChanged?.()}
                            />
                        )}
                        {onRestartAgent && restartOptions.isAgent && (
                            <button
                                type="button"
                                className="pctl"
                                title={
                                    primaryRestart === 'resume'
                                        ? 'Restart agent (resume the conversation)'
                                        : 'Restart agent (fresh — starts a new conversation)'
                                }
                                aria-label="Restart agent"
                                onClick={() => onRestartAgent(primaryRestart)}
                            >
                                <IconRefresh size={14} />
                            </button>
                        )}
                    </>
                }
            />
            {menu && overlayRoot && createPortal(
                <div ref={menuRef} className="proj-popover ctx-menu agent-panel-menu" role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y }}>
                    {onAgentSettings && <button type="button" role="menuitem" onClick={() => { setMenu(null); onAgentSettings(); }}><IconSettings size={14} /> Agent settings…</button>}
                    {onRestartAgent && restartOptions.canResume && <button type="button" role="menuitem" onClick={() => { setMenu(null); onRestartAgent('resume'); }}><IconRefresh size={14} /> Restart agent (resume)</button>}
                    {onRestartAgent && restartOptions.canRestartFresh && <button type="button" role="menuitem" onClick={() => { setMenu(null); onRestartAgent('fresh'); }}><IconRefresh size={14} /> Restart agent (fresh)</button>}
                </div>,
                overlayRoot,
            )}
        </div>
    );
}
