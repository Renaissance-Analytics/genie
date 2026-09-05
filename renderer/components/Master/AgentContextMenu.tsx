import { useEffect, useRef } from 'react';
import { IconPlay, IconPin, IconAlert, IconTrash } from './icons';
import { agentCardMenuItems, type AgentCardMenuItem } from '../../lib/agent-card-menu';
import type { AgentGridRow } from '../../lib/ams-grid';
import { clampPopoverToViewport } from '../../lib/anchored-popover';

/**
 * The right-click menu for an agent square — including one that is NOT running.
 *
 * The square's menu used to be the TERMINAL menu, opened behind `if (specId)`.
 * A paused agent has no spec, so right-clicking it did nothing and said
 * nothing. This menu is built from the agent record instead, which is what a
 * stopped agent still has.
 *
 * Dismissal mirrors SpecContextMenu deliberately: two menus on the same surface
 * that close differently is the kind of small inconsistency that reads as
 * breakage. Edge-clamping is no longer mirrored but SHARED -- four copies of
 * it had drifted into three different amounts of the job (genie#416), so it
 * lives in `lib/anchored-popover` and this file is one of its callers.
 */
export default function AgentContextMenu({
    position,
    row,
    onClose,
    onAct,
}: {
    position: { x: number; y: number };
    row: AgentGridRow;
    onClose: () => void;
    onAct: (id: AgentCardMenuItem['id']) => void;
}) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDocClick = (e: MouseEvent) => {
            if (!menuRef.current) return;
            if (e.target instanceof Node && !menuRef.current.contains(e.target)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    // Clamp to the viewport, so a right-click near an edge does not open a menu
    // half off screen.
    useEffect(() => {
        const el = menuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const { left, top } = clampPopoverToViewport({
            left: position.x,
            top: position.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const items = agentCardMenuItems(row);
    if (items.length === 0) return null;

    const iconFor = (id: AgentCardMenuItem['id']) =>
        id === 'start' ? (
            <IconPlay size={14} />
        ) : id === 'delete' || id === 'remove-orphan' ? (
            <IconTrash size={14} />
        ) : (
            <IconPin size={14} />
        );

    return (
        <div
            ref={menuRef}
            className="proj-popover ctx-menu agent-ctx-menu"
            role="menu"
            style={{ position: 'fixed', left: position.x, top: position.y }}
        >
            <div className="ctx-header">
                <span className="ctx-header-label">{row.name}</span>
                {/* What this agent IS, not which TUI happens to be driving it —
                    the state line names the driver only when there is one. */}
                <span className="ctx-header-sub">
                    {row.running
                        ? `running · ${row.provider ?? 'no TUI'}`
                        : 'not running'}
                </span>
            </div>
            <div className="proj-popover-section">
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className={`ctx-item${item.primary ? ' is-primary' : ''}${
                            item.id === 'delete' || item.id === 'remove-orphan'
                                ? ' is-destructive'
                                : ''
                        }`}
                        onClick={() => {
                            onClose();
                            onAct(item.id);
                        }}
                    >
                        {iconFor(item.id)}
                        <span className="ctx-item-body">
                            <span className="ctx-item-label">{item.label}</span>
                            {item.hint && <span className="ctx-item-hint">{item.hint}</span>}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
