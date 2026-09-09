import { useCallback, useEffect, useState } from 'react';
import { Tabs, Text, Textarea } from '@particle-academy/react-fancy';
import { IconCheck, IconPin, IconReply, IconX } from './icons';
import {
    api,
    hasGenieBridge,
    isRemoteWindow,
    type UserListActionSpec,
    type WorkspaceListsSpec,
} from '../../lib/genie';

/**
 * The AgentList + UserList panel (genie#556). Right-side slide-in reusing the
 * Docs flyout chrome, with a PIN that docks it to the right edge — pinned, the
 * app shell reserves the width (`.gwrap.lists-docked`) so the panel sits beside
 * the Floor rather than over it.
 *
 * Two lists, two audiences, so two TABS rather than one scrolling stack: what is
 * waiting on the PERSON is the actionable half and leads; what each agent is
 * separately tracking is context.
 *
 * Push-driven — `on.listsChanged` carries the workspace, so an agent adding an
 * item through the `lists` MCP tool updates an open panel with no polling.
 *
 * On a REMOTE window the lists are the HOST's, read and resolved over the bridge
 * (genie#586) — a list is work, and work is host-sourced. The one state that
 * still needs spelling out is a read that FAILED: an empty view and "the host
 * could not be asked" are the same picture, and the second is what a window
 * driving a host too old to serve `/api/desktop/lists/*` gets.
 */

/** A resolution that has happened, and whether the agent actually heard about it. */
export type NudgeOutcomeView =
    | { delivered: true; agentName: string }
    | { delivered: false; agentName: string; reason: string };

export interface ListsBodyProps {
    view: WorkspaceListsSpec;
    /**
     * This window drives a REMOTE host. The lists themselves come from that host
     * now, so this only changes what a FAILED read is likely to mean — a host on
     * an older Genie serves no lists route at all, which is worth saying rather
     * than leaving someone to read `HTTP 405` and guess.
     */
    remote: boolean;
    /**
     * Why the lists could not be read, if they could not be.
     *
     * Kept apart from an empty `view` because the two render identically and mean
     * opposite things: one is "nothing is waiting on you", the other is "nobody
     * knows what is waiting on you". Rendering the first for the second is the
     * failure this panel is built to avoid.
     */
    error: string | null;
    /** The item id currently being resolved, if any. */
    busy: string | null;
    outcome: NudgeOutcomeView | null;
    onResolve: (id: string, action: UserListActionSpec, comment: string) => void;
    /** Which tab opens first. Defaults to the person's own list — the half with
     *  something for them to do. */
    initialTab?: 'user' | 'agents';
}

const ACTION_LABEL: Record<UserListActionSpec, string> = {
    done: 'Done',
    thrown_back: 'Back to the agent',
    refused: "Won't do",
};

export function ListsBody({
    view,
    remote,
    error,
    busy,
    outcome,
    onResolve,
    initialTab = 'user',
}: ListsBodyProps) {
    if (error) {
        return (
            <>
                {/* The outcome survives the failure, and has to: a resolve and
                    the re-read that follows it travel the same wire, so they
                    fail together — exactly when someone has just ticked an item
                    off and is owed an answer about whether the agent heard. */}
                <NudgeOutcomeNotice outcome={outcome} />
                <div className="lists-notice" role="status">
                    <Text size="sm">
                        Genie could not read this workspace’s lists: {error}
                        {remote
                            ? ' — this window is driving a remote workstation, and a host running an older Genie does not serve them at all.'
                            : ''}
                    </Text>
                </div>
            </>
        );
    }

    return (
        <Tabs defaultTab={initialTab} variant="underline" className="lists-tabs">
            <Tabs.List>
                <Tabs.Tab value="user">
                    Waiting on you{view.userCount > 0 ? ` (${view.userCount})` : ''}
                </Tabs.Tab>
                <Tabs.Tab value="agents">Agent lists</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panels>
                <Tabs.Panel value="user">
                    <NudgeOutcomeNotice outcome={outcome} />
                    {view.user.length === 0 ? (
                        <div className="lists-empty">
                            <Text size="sm">
                                Nothing is waiting on you. Agents put things here when they
                                need a person but do not need to stop.
                            </Text>
                        </div>
                    ) : (
                        <ul className="lists-items">
                            {view.user.map((item) => (
                                <UserItemRow
                                    key={item.id}
                                    id={item.id}
                                    text={item.text}
                                    agentName={item.agentName}
                                    busy={busy === item.id}
                                    onResolve={onResolve}
                                />
                            ))}
                        </ul>
                    )}
                </Tabs.Panel>
                <Tabs.Panel value="agents">
                    {view.agents.length === 0 ? (
                        <div className="lists-empty">
                            <Text size="sm">
                                No agent in this workspace is keeping a list right now.
                            </Text>
                        </div>
                    ) : (
                        view.agents.map((group) => (
                            <section className="lists-group" key={group.agentName}>
                                <div className="lists-group-head">
                                    <Text size="sm" weight="semibold">
                                        {group.agentName}
                                    </Text>
                                    <span className="lists-group-count">
                                        {group.items.length}
                                    </span>
                                </div>
                                <ul className="lists-items">
                                    {group.items.map((item) => (
                                        <li className="lists-item is-readonly" key={item.id}>
                                            <Text size="sm">{item.text}</Text>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))
                    )}
                    {/* An agent's own checklist is the AGENT's to tick off — a
                        person doing it here would resolve something the agent
                        still believes is open, with no way to tell it. */}
                    <div className="lists-foot">
                        <Text size="xs" color="muted">
                            An agent clears its own list. These are shown so you can see what
                            each one is tracking.
                        </Text>
                    </div>
                </Tabs.Panel>
            </Tabs.Panels>
        </Tabs>
    );
}

/**
 * What happened to the last resolution — and, separately, whether the agent that
 * asked actually heard about it.
 *
 * Its own component because it has to render in two places: over the UserList in
 * the ordinary case, and above the failure notice when the read that followed
 * the resolve did not come back. Dropping it in the second case would lose the
 * report at the one moment it matters most.
 */
function NudgeOutcomeNotice({ outcome }: { outcome: NudgeOutcomeView | null }) {
    if (!outcome) return null;
    return (
        <div
            className={`lists-outcome${outcome.delivered ? '' : ' is-undelivered'}`}
            role="status"
        >
            <Text size="sm">
                {outcome.delivered
                    ? `Recorded — ${outcome.agentName} was told.`
                    : `Recorded, but ${outcome.agentName} was NOT told: ${outcome.reason}`}
            </Text>
        </div>
    );
}

/**
 * One thing waiting on the person, with the three outcomes an agent can act on.
 *
 * The comment is REQUIRED by `resolveUserTodo`, and deliberately: whatever the
 * person decides is the only thing the agent will hear about it, and "refused"
 * with no reason tells the agent nothing it can act on.
 */
function UserItemRow({
    id,
    text,
    agentName,
    busy,
    onResolve,
}: {
    id: string;
    text: string;
    agentName?: string;
    busy: boolean;
    onResolve: (id: string, action: UserListActionSpec, comment: string) => void;
}) {
    const [comment, setComment] = useState('');
    const act = (action: UserListActionSpec) => onResolve(id, action, comment.trim() || 'Done.');

    return (
        <li className="lists-item">
            <div className="lists-item-text">
                <Text size="sm">{text}</Text>
                {agentName && (
                    <span className="lists-asker" title={`${agentName} is waiting on this`}>
                        {agentName}
                    </span>
                )}
            </div>
            <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="What should the agent know? (sent with your answer)"
                rows={2}
                className="lists-comment"
            />
            <div className="lists-actions">
                <button
                    type="button"
                    className="lists-btn is-done"
                    disabled={busy}
                    onClick={() => act('done')}
                    title={ACTION_LABEL.done}
                >
                    <IconCheck size={13} /> {ACTION_LABEL.done}
                </button>
                <button
                    type="button"
                    className="lists-btn"
                    disabled={busy}
                    onClick={() => act('thrown_back')}
                    title={ACTION_LABEL.thrown_back}
                >
                    <IconReply size={13} /> {ACTION_LABEL.thrown_back}
                </button>
                <button
                    type="button"
                    className="lists-btn is-refuse"
                    disabled={busy}
                    onClick={() => act('refused')}
                    title={ACTION_LABEL.refused}
                >
                    <IconX size={13} /> {ACTION_LABEL.refused}
                </button>
            </div>
        </li>
    );
}

const EMPTY_VIEW: WorkspaceListsSpec = { agents: [], user: [], userCount: 0 };

export default function ListsFlyout({
    open,
    onClose,
    workspaceId,
    pinned,
    onTogglePin,
}: {
    open: boolean;
    onClose: () => void;
    workspaceId: string | null;
    pinned: boolean;
    onTogglePin: () => void;
}) {
    const [view, setView] = useState<WorkspaceListsSpec>(EMPTY_VIEW);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<NudgeOutcomeView | null>(null);
    const remote = isRemoteWindow();

    // On a remote window this reads the HOST over the bridge (genie#586), so
    // there is no longer anything to refuse. A REJECTION is kept and shown: it
    // is the only thing that distinguishes "nothing is waiting on you" from
    // "nobody could be asked", and the two look identical once the empty view
    // renders.
    const refresh = useCallback(() => {
        if (!hasGenieBridge() || !workspaceId) return;
        api()
            .lists.read(workspaceId)
            .then((v) => {
                setView(v);
                setError(null);
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, [workspaceId]);

    // Fetch when the panel becomes visible. Pinned, it is always visible, so
    // `open` alone would leave a docked panel stale from the moment it docked.
    useEffect(() => {
        if (open || pinned) refresh();
    }, [open, pinned, refresh]);

    // Push, not poll: every writer (an agent's MCP call, and the resolve below,
    // local or over the bridge) announces through `lists:changed`, and the
    // payload names the workspace so another project's activity never re-reads
    // this one. On a host window the event is the HOST's, re-emitted onto this
    // channel by main (PASSTHROUGH_EVENTS).
    useEffect(() => {
        if (!hasGenieBridge()) return;
        return api().on.listsChanged?.((payload) => {
            if (!payload?.workspaceId || payload.workspaceId === workspaceId) refresh();
        });
    }, [workspaceId, refresh]);

    const onResolve = useCallback(
        (id: string, action: UserListActionSpec, comment: string) => {
            if (!hasGenieBridge()) return;
            const asker = view.user.find((i) => i.id === id)?.agentName ?? 'the agent';
            setBusy(id);
            api()
                .lists.resolveUser(id, action, comment)
                .then((r) => {
                    // The resolution stands either way — the person really did
                    // it. What varies is whether the agent heard, and that is
                    // reported rather than assumed.
                    if (!r.ok) {
                        setOutcome({ delivered: false, agentName: asker, reason: r.error });
                        return;
                    }
                    setOutcome(
                        r.nudge.delivered
                            ? { delivered: true, agentName: asker }
                            : { delivered: false, agentName: asker, reason: r.nudge.reason },
                    );
                })
                .catch((e: unknown) =>
                    setOutcome({
                        delivered: false,
                        agentName: asker,
                        reason: e instanceof Error ? e.message : String(e),
                    }),
                )
                .finally(() => {
                    setBusy(null);
                    refresh();
                });
        },
        [view.user, refresh],
    );

    const body = (
        <>
            <div className="docs-head">
                <span className="docs-title">Lists</span>
                <span className="grow" />
                <button
                    type="button"
                    className={`gicon${pinned ? ' is-pinned' : ''}`}
                    onClick={onTogglePin}
                    title={pinned ? 'Unpin — float over the Floor' : 'Pin — dock to the right'}
                    aria-label={pinned ? 'Unpin lists' : 'Pin lists to the right'}
                    aria-pressed={pinned}
                >
                    <IconPin size={14} />
                </button>
                <button
                    type="button"
                    className="gicon"
                    onClick={onClose}
                    title={pinned ? 'Hide lists (stays docked next time)' : 'Close lists'}
                    aria-label="Hide lists"
                >
                    <IconX />
                </button>
            </div>
            <div className="lists-body">
                <ListsBody
                    view={view}
                    remote={remote}
                    error={error}
                    busy={busy}
                    outcome={outcome}
                    onResolve={onResolve}
                />
            </div>
        </>
    );

    // Docked, it is part of the layout: no scrim (the Floor stays usable beside
    // it) and no slide transform. `.gwrap.lists-docked` reserves the width, so
    // this covers nothing.
    //
    // `open` still gates it. The two flags mean different things — `open` is
    // "the panel is showing", `pinned` is "when it shows, dock it" — and
    // ignoring `open` here left the header icon toggling a state with no
    // visible effect for as long as the panel was docked.
    if (pinned) {
        if (!open) return null;
        return (
            <aside className="lists-dock" aria-label="Lists">
                {body}
            </aside>
        );
    }

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout lists-flyout"
                role="dialog"
                aria-label="Lists"
                aria-modal="false"
            >
                {body}
            </aside>
        </div>
    );
}
