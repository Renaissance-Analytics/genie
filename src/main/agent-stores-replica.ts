import type { DeckItem } from '../core/deck.js';
import type { Participant } from '../core/inbox.js';
import { InvolvingCache, hasWrittenIn, receiptsOf, unreadOf } from '../core/inbox-read.js';
import type { AgentId } from '../core/identity.js';
import type { ListItem, ListKind } from '../core/attention.js';
import type { ApprovalsView, StoreName, StoresDump, StoresEvent } from './agent-stores-host.js';
import type { AutoApproved } from './approval-queue.js';
import { allUserItemsOf, askedOf, finishedOf, lastHandoffOf, pendingOf, scopedListOf } from './attention-read.js';
import type { Answer, AskedRecord, AttentionData, Finished, ListAddResult, PendingQuestion, QuestionLeft } from './attention-store.js';
import type { InboxMessage, ReceiveInput, ReceivePage, Receipt, SendInput } from './inbox-store.js';
import type { AddInput, Hit, KnowledgeNode, LinkResult, ListInput, SearchInput, Unresolved } from './knowledge-store.js';
import { settingOf, snapshotForOf, snapshotOf, workspaceValuesOf, type SettingValue, type SettingsData } from './settings-read.js';
import type { ChatDrafts } from '../core/chat-drafts.js';
import type { AgentRecord } from '../core/identity.js';
import type { WorkspaceRecord } from './store.js';

/**
 * THE WINDOW'S REPLICAS OF THE HOST'S STORES (the host split, P3.1: plan §11d).
 *
 * genie-host owns the inbox, attention, the approval queue and the knowledge graph (agent-stores-host.ts). The window
 * reads them many times a second (the Deck, the snapshots, the chat's comms rows), so it keeps a replica of each that it
 * reads synchronously, with the SAME reads as the store (core/inbox-read.ts, attention-read.ts). It is re-based from the
 * host's dump at every connect and follows every change after; its events fire once its state has the change. Writes go
 * to the host and answer what the host answers. The knowledge graph is not replicated (it is a database): its reads are
 * calls.
 */

/** How the replicas reach the host: a store method, by name, answered or refused in the host's words. */
export type StoresCall = (store: StoreName, method: string, args: readonly unknown[]) => Promise<unknown>;

export class InboxReplica {
    #messages: InboxMessage[] = [];
    #cursors: Record<string, number> = {};
    readonly #involving = new InvolvingCache<InboxMessage>();
    readonly #sendListeners = new Set<(to: Participant, message: InboxMessage) => void>();
    readonly #readListeners = new Set<(reader: Participant, ids?: readonly string[]) => void>();
    readonly #call: StoresCall;

    constructor(call: StoresCall) {
        this.#call = call;
    }

    rebase(mail: StoresDump['inbox']): void {
        this.#messages = [...mail.messages];
        this.#cursors = { ...mail.cursors };
    }

    apply(event: Extract<StoresEvent, { store: 'inbox' }>): void {
        if (event.kind === 'delta') {
            if (event.updated.length > 0 || event.removed.length > 0) {
                // A NEW array for a change in place: the involving cache reads array and length as "unchanged".
                const updated = new Map(event.updated.map((m) => [m.id, m]));
                const removed = new Set(event.removed);
                this.#messages = this.#messages.filter((m) => !removed.has(m.id)).map((m) => updated.get(m.id) ?? m);
            }
            for (const m of event.appended) this.#messages.push(m);
            this.#cursors = { ...event.cursors };
            return;
        }
        if (event.kind === 'sent') {
            const message = this.#messages.find((m) => m.id === event.messageId);
            if (message) for (const l of [...this.#sendListeners]) l(event.to as Participant, message);
            return;
        }
        for (const l of [...this.#readListeners]) l(event.reader as Participant, event.ids ?? undefined);
    }

    #view() {
        return { messages: this.#messages, cursors: this.#cursors };
    }

    onSend(listener: (to: Participant, message: InboxMessage) => void): () => void {
        this.#sendListeners.add(listener);
        return () => { this.#sendListeners.delete(listener); };
    }

    onRead(listener: (reader: Participant, ids?: readonly string[]) => void): () => void {
        this.#readListeners.add(listener);
        return () => { this.#readListeners.delete(listener); };
    }

    involving(participant: Participant, limit = 200): readonly InboxMessage[] {
        return this.#involving.read(this.#messages, participant, limit);
    }

    all(): InboxMessage[] {
        return [...this.#messages];
    }

    hasWritten(from: Participant, to: Participant): boolean {
        return hasWrittenIn(this.#view(), from, to);
    }

    unread(participant: Participant): InboxMessage[] {
        return unreadOf(this.#view(), participant);
    }

    unreadCount(participant: Participant): number {
        return this.unread(participant).length;
    }

    receipts(from: Participant, limit = 20): Receipt[] {
        return receiptsOf(this.#view(), from, limit);
    }

    async send(input: SendInput): Promise<InboxMessage> {
        // Bytes cross as base64 (a phone's upload, genie#1354): JSON has no bytes.
        const files = input.files?.map((f) => ({ name: f.name, base64: Buffer.from(f.bytes).toString('base64') }));
        return (await this.#call('inbox', 'send', [{ ...input, ...(files ? { files } : {}) }])) as InboxMessage;
    }

    /** The person's receive: committed on the host, never a long wait (the host refuses to hold one for a window). */
    async receive(input: ReceiveInput): Promise<ReceivePage> {
        const { signal: _signal, ...rest } = input;
        void _signal;
        return (await this.#call('inbox', 'receive', [{ ...rest, wait: false }])) as ReceivePage;
    }

    async markDelivered(participant: Participant, ids: readonly string[]): Promise<void> {
        await this.#call('inbox', 'markDelivered', [participant, ids]);
    }

    async recordDeliveryRefusal(participant: Participant, ids: readonly string[], refusal: { readonly attempts: number; readonly reason: string }): Promise<void> {
        await this.#call('inbox', 'recordDeliveryRefusal', [participant, ids, refusal]);
    }

    async deleteThread(a: Participant, b: Participant): Promise<number> {
        return (await this.#call('inbox', 'deleteThread', [a, b])) as number;
    }

    async attachmentForPerson(attachmentId: string): Promise<{ name: string; bytes: Buffer }> {
        const r = (await this.#call('inbox', 'attachmentForPerson', [attachmentId])) as { name: string; base64: string };
        return { name: r.name, bytes: Buffer.from(r.base64, 'base64') };
    }
}

export class AttentionReplica {
    #data: AttentionData = { lists: [], questions: [], finished: [] };
    readonly #recentlyLeft = new Map<string, QuestionLeft>();
    readonly #changeListeners = new Set<() => void>();
    readonly #leaveListeners = new Set<(questionId: string, outcome: QuestionLeft) => void>();
    readonly #call: StoresCall;
    readonly lists: {
        add(input: { list: ListKind; workspaceId: string; agentId: AgentId; text: string }): Promise<ListAddResult>;
        show(input: { list: ListKind; workspaceId: string; agentId: AgentId }): ListItem[];
        done(input: { workspaceId: string; id: string; by: Participant }): Promise<boolean>;
        clear(input: { list: ListKind; workspaceId: string; agentId: AgentId }): Promise<number>;
    };

    constructor(call: StoresCall) {
        this.#call = call;
        this.lists = {
            add: async (input) => (await call('attention', 'lists.add', [input])) as ListAddResult,
            show: (input) => scopedListOf(this.#data, input).map((r) => r.item),
            done: async (input) => (await call('attention', 'lists.done', [input])) as boolean,
            clear: async (input) => (await call('attention', 'lists.clear', [input])) as number,
        };
    }

    rebase(data: AttentionData): void {
        this.#data = data;
        for (const l of [...this.#changeListeners]) l();
    }

    apply(event: Extract<StoresEvent, { store: 'attention' }>): void {
        if (event.kind === 'data') { this.rebase(event.data); return; }
        this.#recentlyLeft.set(event.questionId, event.outcome);
        if (this.#recentlyLeft.size > 200) this.#recentlyLeft.delete(this.#recentlyLeft.keys().next().value as string);
        for (const l of [...this.#leaveListeners]) l(event.questionId, event.outcome);
    }

    pending(): readonly PendingQuestion[] { return pendingOf(this.#data); }
    finished(): readonly Finished[] { return finishedOf(this.#data); }
    allUserItems(): Array<{ workspaceId: string; item: ListItem }> { return allUserItemsOf(this.#data); }
    lastHandoff(agentId: AgentId): { text: string; at: number } | null { return lastHandoffOf(this.#data, agentId); }
    asked(questionId: string): AskedRecord | null { return askedOf(this.#data, questionId); }
    leftOutcome(questionId: string): QuestionLeft | undefined { return this.#recentlyLeft.get(questionId); }

    async answer(questionId: string, answer: Answer): Promise<void> { await this.#call('attention', 'answer', [questionId, answer]); }
    async dismiss(questionId: string, notes: readonly string[] = []): Promise<void> { await this.#call('attention', 'dismiss', [questionId, notes]); }
    async dismissMany(questionIds: readonly string[]): Promise<number> { return (await this.#call('attention', 'dismissMany', [questionIds])) as number; }
    async withdraw(owner: Parameters<import('./attention-store.js').AttentionStore['withdraw']>[0], questionId: string): Promise<{ ok: true; questionId: string; withdrawn: true }> {
        return (await this.#call('attention', 'withdraw', [owner, questionId])) as { ok: true; questionId: string; withdrawn: true };
    }
    async dismissOlderThan(ms: number): Promise<number> { return (await this.#call('attention', 'dismissOlderThan', [ms])) as number; }
    /** Fire and forget, as the store's own is: the change comes back as the store's next data. */
    markSeen(id: string): void { void this.#call('attention', 'markSeen', [id]).catch(() => {}); }

    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => { this.#changeListeners.delete(listener); };
    }

    onLeave(listener: (questionId: string, outcome: QuestionLeft) => void): () => void {
        this.#leaveListeners.add(listener);
        return () => { this.#leaveListeners.delete(listener); };
    }
}

export class ApprovalsReplica {
    #view: ApprovalsView = { deck: [], auto: [], cancelled: [] };
    readonly #listeners = new Set<() => void>();
    readonly #call: StoresCall;

    constructor(call: StoresCall) {
        this.#call = call;
    }

    rebase(view: ApprovalsView): void {
        this.#view = view;
        for (const l of [...this.#listeners]) l();
    }

    deckItems(): DeckItem[] { return [...this.#view.deck]; }
    autoApproved(): readonly AutoApproved[] { return this.#view.auto; }
    lastCancelled(): Array<{ action: string; detail: string; reason: string }> { return [...this.#view.cancelled]; }

    /** A gated action (a window tool's), asked of the host's one queue. */
    async gate(caller: import('./mcp-tools.js').Caller, action: string, detail: string, call?: import('./mcp-tools.js').McpCall): Promise<'allowed' | 'denied'> {
        // Tied to the agent's real call in the host by its forwarded id: it ends when that call goes (genie#1360).
        return (await this.#call('approvals', 'gate', [caller, action, detail, call?.forwardedCallId ?? null])) === 'allowed' ? 'allowed' : 'denied';
    }

    /** The person's verdict, decided in the host's queue: true when there was such an item. */
    async resolve(id: string, choice: 'allow' | 'deny'): Promise<boolean> {
        return (await this.#call('approvals', 'resolve', [id, choice])) === true;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}

/** The knowledge graph, read and written in the host (a database: not replicated). */
export class KnowledgeRemote {
    readonly #call: StoresCall;

    constructor(call: StoresCall) {
        this.#call = call;
    }

    async add(input: AddInput): Promise<{ id: string; unresolved: Unresolved[] }> { return (await this.#call('knowledge', 'add', [input])) as { id: string; unresolved: Unresolved[] }; }
    async get(id: string): Promise<KnowledgeNode | null> { return (await this.#call('knowledge', 'get', [id])) as KnowledgeNode | null; }
    async update(id: string, patch: Parameters<import('./knowledge-store.js').KnowledgeStore['update']>[1]): Promise<boolean> { return (await this.#call('knowledge', 'update', [id, patch])) as boolean; }
    async remove(id: string): Promise<boolean> { return (await this.#call('knowledge', 'remove', [id])) as boolean; }
    async link(from: string, to: string): Promise<LinkResult> { return (await this.#call('knowledge', 'link', [from, to])) as LinkResult; }
    async search(input: SearchInput): Promise<{ hits: Hit[]; nextCursor: string | null }> { return (await this.#call('knowledge', 'search', [input])) as { hits: Hit[]; nextCursor: string | null }; }
    async list(input: ListInput): Promise<{ nodes: KnowledgeNode[]; nextCursor: string | null }> { return (await this.#call('knowledge', 'list', [input])) as { nodes: KnowledgeNode[]; nextCursor: string | null }; }
    async summaries(input: ListInput): Promise<{ hits: Hit[]; nextCursor: string | null }> { return (await this.#call('knowledge', 'summaries', [input])) as { hits: Hit[]; nextCursor: string | null }; }
}

/**
 * THE SETTINGS, AS THIS WINDOW READS THEM (the host split, P3.2): the host's data, the same reads as the store
 * (settings-read.ts), and HOT-SWAP kept — a change by whoever reaches here, the data first, then the listeners, so a
 * listener that applies a setting live reads the new value.
 */
export class SettingsReplica {
    #data: SettingsData = { values: {}, workspaces: {}, carriedOver: null };
    readonly #listeners = new Set<(key: string, value: SettingValue, workspaceId?: string) => void>();
    readonly #call: StoresCall;

    constructor(call: StoresCall) {
        this.#call = call;
    }

    rebase(data: SettingsData): void { this.#data = data; }

    apply(event: Extract<StoresEvent, { store: 'settings' }>): void {
        this.#data = event.data;
        for (const l of [...this.#listeners]) {
            if (event.workspaceId === null) l(event.key, event.value); else l(event.key, event.value, event.workspaceId);
        }
    }

    get(key: string): SettingValue { return settingOf(this.#data, key); }
    snapshot(): Record<string, SettingValue> { return snapshotOf(this.#data); }
    snapshotFor(workspaceId: string): Record<string, SettingValue> { return snapshotForOf(this.#data, workspaceId); }
    workspaceValues(workspaceId: string): Record<string, SettingValue> { return workspaceValuesOf(this.#data, workspaceId); }
    data(): SettingsData { return this.#data; }

    async set(key: string, value: unknown): Promise<void> { await this.#call('settings', 'set', [key, value]); }
    async setFor(workspaceId: string, key: string, value: unknown): Promise<void> { await this.#call('settings', 'setFor', [workspaceId, key, value]); }
    async resetFor(workspaceId: string, key: string): Promise<void> { await this.#call('settings', 'resetFor', [workspaceId, key]); }
    async reset(key: string): Promise<void> { await this.#call('settings', 'reset', [key]); }

    onChange(listener: (key: string, value: SettingValue, workspaceId?: string) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}

/** Every chat's unsent draft, kept in the host (P3.2): read and written by call (only async handlers use them). */
export class DraftsRemote {
    readonly #call: StoresCall;

    constructor(call: StoresCall) {
        this.#call = call;
    }

    async all(): Promise<ChatDrafts> { return (await this.#call('drafts', 'all', [])) as ChatDrafts; }
    async save(agentId: string, raw: unknown): Promise<void> { await this.#call('drafts', 'save', [agentId, raw]); }
    async putFile(bytes: Uint8Array): Promise<string> { return (await this.#call('drafts', 'putFile', [Buffer.from(bytes).toString('base64')])) as string; }
    async readFile(ref: unknown): Promise<Uint8Array | null> {
        const b = (await this.#call('drafts', 'readFile', [ref])) as string | null;
        return b === null ? null : new Uint8Array(Buffer.from(b, 'base64'));
    }
    async release(refs: readonly unknown[]): Promise<void> { await this.#call('drafts', 'release', [refs]); }
    async prune(agentIds: Iterable<string>): Promise<void> { await this.#call('drafts', 'prune', [[...agentIds]]); }
}

/**
 * A window Registry's files, read and written by genie-host (P3.2): the Store's own calls, answered by the files' one
 * writer. `dropped` is what the host's read set aside, from the dump.
 */
export class HostRegistryStore {
    readonly #call: StoresCall;
    readonly dropped: string[];

    constructor(replicas: Pick<StoreReplicas, 'call' | 'registryDropped'>) {
        this.#call = replicas.call;
        this.dropped = [...replicas.registryDropped()];
    }

    async readWorkspaces(): Promise<readonly WorkspaceRecord[]> { return (await this.#call('registry', 'readWorkspaces', [])) as WorkspaceRecord[]; }
    async readAgents(): Promise<readonly AgentRecord[]> { return (await this.#call('registry', 'readAgents', [])) as AgentRecord[]; }
    async readRunningAtQuit(): Promise<readonly string[]> { return (await this.#call('registry', 'readRunningAtQuit', [])) as string[]; }
    async readInterruptedAtQuit(): Promise<readonly string[]> { return (await this.#call('registry', 'readInterruptedAtQuit', [])) as string[]; }
    async writeWorkspaces(workspaces: readonly WorkspaceRecord[]): Promise<void> { await this.#call('registry', 'writeWorkspaces', [workspaces]); }
    async writeAgents(records: readonly AgentRecord[]): Promise<void> { await this.#call('registry', 'writeAgents', [records]); }
    async writeRunningAtQuit(ids: readonly string[]): Promise<void> { await this.#call('registry', 'writeRunningAtQuit', [ids]); }
    async writeInterruptedAtQuit(ids: readonly string[]): Promise<void> { await this.#call('registry', 'writeInterruptedAtQuit', [ids]); }
}

export interface StoreReplicas {
    readonly inbox: InboxReplica;
    readonly attention: AttentionReplica;
    readonly approvals: ApprovalsReplica;
    readonly knowledge: KnowledgeRemote;
    readonly settings: SettingsReplica;
    readonly drafts: DraftsRemote;
    /** A store method on the host, as the replicas call it. */
    readonly call: StoresCall;
    /** What the host's store dropped reading the registry's files. */
    registryDropped(): readonly string[];
    /** The registry's files were written (by any window, or the host): re-read them. */
    onRegistryChanged(listener: () => void): () => void;
    rebase(dump: StoresDump): void;
    apply(event: StoresEvent): void;
}

export function storeReplicas(call: StoresCall): StoreReplicas {
    const inbox = new InboxReplica(call);
    const attention = new AttentionReplica(call);
    const approvals = new ApprovalsReplica(call);
    const knowledge = new KnowledgeRemote(call);
    const settings = new SettingsReplica(call);
    const drafts = new DraftsRemote(call);
    let dropped: readonly string[] = [];
    const registryListeners = new Set<() => void>();
    return {
        inbox, attention, approvals, knowledge, settings, drafts, call,
        registryDropped: () => dropped,
        onRegistryChanged: (listener) => { registryListeners.add(listener); return () => { registryListeners.delete(listener); }; },
        rebase: (dump) => {
            inbox.rebase(dump.inbox); attention.rebase(dump.attention); approvals.rebase(dump.approvals);
            if (dump.settings) settings.rebase(dump.settings);
            dropped = dump.registryDropped ?? [];
            // A reconnect: what changed while the link was down is read again.
            for (const l of [...registryListeners]) l();
        },
        apply: (event) => {
            if (event.store === 'inbox') inbox.apply(event);
            else if (event.store === 'attention') attention.apply(event);
            else if (event.store === 'settings') settings.apply(event);
            else if (event.store === 'registry') { for (const l of [...registryListeners]) l(); }
            else approvals.rebase(event.view);
        },
    };
}

