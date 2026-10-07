import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayRoot } from '../../lib/use-overlay-root';
import { clampPopoverToViewport } from '../../lib/anchored-popover';
import {
    agentChromeControls,
    agentChromeMenu,
    type AgentChromeInput,
} from '../../lib/agent-chrome';
import type { RestartMode } from '../../../main/agents/restart-options';
import { IconRefresh, IconSettings } from './icons';

/**
 * Agent chrome, rendered the same way by the grid tile and the Agent view header.
 *
 * Replaces `AgentPanel`, which was the only place this lived and therefore the reason the
 * Agent view had none of it. Every judgement — which restart mode leads, what the menu
 * offers, whether a warning is honest — is in `renderer/lib/agent-chrome.ts` and tested
 * there; these components only draw what that returns. The renderer has no DOM harness, so
 * a decision left in here is a decision nobody can assert on.
 *
 * Deliberately absent: the driver switcher. It lives in Agent settings → Driver, the one
 * control built on `decideTuiSwitch`, which never offers a switch the host would refuse
 * (genie#463). See the note in the lib module.
 */

export interface AgentChromeHandlers {
    onRestartAgent?: (mode: RestartMode) => void;
    onAgentSettings?: () => void;
}

/** The header actions row — restart, and a screen switch when the surface supplies one. */
export function AgentHeaderActions({
    input,
    onRestartAgent,
    onScreenSwitch,
}: {
    input: AgentChromeInput;
    onRestartAgent?: (mode: RestartMode) => void;
    onScreenSwitch?: () => void;
}) {
    const controls = agentChromeControls(input);
    if (controls.length === 0) return null;
    return (
        <>
            {controls.map((control) =>
                control.kind === 'screen-switch' ? (
                    <button
                        key="screen-switch"
                        type="button"
                        className="pctl agent-screen-switch"
                        aria-label={control.label}
                        title={control.label}
                        disabled={control.busy}
                        onClick={onScreenSwitch}
                    >
                        <span aria-hidden="true">{control.target === 'sidecar' ? '↔' : '←'}</span>
                        {control.name}
                    </button>
                ) : (
                    <button
                        key="restart"
                        type="button"
                        className="pctl"
                        title={control.title}
                        aria-label="Restart agent"
                        onClick={() => onRestartAgent?.(control.mode)}
                    >
                        <IconRefresh size={14} />
                    </button>
                ),
            )}
        </>
    );
}

/**
 * Right-click menu: settings, and whichever restarts are real.
 *
 * Returns the open/close plumbing so a surface can attach it to whatever element owns the
 * context menu, without each surface re-implementing the clamp.
 */
export function useAgentChromeMenu() {
    const [at, setAt] = useState<{ x: number; y: number } | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!at) return;
        const close = (event: globalThis.MouseEvent) => {
            if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) setAt(null);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [at]);

    // Keep it on screen. Right-clicking near the bottom or right edge opened it at the
    // cursor with no clamp, so its items ran off the edge — the defect the sibling context
    // menus had fixed by hand and this one never had (genie#416). Measured AFTER mount, so
    // the height reflects which items actually rendered.
    useEffect(() => {
        const el = ref.current;
        if (!at || !el) return;
        const rect = el.getBoundingClientRect();
        const { left, top } = clampPopoverToViewport({
            left: at.x,
            top: at.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }, [at]);

    return {
        at,
        ref,
        open: (event: MouseEvent) => {
            event.preventDefault();
            setAt({ x: event.clientX, y: event.clientY });
        },
        close: () => setAt(null),
    };
}

/** The menu itself, portalled into the overlay root. */
export function AgentChromeMenu({
    menu,
    input,
    onRestartAgent,
    onAgentSettings,
}: {
    menu: ReturnType<typeof useAgentChromeMenu>;
    input: AgentChromeInput;
} & AgentChromeHandlers) {
    // NEVER document.body: Genie's surface tokens live on `.gwrap`/`.genie-overlay-root`,
    // and a portal outside that subtree resolves them to nothing and paints transparent
    // (genie#114).
    const overlayRoot = useOverlayRoot();
    const items = agentChromeMenu(input);
    if (!menu.at || !overlayRoot || items.length === 0) return null;

    return createPortal(
        <div
            ref={menu.ref}
            className="proj-popover ctx-menu agent-panel-menu"
            role="menu"
            style={{ position: 'fixed', left: menu.at.x, top: menu.at.y }}
        >
            {items.map((item) => {
                if (item.kind === 'settings') {
                    return (
                        <button
                            key={item.kind}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                menu.close();
                                onAgentSettings?.();
                            }}
                        >
                            <IconSettings size={14} /> {item.label}
                        </button>
                    );
                }
                const mode: RestartMode = item.kind === 'restart-resume' ? 'resume' : 'fresh';
                return (
                    <button
                        key={item.kind}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            menu.close();
                            onRestartAgent?.(mode);
                        }}
                    >
                        <IconRefresh size={14} /> {item.label}
                    </button>
                );
            })}
        </div>,
        overlayRoot,
    );
}
