import { useEffect, useState, type ReactElement } from 'react';
import { agentGridRows, type AgentGridRow } from '../../lib/ams-grid';
import { emptyWorkspaceView } from '../../lib/empty-workspace';
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
 * ## There is deliberately NO live terminal preview here
 *
 * The first version rendered a real xterm per running agent inside a FauxClient
 * frame, with `onScreen={false}` so no fit could reach the pty (genie#229). That
 * guard worked and was not the hazard.
 *
 * The hazard is ATTACHMENT. Mounting a `Terminal` attaches to the pty, and
 * unmounting calls `api().terminal.detach()` — and main's rule is that a
 * deliberate detach KILLS a non-retained pty when the last owner goes
 * (`shouldKillOnDetach`). On an empty floor no panel is mounted for that agent,
 * so the preview is ALWAYS the only owner: navigating away would have killed
 * the very agents this panel exists to show.
 *
 * That shipped in beta.334 and is the reason this reads as a card instead. A
 * real preview needs a mechanism that never attaches — a snapshot of the
 * buffer, which needs an IPC that does not exist yet — not a live terminal with
 * a safety flag on it.
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
                            {row.running ? (
                                // NO LIVE TERMINAL HERE. See the module docblock:
                                // mounting one attaches to the pty, and unmounting
                                // DETACHES — which kills a non-retained pty when it
                                // is the last owner, which a preview always is on an
                                // empty floor.
                                <span className="empty-ws-card-dormant">
                                    Running. Open it to see its terminal.
                                </span>
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
