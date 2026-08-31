import { useState } from 'react';
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
 * Avatars default to the TUI's real brand mark. A user-set avatar wins — that is
 * the field an agent's `AGENT.md` carries and, in time, the one Tynn will set
 * too.
 */
export default function AgentAvatarStack({ stack }: { stack: AgentStack }) {
    const [open, setOpen] = useState(false);
    if (stack.total === 0) return null;

    return (
        <span
            className="ws-agent-stack"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            // The row itself is a button, so this must not activate the
            // workspace when someone is only reading the popover.
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
            {open && (
                <span className="ws-agent-popover" role="tooltip">
                    {stack.entries.map((entry) => (
                        <span key={entry.id} className="ws-agent-popover-row">
                            <span className="ws-agent-popover-face">
                                <Face entry={entry} />
                            </span>
                            <span className="ws-agent-popover-text">
                                <strong>{entry.name}</strong>
                                <span className="ws-agent-popover-meta">
                                    {entry.provider
                                        ? `${entry.provider} · ${entry.running ? 'running' : 'stopped'}`
                                        : 'no TUI yet'}
                                    {entry.sidecars.length > 0 &&
                                        ` · ${entry.sidecars.length} sidecar${
                                            entry.sidecars.length === 1 ? '' : 's'
                                        } (${entry.sidecars
                                            .map((s) => `${s.provider} ${s.running ? 'live' : 'idle'}`)
                                            .join(', ')})`}
                                    {entry.collisionGroup && ' · name conflict'}
                                </span>
                            </span>
                        </span>
                    ))}
                    {stack.overflow > 0 && (
                        <span className="ws-agent-popover-more">
                            and {stack.overflow} more — open the workspace to see them all
                        </span>
                    )}
                </span>
            )}
        </span>
    );
}

/**
 * A user avatar if there is one, else the TUI's brand mark, else the initial.
 *
 * The initial is the honest fallback for a TUI with no mark of its own:
 * borrowing another vendor's logo would assert a relationship that does not
 * exist, and a blank would read as "no agent".
 */
function Face({ entry }: { entry: AgentStackEntry }) {
    if (entry.avatar) return <span className="ws-agent-emoji">{entry.avatar}</span>;
    const mark = providerBrandMark(entry.provider);
    if (mark) return <BrandMark name={mark} size={14} />;
    return <span className="ws-agent-initial">{entry.name.slice(0, 1).toUpperCase()}</span>;
}
