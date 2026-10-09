import { Icon, Text } from '@particle-academy/react-fancy';
import {
    agentChangesView,
    CONFLICT_NOTICE,
    type AgentChangesInput,
    type ChangedFile,
    type ChangeGroup,
} from '../../lib/agent-changes-view';

/**
 * THE CHANGES TAB — §5.3's Changed filter, scoped to one agent.
 *
 * Every decision is in `lib/agent-changes-view.ts`: who changed what, how much, what cannot be
 * seen, and the order the groups appear in. This file is the render, and it is deliberately
 * thin — the test environment has no DOM, so a decision made here would be a decision nothing
 * covers.
 *
 * ## Why there is no diff pane here
 *
 * `fancy-git-ui` has `DiffViewer`, and it is the right component for showing a hunk — it takes
 * a unified patch or a parsed `Diff` and renders it on the suite's shared model. It is not used
 * here because this surface is a LIST of changed files, and opening one belongs to the file
 * panel the tab is filtered into. So the row takes an `onOpenFile` callback instead of
 * embedding an editor, and whoever wires it owns where the file opens. `WorkingTree` is the
 * other near-miss: it is shaped like this list but keyed on git's staged/unstaged axis with
 * stage and unstage actions, and this panel's axis is WHO CHANGED IT. There is nothing in
 * `WorkingTreeStatus` that can carry an agent.
 *
 * What the view DOES borrow from the suite is `computeDiff` — `fancy-file-commons` is the same
 * engine `DiffViewer` parses with, so the `+N −M` in a header and the hunks in any diff pane
 * can never disagree about the same bytes.
 */

/** `+2` / `−1`, and NOTHING when the count is unknown. See the view's note on why. */
function Counts({ file }: { file: Pick<ChangedFile, 'added' | 'removed'> }): React.JSX.Element | null {
    if (file.added === null && file.removed === null) return null;
    return (
        <>
            {file.added !== null ? (
                <Text size="xs" className="changes-added" color="success">
                    {`+${file.added}`}
                </Text>
            ) : null}
            {file.removed !== null ? (
                <Text size="xs" className="changes-removed" color="danger">
                    {/* U+2212 MINUS SIGN, not a hyphen: it aligns with the `+` and reads as an
                        arithmetic sign rather than as a dash, which would read as "no value". */}
                    {`−${file.removed}`}
                </Text>
            ) : null}
        </>
    );
}

function FileRow({
    file,
    onOpenFile,
}: {
    file: ChangedFile;
    onOpenFile?: (path: string) => void;
}): React.JSX.Element {
    /**
     * A real `<button>` when there is somewhere to open the file, and an inert `<div>`
     * otherwise.
     *
     * Not a div with an onClick: a row that answers Enter and announces itself as activatable
     * is the difference between a surface a keyboard reaches and one it does not. And a row
     * with nothing behind it stays inert rather than becoming a control that silently does
     * nothing — absence of a control, not a dead one.
     */
    const Tag = onOpenFile ? 'button' : 'div';
    return (
        <div
            className="changes-row"
            // Present only for a KNOWN collision. `conflicted: null` is "Genie was not told",
            // and an attribute asserting `false` would be a claim about an editor buffer this
            // surface cannot read.
            data-conflicted={file.conflicted === true ? '' : undefined}
        >
            <Tag
                className="changes-file"
                {...(onOpenFile
                    ? { type: 'button' as const, onClick: () => onOpenFile(file.path) }
                    : {})}
            >
                <Icon name="pencil" size="xs" />
                <Text size="sm" className="changes-file-name">
                    {file.name}
                </Text>
                {/* The folder, dimmed. Absent for a file at the root rather than rendered as a
                    bare separator. */}
                {file.dir ? (
                    <Text size="xs" className="changes-file-dir" color="muted">
                        {file.dir}
                    </Text>
                ) : null}
                <Counts file={file} />
            </Tag>
            {/* OUTSIDE the control. The notice is a sentence to read, and a paragraph inside a
                button is read out as part of its label. */}
            {file.conflicted === true ? (
                <Text size="xs" className="changes-conflict">
                    {CONFLICT_NOTICE}
                </Text>
            ) : null}
        </div>
    );
}

function Group({
    group,
    onOpenFile,
}: {
    group: ChangeGroup;
    onOpenFile?: (path: string) => void;
}): React.JSX.Element {
    return (
        <div className="changes-group" data-self={group.self ? '' : undefined}>
            <div className="changes-group-head">
                {/**
                 * THE AUTHOR, or the board's own words for having none.
                 *
                 * `who === null` is a write the watcher saw with no tool call behind it. The
                 * group says why there is no name instead of inventing one — "unknown" would
                 * read as a person, and a blank header as a rendering fault.
                 */}
                <Text size="xs" className="changes-who" weight="medium">
                    {group.who ?? 'on disk · not attributed'}
                </Text>
                <Text size="xs" className="changes-group-count" color="muted">
                    {`${group.files.length} file${group.files.length === 1 ? '' : 's'}`}
                </Text>
                <Counts file={group} />
            </div>
            {group.files.map((file) => (
                <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
            ))}
        </div>
    );
}

export function AgentChanges({
    sessions,
    agentId,
    observed,
    conflicts = null,
    onOpenFile,
}: AgentChangesInput & {
    /** Where a row goes when it is activated. Absent ⇒ the rows are inert, by design. */
    onOpenFile?: (path: string) => void;
}): React.JSX.Element {
    const view = agentChangesView({ sessions, agentId, observed, conflicts });

    if (view.fileCount === 0) {
        // A SENTENCE, not a blank panel: an agent that has changed nothing is a fact about a
        // new agent rather than a fault, and a blank tab reads as broken.
        return (
            <div className="agent-changes">
                <Text size="sm">No changes yet. Files this agent edits will appear here, grouped by who changed them.</Text>
            </div>
        );
    }

    return (
        <div className="agent-changes">
            <div className="changes-summary">
                <Text size="xs" weight="medium">
                    {`${view.fileCount} file${view.fileCount === 1 ? '' : 's'} changed`}
                </Text>
                <Counts file={view} />
                {/**
                 * AND WHETHER THE TOTAL IS THE WHOLE STORY.
                 *
                 * Most providers answer a write with a text confirmation, not a diff, so a sum
                 * over the files that could be counted is routinely partial. Saying how many
                 * were left out is what keeps the number from reading as complete — the same
                 * reason the lanes strip reports its unplaced rows.
                 */}
                {view.uncounted > 0 ? (
                    <Text size="xs" className="changes-uncounted" color="muted">
                        {`${view.uncounted} not counted`}
                    </Text>
                ) : null}
                {view.conflictCount !== null && view.conflictCount > 0 ? (
                    <Text size="xs" className="changes-collisions" color="danger">
                        {`${view.conflictCount} in collision`}
                    </Text>
                ) : null}
            </div>
            {view.groups.map((group) => (
                <Group key={group.id} group={group} onOpenFile={onOpenFile} />
            ))}
        </div>
    );
}
