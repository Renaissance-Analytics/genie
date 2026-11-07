import type { Caller, McpCall } from './mcp-tools.js';
import type { AgentStores } from './agent-stores-host.js';
import type { ApprovalQueue } from './approval-queue.js';
import type { AttentionStore } from './attention-store.js';
import type { InboxStore } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { SettingsStore } from './settings-store.js';

/**
 * WHAT THE WINDOW USES OF THE STORES AGENTS WRITE TO (the host split, P3.1). In engine mode these are the replicas of
 * genie-host's stores (agent-stores-replica.ts); on the emergency path they are the stores themselves. Compose, the Deck,
 * the snapshots and the person's actions are written against these, never against a store class, so either fits.
 */
export type InboxApi = Pick<InboxStore, 'onSend' | 'onRead' | 'involving' | 'all' | 'hasWritten' | 'unread' | 'unreadCount' | 'receipts' | 'send' | 'receive' | 'markDelivered' | 'recordDeliveryRefusal' | 'deleteThread' | 'attachmentForPerson'>;

export type AttentionApi = Pick<AttentionStore, 'pending' | 'finished' | 'allUserItems' | 'lastHandoff' | 'asked' | 'leftOutcome' | 'answer' | 'dismiss' | 'dismissMany' | 'dismissOlderThan' | 'markSeen' | 'onChange' | 'onLeave' | 'lists' | 'withdraw'>;

type MaybePromise<T> = T | Promise<T>;

export interface ApprovalsApi {
    deckItems: ApprovalQueue['deckItems'];
    autoApproved: ApprovalQueue['autoApproved'];
    lastCancelled: ApprovalQueue['lastCancelled'];
    onChange: ApprovalQueue['onChange'];
    /** The person's verdict. The host's queue answers later (true = there was such an item). */
    resolve(id: string, choice: 'allow' | 'deny'): MaybePromise<boolean>;
    /** A gated action asks the ONE queue (the host's in engine mode): a window tool's approval among them. */
    gate(caller: Caller, action: string, detail: string, call?: McpCall): Promise<'allowed' | 'denied'>;
}

/** The knowledge graph: read and written where it lives (a call across the link in engine mode). */
export interface KnowledgeApi {
    add(...a: Parameters<KnowledgeStore['add']>): MaybePromise<ReturnType<KnowledgeStore['add']>>;
    get(...a: Parameters<KnowledgeStore['get']>): MaybePromise<ReturnType<KnowledgeStore['get']>>;
    search(...a: Parameters<KnowledgeStore['search']>): MaybePromise<ReturnType<KnowledgeStore['search']>>;
    list(...a: Parameters<KnowledgeStore['list']>): MaybePromise<ReturnType<KnowledgeStore['list']>>;
    summaries(...a: Parameters<KnowledgeStore['summaries']>): MaybePromise<ReturnType<KnowledgeStore['summaries']>>;
}

/** The stores themselves: what a window that opened them (the emergency path) holds, and what genie-host holds. */
export type OwnAgentStores = AgentStores;

/** The settings as a window uses them (P3.2): reads synchronous (a replica), writes the host's, change listeners kept. */
export type SettingsApi = Pick<SettingsStore, 'get' | 'set' | 'setFor' | 'resetFor' | 'reset' | 'workspaceValues' | 'snapshotFor' | 'snapshot' | 'onChange'>;

export interface WindowAgentStores {
    /** Absent = this window opens the settings itself (the emergency path, and a window composed before P3.2). */
    readonly settings?: SettingsApi;
    readonly inbox: InboxApi;
    readonly attention: AttentionApi;
    readonly knowledge: KnowledgeApi;
    readonly approvals: ApprovalsApi;
}
