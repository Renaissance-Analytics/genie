import { Badge, Text } from '@particle-academy/react-fancy';
import type { Color } from '@particle-academy/react-fancy';
import { agentFileGroups, type AgentFileRow, type AgentFilesView } from '../../lib/agent-files-view';
import type { GitFileStatus } from '../../lib/genie';
import { formatQuestionAge } from '../../lib/question-age';

/**
 * THE FILES TAB — §5.3's workspace file panel, filtered to this agent.
 *
 * *"The agent's Files and Changes tabs open this panel filtered to that agent."* So this is a
 * VIEW ONTO the panel, not a second one: every decision about what belongs in the list and who
 * it belongs to is made in `lib/agent-files-view.ts`, which is pure and tested, because the
 * renderer's test environment has no DOM and a decision made inside a component is a decision
 * nobody checks.
 *
 * ## What it deliberately is not
 *
 * **Not an editor.** Opening a file is handed back through `onOpenFile`, which the Floor wires
 * to the existing panel. A second editor here would be a second set of tabs, a second dirty
 * state and a second place to lose somebody's unsaved buffer.
 *
 * **Not a guess.** A file whose newest write no agent reported is marked `?` and greyed, never
 * folded into this agent's list — *"Genie does not guess the author."* Unclaimed changes and
 * other agents' changes are COUNTED in the footer instead, so the filter never hides work
 * silently: a human who cannot see those numbers cannot tell a quiet workspace from a tight
 * filter.
 *
 * No icons: nothing in this app registers an icon set, so an `<Icon>` here would render an
 * empty span and reserve space for a glyph that never arrives.
 */

/** Git's state as a colour. `ignored` is the only grey one — the rest are things that will
 *  land in a commit, and the palette says which kind. */
const STATUS_COLOR = {
    modified: 'amber',
    added: 'emerald',
    deleted: 'rose',
    renamed: 'sky',
    untracked: 'violet',
    ignored: 'slate',
} as const satisfies Record<GitFileStatus, Color>;

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;

function Row({ row, now, onOpenFile }: {
    row: AgentFileRow;
    now: number;
    onOpenFile?: (path: string) => void;
}): React.JSX.Element {
    /**
     * A row is a BUTTON when it opens something, and a plain div otherwise.
     *
     * Not a div with an onClick — that is the defect this release exists to fix. A row that
     * answers Enter and announces itself as activatable is the difference between a surface a
     * keyboard reaches and one it does not, and a row with nothing behind it stays inert rather
     * than becoming a control that does nothing.
     */
    const Tag = onOpenFile ? 'button' : 'div';
    /**
     * `at: 0` is `workspaceChanges` reporting a call the provider never stamped, and
     * `formatQuestionAge` renders null for it — so an unstamped change shows no age instead of
     * a date in 1970 under a file somebody edited a minute ago.
     */
    const age = formatQuestionAge(row.at, now);
    return (
        <Tag
            className="agent-files-row"
            data-status={row.status ?? undefined}
            // On the ROW as well as on the marker, so the stylesheet can grey the whole line
            // rather than only the glyph.
            data-disk={row.touchedOnDisk ? '' : undefined}
            {...(onOpenFile ? { type: 'button' as const, onClick: () => onOpenFile(row.path) } : {})}
        >
            <Text size="sm" className="agent-files-name">
                {row.name}
            </Text>
            {row.status ? (
                <Badge size="sm" variant="soft" color={STATUS_COLOR[row.status]}>
                    {row.status}
                </Badge>
            ) : null}
            {row.touchedOnDisk ? (
                // The board's own mark for an unclaimed write: neutral, and a question rather
                // than a name.
                <Text
                    size="xs"
                    className="agent-files-unclaimed"
                    title="The newest write to this file was not reported by any agent"
                >
                    ?
                </Text>
            ) : null}
            {row.supersededBy ? (
                <Text size="xs" className="agent-files-since">
                    {row.supersededBy} wrote it since
                </Text>
            ) : null}
            {age ? (
                <Text size="xs" className="agent-files-age">
                    {age}
                </Text>
            ) : null}
        </Tag>
    );
}

export interface AgentFilesProps {
    view: AgentFilesView;
    /** Passed in rather than read from the clock, so the ages a test asserts are the ages a
     *  person sees. A render that calls `Date.now()` itself is a render no test can pin. */
    now?: number;
    /** Open the file in the workspace panel. Absent ⇒ the rows are a list, not controls. */
    onOpenFile?: (path: string) => void;
    /** Open another agent, from the footer count of what this filter is hiding. */
    onOpenAgent?: (agentId: string) => void;
}

export function AgentFiles({ view, now = Date.now(), onOpenFile, onOpenAgent }: AgentFilesProps): React.JSX.Element {
    if (view.rows === null) {
        /**
         * NO WORKSPACE, so there is nothing to filter.
         *
         * Said as a sentence rather than drawn as an empty list, because the two situations
         * have different remedies: an empty list tells someone their agent has been idle, and
         * this one tells them Genie cannot place the agent in a workspace at all.
         */
        return (
            <div className="agent-files" data-testid="agent-files">
                <Text size="sm" className="agent-files-empty">
                    Genie cannot see which workspace {view.who} is in, so there is no file panel to filter.
                </Text>
            </div>
        );
    }

    const groups = agentFileGroups(view.rows);
    const footer = view.others.length > 0 || view.unattributed > 0;

    return (
        <div className="agent-files" data-testid="agent-files">
            {view.rows.length === 0 ? (
                <Text size="sm" className="agent-files-empty">
                    No files changed by {view.who} yet.
                </Text>
            ) : null}

            {groups.map((group) => (
                <div className="agent-files-group" key={group.dir ?? '\u0000root'}>
                    {/* A file at the workspace root has no folder, and an empty header would
                        be a blank line that reads as a rendering fault. */}
                    {group.dir ? (
                        <Text size="xs" className="agent-files-dir">
                            {group.dir}
                        </Text>
                    ) : null}
                    {group.rows.map((row) => (
                        <Row key={row.path} row={row} now={now} {...(onOpenFile ? { onOpenFile } : {})} />
                    ))}
                </div>
            ))}

            {/* No footer at all for a count of zero. A line that is always present but only
                sometimes means anything trains people to ignore it. */}
            {footer ? (
                <div className="agent-files-others">
                    {view.others.map((other) => {
                        const Tag = onOpenAgent ? 'button' : 'div';
                        return (
                            <Tag
                                key={other.agentId}
                                className="agent-files-other"
                                {...(onOpenAgent
                                    ? { type: 'button' as const, onClick: () => onOpenAgent(other.agentId) }
                                    : {})}
                            >
                                <Text size="xs">
                                    {other.who} · {files(other.count)}
                                </Text>
                            </Tag>
                        );
                    })}
                    {view.unattributed > 0 ? (
                        <div className="agent-files-unattributed">
                            {/* The count, and the `?` instead of a name. Attribution is the one
                                thing this surface sells, so a number it cannot attribute says
                                so rather than borrowing the nearest agent's name. */}
                            <Text size="xs">
                                ? · {view.unattributed} changed {view.unattributed === 1 ? 'file' : 'files'} nobody
                                reported
                            </Text>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
