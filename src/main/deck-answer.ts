import type { FeatureAction } from '../renderer/features.js';
import { approvalNoteText } from '../core/approval-note.js';
import type { DeckItem } from '../core/deck.js';
import { deckAnswerNotes, deckNoteRefusal } from '../core/deck-answer-wire.js';
import { resolveDeckAnswer, resolveDeckForm } from '../core/deck-resolve.js';
import { HUMAN } from '../core/inbox.js';
import type { AttentionStore } from './attention-store.js';
import type { HostsSyncResult } from './hosts-file.js';
import type { InboxStore } from './inbox-store.js';

/**
 * THE DECK'S ANSWER (Tynn #551, host split P5d.2): a question answered, an approval resolved (its note delivered), a list
 * item done, mail read, a finished agent seen. One function for the window's feature action and for genie-host, which
 * answers a phone's Deck with every window closed. What only a window can do (an elevation, the main process's error
 * record) is refused where it is not wired, with what to do.
 */
export type DeckAnswerAction = Extract<FeatureAction, { kind: 'deck.answer' | 'deck.answerForm' }>;

export interface DeckAnswerPorts {
    /**
     * THE HOST'S OWN DECK (Tynn #861): what an answer is resolved against. An answer names an item by id; its title, its
     * agent, its options and whether it was forwarded are read here, never from the copy a client sent.
     */
    deckItems(): readonly DeckItem[];
    readonly attention: Pick<AttentionStore, 'answer' | 'pending'> & { readonly lists: Pick<AttentionStore['lists'], 'done'> };
    /** As the window's approvals API types it (a replica may answer later); read exactly as the feature action always did. */
    readonly approvals: { resolve(id: string, choice: 'allow' | 'deny'): boolean | Promise<boolean>; dismissExpired?(id: string): boolean | Promise<boolean> };
    readonly inbox: Pick<InboxStore, 'unread' | 'receive'>;
    readonly deliverToAgent?: ((agentId: string, text: string) => boolean | Promise<boolean>) | undefined;
    readonly trustCertificate?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly deferTrustCertificate?: () => void;
    readonly syncHosts?: () => Promise<HostsSyncResult>;
    /** The hosts-file ask's Not now (Tynn #753). */
    readonly deferHosts?: () => void;
    /** The person's normal browser, in the window that answered: "Open <name> in your browser" ends there (Tynn #743). */
    readonly openExternal?: (url: string) => Promise<void>;
    /** `retryHostCopy`, `openLog` (Tynn #693): the window's. `openLog` answers why it could not open, or `null`. */
    /** A rate-limit alert's kept notice (Tynn #748): Dismiss forgets it. */
    readonly limitNotices?: { dismiss(id: string): boolean };
    /** A Playwright install Genie could not finish (Tynn #846): Retry installs it again, Dismiss puts it away. */
    readonly playwrightNotices?: { retry(id: string): Promise<boolean>; dismiss(id: string): boolean };
    /** A turn Genie ended as stalled (Tynn #855): Stop or Restart the agent, or Dismiss; `false` when there is no such item. */
    readonly stalledTurns?: { act(agentId: string, action: 'stop' | 'restart' | 'dismiss'): Promise<boolean> };
    /** `deckItems`: the window's own record of them, the items an answer to one is resolved against (Tynn #861). */
    readonly mainErrors?: { deckItems?(): readonly DeckItem[] | Promise<readonly DeckItem[]>; dismiss(id: string): boolean | Promise<boolean>; retryHostCopy?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>; openLog?(id?: string): Promise<string | null>; report?(id: string): Promise<string | null> };
}

const NEEDS_WINDOW = (what: string): string => `${what} needs Genie’s window on this machine: open Genie there`;

/** No longer on this host's Deck: answered, dismissed, withdrawn — or never one of its items. */
export const DECK_ITEM_GONE = 'This is no longer waiting here: it was answered, dismissed or withdrawn. Nothing was sent.';

/** The item this answer names, as THIS host holds it; `null` when it holds none by that id. */
async function ownItem(ports: DeckAnswerPorts, id: unknown): Promise<DeckItem | null> {
    if (typeof id !== 'string' || id === '') return null;
    const own = ports.deckItems().find((i) => i.id === id);
    if (own) return own;
    // Genie's own record of an error its window's process caught (main-errors.ts) is that process's, asked of it.
    const errors = ports.mainErrors?.deckItems ? await ports.mainErrors.deckItems() : [];
    return (Array.isArray(errors) ? errors : []).find((i) => i.id === id) ?? null;
}

export async function answerDeck(action: DeckAnswerAction, ports: DeckAnswerPorts): Promise<void> {
    // THE ANSWER ONLY (Tynn #861): the id, the option or the picks, the notes. A note over the cap is refused, never cut.
    const refusal = deckNoteRefusal(deckAnswerNotes(action));
    if (refusal) throw new Error(refusal);
    const item = await ownItem(ports, (action.item as { id?: unknown } | null | undefined)?.id);
    if (!item) throw new Error(DECK_ITEM_GONE);
    const command = action.kind === 'deck.answer'
        ? resolveDeckAnswer(item, String(action.optionId), typeof action.note === 'string' ? action.note : '')
        : resolveDeckForm(item, Array.isArray(action.selections) ? action.selections : [], Array.isArray(action.notes) ? action.notes : [], typeof action.note === 'string' ? action.note : '');
    switch (command.kind) {
        case 'refused':
            throw new Error(command.reason);
        case 'answer-question': {
            // THE COPY THE PERSON ANSWERED (Tynn #600): its agent may have rewritten the question since (`update`), or it may
            // have left. An answer to an older copy would record labels the agent never offered; it is refused in words,
            // and the Deck then shows the question as it is now.
            const current = ports.attention.pending().find((q) => q.id === command.questionId);
            if (!current) throw new Error('This question is no longer waiting: it was answered, dismissed or withdrawn. Nothing was sent.');
            // The revision the person answered is the one fact of the item an answer brings: it is checked, never trusted.
            if ((current.revision ?? 0) !== (action.item.revision ?? 0)) {
                throw new Error(`This question was changed since you opened it (it is on version ${(current.revision ?? 0) + 1} now). Nothing was sent: read it again and answer the current one.`);
            }
            await ports.attention.answer(command.questionId, { selections: command.selections, notes: command.notes, note: command.note });
            break;
        }
        case 'resolve-approval': {
            // THE NOTE REACHES THE AGENT (beta.33 item 16): the tool call gets its verdict; the note follows as your
            // message. Checked BEFORE the answer, so a note that could not be delivered never leaves a silent verdict.
            // The title quoted and the agent told are the host's own (Tynn #861): a client cannot redirect a note.
            const text = action.kind === 'deck.answer' && item.agentId
                ? approvalNoteText({ what: `“${item.title}”`, outcome: command.choice === 'allow' ? 'allowed' : 'denied', option: command.choice, note: command.note })
                : null;
            if (text !== null && !ports.deliverToAgent) throw new Error('your note cannot reach the agent from here; answer without it, or from its own window');
            if (!ports.approvals.resolve(command.approvalId, command.choice)) throw new Error(`no pending approval ${command.approvalId}`);
            if (text !== null && !(await ports.deliverToAgent!(item.agentId!, text))) throw new Error(`answered — but ${item.agentName ?? 'the agent'} is not running, so your note was not delivered`);
            break;
        }
        // An approval nobody answered in time (Tynn #1006): its notice goes; there is no verdict to give any more.
        case 'dismiss-expired-approval': {
            if (!ports.approvals.dismissExpired || !(await ports.approvals.dismissExpired(command.approvalId))) throw new Error(DECK_ITEM_GONE);
            break;
        }
        case 'list-done':
            // The PERSON's Done: the store mails the agent that put the item on their list (attention-store.ts).
            if (!(await ports.attention.lists.done({ workspaceId: command.workspaceId, id: command.itemId, by: HUMAN }))) throw new Error(`no list item ${command.itemId}`);
            break;
        case 'mark-read': {
            const unread = ports.inbox.unread(HUMAN);
            const target = unread.find((m) => m.id === command.messageId);
            if (!target) throw new Error(`no unread message ${command.messageId}`);
            await ports.inbox.receive({ participant: HUMAN, limit: unread.filter((m) => m.seq < target.seq).length + 1 });
            break;
        }
        case 'trust-certificate': {
            // The same Trust as Hosting's line: one elevation, and a failure comes back with its reason.
            if (!ports.trustCertificate) throw new Error(NEEDS_WINDOW('trusting Genie’s certificate'));
            const r = await ports.trustCertificate();
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'defer-trust-certificate':
            if (!ports.deferTrustCertificate) throw new Error(NEEDS_WINDOW('putting the certificate off'));
            ports.deferTrustCertificate();
            break;
        case 'sync-hosts': {
            // What genie-host held for a window: the person approves it here, so the prompt is raised by this window.
            if (!ports.syncHosts) throw new Error(NEEDS_WINDOW('the hosts file'));
            const r = await ports.syncHosts();
            if ('error' in r) throw new Error(r.error);
            break;
        }
        case 'defer-hosts':
            if (!ports.deferHosts) throw new Error(NEEDS_WINDOW('putting the hosts file off'));
            ports.deferHosts();
            break;
        case 'open-site': {
            // OPEN <NAME> IN YOUR BROWSER (Tynn #743). The Trust first: when the certificate is untrusted it is the ONE
            // prompt, and a due hosts write rides in it (HostsSync.joinElevation); when trusted it answers at once with no
            // prompt. Then the hosts sync: a write the Trust carried has landed and asks nothing; otherwise it is the one
            // prompt. A decline stops here with its reason and nothing opens.
            if (!ports.trustCertificate || !ports.syncHosts) throw new Error(NEEDS_WINDOW('opening a site in your browser'));
            const trusted = await ports.trustCertificate();
            if (!trusted.ok) throw new Error(trusted.reason);
            const hosts = await ports.syncHosts();
            if ('error' in hosts) throw new Error(hosts.error);
            // The person's own browser, from the window they clicked in. A Genie with no window to open it from has still
            // done the work: the site is reachable, and the row is gone.
            await ports.openExternal?.(command.url);
            break;
        }
        case 'defer-open-site':
            if (!ports.deferTrustCertificate || !ports.deferHosts) throw new Error(NEEDS_WINDOW('putting this off'));
            ports.deferTrustCertificate();
            ports.deferHosts();
            break;
        case 'playwright-install':
            // A Playwright install Genie could not finish (Tynn #846). Retry runs it again: when it fails again the item stays, with why.
            if (!ports.playwrightNotices) throw new Error('Genie’s Playwright installer is not running here; nothing was done');
            if (command.retry ? !(await ports.playwrightNotices.retry(command.id)) : !ports.playwrightNotices.dismiss(command.id)) throw new Error(`no Playwright install item ${command.id}`);
            break;
        case 'stalled-turn':
            // A turn Genie ended as stalled (Tynn #855): the agent is stopped or restarted on its conversation here, on its host.
            if (!ports.stalledTurns) throw new Error('this Genie does not keep stalled turns; nothing was done');
            if (!(await ports.stalledTurns.act(command.agentId, command.action))) throw new Error(`no stalled turn for ${command.agentId}`);
            break;
        case 'dismiss-limit-alert':
            if (!ports.limitNotices) throw new Error(NEEDS_WINDOW('dismissing a rate-limit alert'));
            if (!ports.limitNotices.dismiss(command.id)) throw new Error(`no rate-limit notice ${command.id}`);
            break;
        case 'dismiss-main-error':
            // Read, and put aside. Refused with its reason when nothing is wired or the item is already gone.
            if (!ports.mainErrors) throw new Error('the main process’s error record is not wired into this Genie; nothing was dismissed');
            if (!await ports.mainErrors.dismiss(command.id)) throw new Error(`no recorded error ${command.id}`);
            break;
        case 'retry-host-copy': {
            // The copy is made by the window that starts the host; its failure comes back in words (Tynn #693).
            if (!ports.mainErrors?.retryHostCopy) throw new Error(NEEDS_WINDOW('making the host’s copy'));
            const r = await ports.mainErrors.retryHostCopy(command.id);
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'open-lifecycle-log': {
            if (!ports.mainErrors?.openLog) throw new Error(NEEDS_WINDOW('opening the log'));
            const failed = await (command.id ? ports.mainErrors.openLog(command.id) : ports.mainErrors.openLog());
            if (failed !== null) throw new Error(`Genie could not open the log: ${failed}`);
            break;
        }
        case 'report-main-error': {
            if (!ports.mainErrors?.report) throw new Error(NEEDS_WINDOW('opening an issue draft'));
            const failed = await ports.mainErrors.report(command.id);
            if (failed !== null) throw new Error(`Genie could not open the issue draft: ${failed}`);
            break;
        }
        case 'answer-provider-approval':
            // A session-layer concern: main.ts routes it to the session host.
            throw new Error(`${command.kind} is handled by the session host, not the feature IPC`);
    }
}
