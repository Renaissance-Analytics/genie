import type { DeckItem } from '../core/deck.js';
import type { ApprovalQueue, AutoApproved } from './approval-queue.js';
import type { AttentionData, AttentionStore, QuestionLeft } from './attention-store.js';
import type { InboxMessage, InboxStore, SendInput } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';

/**
 * THE STORES AGENTS WRITE TO, OWNED BY GENIE-HOST (the host split, P3.1: plan §11d).
 *
 * The inbox, attention (questions, imDone, the lists), the approval queue and the knowledge graph each have ONE writer:
 * this host. Agents reach them through Genie's MCP server here, with or without a window. A window holds replicas
 * (agent-stores-replica.ts): it is sent the whole state when it connects (`dump`) and every change after (`onEvent`), and
 * writes through `call` — only the methods named below, so a window cannot reach what it has no business with.
 */

export interface AgentStores {
    readonly inbox: InboxStore;
    readonly attention: AttentionStore;
    readonly knowledge: KnowledgeStore;
    readonly approvals: ApprovalQueue;
}

export interface ApprovalsView {
    readonly deck: readonly DeckItem[];
    readonly auto: readonly AutoApproved[];
    readonly cancelled: ReadonlyArray<{ action: string; detail: string; reason: string }>;
}

export interface StoresDump {
    readonly inbox: { readonly messages: readonly InboxMessage[]; readonly cursors: Readonly<Record<string, number>> };
    readonly attention: AttentionData;
    readonly approvals: ApprovalsView;
}

export type StoresEvent =
    | {
        readonly store: 'inbox';
        readonly kind: 'delta';
        readonly appended: readonly InboxMessage[];
        readonly updated: readonly InboxMessage[];
        readonly removed: readonly string[];
        readonly cursors: Readonly<Record<string, number>>;
    }
    | { readonly store: 'inbox'; readonly kind: 'sent'; readonly to: string; readonly messageId: string }
    | { readonly store: 'inbox'; readonly kind: 'read'; readonly reader: string; readonly ids: readonly string[] | null }
    | { readonly store: 'attention'; readonly kind: 'data'; readonly data: AttentionData }
    | { readonly store: 'attention'; readonly kind: 'left'; readonly questionId: string; readonly outcome: QuestionLeft }
    | { readonly store: 'approvals'; readonly kind: 'view'; readonly view: ApprovalsView };

export type StoreName = 'inbox' | 'attention' | 'knowledge' | 'approvals';

/** What a window may call, per store. Everything else is the host's own (an agent's tools run here). */
export const WINDOW_CALLS: Readonly<Record<StoreName, readonly string[]>> = {
    inbox: ['send', 'receive', 'deleteThread', 'attachmentForPerson'],
    attention: ['answer', 'dismiss', 'dismissMany', 'dismissOlderThan', 'markSeen', 'withdraw', 'lists.add', 'lists.done', 'lists.clear'],
    knowledge: ['add', 'get', 'update', 'remove', 'link', 'search', 'list'],
    approvals: ['resolve', 'gate'],
};

export class AgentStoresService {
    readonly #stores: AgentStores;
    readonly #forwardedCall: (id: string) => import('./mcp-tools.js').McpCall | undefined;
    readonly #listeners = new Set<(event: StoresEvent) => void>();
    /** The mail as the windows were last told it: what the next delta is taken against. */
    #known = new Map<string, InboxMessage>();
    #knownCursors = '{}';

    constructor(stores: AgentStores, options: { forwardedCall?: (id: string) => import('./mcp-tools.js').McpCall | undefined } = {}) {
        this.#stores = stores;
        this.#forwardedCall = options.forwardedCall ?? (() => undefined);
        this.#rememberMail();
        stores.inbox.onChanged(() => this.#mailChanged());
        stores.inbox.onSend((to, message) => this.#emit({ store: 'inbox', kind: 'sent', to, messageId: message.id }));
        stores.inbox.onRead((reader, ids) => this.#emit({ store: 'inbox', kind: 'read', reader, ids: ids ? [...ids] : null }));
        stores.attention.onChange(() => this.#emit({ store: 'attention', kind: 'data', data: stores.attention.snapshot() }));
        stores.attention.onLeave((questionId, outcome) => this.#emit({ store: 'attention', kind: 'left', questionId, outcome }));
        stores.approvals.onChange(() => this.#emit({ store: 'approvals', kind: 'view', view: this.#approvalsView() }));
    }

    get stores(): AgentStores {
        return this.#stores;
    }

    /** Everything a window that just connected needs to read before anything else. */
    dump(): StoresDump {
        const mail = this.#stores.inbox.snapshot();
        return { inbox: { messages: mail.messages, cursors: mail.cursors }, attention: this.#stores.attention.snapshot(), approvals: this.#approvalsView() };
    }

    onEvent(listener: (event: StoresEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A window's write (or a knowledge read: the graph is not replicated). Only WINDOW_CALLS; anything else is refused. */
    async call(store: string, method: string, args: readonly unknown[]): Promise<unknown> {
        const allowed = (WINDOW_CALLS as Record<string, readonly string[] | undefined>)[store];
        if (!allowed || !allowed.includes(method)) throw new Error(`a window cannot call ${store}.${method}`);
        const s = this.#stores;
        switch (store) {
            case 'inbox': {
                if (method === 'attachmentForPerson') {
                    const a = await s.inbox.attachmentForPerson(String(args[0]));
                    // Bytes as base64 across the link: JSON has no bytes.
                    return { name: a.name, base64: Buffer.from(a.bytes).toString('base64') };
                }
                if (method === 'receive') {
                    // A window's receive is the person's own, never a long wait it could not abort across the link.
                    const input = (args[0] ?? {}) as Record<string, unknown>;
                    return s.inbox.receive({ ...input, wait: false } as Parameters<InboxStore['receive']>[0]);
                }
                if (method === 'send') {
                    // A phone's upload crossed as base64; the store takes bytes.
                    const input = (args[0] ?? {}) as Omit<SendInput, 'files'> & { files?: Array<{ name: string; base64: string }> };
                    const files = input.files?.map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(f.base64, 'base64')) }));
                    const { files: _wire, ...rest } = input;
                    void _wire;
                    return s.inbox.send({ ...rest, ...(files ? { files } : {}) });
                }
                return (s.inbox as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
            }
            case 'attention': {
                if (method.startsWith('lists.')) return (s.attention.lists as unknown as Record<string, (...a: unknown[]) => unknown>)[method.slice('lists.'.length)]!(...args);
                return (s.attention as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
            }
            case 'knowledge':
                return (s.knowledge as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
            case 'approvals':
                // A window tool's gated action (forwarded from the host) asks this one queue; no MCP call to watch here.
                if (method === 'gate') return s.approvals.gate(args[0] as never, String(args[1]), String(args[2]), typeof args[3] === 'string' ? this.#forwardedCall(args[3]) : undefined);
                return s.approvals.resolve(String(args[0]), args[1] === 'allow' ? 'allow' : 'deny');
            default:
                throw new Error(`no store ${store}`);
        }
    }

    #approvalsView(): ApprovalsView {
        const a = this.#stores.approvals;
        return { deck: a.deckItems(), auto: a.autoApproved(), cancelled: a.lastCancelled() };
    }

    #rememberMail(): void {
        const mail = this.#stores.inbox.snapshot();
        this.#known = new Map(mail.messages.map((m) => [m.id, m]));
        this.#knownCursors = JSON.stringify(mail.cursors);
    }

    /** What changed since the windows were last told, by message id: appended, updated (a read mark), removed (a deletion). */
    #mailChanged(): void {
        const mail = this.#stores.inbox.snapshot();
        const appended: InboxMessage[] = [];
        const updated: InboxMessage[] = [];
        const seen = new Set<string>();
        for (const m of mail.messages) {
            seen.add(m.id);
            const before = this.#known.get(m.id);
            if (!before) appended.push(m);
            else if (before !== m) updated.push(m);
        }
        const removed = [...this.#known.keys()].filter((id) => !seen.has(id));
        const cursors = JSON.stringify(mail.cursors);
        this.#known = new Map(mail.messages.map((m) => [m.id, m]));
        if (appended.length === 0 && updated.length === 0 && removed.length === 0 && cursors === this.#knownCursors) return;
        this.#knownCursors = cursors;
        this.#emit({ store: 'inbox', kind: 'delta', appended, updated, removed, cursors: { ...mail.cursors } });
    }

    #emit(event: StoresEvent): void {
        for (const l of [...this.#listeners]) {
            try { l(event); } catch { /* one window's listener never costs another's */ }
        }
    }
}
