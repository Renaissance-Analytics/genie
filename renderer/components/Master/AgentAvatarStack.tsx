import { Popover } from '@particle-academy/react-fancy';
import { providerBrandMark } from '../../lib/provider-brand';
import type { AgentStack, AgentStackEntry } from '../../lib/agent-stack';
import { agentStackStats, agentStackStatus } from '../../lib/agent-stack-stats';
import { agentCardMenuItems, type AgentCardMenuItem } from '../../lib/agent-card-menu';
import { BrandMark } from './BrandMark';

/**
 * WHO is working in this workspace, on the row itself.
 *
 * A workspace row said nothing about its agents — you had to expand it to find
 * out. The stack puts that on the row: one avatar per agent, running ones first,
 * with a count when they do not all fit.
 *
 * The popover is NOT a tooltip. When the sidebar is collapsed it is the only way
 * to reach an agent, so it carries what the expanded grid carries: STATUS, STATS
 * and the same CONTROLS. It first shipped as a single status line with nothing
 * to click, which is the thing the owner asked for twice.
 *
 * Built on Fancy's `Popover`, not a hand-rolled panel. The first version hung an
 * absolutely-positioned div inside the row — a `<button>` in a scrolling list —
 * and it rendered as loose text across the workspaces underneath. Popover
 * portals and positions itself, so nothing in the row's stacking context can
 * clip or misplace it, INCLUDING the 56px rail when the sidebar is a flyout over
 * it. Reaching for the component instead of rebuilding one is also the standing
 * rule here.
 */
export default function AgentAvatarStack({
    stack,
    onAct,
}: {
    stack: AgentStack;
    /** Run one of the agent's controls. Same model the sidebar's context menu
     *  uses, so the two cannot offer different things for the same agent. */
    onAct?: (entry: AgentStackEntry, action: AgentCardMenuItem['id']) => void;
}) {
    if (stack.total === 0) return null;

    return (
        // To the RIGHT of the avatar row, vertically centred (owner). `right`
        // rather than `right-start`: the panel is centred on the avatars, not
        // hung from their top edge.
        <Popover hover placement="right" offset={10}>
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
            {/* `menu`, not `tooltip`: it holds controls, and a tooltip role
                tells a screen reader there is nothing here to operate. */}
            <Popover.Content className="ws-agent-popover" role="menu">
                {stack.entries.map((entry) => (
                    <div key={entry.id} className="ws-agent-popover-row">
                        <span className="ws-agent-popover-face">
                            <Face entry={entry} />
                        </span>
                        <span className="ws-agent-popover-text">
                            <strong>{entry.name}</strong>
                            {/* STATUS — which driver, and whether it is up. */}
                            <span className="ws-agent-popover-meta">
                                {agentStackStatus(entry)}
                            </span>
                            {/* STATS — the countable facts, and only the real
                                ones: per-agent throughput does not exist in the
                                renderer, so nothing here pretends to it. */}
                            <span className="ws-agent-popover-stats">
                                {agentStackStats(entry).map((stat) => (
                                    <span key={stat} className="ws-agent-stat">
                                        {stat}
                                    </span>
                                ))}
                            </span>
                            {/* CONTROLS — the same model the sidebar's agent
                                menu uses, so a collapsed sidebar is not a
                                reduced one. */}
                            {onAct && (
                                <span className="ws-agent-popover-actions">
                                    {agentCardMenuItems({
                                        kind: 'agent',
                                        id: entry.id,
                                        name: entry.name,
                                        purpose: '',
                                        avatar: entry.avatar,
                                        role: entry.role,
                                        provider: entry.provider,
                                        tuis: [],
                                        running: entry.running,
                                        collisionGroup: entry.collisionGroup,
                                    }).map((item) => (
                                        <button
                                            key={item.id}
                                            type="button"
                                            role="menuitem"
                                            className={`ws-agent-action${
                                                item.primary ? ' is-primary' : ''
                                            }`}
                                            title={item.hint}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onAct(entry, item.id);
                                            }}
                                        >
                                            {item.label}
                                        </button>
                                    ))}
                                </span>
                            )}
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
