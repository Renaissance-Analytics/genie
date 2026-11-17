import { applyMachineFeatureAction, machineFeatureSnapshot } from './feature-machine.js';
import { applyToolchainCoreFeatureAction, toolchainSection } from './feature-toolchain.js';
export { toolchainSection, toolchainStateFrom } from './feature-toolchain.js';
import { applyHostingFeatureAction, hostingFeatureSnapshot } from './feature-hosting.js';
export { ENGINE_STATUS_WAIT_MS, ROW_LOG_LINES, sitePins } from './feature-hosting.js';
import { applyPersonalFeatureAction, personalFeatureSnapshot } from './feature-personal.js';
import type { IssueWatchPanelView } from '../core/issue-watch.js';
import { REMOTE_ORIGIN, type FeatureOrigin } from './host-picks.js';
import { applyFeatureControlAction } from './feature-controls.js';
import { applyDeckFeatureAction } from './feature-deck.js';
import type { SyncResult } from '../core/integrations.js';
import type { TynnAccountPort } from './tynn-account.js';
import type { GithubAccountPort } from './github-account.js';
import type { RepairOutcome } from '../core/toolchain.js';
import type { FlowAdding, FlowSaved, KnowledgeAdded, KnowledgeAdding, ServiceAdding, ServiceLogs, SiteAdding, SiteEditing } from '../renderer/features.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { RepairReport } from '../core/toolchain-repair.js';
import type { ToolchainActivity } from '../core/toolchain-risk.js';
import type { InstallOutcome } from './toolchain-ops.js';
import type { GoInstallOutcome, GoRemoveOutcome, GoVersionsView } from './go-versions.js';
import type { PythonInstallOutcome, PythonRemoveOutcome, PythonVersionsView } from './python-versions.js';
import type { DotnetInstallOutcome, DotnetRemoveOutcome, DotnetVersionsView } from './dotnet-versions.js';
import type { RustInstallOutcome, RustRemoveOutcome, RustVersionsView } from './rust-versions.js';
import type { RubyInstallOutcome, RubyRemoveOutcome, RubyVersionsView } from './ruby-versions.js';
import type { JavaInstallOutcome, JavaRemoveOutcome, JavaVersionsView } from './java-versions.js';
import type { PlaywrightBrowsersView, PlaywrightInstallOutcome } from './playwright-browsers.js';
import type { DefaultOutcome } from './toolchain-defaults.js';
import type { MachinePathOutcome } from './machine-path.js';
import type { DefaultLang } from '../core/toolchain-defaults.js';
import type { NodeInstallOutcome, NodeRemoveOutcome, NodeVersionsView } from './node-versions.js';
import type { PhpInstallOutcome, PhpRemoveOutcome, PhpVersionsView, SitePin } from './php-versions.js';
import type { WindowServices as ComposedServices } from './compose.js';
import type { OpenInBrowser } from './hosting-actions.js';
import type { ProcessBook } from './process-book.js';
import type { FeatureAction, FeatureData, InboxSearchResult, InboxThreadView, InstallPreview, ToolchainRefusal, ToolchainSection } from '../renderer/features.js';
import type { AskedRecord } from './attention-store.js';

/**
 * THE FEATURE SURFACES' MAIN-SIDE HALF.
 *
 * The renderer sends a `FeatureAction`; the main process applies it to the composed services and
 * answers with the next `FeatureData`. Every action from a surface is the PERSON acting — so arming
 * a flow here is allowed (an agent's arm goes through the MCP tool and is refused there), inbox mail
 * is sent FROM the human, and the knowledge search covers everything (the human sees all scopes).
 *
 * The snapshot is MEASURED for every section the services can answer at once; knowledge hits stay
 * `null` until a search is asked for, and the toolchain stays `null` until a scan has run — both
 * are "not asked yet", drawn as skeletons, never as empties.
 */

/** What main wires in that the tests inject: the toolchain prober/updater with its clock, and the kept background processes. */
export interface FeaturePorts {
    /** genie-host's safe mode (Tynn #386): "Leave safe mode". Absent = no host to leave it in (refused, said). */
    readonly safeMode?: { leave(): Promise<{ ok: true } | { ok: false; reason: string }> };
    /** The reopened-window notice (Tynn #386): Dismiss, and Stop all agents. Absent = no host to ask (refused, said). */
    /** The brought-back page's notice: forget it. */
    readonly rendererNotice?: { dismiss(): Promise<{ ok: true } | { ok: false; reason: string }> };
    readonly hangNotice?: { dismiss(): Promise<{ ok: true } | { ok: false; reason: string }>; stopAll(): Promise<{ ok: true } | { ok: false; reason: string }> };
    /** A part of a snapshot that took at least `ms` (genie-test-windows, job Q0: an action took 20 s with main mostly free). */
    readonly slowPart?: { readonly ms: number; log(part: string, ms: number): void };
    /**
     * How long a snapshot waits for Docker's engine statuses before it goes out with the last read (genie#1393); absent =
     * ENGINE_STATUS_WAIT_MS. The first read ever is always waited for: there is no last one to show.
     */
    readonly engineStatusWaitMs?: number | undefined;
    /** Docker answered after a snapshot stopped waiting for it: push again, so the Services tab catches up (main.ts). */
    readonly onEngineStatusesLate?: (() => void) | undefined;
    /**
     * A message that must reach a running agent (SessionHost.deliver): an approval's note, after a Genie approval is
     * answered on the Deck or a toast (beta.33 item 16). Absent = no sessions here, and a note is refused, never dropped.
     */
    readonly deliverToAgent?: ((agentId: string, text: string) => boolean | Promise<boolean>) | undefined;
    /** Tailscale on this machine (main/tailscale-cli.ts, Tynn #821): its cached status, up, install. */
    readonly tailscale?: {
        status(): import('./tailscale-cli.js').TailscaleStatus | null;
        up(): Promise<import('./tailscale-cli.js').TailscaleUpResult>;
        install(): Promise<{ started: boolean; url?: string; message?: string }>;
        /** Read Tailscale again, and keep reading while it is not connected (bounded): Remote access opened or focused (Tynn #749). */
        refresh?(): Promise<unknown>;
    };
    /** The listener following its switch (main/remote-access.ts, Tynn #820); absent = no host side (doctor mode). */
    readonly remoteAccess?: { apply(): Promise<void>; restart(): Promise<void> };
    /** This machine's Tynn workstation registration, as main last read it (main/workstation-identity.ts, Tynn #836). */
    readonly tynnWorkstation?: () => import('../renderer/features.js').TynnWorkstationState | null;
    /**
     * Windows: Genie's firewall rule (main/remote-firewall.ts); absent elsewhere. `rule()` is main's last reading from Windows
     * (`null` = not read yet); `refresh()` reads Windows again; `allow()` / `remove()` each go through one UAC prompt (Tynn #685).
     */
    readonly firewall?: {
        rule(): import('../renderer/features.js').FirewallRuleView | null;
        refresh(): Promise<void>;
        /** Read Windows again, debounced: Settings → Remote access opened, or its window focused. */
        reread(): Promise<void>;
        allow(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
        remove(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
    };
    /** This Genie's Tynn account (main/tynn-account.ts). Absent = none (doctor mode): signed out, and sign-in refuses. */
    readonly tynnAccount?: TynnAccountPort;
    /** This Genie's GitHub sign-in (main/github-account.ts). Absent = none (doctor mode): signed out, and sign-in refuses. */
    readonly githubAccount?: GithubAccountPort;
    /**
     * Linux with no keyring (main/linux-keyring.ts, the owner 2026-11-01): the card's view (null = fine, or not Linux) and
     * its one button. Absent = no card (doctor mode, tests that do not wire it).
     */
    readonly keyring?: { view(): import('./linux-keyring.js').KeyringView | null; fix(): Promise<void>; press?(): Promise<void>; cancel?(): void | Promise<void>; notice?(): string | null };
    /** The background processes the person keeps (§6.6): written down, restored on launch. */
    readonly processes?: import('./processes-host.js').ProcessBookApi;
    /** Scheduled tasks' clock (genie#1204): the person's Run now. Absent = none (doctor mode). */
    readonly processScheduler?: Pick<import('./process-scheduler.js').ProcessScheduler, 'runNow'>;
    /** Open the flow editor window on a route (`genie://flow/<id>`, `genie://flow/new?workspace=<id>`, genie#1204). Absent = no windows (doctor mode). */
    readonly openFlowEditor?: (route: string) => void | Promise<void>;
    /** IssueWatch's view per workspace id (Tynn #806). Absent = none (doctor mode). */
    readonly issueWatch?: () => Readonly<Record<string, IssueWatchPanelView>>;
    /** Have Tynn read a workspace's repos now — the GitHub panel's Refresh. Absent = none (doctor mode). */
    readonly issueWatchRefresh?: (workspaceId: string) => Promise<unknown>;
    /**
     * Each workspace's storage (main/workspace-storage-host.ts, Tynn #697): its view, and the four things the Storage tab asks.
     * Ids only: the port resolves the workspace and re-validates every item. `measure` starts a measure and returns; main pushes
     * when it is done. Absent = this window cannot measure (doctor mode, a remote window without a host).
     */
    readonly storage?: {
        views(): Readonly<Record<string, import('../core/workspace-storage.js').StorageView>>;
        measure(workspaceId: string): void;
        trash(workspaceId: string, itemId: string): Promise<void>;
        cleanUp(workspaceId: string, itemIds: readonly string[]): Promise<void>;
        restore(workspaceId: string, trashId: string): Promise<void>;
        empty(workspaceId: string, approval: import('../core/workspace-storage.js').TrashApproval): Promise<void>;
    };
    /** Set one repo's IssueWatch switch in Tynn (tynn.ai#307). Absent = none (doctor mode). */
    readonly issueWatchSetRepo?: (workspaceId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }) => Promise<unknown>;
    readonly toolchain?: {
        probe(): Promise<ToolStatus[]>;
        /** Tynn #714: ONE tool's version and newest version, for the one-at-a-time "Check for updates". Absent = that check is not wired. */
        probeTool?(tool: string): Promise<ToolStatus>;
        /** Tynn #714: push the run as it moves (each row's state); `null` when it is over. */
        checking?(run: NonNullable<ToolchainSection['checkRun']> | null): void;
        /** `version`: the version the button named (genie#1306); `progress`: the row's step while it runs. */
        update(tool: string, version?: string, progress?: (step: string | null) => void): Promise<RepairOutcome | { kind: 'refused'; reason: string }>;
        /** Push the row's in-progress state (genie#1306): the update and its step, `null` when it is over. */
        updating?(row: { readonly tool: string; readonly version?: string; readonly step: string } | null): void;
        now(): number;
        /** What is running right now — the update guard's input. An update is refused while this is not wired. */
        activity?(): Promise<ToolchainActivity>;
        /** T1: install one missing tool. The consent is the person's; the installer checks it too. */
        install?(tool: string, consent: boolean): Promise<InstallOutcome>;
        /** How a missing tool would be installed here, shown before anything runs. */
        preview?(tool: string): Promise<InstallPreview>;
        /** T2: Check and repair. */
        repair?(): Promise<RepairReport>;
        /** Open a provider's own login (LoginHost, the Agent view's Log in), for a row that says Not signed in (Tynn #698). */
        login?(provider: string): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
        /** Repair a provider's CLI (Tynn #698, main/cli-repair.ts): each step pushed while it runs; never throws by contract, guarded anyway. */
        repairCli?(provider: string, progress: (step: string | null) => void): Promise<{ readonly kind: 'repaired'; readonly words: string } | { readonly kind: 'failed' | 'refused'; readonly reason: string }>;
        /** T4: Genie-managed PHP versions. `pins` are the sites' PHP pins, which a removal is refused against. */
        php?: {
            list(pins: readonly SitePin[]): Promise<PhpVersionsView>;
            install(version: string, consent: boolean): Promise<PhpInstallOutcome>;
            remove(version: string, pins: readonly SitePin[]): PhpRemoveOutcome;
        };
        /** Genie's own Node (main/node-versions.ts): nodejs.org zips, checksum-verified, under its toolchain directory. */
        node?: {
            list(): Promise<NodeVersionsView>;
            install(version: string, consent: boolean): Promise<NodeInstallOutcome>;
            remove(version: string): NodeRemoveOutcome;
        };
        /** Genie's own Go (main/go-versions.ts): go.dev archives, checksum-verified, every OS. */
        go?: {
            list(): Promise<GoVersionsView>;
            install(version: string, consent: boolean): Promise<GoInstallOutcome>;
            remove(version: string): GoRemoveOutcome;
        };
        /** Genie's own Python (main/python-versions.ts): python.org's Windows zips, checksum-verified; elsewhere refused (TC4b). */
        python?: {
            list(): Promise<PythonVersionsView>;
            install(version: string, consent: boolean): Promise<PythonInstallOutcome>;
            remove(version: string): PythonRemoveOutcome;
        };
        /** Genie's own .NET SDKs (main/dotnet-versions.ts): Microsoft's archives, sha512-verified, every OS. */
        dotnet?: {
            list(): Promise<DotnetVersionsView>;
            install(version: string, consent: boolean): Promise<DotnetInstallOutcome>;
            remove(version: string): Promise<DotnetRemoveOutcome>;
        };
        /** Genie's own Rust (main/rust-versions.ts): rustup as the downloader, the toolchain directory kept; Linux and macOS. */
        rust?: {
            list(): Promise<RustVersionsView>;
            install(version: string, consent: boolean): Promise<RustInstallOutcome>;
            remove(version: string): RustRemoveOutcome;
        };
        /** Genie's own Ruby (main/ruby-versions.ts): built from ruby-lang.org's source on Linux. */
        ruby?: {
            list(): Promise<RubyVersionsView>;
            install(version: string, consent: boolean): Promise<RubyInstallOutcome>;
            remove(version: string): RubyRemoveOutcome;
        };
        /** Genie's own Java (main/java-versions.ts): Temurin JDKs, sha256-verified; Windows and Linux. */
        java?: {
            list(): Promise<JavaVersionsView>;
            install(version: string, consent: boolean): Promise<JavaInstallOutcome>;
            remove(version: string): JavaRemoveOutcome;
        };
        /** Genie's one Playwright browser install (main/playwright-browsers.ts): every workspace and worktree uses it (Tynn #604). */
        playwright?: {
            list(): Promise<PlaywrightBrowsersView>;
            install(version: string | null, browsers: readonly string[], consent: boolean): Promise<PlaywrightInstallOutcome>;
        };
        /** Each language's default (main/toolchain-defaults.ts): read from the `current/<lang>` links; set repoints one. */
        defaults?: {
            list(): Record<DefaultLang, string | null>;
            set(lang: DefaultLang, version: string | null): DefaultOutcome;
        };
        /** The machine's own PATH (main/machine-path.ts): the `current` entries, once, with consent; Undo restores it exactly. */
        machinePath?: {
            status(): Promise<MachinePathStatus>;
            apply(consent: boolean): Promise<MachinePathOutcome>;
            remove(): Promise<MachinePathOutcome>;
        };
    };
    /** Genie's browser, for a site row's Open — the pane `browser.navigate` shows, and the agents' `sites open` uses. */
    readonly openInBrowser?: OpenInBrowser;
    /** The main process's record of errors it caught and survived (core/main-errors.ts): the Deck's Dismiss on one. */
    readonly mainErrors?: { dismiss(id: string): boolean | Promise<boolean>; retryHostCopy?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>; openLog?(id?: string): Promise<string | null>; report?(id: string): Promise<string | null> };
    /** What's New for the running version, once (Tynn #762): `null` when seen or there are no notes for it. */
    readonly whatsNew?: (shown: boolean) => { version: string; notes: string } | null;
    /** The running version (Tynn #763: the header shows it). */
    readonly appVersion?: () => string;
}

export { customSoundData } from './feature-personal.js';

export interface FeatureState {
    toolStatuses: readonly ToolStatus[] | null;
    /** Tynn sign-in under way: the link opened (kept on screen for a machine without a browser), and Tynn's last word. */
    tynnSignInUrl?: string | null;
    tynnMessage?: string | null;
    knowledgeQuery: string;
    browserUrl?: string | null;
    /** The host the pane's last address off the dev sites was handed to the person's own browser for (Tynn #741). */
    browserHandedOff?: string | null;
    /** The Genie Browser's history as its view last reported it (main/browser-pane.ts). */
    browserCanGoBack?: boolean;
    browserCanGoForward?: boolean;
    toolchainCheckedAt?: number | null;
    /** The Toolchain surface's own state beyond the scan (renderer/features.ts `ToolchainSection`). */
    toolchainInstalls?: Readonly<Record<string, InstallPreview>> | null;
    toolchainBusy?: string | null;
    toolchainFindings?: RepairReport['findings'] | null;
    toolchainRepairedAt?: number | null;
    toolchainWarning?: ToolchainSection['warning'] | null;
    toolchainUpdating?: ToolchainSection['updating'] | null;
    toolchainUpdated?: ToolchainSection['updated'] | null;
    toolchainResult?: string | null;
    /** The last or current "Check for updates" run (Tynn #714). */
    toolchainCheckRun?: ToolchainSection['checkRun'] | null;
    /** What's new asked for again (Help → What's new, Tynn #762): shown although seen, until closed. */
    whatsNewShown?: boolean;
    /** Refused or failed toolchain actions, one per row, each cleared by that row's next action. */
    toolchainRefusals?: readonly ToolchainRefusal[] | null;
    toolchainPhp?: PhpVersionsView | null;
    toolchainNode?: NodeVersionsView | null;
    toolchainGo?: GoVersionsView | null;
    toolchainPython?: PythonVersionsView | null;
    toolchainDotnet?: DotnetVersionsView | null;
    toolchainRust?: RustVersionsView | null;
    toolchainRuby?: RubyVersionsView | null;
    toolchainJava?: JavaVersionsView | null;
    toolchainPlaywright?: PlaywrightBrowsersView | null;
    toolchainDefaults?: Record<DefaultLang, string | null> | null;
    toolchainMachinePath?: MachinePathStatus | null;
    siteAdding?: SiteAdding | null;
    siteEditing?: SiteEditing | null;
    flowAdding?: FlowAdding | null;
    /** Transient: what the canvas's save did, served in that action's answer only (genie#1204). */
    flowSaved?: FlowSaved | null;
    serviceAdding?: ServiceAdding | null;
    /** The engine log the person opened in the Services tab (H6), until they hide it. */
    serviceLogs?: ServiceLogs | null;
    serviceUpdating?: NonNullable<FeatureData['services']>['updating'];
    knowledgeAdding?: KnowledgeAdding | null;
    knowledgeLastAdd?: KnowledgeAdded | null;
    /** What the last Allow through the firewall did (Tynn #820), in words. */
    firewallOutcome?: string | null;
    /** What the last Tailscale Connect or Install did (Tynn #821), in words. */
    tailscaleOutcome?: string | null;
    lastSync?: { workspaceId: string; results: readonly SyncResult[] } | null;
    /** Transient: the thread an `inbox.thread` action asked for, served in its answer only. */
    inboxThread?: InboxThreadView | null;
    /** Transient: an attachment's bytes an `inbox.attachment` action asked for, served once. */
    servedAttachment?: { id: string; name: string; base64: string } | null;
    /** Transient: a thread search an `inbox.search` action asked for, served in its answer only. */
    inboxSearch?: InboxSearchResult | null;
    /** Transient: a decided question's record an `inbox.question` action asked for, served once. */
    servedQuestion?: { id: string; record: AskedRecord | null } | null;
}

/** What the machine-PATH card shows: whether it is applied, where, and exactly what would change. */
export interface MachinePathStatus {
    readonly applied: boolean;
    readonly where: readonly string[];
    readonly entries: readonly string[];
    readonly targets: readonly string[];
}

/**
 * Every snapshot's number, taken when it STARTS (genie#1393). Snapshots race: a click's answer built while a site was
 * `starting` could land after the push built when it answered, and the window kept whichever came last. The window keeps
 * the higher number (renderer/features.ts `newestSnapshot`).
 */
let snapshotSeq = 0;

export async function featureSnapshot(services: ComposedServices, state: FeatureState, ports: FeaturePorts = {}): Promise<FeatureData> {
    const seq = ++snapshotSeq;
    const timed = async <T>(part: string, work: () => Promise<T>): Promise<T> => {
        if (!ports.slowPart) return work();
        const started = Date.now();
        try { return await work(); } finally { const ms = Date.now() - started; if (ms >= ports.slowPart.ms) ports.slowPart.log(part, ms); }
    };
    const personal = await timed('knowledge', () => personalFeatureSnapshot(services, state));
    const hosting = await hostingFeatureSnapshot(services, state, ports, timed);
    return {
        seq,
        ...personal,
        ...hosting,
        toolchain: toolchainSection(state),
        ...machineFeatureSnapshot(services, state, ports),
    };
}

/** Apply one action as the person, then answer with the next snapshot. Refusals throw with the reason — except a toolchain row's, which comes back IN the snapshot, on that row (`toolchain.refusals`). */
export async function handleFeatureAction(services: ComposedServices, action: FeatureAction, state: FeatureState = { toolStatuses: null, knowledgeQuery: '' }, ports: FeaturePorts = {}, origin: FeatureOrigin = REMOTE_ORIGIN): Promise<FeatureData> {
    // genie#1583: which half of a slow action waits, the action itself or the snapshot it answers with.
    const actStarted = Date.now();
    const slow = (part: string, started: number): void => { const ms = Date.now() - started; if (ports.slowPart && ms >= ports.slowPart.ms) ports.slowPart.log(part, ms); };
    const next: FeatureState = { ...state };
    if (!await applyPersonalFeatureAction(services, action, state, next, ports, origin)
        && !await applyHostingFeatureAction(services, action, state, next, ports)
        && !await applyMachineFeatureAction(services, action, state, next, ports)
        && !await applyToolchainCoreFeatureAction(services, action, state, next, ports)
        && !await applyDeckFeatureAction({ attention: services.attention, approvals: services.approvals, inbox: services.inbox,
            deckItems: () => services.deckItems(), deliverToAgent: ports.deliverToAgent,
            trustCertificate: () => services.trustCertificate(), deferTrustCertificate: () => services.deferTrustCertificate(),
            syncHosts: () => services.syncHosts(), deferHosts: () => services.deferHosts(), ...(ports.mainErrors ? { mainErrors: ports.mainErrors } : {}),
        }, action)) await applyFeatureControlAction(services, action, next, ports);
    slow(`act:${action.kind}`, actStarted);
    const snapshotStarted = Date.now();
    try {
        return await featureSnapshot(services, next, ports);
    } finally {
        slow('snapshot', snapshotStarted);
    }
}

