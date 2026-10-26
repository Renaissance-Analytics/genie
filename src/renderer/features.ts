import type { TailscaleStatus } from '../main/tailscale-cli.js';
import type { IssueWatchPanelView } from '../core/issue-watch.js';
import type { AgentFilesReport } from '../core/agent-files-health.js';
import type { FlowForm, KnowledgeForm, Problem, ServiceForm, SiteForm, SiteFormDefaults } from '../core/forms.js';
import type { ServiceInstance } from '../core/services.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { RepairFinding } from '../core/toolchain-repair.js';
import type { DeckItem } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import type { MemoryClass, Scope } from '../main/knowledge-store.js';
import type { Hit } from '../main/knowledge-store.js';
import type { FlowRecord } from '../main/flow-store.js';
import type { SiteInfo } from '../main/site-manager.js';
import type { GoVersionsView } from '../main/go-versions.js';
import type { PythonVersionsView } from '../main/python-versions.js';
import type { DotnetVersionsView } from '../main/dotnet-versions.js';
import type { RustVersionsView } from '../main/rust-versions.js';
import type { RubyVersionsView } from '../main/ruby-versions.js';
import type { JavaVersionsView } from '../main/java-versions.js';
import type { NodeVersionsView } from '../main/node-versions.js';
import type { PhpVersionsView } from '../main/php-versions.js';
import type { SiteProcessLog } from '../main/hosting-actions.js';
import type { FrontDoorStatus } from '../main/compose.js';
import type { ShareLink } from '../core/remote.js';
import type { AnnotatedRow, SyncResult } from '../core/integrations.js';
import type { GithubView } from '../core/github.js';
import type { PluginEntry } from '../main/plugin-host.js';
import type { Device } from '../main/remote-devices.js';

export type { FrontDoorStatus };
import type { HostedProcess } from '../main/process-book.js';
import type { RestartPolicy } from '../main/process-supervisor.js';
import type { InboxMessage } from '../main/inbox-store.js';
import type { ThreadSummary } from '../core/inbox-threads.js';

/**
 * The AgentInbox (beta.33 item 19): the person's unread mail, who can be written to, the person's own conversation
 * (`recent`, an observed agent's chat), every thread (core/inbox-threads.ts), and the mail agents have not collected.
 * `thread` and `servedAttachment` are in the ANSWER to the action that asked for them only — never in a pushed snapshot.
 */
export interface InboxSection {
    readonly unread: readonly InboxMessage[];
    readonly peers: readonly { address: string; agentId?: string | undefined; name: string; reachable: boolean }[];
    readonly recent: readonly InboxMessage[];
    readonly threads?: readonly ThreadSummary[] | undefined;
    /** Mail every agent has not collected (Genie 1's lag badge). */
    readonly uncollected?: number | undefined;
    readonly thread?: InboxThreadView | null | undefined;
    readonly servedAttachment?: { id: string; name: string; base64: string } | null | undefined;
}

/** One thread's history as the `inbox.thread` action answers it: the newest `limit`, and whether older ones exist. */
export interface InboxThreadView {
    readonly key: string;
    readonly messages: readonly InboxMessage[];
    readonly more: boolean;
    readonly limit: number;
    /** The message the thread was opened on (a chat's mail row), when it was. */
    readonly focus: string | null;
}

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
    /** The PHP versions Genie manages here, newest first — the form's PHP version choices (php sites; empty = PATH PHP only). */
    readonly phpVersions?: readonly string[];
}

/** An Edit-a-site form open in the Hosting surface: the site as it is declared now, problems from the last refused save. */
export interface SiteEditing {
    readonly siteId: string;
    readonly host: string;
    readonly defaults: SiteForm;
    readonly problems: readonly Problem[];
    /** The PHP versions Genie manages here, as Add offers them — so an Edit shows the site's pin and never drops it. */
    readonly phpVersions?: readonly string[];
}

/** A site row: the site, and the end of each of its processes' output (the supervisor's tail — there after a crash). */
export type HostedSite = SiteInfo & { readonly logs?: readonly SiteProcessLog[] };

/** What the canvas's save did (genie#1204): stored — disarmed if it changed what an armed flow does — or refused, on the nodes. */
export type FlowSaved =
    | { readonly ok: true; readonly flowId: string; readonly disarmed: boolean }
    | { readonly ok: false; readonly problems: readonly import('../core/flow-canvas.js').FlowProblem[] };

/** An Add-a-flow form open in the Flows surface. */
export interface FlowAdding {
    readonly defaults: FlowForm;
    readonly problems: readonly Problem[];
    /** Set when the form EDITS this flow (flows.save), absent when it adds one (flows.create). */
    readonly flowId?: string;
}

/** An Add-an-engine form open in the Services tab. `consent` is the driver's answer when the image is not here: the person pulls it, or cancels. */
export interface ServiceAdding {
    readonly workspaceId: string;
    readonly defaults: ServiceForm;
    readonly problems: readonly Problem[];
    readonly consent: { image: string; note: string; form: ServiceForm } | null;
}

/** Docker's state for the container, or `docker-not-running` when Docker itself is not there to ask (never read as `absent`). */
export type ServiceStatus = 'running' | 'exited' | 'absent' | 'docker-not-running';

/** The end of one engine's own output, as `docker logs --tail` gave it when the person asked (H6). */
export interface ServiceLogs {
    readonly serviceId: string;
    readonly text: string;
    /** How many lines were asked of Docker (bounded): fewer came back if the engine has written fewer. */
    readonly tail: number;
}

/** One engine instance with its status as Docker reported it on this snapshot — never remembered. */
export interface ServiceView {
    readonly instance: ServiceInstance;
    readonly status: ServiceStatus;
    /** Only with `docker-not-running`: Docker's own reason (the daemon is down, or Docker is not installed). */
    readonly note?: string;
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
    /** The `remote_access` switch (Tynn #820): off = nothing listens, whatever Tailscale says. */
    readonly enabled: boolean;
    /** Windows: the firewall rule can be added here (Genie 1's allowFirewall). */
    readonly firewall: boolean;
    /** What the last Allow through the firewall did, in words; absent = not tried. */
    readonly firewallOutcome?: string | null | undefined;
    /** Where Tailscale stands on this machine (main/tailscale-cli.ts, Tynn #821); absent/`null` = not read yet. */
    readonly tailscale?: TailscaleStatus | null | undefined;
    /** What the last Connect or Install did, in words; absent = not tried. */
    readonly tailscaleOutcome?: string | null | undefined;
    /** This machine on the Tynn network (main/workstation-identity.ts, Tynn #836); absent/`null` = not read yet. */
    readonly tynnWorkstation?: TynnWorkstationState | null | undefined;
}

/** This machine on the Tynn relay as a host (main/tynn-network.ts, Tynn #838). */
export type TynnRelayState =
    | { readonly state: 'off' }
    | { readonly state: 'connecting' }
    | { readonly state: 'reachable'; readonly relay: string }
    | { readonly state: 'unavailable'; readonly reason: string };

/** Whether this machine is registered with Tynn as a workstation, and with which Tynn; or why not. */
export type TynnWorkstationState =
    | { readonly registered: true; readonly host: string; readonly workstationId: string; readonly relay?: TynnRelayState | undefined }
    | { readonly registered: false; readonly reason: string };

/** §6.9 as the Settings surface sees it. `lastSync` is the most recent config sync's four results. */
export interface IntegrationsSection {
    readonly tynnSignedIn: boolean;
    /** This Genie's Tynn account: where, who (null signed out), the sign-in link kept on screen, and Tynn's last word. */
    readonly tynn: { readonly host: string; readonly user: { readonly name: string; readonly email: string } | null; readonly signInUrl: string | null; readonly message: string | null };
    /** GitHub as this Genie's sign-in read it from GitHub (main/github-account.ts): never the token. */
    readonly github: GithubView;
    readonly gated: readonly AnnotatedRow[];
    readonly lastSync: { workspaceId: string; results: readonly SyncResult[] } | null;
    /** Genie's own MCP server (§6.9): where it listens, and whether a real server/discover answered at boot (§6.4). */
    readonly mcp: { url: string | null; verified: { ok: true; versions: readonly string[] } | { ok: false; reason: string } | null; tools?: readonly { name: string; description: string }[] };
    /** What the sync last did to each workspace's agent files: current, upgraded, or failed (absent before the first sync). */
    readonly agentFiles?: readonly AgentFilesReport[];
}

/** §6.7 as Settings sees it: every plugin folder with its state and reason, and whether developer mode admits unsigned ones. */
import type { PluginPanelView } from './components/PluginPane.js';
import type { ClaimingEditor } from '../core/plugin-editors.js';

export interface PluginsSection {
    readonly dir: string;
    readonly developerMode: boolean;
    readonly entries: readonly PluginEntry[];
    /** The panels ENABLED plugins contribute (§6.7), with their plugin's name — what `+plugin` offers. */
    readonly panels: readonly PluginPanelView[];
    /** The editors ENABLED plugins declare (beta.33 item 14): a file whose type one claims opens in it, in the file panel. */
    readonly editors?: readonly ClaimingEditor[];
}

/** How a MISSING tool would be installed here — the exact command, shown before anything runs — or why it cannot be. */
export type InstallPreview = { readonly label: string; readonly elevated: boolean } | { readonly refused: string };

/**
 * The Toolchain surface. `tools`/`checkedAt` are the scan; the rest appear only once there is something to say: how each
 * missing tool would be installed, what is running right now (`busy`), the last Check and repair's findings with each
 * one's measured result, an update that needs the person's go-ahead (`warning`), and the last action's outcome.
 */
/**
 * A toolchain action that was REFUSED (the update guard naming who is busy, consent missing) or ran and did not take
 * (an install that still does not answer, an update the re-probe shows unchanged), with the reason verbatim. It is
 * drawn on the row it was for — a PHP version's in PHP versions — and cleared by the next action for that row.
 */
export interface ToolchainRefusal {
    readonly tool: string;
    /** A Genie-managed PHP version's action (install/remove PHP x.y.z); absent for a tool row. */
    readonly version?: string;
    readonly reason: string;
}

export interface ToolchainSection {
    readonly tools: readonly ToolStatus[];
    readonly checkedAt: number | null;
    readonly installs?: Readonly<Record<string, InstallPreview>>;
    readonly busy?: string;
    readonly findings?: readonly RepairFinding[];
    readonly repairedAt?: number;
    readonly warning?: { readonly tool: string; readonly reason: string; readonly affected: readonly string[] };
    readonly result?: string;
    /** Each refused or failed action, one per row, until that row's next action. Absent when there is none. */
    readonly refusals?: readonly ToolchainRefusal[];
    /** T4: Genie-managed PHP versions (with the sites pinned to each), the PATH PHP, and what can be installed. */
    readonly php?: PhpVersionsView;
    /** Genie's own Node versions, the PATH node, and what can be installed. */
    readonly node?: NodeVersionsView;
    /** Genie's own Go versions, the PATH go, and what can be installed. */
    readonly go?: GoVersionsView;
    /** Genie's own Python versions (Windows; TC4a), the PATH python, and what can be installed — or why not here. */
    readonly python?: PythonVersionsView;
    /** Genie's own .NET SDKs (TC6a), the dotnet on PATH, and what can be installed. */
    readonly dotnet?: DotnetVersionsView;
    /** Genie's own Rust versions (TC6b), the rustc on PATH, and what can be installed — or why not here. */
    readonly rust?: RustVersionsView;
    /** Genie's own Ruby versions (TC6c), the ruby on PATH, and what can be installed — or why not here. */
    readonly ruby?: RubyVersionsView;
    /** Genie's own Java (TC6d, Temurin), the java on PATH, and each LTS line's release here — or why not. */
    readonly java?: JavaVersionsView;
    /** Each language's default version (`null` = the system's own), read from Genie's `current/<lang>` links. */
    readonly defaults?: Readonly<Record<'node' | 'go' | 'php' | 'python' | 'dotnet' | 'rust' | 'ruby' | 'java', string | null>>;
    /** The machine's own PATH: whether Genie's defaults are on it, where, and exactly what would change (plan TC3b). */
    readonly machinePath?: { readonly applied: boolean; readonly where: readonly string[]; readonly entries: readonly string[]; readonly targets: readonly string[] };
}

export interface FeatureData {
    readonly knowledge: { hits: readonly Hit[] | null; query: string; adding: KnowledgeAdding | null; lastAdd: KnowledgeAdded | null };
    /**
     * `saved`: what the canvas's last `flows.saveGraph` did (genie#1204) — served in the answer to that action only, never
     * in a pushed snapshot: the flow it saved (and whether the save disarmed it), or the problems, each on its node.
     */
    readonly flows: { flows: readonly FlowRecord[]; adding: FlowAdding | null; saved?: FlowSaved | null } | null;
    readonly hosting: { sites: readonly HostedSite[]; processes: readonly HostedProcess[]; adding: SiteAdding | null; editing?: SiteEditing | null; frontDoor: FrontDoorStatus } | null;
    /** `logs`: the one engine log the person opened, or null/absent when none is open. */
    readonly services: { instances: readonly ServiceView[]; adding: ServiceAdding | null; logs?: ServiceLogs | null; updating?: { serviceId: string; image: string; note: string; dependents: readonly string[] } | null } | null;
    readonly toolchain: ToolchainSection | null;
    readonly inbox: InboxSection | null;
    readonly settings: { values: Readonly<Record<string, boolean | string>> | null };
    /** The Genie Browser: the page it shows (each .gen site at its own https origin), this machine's sites, and its history. */
    readonly browser: { url: string | null; routes: readonly GenRoute[]; canGoBack: boolean; canGoForward: boolean };
    readonly remote: RemoteSection | null;
    readonly integrations: IntegrationsSection | null;
    readonly plugins: PluginsSection | null;
    /** IssueWatch's view per workspace id (Tynn #806), pushed by main; `null` until main reports. */
    readonly issueWatch: Readonly<Record<string, IssueWatchPanelView>> | null;
    /** What's New for the running version, once (Tynn #762); `null`/absent = nothing to show. */
    readonly whatsNew?: { version: string; notes: string } | null;
    /** The running version (Tynn #763: the header shows it); absent/`null` = not known yet. */
    readonly version?: string | null;
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
    browser: { url: null, routes: [], canGoBack: false, canGoForward: false },
    remote: null,
    integrations: null,
    plugins: null,
    issueWatch: null,
};

/** The actions a feature surface can ask the main process for. Each is a request, never a mutation of renderer state. */
export type FeatureAction =
    /** The GitHub panel's Refresh: Tynn reads this workspace's repos now. */
    | { kind: 'issueWatch.refresh'; workspaceId: string }
    /** One repo's IssueWatch switch in Tynn (watch it; include a fork's upstream) — one field at a time. */
    | { kind: 'issueWatch.setRepo'; workspaceId: string; owner: string; repo: string; enabled?: boolean; includeUpstream?: boolean }
    | { kind: 'whatsNew.show' }
    | { kind: 'whatsNew.close'; version: string }
    | { kind: 'knowledge.search'; query: string }
    | { kind: 'knowledge.openAdd'; workspaceId?: string }
    | { kind: 'knowledge.cancelForm' }
    /** The Add-a-memory form, submitted as the USER. Validated in main; the add's unresolved links are reported back. */
    | { kind: 'knowledge.create'; form: KnowledgeForm }
    | { kind: 'flows.arm'; flowId: string }
    | { kind: 'flows.disarm'; flowId: string }
    | { kind: 'flows.remove'; flowId: string }
    /** The person's Run now: one run of the flow, armed or not; its outcome lands in the flow's run history. */
    | { kind: 'flows.runNow'; flowId: string }
    | { kind: 'flows.add'; workspaceId: string }
    | { kind: 'flows.cancelForm' }
    /** The Add-a-flow form, submitted as the USER (so `armed` is honoured). */
    | { kind: 'flows.create'; form: FlowForm }
    /** Open the form on an existing flow; save it in place (genie#1204). */
    | { kind: 'flows.edit'; flowId: string }
    | { kind: 'flows.save'; flowId: string; form: FlowForm }
    /** THE CANVAS (genie#1204): open a flow, or a new one in a workspace, in the flow editor's own window. */
    | { kind: 'flows.openEditor'; flowId: string }
    | { kind: 'flows.newFlow'; workspaceId: string }
    /** The canvas's Save, as the USER: create (`flowId` absent, always disarmed) or update in place. Answered in `flows.saved`. */
    | { kind: 'flows.saveGraph'; flowId?: string; workspaceId: string; name: string; document: unknown }
    | { kind: 'hosting.addSite'; workspaceId: string; repoPath: string }
    | { kind: 'hosting.cancelForm' }
    /** The Add-a-site form, submitted. Validated in main; a refusal names every problem. */
    | { kind: 'hosting.createSite'; workspaceId: string; repoPath: string; form: SiteForm }
    /** One OS prompt: install Genie's local root so browsers accept https://<name>.gen. */
    | { kind: 'hosting.trustCertificate' }
    /** Try the hosts block again after a declined prompt. */
    | { kind: 'hosting.syncHosts' }
    | { kind: 'hosting.retryFrontDoor' }
    | { kind: 'hosting.startSite'; siteId: string }
    | { kind: 'hosting.stopSite'; siteId: string }
    | { kind: 'hosting.removeSite'; siteId: string }
    /** Stopped and started again, as Start starts it; a remembered Stop is lifted. */
    | { kind: 'hosting.restartSite'; siteId: string }
    /** Open it in Genie's browser (the browser surface shows it). */
    | { kind: 'hosting.openSite'; siteId: string }
    /** Open the Edit form for a site, prefilled with how it is declared now. `hosting.cancelForm` closes it. */
    | { kind: 'hosting.editSite'; siteId: string }
    /** The Edit form, submitted: the Add form's validation, then written back to the workspace's project.json. */
    | { kind: 'hosting.updateSite'; siteId: string; form: SiteForm }
    | { kind: 'hosting.restartProcess'; processId: string }
    | { kind: 'hosting.stopProcess'; processId: string }
    /** Add a background process the person keeps (§6.6): started now, written down, brought back on launch. */
    | { kind: 'hosting.createProcess'; workspaceId: string; workspacePath: string; name: string; command: string; folder?: string; restart: RestartPolicy }
    /** Start a kept process the person stopped; the start is written down too. */
    | { kind: 'hosting.startProcess'; processId: string }
    | { kind: 'hosting.removeProcess'; processId: string }
    | { kind: 'services.add'; workspaceId: string }
    | { kind: 'services.cancelForm' }
    /** The Add-an-engine form, submitted. `consent: true` is the person's answer to the pull question. */
    | { kind: 'services.create'; form: ServiceForm; consent: boolean }
    /** The warning is on the row before this is sent (core/services.ts says it). */
    | { kind: 'services.setActive'; workspaceId: string; engine: string; version: string }
    /** This engine is the one of its kind the workspace uses (attaching a detached shared one again) — by id, never by version. */
    | { kind: 'services.use'; workspaceId: string; serviceId: string }
    /** This SHARED engine stops giving the workspace its env; its slice and data stay. */
    | { kind: 'services.detach'; workspaceId: string; serviceId: string }
    | { kind: 'services.start'; serviceId: string }
    | { kind: 'services.stop'; serviceId: string }
    | { kind: 'services.update'; serviceId: string; consent?: boolean; confirmed?: boolean }
    | { kind: 'services.cancelUpdate' }
    /**
     * `deleteData` acts for `workspaceId` — the engine's sole data holder, which the row sends (core/service-tenancy.ts
     * `soleHolderOf`); main refuses it, naming them, while any OTHER workspace keeps data in the engine.
     */
    | { kind: 'services.remove'; serviceId: string; deleteData: boolean; workspaceId?: string }
    /** Read the end of an engine's output (`docker logs`, bounded); it stays open until `services.hideLogs`. */
    | { kind: 'services.logs'; serviceId: string; tail?: number }
    | { kind: 'services.hideLogs' }
    | { kind: 'toolchain.check'; force?: boolean }
    /** `confirmed`: the person read the warning (Docker's restart) and chose to go ahead. A REFUSAL is never confirmable. */
    | { kind: 'toolchain.update'; tool: string; confirmed?: boolean }
    /** Install a missing tool (or the Windows VC++ runtime). `consent` is the person's click on the command shown. */
    | { kind: 'toolchain.install'; tool: string; consent: boolean }
    | { kind: 'toolchain.repair' }
    /** Install one managed PHP version (windows.php.net, checksum-verified). `consent` is the person's click. */
    | { kind: 'toolchain.installPhp'; version: string; consent: boolean }
    /** Remove a managed PHP version — refused while a site is pinned to it. */
    | { kind: 'toolchain.removePhp'; version: string }
    /** Install one Genie-managed Node version (nodejs.org, checksum-verified). `consent` is the person's click. */
    | { kind: 'toolchain.installNode'; version: string; consent: boolean }
    | { kind: 'toolchain.removeNode'; version: string }
    /** Install one Genie-managed Go version (go.dev, checksum-verified). `consent` is the person's click. */
    | { kind: 'toolchain.installGo'; version: string; consent: boolean }
    | { kind: 'toolchain.removeGo'; version: string }
    /** Install one Genie-managed Python version (python.org, checksum-verified). `consent` is the person's click. */
    | { kind: 'toolchain.installPython'; version: string; consent: boolean }
    | { kind: 'toolchain.removePython'; version: string }
    /** Install one Genie-managed .NET SDK (Microsoft, sha512-verified). `consent` is the person's click. */
    | { kind: 'toolchain.installDotnet'; version: string; consent: boolean }
    | { kind: 'toolchain.removeDotnet'; version: string }
    /** Install one Genie-managed Rust version (rustup as the downloader). `consent` is the person's click. */
    | { kind: 'toolchain.installRust'; version: string; consent: boolean }
    | { kind: 'toolchain.removeRust'; version: string }
    /** Install one Genie-managed Ruby version (built from ruby-lang.org's source). `consent` is the person's click. */
    | { kind: 'toolchain.installRuby'; version: string; consent: boolean }
    | { kind: 'toolchain.removeRuby'; version: string }
    /** Install one Genie-managed JDK (Temurin, sha256-verified). `consent` is the person's click. */
    | { kind: 'toolchain.installJava'; version: string; consent: boolean }
    | { kind: 'toolchain.removeJava'; version: string }
    /** Make a managed version a language's default, or `null` for the system's own (plan TC3a). */
    | { kind: 'toolchain.setDefault'; lang: 'node' | 'go' | 'php' | 'python' | 'dotnet' | 'rust' | 'ruby' | 'java'; version: string | null }
    /** Put Genie's defaults on the machine's own PATH (`apply`, with `consent`), or take them off (Undo). */
    | { kind: 'toolchain.machinePath'; apply: boolean; consent?: boolean }
    /** An inline answer on a Deck item (the Deck resolves; core/deck-resolve.ts says what it means). */
    /** `note`: the person's words with the answer (beta.33 item 16), delivered to the asking agent. */
    | { kind: 'deck.answer'; item: DeckItem; optionId: string; note?: string }
    /**
     * A multi-part question answered IN PLACE (§4.5): one array of labels per question and one note per question (a note
     * alone answers its question). `note` is the overall note — '' from the form, which no longer shows one.
     */
    | { kind: 'deck.answerForm'; item: DeckItem; selections: string[][]; notes: string[]; note: string }
    /**
     * Dismiss an agent's question WITHOUT an answer (Deck or question window): it leaves both, and the agent is told —
     * with the person's notes, one per question as the form holds them ('' where none; absent = no notes).
     */
    | { kind: 'deck.dismiss'; item: DeckItem; notes?: string[] }
    /** "Dismiss all stale": exactly the questions the person SAW marked stale; main dismisses those still stale. */
    | { kind: 'deck.dismissStale'; ids: string[] }
    /** "Dismiss all older than 1 day": every agent question asked longer ago than this, each agent told. */
    | { kind: 'deck.dismissOlder'; olderThanMs: number }
    /** The person adds a memory. */
    | { kind: 'knowledge.add'; title: string; body: string; class?: MemoryClass; scope: Scope; tags?: string[] }
    /** Attachments are host paths from the host's own picker; the store keeps BYTE COPIES, never the path. */
    | { kind: 'inbox.send'; to: string; text: string; attachments?: readonly string[] }
    | { kind: 'inbox.markRead'; messageId: string }
    /** A thread's history, by its key or by a message in it; answered in `inbox.thread`, never pushed. */
    | { kind: 'inbox.thread'; key?: string; messageId?: string; limit: number }
    | { kind: 'inbox.markAllRead' }
    /** An attachment's bytes for the person, answered once in `inbox.servedAttachment`. */
    | { kind: 'inbox.attachment'; attachmentId: string }
    | { kind: 'inbox.deleteThread'; key: string }
    | { kind: 'settings.set'; key: string; value: boolean | string }
    /** Pick your own sound file for an alert (Tynn #766 B2): the host's picker; the alert is set to Custom file. */
    | { kind: 'settings.setSoundFile'; key: string; path: string }
    | { kind: 'settings.reset'; key: string }
    | { kind: 'browser.navigate'; url: string }
    /** The Genie Browser's history and reload — the view's own (main applies them to the pane). */
    | { kind: 'browser.back' }
    | { kind: 'browser.forward' }
    | { kind: 'browser.reload' }
    | { kind: 'remote.issuePin' }
    | { kind: 'remote.revokeDevice'; deviceId: string }
    | { kind: 'remote.lock' }
    | { kind: 'remote.unlock' }
    /** Stop and start the listener (Genie 1's restart). */
    | { kind: 'remote.restart' }
    /** Windows: add the tailnet-scoped inbound rule for the port, one UAC prompt (Genie 1's allowFirewall). */
    | { kind: 'remote.allowFirewall' }
    /** Bring this machine onto the tailnet (`tailscale up`); a sign-in link opens in the browser (Genie 1's tailscale.up). */
    | { kind: 'tailscale.up' }
    /** Install Tailscale: its own signed installer on Windows, its download page elsewhere (Genie 1's tailscale.install). */
    | { kind: 'tailscale.install' }
    /** Mint a share link for one workspace. Its URL comes back in THIS answer only. */
    | { kind: 'remote.mintShare'; workspaceId: string; grantedTo: string; expiresInMs: number }
    | { kind: 'remote.revokeShare'; shareId: string }
    /** Sign in to Tynn with a token; an empty token signs out. */
    | { kind: 'integrations.tynnSignIn' }
    | { kind: 'integrations.tynnCode'; code: string }
    | { kind: 'integrations.tynnSignOut' }
    /** GitHub (beta.33 item 25; Genie 1's): sign in with the device flow, cancel it, read GitHub again, open one of its pages, sign out. */
    | { kind: 'integrations.githubSignIn' }
    | { kind: 'integrations.githubCancelSignIn' }
    | { kind: 'integrations.githubRefresh' }
    | { kind: 'integrations.githubOpen'; target: { page: 'install' } | { page: 'device' } | { page: 'authorizations' } | { page: 'installation'; installationId: number } }
    | { kind: 'integrations.githubSignOut' }
    | { kind: 'workspace.syncAgentFiles'; workspaceId: string; workspacePath: string }
    /** Enable or disable an installable plugin; refused (unchanged list) for one that is not. */
    | { kind: 'plugins.setEnabled'; id: string; enabled: boolean };

/**
 * The refusal THIS toolchain action left on its row, if any — what the renderer also writes to its console, so the
 * console keeps the line it always had. Another row's older refusal is not this action's and is not repeated.
 */
export function toolchainRefusalOf(action: FeatureAction, data: FeatureData): ToolchainRefusal | null {
    const refusals = data.toolchain?.refusals ?? [];
    if (action.kind === 'toolchain.update' || action.kind === 'toolchain.install') return refusals.find((r) => r.tool === action.tool && r.version === undefined) ?? null;
    if (action.kind === 'toolchain.installPhp' || action.kind === 'toolchain.removePhp') return refusals.find((r) => r.tool === 'php' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installNode' || action.kind === 'toolchain.removeNode') return refusals.find((r) => r.tool === 'node' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installGo' || action.kind === 'toolchain.removeGo') return refusals.find((r) => r.tool === 'go' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installPython' || action.kind === 'toolchain.removePython') return refusals.find((r) => r.tool === 'python' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installDotnet' || action.kind === 'toolchain.removeDotnet') return refusals.find((r) => r.tool === 'dotnet' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installRust' || action.kind === 'toolchain.removeRust') return refusals.find((r) => r.tool === 'rust' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installRuby' || action.kind === 'toolchain.removeRuby') return refusals.find((r) => r.tool === 'ruby' && r.version === action.version) ?? null;
    if (action.kind === 'toolchain.installJava' || action.kind === 'toolchain.removeJava') return refusals.find((r) => r.tool === 'java' && r.version === action.version) ?? null;
    return null;
}
