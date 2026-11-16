import { Button } from '@particle-academy/react-fancy';
import { useEffect, useReducer } from 'react';
import { personText } from '../../core/person-text.js';
import type { DeckItem } from '../../core/deck.js';
import { EMPTY_TOASTS, toastReducer, toastView, type ToastStackView } from '../../core/approval-toasts.js';
import { workspaceLabel } from '../../core/workspace-label.js';
import { WorkspaceSwatch } from '../workspace-colors.js';
import { ApprovalCard } from './ApprovalCard.js';

/**
 * THE APPROVAL TOASTS (Tynn #730; the owner, 2026-11-14) — everything waiting in the Deck for an approval, answered from
 * whatever page is open. The rules are `core/approval-toasts.ts`; this draws them.
 *
 * ## Where
 *
 * BOTTOM-LEFT of the PAGE COLUMN (Shell: the content beside the rail, before the chat dock). Inside that column it is over
 * the content, clear of the sidebar nav on its left, and the chat — with its input — is a column after the page, so a
 * toast cannot cover the chat input at any width (`toastBox`; Genie's own alert toasts are bottom-left too, genie#1211).
 *
 * ## What
 *
 * A toast is an ApprovalCard — the card an agent's page and chat used to carry — with the asking agent and workspace above
 * it: the exact command, the optional note, the item's own options (Allow / Deny, or whatever it offers), and "Trust this
 * workspace" where the card offers it. Answering calls the Deck's own `onAnswer`, the one resolution path
 * (`deckAnswerRoute`), so an approval answered here, in the chat or on another device leaves the snapshot, and so leaves
 * every one of them. It stays until then; there is no Later and no timeout.
 */

export interface ApprovalToastStackProps {
    view: ToastStackView;
    /** Allow / Deny / the item's own option — the Deck's answer — with the note typed on this request ('' = none). */
    onAnswer: (item: DeckItem, optionId: string, note: string) => void;
    /** "+N more" opened (true) or folded back (false). */
    onExpand: (on: boolean) => void;
    /** Open the asking agent's chat. Absent = the toast offers no door. */
    onOpenAgent?: ((item: DeckItem) => void) | undefined;
    /** Trust the item's workspace from its card (Tynn #618). Absent = not offered. */
    onTrustWorkspace?: ((workspaceId: string) => Promise<unknown>) | undefined;
    /**
     * The workspaces this window knows (the snapshot's). An item can arrive with a workspaceId and no name; the toast reads
     * the name here, the way the Dashboard row does, rather than call the workspace unknown.
     */
    workspaces?: readonly { id: string; path: string; name?: string | undefined; color?: string | undefined }[] | null | undefined;
    /** The agents this window knows, for an item that carries its agent but no workspace. */
    agents?: readonly { id: string; workspaceId: string }[] | null | undefined;
}

type Where = { name: string; color: string | undefined };

function workspaceOf(item: DeckItem, { workspaces, agents }: Pick<ApprovalToastStackProps, 'workspaces' | 'agents'>): Where {
    const own = item.workspaceName?.trim();
    if (own) return { name: own, color: item.workspaceColor };
    const id = item.workspaceId ?? agents?.find((a) => a.id === item.agentId)?.workspaceId ?? null;
    const known = id === null ? undefined : workspaces?.find((w) => w.id === id);
    if (!known) return { name: 'a workspace not known here', color: item.workspaceColor };
    return { name: workspaceLabel(workspaces, known.id), color: item.workspaceColor ?? known.color };
}

function ToastCard({ item, busy, onAnswer, onOpenAgent, onTrustWorkspace, workspaces, agents }: { item: DeckItem; busy: boolean } & Pick<ApprovalToastStackProps, 'onAnswer' | 'onOpenAgent' | 'onTrustWorkspace' | 'workspaces' | 'agents'>) {
    const where = workspaceOf(item, { workspaces, agents });
    const options = item.answer.kind === 'inline' ? item.answer.options : [];
    return (
        <div data-approval-toast={item.id} className="rounded-lg border border-[var(--warning)]/40 bg-[var(--bg-1)] p-3 text-[13px] shadow-lg">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
                <span data-approval-toast-agent="" className="font-semibold text-[var(--fg-1)]">{item.agentName ?? 'An agent'}</span>
                <span aria-hidden="true">·</span>
                {/* The workspace's colour beside its name (genie#1300). */}
                <WorkspaceSwatch color={where.color} />
                <span data-approval-toast-workspace="" className="min-w-0 flex-1 truncate">{where.name}</span>
                {onOpenAgent && item.agentId ? (
                    <Button type="button" size="xs" variant="ghost" data-toast-open={item.id} onClick={() => onOpenAgent(item)} title="Open this agent's chat">Open</Button>
                ) : null}
            </div>
            <ApprovalCard
                flat
                approval={{ question: personText(item.title), options, why: item.why ?? null }}
                agentName={item.agentName ?? undefined}
                // '' = an answer in flight: every option refuses a second press until the request leaves.
                answering={busy ? '' : null}
                onAnswer={(optionId, note) => onAnswer(item, optionId, note)}
                onTrustWorkspace={onTrustWorkspace && item.workspaceId ? () => onTrustWorkspace(item.workspaceId!) : undefined}
            />
        </div>
    );
}

/** The stack itself: a pure function of its view — no state, so a test can render it and read its handlers. */
export function ApprovalToastStack({ view, onAnswer, onExpand, onOpenAgent, onTrustWorkspace, workspaces, agents }: ApprovalToastStackProps) {
    if (view.total === 0) return null;
    return (
        <div
            data-approval-toasts=""
            data-total={view.total}
            data-expanded={view.expanded ? 'true' : 'false'}
            role="region"
            aria-label={`Approvals waiting: ${view.total}`}
            // The first toast is the one most worth answering: it sits in the corner, the rest stack above it, "+N more" on top.
            // In the toast column (ToastColumn): the column is placed, this stack only stacks.
            className="pointer-events-none flex flex-col-reverse gap-2"
        >
            {view.shown.map((item) => (
                <div key={item.id} className="pointer-events-auto">
                    <ToastCard item={item} busy={view.answering.includes(item.id)} onAnswer={onAnswer} onOpenAgent={onOpenAgent} onTrustWorkspace={onTrustWorkspace} workspaces={workspaces} agents={agents} />
                </div>
            ))}
            {view.more > 0 ? (
                <Button type="button" size="xs" data-toast-more={view.more} className="pointer-events-auto self-start rounded-full border border-[var(--warning)]/40 bg-[var(--bg-1)] px-3 shadow-lg" onClick={() => onExpand(true)}>
                    {`+${view.more} more waiting for approval`}
                </Button>
            ) : view.expanded ? (
                <Button type="button" size="xs" data-toast-fewer="" className="pointer-events-auto self-start rounded-full border border-[var(--border-1)] bg-[var(--bg-1)] px-3 shadow-lg" onClick={() => onExpand(false)}>
                    Show fewer
                </Button>
            ) : null}
        </div>
    );
}

/**
 * The stack's rules, as state: what arrived, what waits under Do Not Disturb, whether "+N more" is open. HELD BY THE SHELL
 * (not by the stack), because the agent's page and its chat need to know which approvals a toast carries — they show a
 * marker for those and no second set of buttons (agent-view.ts `approvalPlacement`).
 */
export function useApprovalToasts(items: readonly DeckItem[], dnd: boolean): { view: ToastStackView; pressed: (item: DeckItem) => void; expand: (on: boolean) => void } {
    // The first render already knows what arrived under DND, so nothing flashes on boot.
    const [state, dispatch] = useReducer(toastReducer, null, () => toastReducer(EMPTY_TOASTS, { kind: 'items', items, dnd }));
    useEffect(() => { dispatch({ kind: 'items', items, dnd }); }, [items, dnd]);
    return {
        view: toastView(state, items),
        pressed: (item) => dispatch({ kind: 'answering', id: item.id }),
        expand: (on) => dispatch({ kind: 'expand', on }),
    };
}
