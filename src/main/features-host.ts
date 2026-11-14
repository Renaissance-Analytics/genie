import type { AgentRecord } from '../core/identity.js';
import { agentAddress } from '../core/inbox.js';
import { LatestPush } from '../core/latest-push.js';
import type { Resolution } from '../core/inbox.js';
import type { CallContext } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { AttentionStore } from './attention-store.js';
import type { FlowsApi } from './flows-host.js';
import type { InboxStore } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { SettingsStore } from './settings-store.js';
import { applyPersonalFeatureAction, customSoundData, personalFeatureSnapshot, type PersonalFeatureServices } from './feature-personal.js';
import type { FeatureState } from './feature-ipc.js';
import { REMOTE_ORIGIN } from './host-picks.js';

/** Owned business ports for the first feature group; no window composition or OS adapter. */
export interface HostFeaturesPorts {
    readonly settings: Pick<SettingsStore, 'snapshot' | 'get' | 'set' | 'reset' | 'onChange'>;
    readonly knowledge: Pick<KnowledgeStore, 'summaries' | 'search' | 'add' | 'get'>;
    readonly flows: FlowsApi;
    readonly inbox: Pick<InboxStore, 'all' | 'unread' | 'involving' | 'send' | 'receive' | 'attachmentForPerson' | 'deleteThread' | 'onSend' | 'onRead'>;
    readonly attention: Pick<AttentionStore, 'asked'>;
    readonly roster: () => readonly AgentRecord[];
    readonly resolveAddress: (address: string) => Resolution;
    readonly mailRefusal: (address: string) => string | null;
    readonly workspaceIds: () => readonly string[];
    readonly runFlow: (id: string) => Promise<unknown>;
    readonly refreshPlugins: () => Promise<void>;
    readonly applyRemote: () => Promise<void>;
}

const emptyState = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

/**
 * Incremental host aggregator (Tynn #720). Group one uses the owned stores and the window's shared business rules.
 * Production composition follows the remaining measured groups; this does not open another store or scheduler.
 */
export class HostFeatures {
    readonly #services: PersonalFeatureServices;
    readonly #callers = new Map<string, FeatureState>();
    readonly #listeners = new Set<(data: FeatureData) => void>();
    readonly #offs: Array<() => void>;
    readonly #push: LatestPush<FeatureData>;
    #seq = 0;
    #closed = false;

    constructor(readonly ports: HostFeaturesPorts) {
        this.#services = {
            settings: ports.settings, knowledge: ports.knowledge, flows: ports.flows, inbox: ports.inbox, attention: ports.attention,
            agentAddresses: () => ports.roster().map(record => ({ address: agentAddress(record, new Map()), agentId: record.id, name: record.name })),
            resolveAddress: address => ports.resolveAddress(address), mailRefusal: address => ports.mailRefusal(address),
            workspaceIds: () => ports.workspaceIds(), flowScheduler: { runNow: id => ports.runFlow(id) },
            pluginsRefresh: () => ports.refreshPlugins(),
        };
        // Invalidations carry facts, never a caller's query, form or action-only answer.
        this.#push = new LatestPush({ build: () => this.#snapshot(emptyState()), deliver: data => {
            if (!this.#closed) for (const listener of this.#listeners) listener(data);
        } });
        const changed = () => this.#changed();
        this.#offs = [ports.settings.onChange(changed), ports.flows.onChange(changed), ports.inbox.onSend(changed), ports.inbox.onRead(changed)];
    }

    async snapshot(context: CallContext): Promise<FeatureData> {
        this.#check(context);
        return this.#snapshot(this.#callers.get(context.connectionId) ?? emptyState());
    }

    async act(action: FeatureAction, context: CallContext): Promise<FeatureData> {
        this.#check(context);
        const state = this.#callers.get(context.connectionId) ?? emptyState();
        const next = { ...state };
        if (!await applyPersonalFeatureAction(this.#services, action, state, next,
            { remoteAccess: { apply: () => this.ports.applyRemote() } }, REMOTE_ORIGIN)) {
            throw new Error(`the host feature service does not answer ${action.kind} yet`);
        }
        const answer = await this.#snapshot(next);
        // These are replies to the action that requested them, never the next read or a broadcast.
        const { inboxThread: _thread, inboxSearch: _search, servedAttachment: _attachment,
            servedQuestion: _question, flowSaved: _saved, ...retained } = next;
        this.#callers.set(context.connectionId, retained);
        // Knowledge has no store change signal. The other owned stores already invalidate once per change.
        if (action.kind === 'knowledge.add' || action.kind === 'knowledge.create') this.#changed();
        return answer;
    }

    soundData(key: string): Promise<string | null> { return customSoundData(this.ports.settings, key); }

    onChange(listener: (data: FeatureData) => void): () => void {
        if (this.#closed) throw new Error('the host feature service is closed');
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    close(): void {
        this.#closed = true;
        for (const off of this.#offs.splice(0)) off();
        this.#listeners.clear(); this.#callers.clear();
    }

    #check(context: CallContext): void {
        if (this.#closed) throw new Error('the host feature service is closed');
        if (!context.connectionId) throw new Error('features need an admitted caller');
    }

    #changed(): void { if (!this.#closed && this.#listeners.size > 0) this.#push.request(); }

    async #snapshot(state: FeatureState): Promise<FeatureData> {
        const seq = ++this.#seq;
        return { seq, ...await personalFeatureSnapshot(this.#services, state), hosting: null, services: null, toolchain: null,
            browser: { url: null, routes: [], canGoBack: false, canGoForward: false },
            remote: null, integrations: null, plugins: null, issueWatch: null };
    }
}
