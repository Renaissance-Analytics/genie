import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { providerBrandMark } from '../../lib/provider-brand';
import type { AgentStack, AgentStackEntry } from '../../lib/agent-stack';
import { BrandMark } from './BrandMark';

/**
 * WHO is working in this workspace, on the row itself.
 *
 * A workspace row said nothing about its agents — you had to expand it to find
 * out. The stack puts that on the row: one avatar per agent, running ones first,
 * with a count when they do not all fit. Hovering opens the detail: each agent's
 * active TUI and whether any sidecars are alive.
 *
 * The detail is PORTALED and `position: fixed`, the same shape
 * `runtime-pill-menu` uses two controls to the right. The first version anchored
 * it `absolute` inside the row, and it rendered as loose text over the workspace
 * rows beneath — a row is a `<button>` inside a scrolling list, which is a bad
 * place to hang an overlay. Copying the pattern that already works on this exact
 * row removes the whole class of problem: no stacking context to fight, no
 * clipping, and nothing painted across the next workspace.
 */
export default function AgentAvatarStack({ stack }: { stack: AgentStack }) {
    const anchor = useRef<HTMLSpanElement>(null);
    const [at, setAt] = useState<{ top: number; right: number } | null>(null);

    // Close on any scroll or resize: the popover is FIXED, so the row would
    // slide out from under it and leave the detail floating beside a different
    // workspace — which is worse than showing nothing, because it reads as true.
    useEffect(() => {
        if (!at) return;
        const close = () => setAt(null);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [at]);

    if (stack.total === 0) return null;

    const open = (): void => {
        const rect = anchor.current?.getBoundingClientRect();
        if (rect) setAt({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };

    return (
        <span
            ref={anchor}
            className="ws-agent-stack"
            onMouseEnter={open}
            onMouseLeave={() => setAt(null)}
            // The row itself is a button, so this must not activate the
            // workspace when someone is only reading the detail.
            onClick={(e) => e.stopPropagation()}
            aria-label={`${stack.running} of ${stack.total} agents running`}
        >
            {stack.entries.map((entry) => (
                <span
                    key={entry.id}
                    className={`ws-agent-avatar${entry.running ? ' is-running' : ''}${
                        entry.collisionGroup ? ' is-collision' : ''
                    }`}
                >
                    <Face entry={entry} />
                </span>
            ))}
            {stack.overflow > 0 && (
                <span className="ws-agent-avatar is-overflow">+{stack.overflow}</span>
            )}
            {at &&
                createPortal(
                    <div
                        className="ws-agent-popover"
                        role="tooltip"
                        style={{ top: at.top, right: at.right }}
                    >
                        {stack.entries.map((entry) => (
                            <div key={entry.id} className="ws-agent-popover-row">
                                <span className="ws-agent-popover-face">
                                    <Face entry={entry} />
                                </span>
                                <span className="ws-agent-popover-text">
                                    <strong>{entry.name}</strong>
                                    <span className="ws-agent-popover-meta">{meta(entry)}</span>
                                </span>
                            </div>
                        ))}
                        {stack.overflow > 0 && (
                            <div className="ws-agent-popover-more">
                                and {stack.overflow} more — open the workspace to see them all
                            </div>
                        )}
                    </div>,
                    document.body,
                )}
        </span>
    );
}

/** One agent's status line. */
function meta(entry: AgentStackEntry): string {
    const parts = [
        entry.provider
            ? `${entry.provider} · ${entry.running ? 'running' : 'stopped'}`
            : 'no TUI yet',
    ];
    if (entry.sidecars.length > 0) {
        parts.push(
            `${entry.sidecars.length} sidecar${
                entry.sidecars.length === 1 ? '' : 's'
            } (${entry.sidecars
                .map((s) => `${s.provider} ${s.running ? 'live' : 'idle'}`)
                .join(', ')})`,
        );
    }
    if (entry.collisionGroup) parts.push('name conflict');
    return parts.join(' · ');
}

/**
 * A user avatar if there is one, else the TUI's brand mark, else the initial.
 *
 * The initial is the honest fallback for a TUI with no mark of its own:
 * borrowing another vendor's logo asserts a relationship that does not exist,
 * and a blank would read as "no agent".
 */
function Face({ entry }: { entry: AgentStackEntry }) {
    if (entry.avatar) return <span className="ws-agent-emoji">{entry.avatar}</span>;
    const mark = providerBrandMark(entry.provider);
    if (mark) return <BrandMark name={mark} size={14} />;
    return <span className="ws-agent-initial">{entry.name.slice(0, 1).toUpperCase()}</span>;
}
