import { applyMachineFeatureAction, githubAccountOf, machineFeatureSnapshot } from './feature-machine.js';
import { applyToolchainCoreFeatureAction, clearRefusal, refuse, rescanToolchain, toolchainSection } from './feature-toolchain.js';
export { toolchainSection, toolchainStateFrom } from './feature-toolchain.js';
import { applyHostingFeatureAction, hostingFeatureSnapshot, sitePins } from './feature-hosting.js';
export { ENGINE_STATUS_WAIT_MS, ROW_LOG_LINES, sitePins } from './feature-hosting.js';
import { applyPersonalFeatureAction, personalFeatureSnapshot } from './feature-personal.js';
import type { IssueWatchPanelView } from '../core/issue-watch.js';
import { REMOTE_ORIGIN, type FeatureOrigin } from './host-picks.js';
import { classifyNavigation } from '../core/browser-policy.js';
import type { SyncResult } from '../core/integrations.js';
import type { TynnAccountPort } from './tynn-account.js';
import type { GithubAccountPort } from './github-account.js';
import { dismissableStale, isDismissable } from '../core/deck.js';
import type { RepairOutcome } from '../core/toolchain.js';
import type { FlowAdding, FlowSaved, KnowledgeAdded, KnowledgeAdding, ServiceAdding, ServiceLogs, SiteAdding, SiteEditing } from '../renderer/features.js';
import { answerDeck } from './deck-answer.js';
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
import type { DefaultOutcome } from './toolchain-defaults.js';
import type { MachinePathOutcome } from './machine-path.js';
import { LANG_LABEL, type DefaultLang } from '../core/toolchain-defaults.js';
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
    readonly openFlowEditor?: (route: string) => void;
    /** IssueWatch's view per workspace id (Tynn #806). Absent = none (doctor mode). */
    readonly issueWatch?: () => Readonly<Record<string, IssueWatchPanelView>>;
    /** Have Tynn read a workspace's repos now — the GitHub panel's Refresh. Absent = none (doctor mode). */
    readonly issueWatchRefresh?: (workspaceId: string) => Promise<unknown>;
    /** Set one repo's IssueWatch switch in Tynn (tynn.ai#307). Absent = none (doctor mode). */
    readonly issueWatchSetRepo?: (workspaceId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }) => Promise<unknown>;
    readonly toolchain?: {
        probe(): Promise<ToolStatus[]>;
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
        login?(provider: string): { ok: true } | { ok: false; reason: string };
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
    readonly mainErrors?: { dismiss(id: string): boolean; retryHostCopy?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>; openLog?(id?: string): Promise<string | null>; report?(id: string): Promise<string | null> };
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

/** The Toolchain rows whose CLI repair is running now (`toolchain.repairCli`): one repair per CLI at a time. */
const repairingCli = new Set<string>();

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
        && !await applyToolchainCoreFeatureAction(services, action, state, next, ports)) switch (action.kind) {
        // WHAT'S NEW (Tynn #762): asked for again from Help; closing records the version as seen.
        case 'rendererNotice.dismiss': {
            if (!ports.rendererNotice) throw new Error('This window keeps no such notice.');
            const done = await ports.rendererNotice.dismiss();
            if (!done.ok) throw new Error(done.reason);
            break;
        }
        case 'hangNotice.dismiss':
        case 'hangNotice.stopAll': {
            if (!ports.hangNotice) throw new Error('Genie’s host is not connected.');
            const done = action.kind === 'hangNotice.dismiss' ? await ports.hangNotice.dismiss() : await ports.hangNotice.stopAll();
            if (!done.ok) throw new Error(done.reason);
            break;
        }
        case 'safeMode.leave': {
            if (!ports.safeMode) throw new Error('Genie’s host is not connected, so safe mode cannot be left from here.');
            const left = await ports.safeMode.leave();
            if (!left.ok) throw new Error(left.reason);
            break;
        }
        case 'whatsNew.show':
            next.whatsNewShown = true;
            break;
        case 'whatsNew.close':
            await services.settings.set('whats_new_seen_version', action.version);
            next.whatsNewShown = false;
            break;
        case 'toolchain.login': {
            clearRefusal(next, action.tool);
            // The row's tool is the provider's CLI: claude-code is Claude's, codex is Codex's (Tynn #698).
            const provider = action.tool === 'claude-code' ? 'claude' : action.tool;
            const login = ports.toolchain?.login;
            const opened = login ? login(provider) : { ok: false as const, reason: 'no login is wired into this Genie' };
            if (!opened.ok) refuse(next, action.tool, opened.reason);
            break;
        }
        case 'toolchain.repairCli': {
            // ONE REPAIR AT A TIME per CLI (PR #1881 review): a second click while one runs does nothing. Two installers
            // writing the same folder race, and the second's end would clear the first's progress off the row.
            if (repairingCli.has(action.tool)) break;
            clearRefusal(next, action.tool);
            const tc = ports.toolchain;
            if (!tc?.repairCli) {
                refuse(next, action.tool, 'no repair is wired into this Genie; nothing was changed');
                break;
            }
            const provider = action.tool === 'claude-code' ? 'claude' : action.tool;
            const row = (step: string) => tc.updating?.({ tool: action.tool, step });
            // Taken in the same synchronous run as the check above, so no second click can slip between them.
            repairingCli.add(action.tool);
            try {
                row('Starting');
                const outcome = await tc.repairCli(provider, (step) => { if (step) row(step); });
                if (outcome.kind === 'repaired') next.toolchainResult = outcome.words;
                else refuse(next, action.tool, outcome.reason);
            } catch (error) {
                refuse(next, action.tool, `The repair stopped: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                tc.updating?.(null);
                repairingCli.delete(action.tool);
            }
            // The row shows what the check finds now, never the repair's word for it.
            await rescanToolchain(next, tc, sitePins(services));
            break;
        }
        case 'toolchain.installPhp': {
            clearRefusal(next, 'php', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'php', `Genie installs nothing without your go-ahead; PHP ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.php) {
                refuse(next, 'php', 'no PHP version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.php.install(action.version, true);
            if (outcome.kind === 'refused') {
                refuse(next, 'php', outcome.reason, action.version);
                break;
            }
            if (outcome.kind === 'not-installed') refuse(next, 'php', outcome.reason, action.version);
            next.toolchainResult =
                outcome.kind === 'installed' ? `PHP ${outcome.version} is installed; a php site can be pinned to it.`
                : outcome.kind === 'already-installed' ? `PHP ${outcome.version} was already installed; nothing was downloaded.`
                : `PHP ${action.version} was not installed: ${outcome.reason}.`;
            next.toolchainPhp = await tc.php.list(sitePins(services));
            break;
        }
        case 'toolchain.removePhp': {
            {
                const current = ports.toolchain?.defaults?.list()['php'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'php', action.version);
                    refuse(next, 'php', `${LANG_LABEL['php']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'php', action.version);
            if (!tc?.php) {
                refuse(next, 'php', 'no PHP version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.php.remove(action.version, sitePins(services));
            if (outcome.kind === 'refused') {
                refuse(next, 'php', outcome.reason, action.version);
                break;
            }
            next.toolchainResult = `PHP ${outcome.version} was removed.`;
            next.toolchainPhp = await tc.php.list(sitePins(services));
            break;
        }
        case 'toolchain.installPython': {
            clearRefusal(next, 'python', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'python', `Genie installs nothing without your go-ahead; Python ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.python) {
                refuse(next, 'python', 'no Python version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.python.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'python', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Python ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Python ${outcome.version} was already installed; nothing was downloaded.`
                    : `Python ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainPython = await tc.python.list();
            break;
        }
        case 'toolchain.removePython': {
            {
                const current = ports.toolchain?.defaults?.list()['python'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'python', action.version);
                    refuse(next, 'python', `${LANG_LABEL['python']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'python', action.version);
            if (!tc?.python) {
                refuse(next, 'python', 'no Python version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.python.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'python', outcome.reason, action.version);
            else next.toolchainResult = `Python ${outcome.version} was removed.`;
            next.toolchainPython = await tc.python.list();
            break;
        }
        case 'toolchain.installDotnet': {
            clearRefusal(next, 'dotnet', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'dotnet', `Genie installs nothing without your go-ahead; .NET SDK ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.dotnet) {
                refuse(next, 'dotnet', 'no .NET version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.dotnet.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'dotnet', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `.NET SDK ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `.NET SDK ${outcome.version} was already installed; nothing was downloaded.`
                    : `.NET SDK ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainDotnet = await tc.dotnet.list();
            break;
        }
        case 'toolchain.removeDotnet': {
            {
                const current = ports.toolchain?.defaults?.list()['dotnet'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'dotnet', action.version);
                    refuse(next, 'dotnet', `${LANG_LABEL['dotnet']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'dotnet', action.version);
            if (!tc?.dotnet) {
                refuse(next, 'dotnet', 'no .NET version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = await tc.dotnet.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'dotnet', outcome.reason, action.version);
            else next.toolchainResult = `.NET SDK ${outcome.version} was removed.`;
            next.toolchainDotnet = await tc.dotnet.list();
            break;
        }
        case 'toolchain.installRust': {
            clearRefusal(next, 'rust', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'rust', `Genie installs nothing without your go-ahead; Rust ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.rust) {
                refuse(next, 'rust', 'no Rust version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.rust.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'rust', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Rust ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Rust ${outcome.version} was already installed; nothing was downloaded.`
                    : `Rust ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainRust = await tc.rust.list();
            break;
        }
        case 'toolchain.removeRust': {
            {
                const current = ports.toolchain?.defaults?.list()['rust'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'rust', action.version);
                    refuse(next, 'rust', `${LANG_LABEL['rust']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'rust', action.version);
            if (!tc?.rust) {
                refuse(next, 'rust', 'no Rust version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.rust.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'rust', outcome.reason, action.version);
            else next.toolchainResult = `Rust ${outcome.version} was removed.`;
            next.toolchainRust = await tc.rust.list();
            break;
        }
        case 'toolchain.installRuby': {
            clearRefusal(next, 'ruby', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'ruby', `Genie installs nothing without your go-ahead; Ruby ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.ruby) {
                refuse(next, 'ruby', 'no Ruby version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.ruby.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'ruby', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Ruby ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Ruby ${outcome.version} was already installed; nothing was downloaded.`
                    : `Ruby ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainRuby = await tc.ruby.list();
            break;
        }
        case 'toolchain.removeRuby': {
            {
                const current = ports.toolchain?.defaults?.list()['ruby'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'ruby', action.version);
                    refuse(next, 'ruby', `${LANG_LABEL['ruby']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'ruby', action.version);
            if (!tc?.ruby) {
                refuse(next, 'ruby', 'no Ruby version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.ruby.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'ruby', outcome.reason, action.version);
            else next.toolchainResult = `Ruby ${outcome.version} was removed.`;
            next.toolchainRuby = await tc.ruby.list();
            break;
        }
        case 'toolchain.installJava': {
            clearRefusal(next, 'java', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'java', `Genie installs nothing without your go-ahead; Java ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.java) {
                refuse(next, 'java', 'no Java version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.java.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'java', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Java ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Java ${outcome.version} was already installed; nothing was downloaded.`
                    : `Java ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainJava = await tc.java.list();
            break;
        }
        case 'toolchain.removeJava': {
            {
                const current = ports.toolchain?.defaults?.list()['java'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'java', action.version);
                    refuse(next, 'java', `${LANG_LABEL['java']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'java', action.version);
            if (!tc?.java) {
                refuse(next, 'java', 'no Java version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.java.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'java', outcome.reason, action.version);
            else next.toolchainResult = `Java ${outcome.version} was removed.`;
            next.toolchainJava = await tc.java.list();
            break;
        }
        case 'deck.answer':
        case 'deck.answerForm': {
            // One answer for the window and genie-host (deck-answer.ts, Tynn #551).
            await answerDeck(action, {
                attention: services.attention,
                approvals: services.approvals,
                inbox: services.inbox,
                deliverToAgent: ports.deliverToAgent,
                trustCertificate: () => services.trustCertificate(),
                deferTrustCertificate: () => services.deferTrustCertificate(),
                syncHosts: () => services.syncHosts(),
                ...(ports.mainErrors ? { mainErrors: ports.mainErrors } : {}),
            });
            break;
        }
        case 'deck.dismiss':
            // An agent's question, put aside WITHOUT an answer: it leaves the Deck and the question window, and the asker is
            // mailed that it was dismissed (attention-store.ts). An approval or a forwarded question is not dismissable.
            if (!isDismissable(action.item)) throw new Error('only an agent’s question can be dismissed; an approval is answered with its own options');
            // The person's notes travel with it (one per question; anything that is not a string is no note).
            await services.attention.dismiss(action.item.id, Array.isArray(action.notes) ? action.notes.map((n) => (typeof n === 'string' ? n : '')) : []);
            break;
        case 'deck.dismissStale': {
            // "Dismiss all stale": the ids the person SAW marked stale, re-checked against the Deck now — a question that is
            // no longer pending, or no longer stale, stays. Each asker is mailed once (attention-store.ts).
            const seen = new Set(Array.isArray(action.ids) ? action.ids.filter((id): id is string => typeof id === 'string') : []);
            const still = dismissableStale(services.deckItems()).filter((i) => seen.has(i.id));
            // Never a silent no-op (Tynn #600): when none of them is still a stale question here, the person is told.
            if (still.length === 0) throw new Error('None of these questions is still waiting as a stale one here, so nothing was dismissed. Look at the Deck again.');
            await services.attention.dismissMany(still.map((i) => i.id));
            break;
        }
        case 'deck.dismissOlder':
            // "Dismiss all older than 1 day" — the store's clock decides what is old, each asker mailed once.
            await services.attention.dismissOlderThan(action.olderThanMs);
            break;
        case 'remote.answerPair': {
            // Allow or Deny on "Pair this device?", from this machine's own window (a remote connection is refused upstream).
            const r = await services.pairing.answer(action.id, action.allow);
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'tailscale.install': {
            if (!ports.tailscale) throw new Error('Tailscale is not available here');
            const r = await ports.tailscale.install();
            next.tailscaleOutcome = r.started ? 'Tailscale’s installer is open: finish it, then Connect.' : r.url ? 'Tailscale’s download page opened in your browser.' : (r.message ?? 'Tailscale could not be installed from here.');
            break;
        }
        // The page opened, or its window regained focus: read Windows again, debounced.
        case 'remote.readFirewall': {
            if (!ports.firewall) throw new Error('the firewall rule is only on Windows');
            await ports.firewall.reread();
            break;
        }
        case 'integrations.githubOpen':
            await githubAccountOf(ports).openPage(action.target);
            break;
        case 'workspace.untrust': {
            // The person's Untrust: the only thing that ends a workspace's trust (Tynn #618).
            if ((await services.workspaceTrust.untrust(action.workspaceId)) === null) throw new Error(`There is no workspace "${action.workspaceId}" to untrust.`);
            break;
        }
        case 'workspace.syncAgentFiles':
            // Sync now in a workspace's Settings: THAT workspace's agent files, then its four harness configs — by you.
            await services.syncAgentDocs(action.workspacePath, 'you');
            next.lastSync = { workspaceId: action.workspaceId, results: await services.syncConfig(action.workspacePath, 'you') };
            break;
        case 'workspace.trust': {
            // The person's yes: recorded first, then what it now allows. Genie's files go in, by you, as Sync now does.
            const trusted = await services.workspaceTrust.trust(action.workspaceId);
            if (trusted === null) throw new Error(`There is no workspace "${action.workspaceId}" to trust.`);
            await services.syncAgentDocs(action.workspacePath, 'you');
            next.lastSync = { workspaceId: action.workspaceId, results: await services.syncConfig(action.workspacePath, 'you') };
            break;
        }
        case 'browser.navigate': {
            const nav = classifyNavigation(action.url, services.routes());
            if (nav.kind === 'refused') throw new Error(nav.reason);
            // A site is its own https origin, path kept (core/browser-policy.ts); a name nobody serves is shown at its root.
            next.browserUrl = nav.kind === 'no-site' ? `https://${nav.host}/` : nav.url;
            break;
        }
        // Back, forward and reload act on the pane's own history in main (main.ts); the URL they land on comes back from
        // the view's navigation report, never guessed here.
        case 'browser.back':
        case 'browser.forward':
        case 'browser.reload':
            break;
    }
    slow(`act:${action.kind}`, actStarted);
    const snapshotStarted = Date.now();
    try {
        return await featureSnapshot(services, next, ports);
    } finally {
        slow('snapshot', snapshotStarted);
    }
}

