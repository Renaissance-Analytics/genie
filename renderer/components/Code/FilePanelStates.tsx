import { Badge, Button, Callout, Kbd, MultiSwitch, Table } from '@particle-academy/react-fancy';
import { IconAlert, IconEyeOff, IconMaximize, IconX } from '../Master/icons';
import {
    repoLockNotice,
    type ConflictPauses,
    type ConflictScan,
    type DiskWriteMark,
    type FilePanelSlot,
    type RepoLockState,
} from '../../lib/file-panel-states';
import {
    changeMarker,
    conflictBody,
    conflictPauseState,
    conflictTitle,
    uncheckedNotice,
    type ChangeRow,
} from '../../lib/file-panel-signals';
import type { GitFileStatus } from '../../lib/genie';

/**
 * §5.3's UNWELCOME PANEL STATES, drawn to the owner's mockup out of Fancy primitives.
 *
 * The rules live in `file-panel-states.ts` and the joins in `file-panel-signals.ts`; these are
 * the surfaces that draw them, kept OUT of `CodePanel` for one reason: the renderer has no DOM
 * harness, but `react-dom/server` renders a component with no effects — so a presentational
 * piece here is testable where the same markup inside `CodePanel` (which decides everything in
 * effects) is not. The panel composes them and owns the IPC.
 *
 * Every one of them can render NOTHING, and the nothing is the point. A chip that said "no
 * lock" for a repo it could not read, or a banner that said an agent stopped when nothing
 * stopped it, is the failure the rules were written to prevent — and a component is where that
 * distinction is most easily lost, because a falsy value and a missing one look the same in
 * JSX.
 *
 * ## Fancy, and where Fancy ran out
 *
 * `Badge`, `Button`, `Callout`, `MultiSwitch`, `Kbd` and `Table` are Fancy's, with every prop
 * checked against `node_modules/@particle-academy/react-fancy/dist/*.d.ts`. Two substitutions
 * are deliberate and are reported rather than hidden:
 *
 *  - **Icons are Genie's own** (`../Master/icons`), not Fancy's `<Icon name="…" />`. MEASURED:
 *    `renderToStaticMarkup(<Icon name="git-merge" />)` returns an EMPTY sized span here —
 *    Fancy resolves slugs from a registered icon set, nothing calls `registerIcons`, and
 *    `lucide-react` is not a dependency. Every Fancy `icon=` slug in this app is therefore
 *    inert today. `Callout`'s `icon` prop takes a ReactNode, so Genie's set drops straight in.
 *  - **`Button` has no `outline` variant** — `default | circle | ghost` (checked). The
 *    mockup's outline buttons render as `ghost` and its primaries as `color="blue"`.
 */

/**
 * THE CONFLICT, above the code it is about — one banner per colliding file.
 *
 *  - `scan === null` ⇒ nobody has looked yet, and the panel says nothing. Not an all-clear:
 *    it is the absence of a claim, which is what a surface with no evidence is entitled to.
 *  - A clear scan also renders nothing — a quiet panel is the normal state.
 *
 * The body's second sentence is a claim about ANOTHER PROCESS's state, so it comes from
 * `conflictPauseState` rather than from the fact that a button exists. An agent still running
 * while the banner says it stopped is the one failure here that costs somebody their code.
 */
export function ConflictBanner({
    scan,
    pauses,
    honoured,
    onCompare,
    onKeepMine,
    onTakeTheirs,
}: {
    scan: ConflictScan | null;
    pauses: ConflictPauses | null;
    /** Paths whose `agentSession.cancel` came back HONOURED. */
    honoured: ReadonlySet<string>;
    onCompare?: (path: string) => void;
    onKeepMine?: (path: string) => void;
    onTakeTheirs?: (path: string) => void;
}) {
    if (!scan || scan.conflicts.length === 0) return null;
    const empty: ConflictPauses = { requests: [], unreachable: [], unclaimed: 0 };
    return (
        <>
            {scan.conflicts.map((conflict) => (
                <Callout
                    key={conflict.path}
                    color="red"
                    icon={<IconAlert size={16} />}
                    className="code-conflict code-conflict-file"
                >
                    <p className="code-conflict-title">{conflictTitle(conflict)}</p>
                    <p className="code-conflict-body">
                        {conflictBody(conflict, conflictPauseState(conflict, pauses ?? empty, honoured))}
                    </p>
                    <p className="code-conflict-path">{conflict.path}</p>
                    <span className="code-conflict-buttons">
                        <Button
                            size="sm"
                            color="blue"
                            className="code-conflict-action"
                            onClick={() => onCompare?.(conflict.path)}
                        >
                            Compare
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="code-conflict-action"
                            onClick={() => onKeepMine?.(conflict.path)}
                        >
                            Keep mine
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="code-conflict-action"
                            onClick={() => onTakeTheirs?.(conflict.path)}
                        >
                            {/* No name to put on the button when nobody claimed the write, and
                                Genie does not invent one — the version on disk is still a fact. */}
                            {conflict.who === null ? 'Take the version on disk' : `Take ${conflict.who}'s`}
                        </Button>
                    </span>
                </Callout>
            ))}
        </>
    );
}

/**
 * WHAT THE SCAN COULD NOT LOOK AT.
 *
 * Its own notice, because it is the sentence with no banner of its own and the one most easily
 * left out. `uncheckedNotice` decides whether there is anything to say; zero unchecked tabs is
 * a silence this surface has earned.
 */
export function UncheckedNotice({ scan, opaque }: { scan: ConflictScan; opaque: number }) {
    const notice = uncheckedNotice(scan, opaque);
    if (notice === null) return null;
    return (
        <Callout color="zinc" icon={<IconEyeOff size={14} />} className="code-unchecked">
            {notice}
        </Callout>
    );
}

/**
 * THE REPO CHIP, which carries the lock itself.
 *
 * Red and named for `stale` only. The three silent states are silent for three different
 * reasons and the chip must not distinguish them on screen: `held` is a running git command
 * (milliseconds — a chip that reddened for it would flicker on every `git status`), `none` is a
 * clean repo, and `unseen` is a repo Genie could not look at. Of the three only `unseen` would
 * be a LIE if it were drawn as "ok", and saying nothing is the one claim all three support.
 *
 * `onRemoveLock` is offered for a PROVEN stale lock only. A Remove button for a lock nobody
 * could see would offer to delete a file nobody looked for.
 *
 * The repo's BRANCH is not here, and the mockup's `api · main` therefore reads `web`: nothing
 * in Genie returns a branch name — `files.gitStatus` is the only git producer and it returns
 * per-file statuses. Named in the report rather than filled with a plausible `main`.
 */
export function RepoChip({
    name,
    state,
    onRemoveLock,
}: {
    name: string;
    state: RepoLockState;
    onRemoveLock?: () => void;
}) {
    const notice = repoLockNotice(state);
    const locked = notice !== null;
    return (
        <>
            <Badge
                color={locked ? 'red' : 'zinc'}
                variant={locked ? 'outline' : 'soft'}
                size="sm"
                className={`code-repo-chip${locked ? ' is-locked' : ''}`}
                title={notice ?? name}
            >
                {locked && <IconAlert size={11} />}
                {locked ? `${name} · index.lock held` : name}
            </Badge>
            {locked && onRemoveLock && (
                <Button
                    size="sm"
                    variant="ghost"
                    className="code-remove-lock"
                    onClick={onRemoveLock}
                    title={notice ?? undefined}
                >
                    Remove stale lock
                </Button>
            )}
        </>
    );
}

/**
 * A WRITE NOBODY CLAIMED — §5.3's blind state, and NOT an error.
 *
 * Neutral rather than red, because an unexplained write is a thing Genie cannot see rather than
 * a thing that went wrong. The body says why it cannot see it, which is the only honest way to
 * show a `?` without implying somebody is hiding something.
 *
 * `at === 0` drops the time clause: a change git reported but no watcher event stamped has no
 * timestamp, and a time from the epoch would be worse than no time.
 *
 * The mockup's second action — *"Open moth's terminal"* — is NOT here. Naming a process that
 * did not report the write is precisely the guess the banner's own last sentence refuses. See
 * the report: it needs a signal Genie does not have.
 */
export function UnattributedBanner({
    path,
    at,
    onShowDiff,
}: {
    path: string;
    /** When the watcher saw the write, or `0` when nothing stamped it. */
    at: number;
    onShowDiff?: (path: string) => void;
}) {
    const seen = at > 0 ? `The file watcher saw a write at ${new Date(at).toLocaleTimeString()}. ` : '';
    return (
        <Callout color="zinc" icon={<IconEyeOff size={16} />} className="code-unattributed">
            <p className="code-unattributed-title">No agent reported this change</p>
            <p className="code-unattributed-body">
                {`${seen}Declared agents report their edits; this one came from a process that does not — an observed agent or another program. Genie does not guess the author.`}
            </p>
            {onShowDiff && (
                <Button size="sm" variant="ghost" className="code-unattributed-action" onClick={() => onShowDiff(path)}>
                    Show diff
                </Button>
            )}
        </Callout>
    );
}

/**
 * The panel's changes list — §5.3's *"A file changed on disk and no agent reported it … Genie
 * does not guess the author."*
 *
 * Every label and tone comes from `changeRows` (and through it `diskWriteMarks`); nothing is
 * re-derived here. The panel's own inline list used to compute `change.who ?? '?'` at the point
 * of render, which is the same answer by luck rather than by the rule, and it could not show a
 * file git reported that no agent ever mentioned — it iterated the reported changes only.
 *
 * `conflict === null` draws no mark, exactly as `false` does: a mark means CONTESTED, and its
 * absence means nothing at all. Badging every row with a "checked" state to answer a question
 * about the SCAN would put the panel's uncertainty on every file in it; `UncheckedNotice` says
 * it once, in the place that knows.
 */
export function PanelChangesList({
    rows,
    onOpen,
}: {
    rows: ChangeRow[];
    onOpen: (path: string) => void;
}) {
    return (
        <Table aria-label="Changes this session">
            <Table.Body>
                {rows.map((row) => (
                    <Table.Row
                        key={row.path}
                        className={`code-session-change ${
                            row.tone === 'neutral' ? 'is-unattributed' : 'is-attributed'
                        }${row.conflict === true ? ' is-conflict' : ''}`}
                    >
                        <Table.Cell>
                            {row.at > 0 && (
                                <time dateTime={new Date(row.at).toISOString()}>
                                    {new Date(row.at).toLocaleTimeString()}
                                </time>
                            )}
                        </Table.Cell>
                        <Table.Cell>
                            <Button size="sm" variant="ghost" onClick={() => onOpen(row.path)}>
                                {row.path}
                            </Button>
                        </Table.Cell>
                        <Table.Cell>
                            <span className="code-change-who" title={row.who ?? 'on disk · not attributed'}>
                                {row.who ?? 'on disk · not attributed'}
                            </span>
                        </Table.Cell>
                    </Table.Row>
                ))}
            </Table.Body>
        </Table>
    );
}

/**
 * The TREE's attribution chip.
 *
 * Violet means a named agent; an unclaimed write wears neutral grey and a `?`. That colour
 * difference IS the board's *"Genie does not guess the author"* — the two are the same width
 * and the same shape, so the colour is what a human reads first.
 *
 * `live` pulses while the write is still in flight (`liveWrites`). It ends by itself when the
 * tool call settles: a live mark that outlived its write would make a quiet workspace look busy.
 */
export function WhoChip({ mark, live }: { mark: DiskWriteMark; live: boolean }) {
    if (mark.tone === 'neutral') {
        return (
            <Badge
                color="zinc"
                variant="soft"
                size="sm"
                className="code-who is-unattributed"
                title="on disk · not attributed"
            >
                {mark.label}
            </Badge>
        );
    }
    return (
        <Badge
            color="violet"
            variant="soft"
            size="sm"
            dot={live}
            className={`code-who${live ? ' is-live' : ''}`}
            title={live ? `${mark.label} is writing this file` : mark.label}
        >
            {mark.label}
        </Badge>
    );
}

/** The tree's single-letter change marker. `changeMarker` decides it — including that a file
 *  git said nothing about gets NO marker, because a marker is a state claim. */
export function ChangeMarker({ status }: { status: GitFileStatus | null }) {
    const marker = changeMarker(status);
    if (marker === null) return null;
    return (
        <Badge color={marker.tone} variant="soft" size="sm" className="code-change-marker" title={status ?? undefined}>
            {marker.letter}
        </Badge>
    );
}

/**
 * The panel's 38px header: the label, the filter, the one-per-workspace hint, and the two
 * controls that move or dismiss the panel.
 *
 * The filter is Fancy's `MultiSwitch` — the segmented control the mockup draws — and its
 * `Changed N` count comes from the view rather than from the tree's own guess. `Changed 0` is a
 * measurement and renders as one; a panel that has not looked yet is the TREE's thing to say.
 */
export function FilesHeader({
    filter,
    onFilterChange,
    changedCount,
    onPopOut,
    onClose,
}: {
    filter: string;
    onFilterChange: (filter: string) => void;
    changedCount: number;
    /** Omitted where the panel's own head already carries these controls — drawing
     *  them twice is worse than the mockup having them in one place. */
    onPopOut?: () => void;
    onClose?: () => void;
}) {
    return (
        <div className="code-head">
            <span className="code-head-label">Files</span>
            <MultiSwitch
                size="sm"
                label="File filter"
                labelHidden
                className="code-head-filter"
                value={filter}
                list={[
                    { value: 'all', label: 'All' },
                    { value: 'changed', label: `Changed ${changedCount}` },
                ]}
                onValueChange={onFilterChange}
            />
            <span className="code-head-hint">one per workspace</span>
            {onPopOut && (
                <Button
                    size="sm"
                    variant="ghost"
                    className="code-head-popout"
                    onClick={onPopOut}
                    title="Open the file panel in its own window"
                    aria-label="Open in new window"
                >
                    <IconMaximize size={13} />
                </Button>
            )}
            {onClose && <Button
                size="sm"
                variant="ghost"
                className="code-head-close"
                onClick={onClose}
                title="Close the file panel"
                aria-label="Close panel"
            >
                <IconX size={13} />
                <Kbd keys={['Cmd', 'B']} size="xs" />
            </Button>}
        </div>
    );
}

/**
 * WHAT STANDS IN THE PANEL'S SLOT when the panel is not here.
 *
 * §5.3: *"The panel is in its own window, and there is still only one. The workspace keeps
 * agents and changes; a bar brings the panel back. Closing it (⌘B) looks the same, without the
 * bar."* Which of those it is, `filePanelSlot` decides — this only draws it. The two states
 * that look alike and must not behave alike:
 *
 *  - **popped** — THIS workspace sent the panel to its own window, so there is something to
 *    reel in and `slot.canBringBack` is true.
 *  - **elsewhere** — another window holds it and this one did not send it there. There is a
 *    window to FOCUS and nothing here to bring back.
 *
 * A DUPLICATE popped window is reported as a number rather than silently ignored: two editors
 * over one set of files with independent dirty buffers is worth saying out loud, which is the
 * same reason `uniqueWorkspaceFilePanels` exists for the grid.
 *
 * The mono route is the mockup's own address for the detached panel. It is rendered as TEXT,
 * not a link: nothing in Genie resolves a `genie://` URL today, so an anchor would promise
 * navigation that does not exist.
 */
export function FilePanelStandIn({
    slot,
    duplicates,
    workspaceName,
    onFocusWindow,
    onBringBack,
    onClose,
}: {
    slot: FilePanelSlot;
    /** Extra popped windows for this workspace, from `singlePoppedPanel`. */
    duplicates: number;
    workspaceName: string;
    onFocusWindow: () => void;
    onBringBack: () => void;
    onClose: () => void;
}) {
    if (slot.kind === 'panel') return null;
    const hasWindow = slot.kind === 'popped' || slot.kind === 'elsewhere';
    return (
        <section className={`tpanel code-panel code-popped${slot.bar ? ' code-popped-bar' : ''}`}>
            {slot.kind === 'opening' && <span>Opening workspace files…</span>}
            {hasWindow && (
                <>
                    <span className="code-popped-says">
                        {slot.kind === 'popped'
                            ? `${workspaceName} files are open in their own window.`
                            : `${workspaceName} files are open in another window.`}
                    </span>
                    <code className="code-popped-route">
                        {`genie://workspace/${workspaceName}/files?window=detached`}
                    </code>
                </>
            )}
            {duplicates > 0 && (
                <span className="code-popped-duplicate">
                    {`${duplicates} extra ${duplicates === 1 ? 'window' : 'windows'} for this workspace`}
                </span>
            )}
            {hasWindow && (
                <Button size="sm" variant="ghost" onClick={onFocusWindow}>Focus window</Button>
            )}
            {slot.canBringBack && (
                <Button size="sm" color="blue" onClick={onBringBack}>Bring back</Button>
            )}
            {slot.kind !== 'closed' && (
                <Button size="sm" variant="ghost" onClick={onClose}>Close panel</Button>
            )}
        </section>
    );
}
