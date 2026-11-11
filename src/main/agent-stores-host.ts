import type { DeckItem } from '../core/deck.js';
import type { ApprovalQueue, AutoApproved } from './approval-queue.js';
import type { AttentionData, AttentionStore, QuestionLeft } from './attention-store.js';
import type { InboxMessage, InboxStore, SendInput } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { ChatDraftStore } from './chat-draft-store.js';
import type { SettingsStore } from './settings-store.js';
import type { SettingsData, SettingValue } from './settings-read.js';
import type { Store } from './store.js';
import { DraftFileHandles } from './draft-file-handles.js';

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
    /** The settings (P3.2): one file, one writer — this host; every window a replica, hot-swap kept. */
    readonly settings?: SettingsStore;
    /** Every chat's unsent draft (P3.2). */
    readonly drafts?: ChatDraftStore;
    /** The registry's files and the host's own model of them (P3.2): windows read and write the files through the host. */
    readonly registry?: { readonly store: Store; readonly model: { refresh(): Promise<void> } };
}

export interface ApprovalsView {
    readonly deck: readonly DeckItem[];
    readonly auto: readonly AutoApproved[];
    readonly cancelled: ReadonlyArray<{ action: string; detail: string; reason: string }>;
}

export interface StoresDump {
    readonly inbox: { readonly messages: readonly InboxMessage[]; readonly cursors: Readonly<Record<string, number>>; readonly filtered?: true };
    readonly attention: AttentionData;
    readonly approvals: ApprovalsView;
    readonly settings: SettingsData | null;
    /** What the host's store dropped reading the registry's files (a window shows its faults). */
    readonly registryDropped: readonly string[];
}

export type StoresEvent =
    | {
        readonly store: 'inbox';
        readonly kind: 'delta';
        readonly appended: readonly InboxMessage[];
        readonly updated: readonly InboxMessage[];
        readonly removed: readonly string[];
        readonly cursors: Readonly<Record<string, number>>;
        readonly filtered?: true;
    }
    | { readonly store: 'inbox'; readonly kind: 'sent'; readonly to: string; readonly messageId: string }
    | { readonly store: 'inbox'; readonly kind: 'read'; readonly reader: string; readonly ids: readonly string[] | null }
    | { readonly store: 'attention'; readonly kind: 'data'; readonly data: AttentionData }
    /** Only the parts that changed (Tynn #546): a question asked never sends the finished handoffs again. */
    | { readonly store: 'attention'; readonly kind: 'parts'; readonly parts: Partial<AttentionData> }
    | { readonly store: 'attention'; readonly kind: 'left'; readonly questionId: string; readonly outcome: QuestionLeft }
    | { readonly store: 'approvals'; readonly kind: 'view'; readonly view: ApprovalsView }
    | { readonly store: 'settings'; readonly kind: 'changed'; readonly key: string; readonly value: SettingValue; readonly workspaceId: string | null; readonly data: SettingsData }
    | { readonly store: 'registry'; readonly kind: 'written' };

export type StoreName = 'inbox' | 'attention' | 'knowledge' | 'approvals' | 'settings' | 'drafts' | 'registry';

/** What a window may call, per store. Everything else is the host's own (an agent's tools run here). */
export const WINDOW_CALLS: Readonly<Record<StoreName, readonly string[]>> = {
    inbox: ['send', 'receive', 'markDelivered', 'recordDeliveryRefusal', 'deleteThread', 'attachmentForPerson'],
    attention: ['answer', 'dismiss', 'dismissMany', 'dismissOlderThan', 'markSeen', 'withdraw', 'lists.add', 'lists.done', 'lists.clear'],
    knowledge: ['add', 'get', 'update', 'remove', 'link', 'search', 'list', 'summaries'],
    approvals: ['resolve', 'gate'],
    settings: ['set', 'setFor', 'resetFor', 'reset'],
    drafts: ['all', 'save', 'putFile', 'readFile', 'release', 'prune'],
    registry: ['readWorkspaces', 'readAgents', 'readRunningAtQuit', 'readInterruptedAtQuit', 'writeWorkspaces', 'writeAgents', 'writeRunningAtQuit', 'writeInterruptedAtQuit'],
};

export class AgentStoresService {
    readonly #draftFiles = new Map<string, DraftFileHandles>();
    readonly #draftFileIdleMs: number | undefined;
    /** The registry writes in flight, in the order they came. */
    #registryWrites: Promise<unknown> = Promise.resolve();

    /** Once the registry writes already asked for have landed, and the host's model has followed. A failed write is its caller's to hear. */
    registrySettled(): Promise<void> {
        return this.#registryWrites.then(() => {}, () => {});
    }

    readonly #stores: AgentStores;
    readonly #forwardedCall: (id: string) => import('./mcp-tools.js').McpCall | undefined;
    readonly #listeners = new Set<(event: StoresEvent) => void>();
    /** The mail as the windows were last told it: what the next delta is taken against. */
    #known = new Map<string, InboxMessage>();
    #knownCursors = '{}';

    constructor(stores: AgentStores, options: { forwardedCall?: (id: string) => import('./mcp-tools.js').McpCall | undefined; draftFileIdleMs?: number } = {}) {
        this.#stores = stores;
        this.#draftFileIdleMs = options.draftFileIdleMs;
        this.#forwardedCall = options.forwardedCall ?? (() => undefined);
        this.#rememberMail();
        stores.inbox.onChanged(() => this.#mailChanged());
        stores.inbox.onSend((to, message) => this.#emit({ store: 'inbox', kind: 'sent', to, messageId: message.id }));
        stores.inbox.onRead((reader, ids) => this.#emit({ store: 'inbox', kind: 'read', reader, ids: ids ? [...ids] : null }));
        // Only what changed crosses (Tynn #546): on the owner's machine the whole was 8.6 MB per change, to every link.
        let sent: Readonly<AttentionData> = { ...stores.attention.snapshot() };
        stores.attention.onChange(() => {
            const now = stores.attention.snapshot();
            const parts: Partial<Record<keyof AttentionData, unknown>> = {};
            for (const key of Object.keys(now) as (keyof AttentionData)[]) if (now[key] !== sent[key]) parts[key] = now[key];
            for (const key of Object.keys(sent) as (keyof AttentionData)[]) if (!(key in now)) parts[key] = undefined;
            sent = { ...now };
            if (Object.keys(parts).length > 0) this.#emit({ store: 'attention', kind: 'parts', parts: parts as Partial<AttentionData> });
        });
        stores.attention.onLeave((questionId, outcome) => this.#emit({ store: 'attention', kind: 'left', questionId, outcome }));
        stores.approvals.onChange(() => this.#emit({ store: 'approvals', kind: 'view', view: this.#approvalsView() }));
        // A setting changed, by whoever: every window's replica takes the data, then its listeners fire (hot-swap kept).
        stores.settings?.onChange((key, value, workspaceId) => this.#emit({ store: 'settings', kind: 'changed', key, value, workspaceId: workspaceId ?? null, data: stores.settings!.data() }));
    }

    get stores(): AgentStores {
        return this.#stores;
    }

    draftFileOpen(owner: string, ref: unknown): Promise<{ handle: string; size: number; sha256: string } | null> {
        const store = this.#stores.drafts; if (!store) throw new Error('this host keeps no chat drafts');
        let handles = this.#draftFiles.get(owner);
        if (!handles) { handles = new DraftFileHandles((file, options) => store.openFile(file, options), this.#draftFileIdleMs); this.#draftFiles.set(owner, handles); }
        return handles.open(ref);
    }
    draftFileRead(owner: string, handle: unknown, offset: unknown, length: unknown): Promise<{ base64: string }> { return this.#draftHandles(owner).read(handle, offset, length); }
    draftFileClose(owner: string, handle: unknown): Promise<{ closed: true }> { return this.#draftHandles(owner).close(handle); }
    dropDraftFiles(owner: string): Promise<void> { const handles = this.#draftFiles.get(owner); this.#draftFiles.delete(owner); return handles?.dispose() ?? Promise.resolve(); }
    #draftHandles(owner: string): DraftFileHandles { const handles = this.#draftFiles.get(owner); if (!handles) throw new Error('no such draft file handle on this engine connection'); return handles; }

    /** Everything a window that just connected needs to read before anything else. */
    dump(): StoresDump {
        const mail = this.#stores.inbox.snapshot();
        return { inbox: mail, attention: this.#stores.attention.snapshot(), approvals: this.#approvalsView(), settings: this.#stores.settings?.data() ?? null, registryDropped: [...(this.#stores.registry?.store.dropped ?? [])] };
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
            case 'settings': {
                if (!s.settings) throw new Error('this host keeps no settings');
                return (s.settings as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
            }
            case 'drafts': {
                if (!s.drafts) throw new Error('this host keeps no chat drafts');
                // A draft's file crosses as base64 both ways: JSON has no bytes.
                if (method === 'putFile') return s.drafts.putFile(new Uint8Array(Buffer.from(String(args[0]), 'base64')));
                if (method === 'readFile') { const b = await s.drafts.readFile(args[0]); return b ? Buffer.from(b).toString('base64') : null; }
                if (method === 'prune') return s.drafts.prune(Array.isArray(args[0]) ? (args[0] as string[]) : []);
                return (s.drafts as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
            }
            case 'registry': {
                const reg = s.registry;
                if (!reg) throw new Error('this host keeps no registry');
                const run = async (): Promise<unknown> => {
                    const result = await (reg.store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
                    if (method.startsWith('write')) {
                        // The host's own model follows the files (its tools and approvals read it with no window), then every
                        // window re-reads: two windows, one registry.
                        await reg.model.refresh();
                        this.#mailChanged();
                        this.#emit({ store: 'registry', kind: 'written' });
                    }
                    return result;
                };
                if (!method.startsWith('write')) return run();
                // Counted before the first await: a start right behind this on the same socket must find it.
                const written = run();
                this.#registryWrites = Promise.allSettled([this.#registryWrites, written]);
                return written;
            }
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
        this.#emit({ store: 'inbox', kind: 'delta', appended, updated, removed, cursors: { ...mail.cursors }, ...(mail.filtered ? { filtered: true } : {}) });
    }

    #emit(event: StoresEvent): void {
        for (const l of [...this.#listeners]) {
            try { l(event); } catch { /* one window's listener never costs another's */ }
        }
    }
}
