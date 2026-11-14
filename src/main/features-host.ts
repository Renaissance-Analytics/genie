import type { AgentRecord } from '../core/identity.js';
import type { Resolution } from '../core/inbox.js';
import type { CallContext } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { AttentionStore } from './attention-store.js';
import type { FlowsApi } from './flows-host.js';
import type { InboxStore } from './inbox-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { SettingsStore } from './settings-store.js';

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

/** Typed RED seam (Tynn #720): intentionally inert until the no-window tests are measured. */
export class HostFeatures {
    constructor(_ports: HostFeaturesPorts) {}
    async snapshot(_context: CallContext): Promise<FeatureData> { throw new Error('the host feature service is not ready'); }
    async act(_action: FeatureAction, _context: CallContext): Promise<FeatureData> { throw new Error('the host feature service is not ready'); }
    async soundData(_key: string): Promise<string | null> { throw new Error('the host feature service is not ready'); }
    onChange(_listener: (data: FeatureData) => void): () => void { return () => {}; }
    close(): void {}
}
