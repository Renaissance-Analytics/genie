import type { ToolStatus } from '../core/toolchain.js';
import type { GenRoute } from '../core/gen-router.js';
import type { Hit } from '../main/knowledge-store.js';
import type { FlowRecord } from '../main/flow-store.js';
import type { SiteInfo } from '../main/site-manager.js';
import type { ProcessStatus } from '../main/process-supervisor.js';
import type { InboxMessage } from '../main/inbox-store.js';

/**
 * WHAT THE FEATURE SURFACES RENDER FROM — the renderer's view of the stores, crossed over the
 * bridge. Every section is `null` until the bridge has answered, and the §5 rule holds: `null`
 * means "not asked yet" and draws a skeleton; `[]` means "asked, and there is nothing" and draws
 * the invitation. The two are different claims and never collapse into one.
 */

export interface FeatureData {
    readonly knowledge: { hits: readonly Hit[] | null; query: string };
    readonly flows: { flows: readonly FlowRecord[] } | null;
    readonly hosting: { sites: readonly SiteInfo[]; processes: readonly ProcessStatus[] } | null;
    readonly toolchain: { tools: readonly ToolStatus[]; checkedAt: number | null } | null;
    readonly inbox: { unread: readonly InboxMessage[]; peers: readonly { address: string; name: string; reachable: boolean }[] } | null;
    readonly settings: { values: Readonly<Record<string, boolean | string>> | null };
    readonly browser: { url: string | null; routes: readonly GenRoute[] };
}

/** First paint: nothing has been asked yet. */
export const EMPTY_FEATURES: FeatureData = {
    knowledge: { hits: null, query: '' },
    flows: null,
    hosting: null,
    toolchain: null,
    inbox: null,
    settings: { values: null },
    browser: { url: null, routes: [] },
};

/** The actions a feature surface can ask the main process for. Each is a request, never a mutation of renderer state. */
export type FeatureAction =
    | { kind: 'knowledge.search'; query: string }
    | { kind: 'flows.arm'; flowId: string }
    | { kind: 'flows.disarm'; flowId: string }
    | { kind: 'flows.remove'; flowId: string }
    | { kind: 'flows.add' }
    | { kind: 'hosting.addSite' }
    | { kind: 'hosting.stopSite'; siteId: string }
    | { kind: 'hosting.removeSite'; siteId: string }
    | { kind: 'hosting.restartProcess'; processId: string }
    | { kind: 'hosting.stopProcess'; processId: string }
    | { kind: 'toolchain.check' }
    | { kind: 'toolchain.update'; tool: string }
    | { kind: 'inbox.send'; to: string; text: string }
    | { kind: 'inbox.markRead'; messageId: string }
    | { kind: 'settings.set'; key: string; value: boolean | string }
    | { kind: 'settings.reset'; key: string }
    | { kind: 'browser.navigate'; url: string };
