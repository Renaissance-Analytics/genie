import type { FeatureAction } from '../renderer/features.js';
import { approvalNoteText } from '../core/approval-note.js';
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
    readonly attention: Pick<AttentionStore, 'answer' | 'pending'> & { readonly lists: Pick<AttentionStore['lists'], 'done'> };
    /** As the window's approvals API types it (a replica may answer later); read exactly as the feature action always did. */
    readonly approvals: { resolve(id: string, choice: 'allow' | 'deny'): boolean | Promise<boolean> };
    readonly inbox: Pick<InboxStore, 'unread' | 'receive'>;
    readonly deliverToAgent?: ((agentId: string, text: string) => boolean | Promise<boolean>) | undefined;
    readonly trustCertificate?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly deferTrustCertificate?: () => void;
    readonly syncHosts?: () => Promise<HostsSyncResult>;
    /** `retryHostCopy`, `openLog` (Tynn #693): the window's. `openLog` answers why it could not open, or `null`. */
    readonly mainErrors?: { dismiss(id: string): boolean; retryHostCopy?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>; openLog?(): Promise<string | null> };
}

const NEEDS_WINDOW = (what: string): string => `${what} needs Genie’s window on this machine: open Genie there`;

export async function answerDeck(action: DeckAnswerAction, ports: DeckAnswerPorts): Promise<void> {
    const command = action.kind === 'deck.answer' ? resolveDeckAnswer(action.item, action.optionId, action.note ?? '') : resolveDeckForm(action.item, action.selections, Array.isArray(action.notes) ? action.notes : [], action.note);
    switch (command.kind) {
        case 'refused':
            throw new Error(command.reason);
        case 'answer-question': {
            // THE COPY THE PERSON ANSWERED (Tynn #600): its agent may have rewritten the question since (`update`), or it may
            // have left. An answer to an older copy would record labels the agent never offered; it is refused in words,
            // and the Deck then shows the question as it is now.
            const current = ports.attention.pending().find((q) => q.id === command.questionId);
            if (!current) throw new Error('This question is no longer waiting: it was answered, dismissed or withdrawn. Nothing was sent.');
            if ((current.revision ?? 0) !== (action.item.revision ?? 0)) {
                throw new Error(`This question was changed since you opened it (it is on version ${(current.revision ?? 0) + 1} now). Nothing was sent: read it again and answer the current one.`);
            }
            await ports.attention.answer(command.questionId, { selections: command.selections, notes: command.notes, note: command.note });
            break;
        }
        case 'resolve-approval': {
            // THE NOTE REACHES THE AGENT (beta.33 item 16): the tool call gets its verdict; the note follows as your
            // message. Checked BEFORE the answer, so a note that could not be delivered never leaves a silent verdict.
            const text = action.kind === 'deck.answer' && action.item.agentId
                ? approvalNoteText({ what: `“${action.item.title}”`, outcome: command.choice === 'allow' ? 'allowed' : 'denied', option: command.choice, note: command.note })
                : null;
            if (text !== null && !ports.deliverToAgent) throw new Error('your note cannot reach the agent from here; answer without it, or from its own window');
            if (!ports.approvals.resolve(command.approvalId, command.choice)) throw new Error(`no pending approval ${command.approvalId}`);
            if (text !== null && !(await ports.deliverToAgent!(action.item.agentId!, text))) throw new Error(`answered — but ${action.item.agentName ?? 'the agent'} is not running, so your note was not delivered`);
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
        case 'dismiss-main-error':
            // Read, and put aside. Refused with its reason when nothing is wired or the item is already gone.
            if (!ports.mainErrors) throw new Error('the main process’s error record is not wired into this Genie; nothing was dismissed');
            if (!ports.mainErrors.dismiss(command.id)) throw new Error(`no recorded error ${command.id}`);
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
            const failed = await ports.mainErrors.openLog();
            if (failed !== null) throw new Error(`Genie could not open the log: ${failed}`);
            break;
        }
        case 'answer-provider-approval':
            // A session-layer concern: main.ts routes it to the session host.
            throw new Error(`${command.kind} is handled by the session host, not the feature IPC`);
    }
}
