import type { FlowForm, KnowledgeForm, Problem, ServiceForm, SiteForm, SiteFormDefaults } from '../core/forms.js';
import type { ServiceInstance } from '../core/services.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { DeckItem } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import type { MemoryClass, Scope } from '../main/knowledge-store.js';
import type { Hit } from '../main/knowledge-store.js';
import type { FlowRecord } from '../main/flow-store.js';
import type { SiteInfo } from '../main/site-manager.js';
import type { FrontDoorStatus } from '../main/compose.js';
import type { ShareLink } from '../core/remote.js';
import type { AnnotatedRow, GithubAppStatus, SyncResult } from '../core/integrations.js';
import type { PluginEntry } from '../main/plugin-host.js';
import type { Device } from '../main/remote-devices.js';

export type { FrontDoorStatus };
import type { ProcessStatus } from '../main/process-supervisor.js';
import type { InboxMessage } from '../main/inbox-store.js';

/**
 * WHAT THE FEATURE SURFACES RENDER FROM — the renderer's view of the stores, crossed over the
 * bridge. Every section is `null` until the bridge has answered, and the §5 rule holds: `null`
 * means "not asked yet" and draws a skeleton; `[]` means "asked, and there is nothing" and draws
 * the invitation. The two are different claims and never collapse into one.
 */

/** An Add-a-site form open in the Hosting surface: defaults read from the repo, problems from the last refused submit. */
export interface SiteAdding {
    readonly workspaceId: string;
    readonly repoPath: string;
    readonly defaults: SiteFormDefaults;
    readonly problems: readonly Problem[];
}

/** An Add-a-flow form open in the Flows surface. */
export interface FlowAdding {
    readonly defaults: FlowForm;
    readonly problems: readonly Problem[];
}

/** An Add-an-engine form open in the Services tab. `consent` is the driver's answer when the image is not here: the person pulls it, or cancels. */
export interface ServiceAdding {
    readonly workspaceId: string;
    readonly defaults: ServiceForm;
    readonly problems: readonly Problem[];
    readonly consent: { image: string; note: string; form: ServiceForm } | null;
}

export type ServiceStatus = 'running' | 'exited' | 'absent';

/** One engine instance with its status as Docker reported it on this snapshot — never remembered. */
export interface ServiceView {
    readonly instance: ServiceInstance;
    readonly status: ServiceStatus;
}

/** An Add-a-memory form open in the Knowledge surface. */
export interface KnowledgeAdding {
    readonly defaults: KnowledgeForm;
    readonly problems: readonly Problem[];
}

/** What the last add did: the node, and every `[[wikilink]]` that did not resolve, with why. */
export interface KnowledgeAdded {
    readonly id: string;
    readonly title: string;
    readonly unresolved: readonly { ref: string; reason: 'ambiguous' | 'missing' }[];
}

/** Remote access (§6.8) as the host sees it. `servedLink` is in the answer to a mint ONLY — never in a pushed snapshot. */
export interface RemoteSection {
    readonly host: string;
    readonly url: string | null;
    /** Why `url` is null, in the listener's own words; `null` while something listens. */
    readonly unavailable: string | null;
    readonly locked: boolean;
    readonly pin: { code: string; expiresAt: number } | null;
    readonly devices: readonly Device[];
    readonly shares: readonly ShareLink[];
    readonly connections: readonly { id: string; label: string; isOwner: boolean; workspaceId: string | null; driving: boolean }[];
    readonly servedLink: { id: string; url: string } | null;
}

/** §6.9 as the Settings surface sees it. `lastSync` is the most recent config sync's four results. */
export interface IntegrationsSection {
    readonly tynnSignedIn: boolean;
    readonly github: GithubAppStatus;
    readonly gated: readonly AnnotatedRow[];
    readonly lastSync: { workspaceId: string; results: readonly SyncResult[] } | null;
}

/** §6.7 as Settings sees it: every plugin folder with its state and reason, and whether developer mode admits unsigned ones. */
export interface PluginsSection {
    readonly dir: string;
    readonly developerMode: boolean;
    readonly entries: readonly PluginEntry[];
}

export interface FeatureData {
    readonly knowledge: { hits: readonly Hit[] | null; query: string; adding: KnowledgeAdding | null; lastAdd: KnowledgeAdded | null };
    readonly flows: { flows: readonly FlowRecord[]; adding: FlowAdding | null } | null;
    readonly hosting: { sites: readonly SiteInfo[]; processes: readonly ProcessStatus[]; adding: SiteAdding | null; frontDoor: FrontDoorStatus } | null;
    readonly services: { instances: readonly ServiceView[]; adding: ServiceAdding | null } | null;
    readonly toolchain: { tools: readonly ToolStatus[]; checkedAt: number | null } | null;
    readonly inbox: { unread: readonly InboxMessage[]; peers: readonly { address: string; name: string; reachable: boolean }[] } | null;
    readonly settings: { values: Readonly<Record<string, boolean | string>> | null };
    readonly browser: { url: string | null; routes: readonly GenRoute[] };
    readonly remote: RemoteSection | null;
    readonly integrations: IntegrationsSection | null;
    readonly plugins: PluginsSection | null;
}

/** First paint: nothing has been asked yet. */
export const EMPTY_FEATURES: FeatureData = {
    knowledge: { hits: null, query: '', adding: null, lastAdd: null },
    flows: null,
    hosting: null,
    services: null,
    toolchain: null,
    inbox: null,
    settings: { values: null },
    browser: { url: null, routes: [] },
    remote: null,
    integrations: null,
    plugins: null,
};

/** The actions a feature surface can ask the main process for. Each is a request, never a mutation of renderer state. */
export type FeatureAction =
    | { kind: 'knowledge.search'; query: string }
    | { kind: 'knowledge.openAdd'; workspaceId?: string }
    | { kind: 'knowledge.cancelForm' }
    /** The Add-a-memory form, submitted as the USER. Validated in main; the add's unresolved links are reported back. */
    | { kind: 'knowledge.create'; form: KnowledgeForm }
    | { kind: 'flows.arm'; flowId: string }
    | { kind: 'flows.disarm'; flowId: string }
    | { kind: 'flows.remove'; flowId: string }
    | { kind: 'flows.add'; workspaceId: string }
    | { kind: 'flows.cancelForm' }
    /** The Add-a-flow form, submitted as the USER (so `armed` is honoured). */
    | { kind: 'flows.create'; form: FlowForm }
    | { kind: 'hosting.addSite'; workspaceId: string; repoPath: string }
    | { kind: 'hosting.cancelForm' }
    /** The Add-a-site form, submitted. Validated in main; a refusal names every problem. */
    | { kind: 'hosting.createSite'; workspaceId: string; repoPath: string; form: SiteForm }
    /** One OS prompt: install Genie's local root so browsers accept https://<name>.gen. */
    | { kind: 'hosting.trustCertificate' }
    /** Try the hosts block again after a declined prompt. */
    | { kind: 'hosting.syncHosts' }
    | { kind: 'hosting.stopSite'; siteId: string }
    | { kind: 'hosting.removeSite'; siteId: string }
    | { kind: 'hosting.restartProcess'; processId: string }
    | { kind: 'hosting.stopProcess'; processId: string }
    | { kind: 'services.add'; workspaceId: string }
    | { kind: 'services.cancelForm' }
    /** The Add-an-engine form, submitted. `consent: true` is the person's answer to the pull question. */
    | { kind: 'services.create'; form: ServiceForm; consent: boolean }
    /** The warning is on the row before this is sent (core/services.ts says it). */
    | { kind: 'services.setActive'; workspaceId: string; engine: string; version: string }
    | { kind: 'services.start'; serviceId: string }
    | { kind: 'services.stop'; serviceId: string }
    | { kind: 'services.remove'; serviceId: string; deleteData: boolean }
    | { kind: 'toolchain.check'; force?: boolean }
    | { kind: 'toolchain.update'; tool: string }
    /** An inline answer on a Deck item (the Deck resolves; core/deck-resolve.ts says what it means). */
    | { kind: 'deck.answer'; item: DeckItem; optionId: string }
    /** The person adds a memory. */
    | { kind: 'knowledge.add'; title: string; body: string; class?: MemoryClass; scope: Scope; tags?: string[] }
    /** Attachments are host paths from the host's own picker; the store keeps BYTE COPIES, never the path. */
    | { kind: 'inbox.send'; to: string; text: string; attachments?: readonly string[] }
    | { kind: 'inbox.markRead'; messageId: string }
    | { kind: 'settings.set'; key: string; value: boolean | string }
    | { kind: 'settings.reset'; key: string }
    | { kind: 'browser.navigate'; url: string }
    | { kind: 'remote.issuePin' }
    | { kind: 'remote.revokeDevice'; deviceId: string }
    | { kind: 'remote.lock' }
    | { kind: 'remote.unlock' }
    /** Mint a share link for one workspace. Its URL comes back in THIS answer only. */
    | { kind: 'remote.mintShare'; workspaceId: string; grantedTo: string; expiresInMs: number }
    | { kind: 'remote.revokeShare'; shareId: string }
    /** Sign in to Tynn with a token; an empty token signs out. */
    | { kind: 'integrations.tynnToken'; token: string }
    /** The person confirms a GitHub App step they did in the browser; install needs authorize first. */
    | { kind: 'integrations.githubConfirm'; step: 'authorize' | 'install' }
    | { kind: 'integrations.syncConfig'; workspaceId: string; workspacePath: string }
    /** Enable or disable an installable plugin; refused (unchanged list) for one that is not. */
    | { kind: 'plugins.setEnabled'; id: string; enabled: boolean };
