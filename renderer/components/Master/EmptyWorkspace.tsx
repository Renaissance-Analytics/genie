import { useEffect, useState, type ReactElement } from 'react';
import { FauxClient } from '@particle-academy/react-fancy';
import Terminal from '../Terminal/Terminal';
import { agentGridRows, type AgentGridRow } from '../../lib/ams-grid';
import {
    PREVIEW_LOGICAL_WIDTH,
    emptyWorkspaceView,
    showsPreview,
} from '../../lib/empty-workspace';
import { api } from '../../lib/genie';
import type { TerminalSpec } from '../../lib/genie';

/**
 * WHAT AN EMPTY FLOOR SHOWS.
 *
 * It used to be two buttons, Add Terminal and Add Code, which is the least
 * useful thing it could offer either audience: a verb with no reason to someone
 * who has not set the workspace up, and an offer to make a fourth thing to
 * someone whose three agents are already running out of sight.
 *
 * ## The live preview, and why it cannot damage a terminal
 *
 * A running agent gets a real, live xterm inside a {@link FauxClient} frame.
 * That is deliberate and it is the risky part, so the safety is stated here
 * rather than left to be rediscovered:
 *
 * A terminal measured inside a small container is genie#229. A TUI told it has
 * almost no columns **reflows its scrollback** to that width, and the damage is
 * written before the panel ever comes back — first characters clipped off the
 * left, tails spilling into a sliver down the right. A grid of small preview
 * frames is exactly the shape that caused it.
 *
 * Two independent things stop it, and the preview only ships because BOTH hold:
 *
 *   1. **`onScreen={false}`.** `shouldFit` refuses a fit outright on that,
 *      whatever the element measures (`terminal-fit.ts`, written for #229/#491).
 *      No geometry from a preview ever reaches the pty. This is the guarantee.
 *   2. **The content lays out at {@link PREVIEW_LOGICAL_WIDTH}** and FauxClient
 *      scales it down visually. So even if a fit did somehow run, it would
 *      measure a full-size terminal, not a card.
 *
 * Rule 1 is the promise; rule 2 means a later change that forgets rule 1 still
 * cannot produce the reflow. Neither is decoration.
 *
 * A DORMANT agent gets a card and no frame: a preview around a dead pty implies
 * something is happening in there.
 */
export default function EmptyWorkspace(props: {
    workspaceId: string;
    workspaceName: string;
    specs: readonly TerminalSpec[];
    activeIds: ReadonlySet<string>;
    onOpenAgent: (specId: string) => void;
    onAddTerminal: () => void;
}): ReactElement {
    const { workspaceId, workspaceName, specs, activeIds } = props;
    const [rows, setRows] = useState<AgentGridRow[] | null>(null);

    useEffect(() => {
        let alive = true;
        void api()
            .agents.list(workspaceId)
            .then((record) => {
                if (!alive) return;
                setRows(
                    agentGridRows({
                        agents: record.agents,
                        runtimes: record.runtimes,
                        specs: specs.filter((s) => s.workspace_id === workspaceId),
                        isLive: (id) => activeIds.has(id),
                    }),
                );
            })
            .catch(() => alive && setRows([]));
        return () => {
            alive = false;
        };
    }, [workspaceId, specs, activeIds]);

    // Until the roster answers, say nothing. Flashing the getting-started guide
    // at someone who has six agents is worse than a beat of blank floor.
    if (rows === null) return <div className="empty-ws" aria-busy="true" />;

    const view = emptyWorkspaceView(rows);

    if (view.kind === 'getting-started') {
        return (
            <div className="empty-ws empty-ws-guide">
                <h2 className="empty-ws-title">{workspaceName} has no agents yet</h2>
                <p className="empty-ws-lead">
                    An agent is a coding assistant with its own terminal, memory and inbox. It
                    works in this workspace and stays here between sessions.
                </p>
                <ol className="empty-ws-steps">
                    <li>
                        <strong>Create one.</strong> Right-click the workspace in the rail and
                        choose New Agent, or ask an existing agent to register it for you.
                    </li>
                    <li>
                        <strong>Give it a purpose.</strong> What it is responsible for — that is
                        what it reads on every boot, and what tells other agents when to hand it
                        work.
                    </li>
                    <li>
                        <strong>Start it.</strong> Its panel opens here, and it stays reachable
                        from the rail whether or not a panel is on the floor.
                    </li>
                </ol>
                <p className="empty-ws-aside">
                    Just need a shell?{' '}
                    <button type="button" className="empty-ws-link" onClick={props.onAddTerminal}>
                        Add a terminal
                    </button>{' '}
                    — it will not be an agent, and nothing will be remembered about it.
                </p>
            </div>
        );
    }

    return (
        <div className="empty-ws empty-ws-agents">
            <h2 className="empty-ws-title">
                {view.rows.length} agent{view.rows.length === 1 ? '' : 's'} in {workspaceName}
            </h2>
            <p className="empty-ws-lead">
                Nothing is on the floor right now. These are still here — running ones are shown
                live.
            </p>
            <div className="empty-ws-grid">
                {view.rows.map((row) => {
                    const preview = showsPreview(row);
                    // The spec carries the cwd the pty already runs in. A preview
                    // must never invent one — it is attaching to a live terminal,
                    // not opening a new shell somewhere.
                    const spec = specs.find((s) => s.id === row.specId);
                    return (
                        <button
                            type="button"
                            key={row.id}
                            className={`empty-ws-card${row.running ? ' is-running' : ''}`}
                            onClick={() =>
                                row.specId
                                    ? props.onOpenAgent(row.specId)
                                    : // A dormant agent has no spec to open, so
                                      // clicking it STARTS it — through the same
                                      // path `runAgent start` uses, so the
                                      // workspace's terminal cap still applies. A
                                      // click here must not be a way past a limit
                                      // the owner set.
                                      void api()
                                          .agents.start(workspaceId, row.name)
                                          .catch(() => {})
                            }
                            title={
                                row.running
                                    ? `Open ${row.name}`
                                    : `Start ${row.name}`
                            }
                        >
                            <span className="empty-ws-card-head">
                                <span className="empty-ws-card-name">{row.name}</span>
                                <span className="empty-ws-card-state">
                                    {row.running ? row.provider ?? 'running' : 'not running'}
                                </span>
                            </span>
                            {preview ? (
                                <FauxClient
                                    variant="device"
                                    width={PREVIEW_LOGICAL_WIDTH}
                                    scale="fit"
                                    className="empty-ws-preview"
                                >
                                    <Terminal
                                        id={row.specId!}
                                        cwd={spec?.cwd ?? ''}
                                        workspaceId={workspaceId}
                                        // THE GUARANTEE — see the module docblock.
                                        // `shouldFit` refuses outright on this, so a
                                        // preview can never push geometry to the pty.
                                        onScreen={false}
                                        className="empty-ws-term"
                                    />
                                </FauxClient>
                            ) : (
                                <span className="empty-ws-card-dormant">
                                    {row.purpose || 'Start it to pick up where it left off.'}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
