import { Popover } from '@particle-academy/react-fancy';
import { providerBrandMark } from '../../lib/provider-brand';
import type { AgentStack, AgentStackEntry } from '../../lib/agent-stack';
import { BrandMark } from './BrandMark';

/**
 * WHO is working in this workspace, on the row itself.
 *
 * A workspace row said nothing about its agents — you had to expand it to find
 * out. The stack puts that on the row: one avatar per agent, running ones first,
 * with a count when they do not all fit. Hovering peeks at the detail: each
 * agent's active TUI and whether any sidecars are alive.
 *
 * Built on Fancy's `Popover`, not a hand-rolled panel. The first version hung an
 * absolutely-positioned div inside the row — a `<button>` in a scrolling list —
 * and it rendered as loose text across the workspaces underneath. Popover
 * portals and positions itself, so nothing in the row's stacking context can
 * clip or misplace it, INCLUDING the 56px rail when the sidebar is a flyout over
 * it. Reaching for the component instead of rebuilding one is also the standing
 * rule here.
 */
export default function AgentAvatarStack({ stack }: { stack: AgentStack }) {
    if (stack.total === 0) return null;

    return (
        <Popover hover placement="bottom-end" offset={8}>
            <Popover.Trigger
                aria-label={`${stack.running} of ${stack.total} agents running`}
            >
                <span
                    className="ws-agent-stack"
                    // The row itself is a button, so a peek must not activate the
                    // workspace.
                    onClick={(e) => e.stopPropagation()}
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
                </span>
            </Popover.Trigger>
            <Popover.Content className="ws-agent-popover" role="tooltip">
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
            </Popover.Content>
        </Popover>
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
