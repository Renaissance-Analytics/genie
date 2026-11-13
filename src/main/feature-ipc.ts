import type { IssueWatchPanelView } from '../core/issue-watch.js';
import { catalogEditors, catalogPanels } from '../core/catalog-projections.js';
import type { EngineStatusView } from '../core/engine-reconcile.js';
import { hostPathRefusal, REMOTE_ORIGIN, type FeatureOrigin } from './host-picks.js';
import { TYNN_HOST } from '../core/tynn.js';
import { readFile, stat } from 'node:fs/promises';
import { classifyNavigation } from '../core/browser-policy.js';
import { isAlertSoundKey } from '../core/alerts.js';
import { MAX_SOUND_BYTES, soundFileMime } from '../core/custom-sound.js';
import { tynnGate, type SyncResult } from '../core/integrations.js';
import { unreachableThroughMessage, type TynnAccountPort } from './tynn-account.js';
import type { GithubAccountPort } from './github-account.js';
import { signedOutGithubView } from '../core/github.js';
import { dismissableStale, isDismissable } from '../core/deck.js';
import { shouldCheckUpdates } from './toolchain-prober.js';
import { FIREWALL_RULE_NAME } from './remote-firewall.js';
import type { RepairOutcome } from '../core/toolchain.js';
import { canonicalKind, problemFromText, saveProblems, type FlowProblem } from '../core/flow-canvas.js';
import { canonicalFlowDocument, flowNodes, formEditable } from '../core/flow-form.js';
import { importFlowDocument } from './flow-kinds.js';
import { flowToolDefinitions } from './flow-tools.js';
import { flowFormDefaults, knowledgeFormDefaults, serviceFormDefaults, validateFlowForm, validateKnowledgeForm, type Problem } from '../core/forms.js';
import type { FlowAdding, FlowSaved, HostedSite, KnowledgeAdded, KnowledgeAdding, ServiceAdding, ServiceLogs, SiteAdding, SiteEditing } from '../renderer/features.js';
import { HUMAN, UNNAMED_AGENT } from '../core/inbox.js';
import { inboxThreads, pairOf, searchThread, threadKeyOfMessage, threadWindow, uncollected } from '../core/inbox-threads.js';
import { answerDeck } from './deck-answer.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { RepairReport } from '../core/toolchain-repair.js';
import { updateRisk, type ToolchainActivity } from '../core/toolchain-risk.js';
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
import {
    createService, createSite, detachService, openSite, removeService, removeSite, restartSite, serviceLogs, setActiveService, siteDefaultsIn, siteEditTarget, siteLogs, startService, startSite, stopService, stopSite, updateService, updateSite, useService,
    type OpenInBrowser,
} from './hosting-actions.js';
import type { HostedProcess, ProcessBook } from './process-book.js';
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

/**
 * YOUR OWN SOUND, READ BY KEY (Tynn #766 B2; Genie 1's `settings:sound-data-url`): the renderer is sandboxed and cannot
 * read disk, so main reads the file the alert's setting names into a data URL. It is asked by SETTING KEY, never by
 * path, and reads only a sound file within the cap — so it is not a way to read an arbitrary file. `null` (the alert
 * plays its own sound) for no file, a gone file, a non-sound, a key that is not an alert sound, or one too big.
 */
export async function customSoundData(settings: { get(key: string): unknown }, key: string): Promise<string | null> {
    if (!isAlertSoundKey(key)) return null;
    const path = settings.get(`${key}_custom`);
    if (typeof path !== 'string' || path.trim() === '') return null;
    const mime = soundFileMime(path);
    if (!mime) return null;
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_SOUND_BYTES) return null;
        return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
    } catch {
        return null;
    }
}

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

/** The most of one thread an `inbox.thread` action serves at once. */
const INBOX_THREAD_MAX = 2_000;
/** The most hits a thread search serves; its `total` still counts every match. */
const INBOX_SEARCH_MAX = 200;

/** The Toolchain section: the scan, plus each further fact only when there is one (never an empty placeholder). */
export function toolchainSection(state: FeatureState): ToolchainSection | null {
    if (state.toolStatuses === null) return null;
    return {
        tools: state.toolStatuses,
        checkedAt: state.toolchainCheckedAt ?? null,
        ...(state.toolchainInstalls ? { installs: state.toolchainInstalls } : {}),
        ...(state.toolchainBusy ? { busy: state.toolchainBusy } : {}),
        ...(state.toolchainFindings ? { findings: state.toolchainFindings } : {}),
        ...(typeof state.toolchainRepairedAt === 'number' ? { repairedAt: state.toolchainRepairedAt } : {}),
        ...(state.toolchainWarning ? { warning: state.toolchainWarning } : {}),
        ...(state.toolchainUpdating ? { updating: state.toolchainUpdating } : {}),
        ...(state.toolchainUpdated ? { updated: state.toolchainUpdated } : {}),
        ...(state.toolchainResult ? { result: state.toolchainResult } : {}),
        ...(state.toolchainRefusals && state.toolchainRefusals.length > 0 ? { refusals: state.toolchainRefusals } : {}),
        ...(state.toolchainPhp ? { php: state.toolchainPhp } : {}),
        ...(state.toolchainNode ? { node: state.toolchainNode } : {}),
        ...(state.toolchainGo ? { go: state.toolchainGo } : {}),
        ...(state.toolchainPython ? { python: state.toolchainPython } : {}),
        ...(state.toolchainDotnet ? { dotnet: state.toolchainDotnet } : {}),
        ...(state.toolchainRust ? { rust: state.toolchainRust } : {}),
        ...(state.toolchainRuby ? { ruby: state.toolchainRuby } : {}),
        ...(state.toolchainJava ? { java: state.toolchainJava } : {}),
        ...(state.toolchainDefaults ? { defaults: state.toolchainDefaults } : {}),
        ...(state.toolchainMachinePath ? { machinePath: state.toolchainMachinePath } : {}),
    };
}

/** What main keeps of a toolchain action's answer for the next snapshot (the inverse of `toolchainSection`). */
export function toolchainStateFrom(section: ToolchainSection | null): Partial<FeatureState> {
    return {
        toolStatuses: section?.tools ?? null,
        toolchainCheckedAt: section?.checkedAt ?? null,
        toolchainInstalls: section?.installs ?? null,
        toolchainFindings: section?.findings ?? null,
        toolchainRepairedAt: section?.repairedAt ?? null,
        toolchainWarning: section?.warning ?? null,
        toolchainUpdating: null,
        toolchainUpdated: section?.updated ?? null,
        toolchainResult: section?.result ?? null,
        toolchainRefusals: section?.refusals ?? null,
        toolchainPhp: section?.php ?? null,
        toolchainNode: section?.node ?? null,
        toolchainGo: section?.go ?? null,
        toolchainPython: section?.python ?? null,
        toolchainDotnet: section?.dotnet ?? null,
        toolchainRust: section?.rust ?? null,
        toolchainRuby: section?.ruby ?? null,
        toolchainJava: section?.java ?? null,
        toolchainDefaults: section?.defaults ?? null,
        toolchainMachinePath: section?.machinePath ?? null,
    };
}

/** What the machine-PATH card shows: whether it is applied, where, and exactly what would change. */
export interface MachinePathStatus {
    readonly applied: boolean;
    readonly where: readonly string[];
    readonly entries: readonly string[];
    readonly targets: readonly string[];
}

type ToolchainPort = NonNullable<FeaturePorts['toolchain']>;

/** Every site's PHP pin — what the PHP versions list shows as "used by" and a removal is refused against. */
export function sitePins(services: Pick<ComposedServices, 'sites'>): SitePin[] {
    return services.sites.list().flatMap((s) => (s.serve?.mode === 'php' && s.serve.version ? [{ host: s.host, pin: s.serve.version }] : []));
}

/** Re-probe every tool (the snapshot shows the MEASURED state, never a command's word) and how each missing one would install. */
async function rescanToolchain(next: FeatureState, tc: ToolchainPort, pins: readonly SitePin[] = []): Promise<void> {
    if (tc.php) next.toolchainPhp = await tc.php.list(pins);
    if (tc.node) next.toolchainNode = await tc.node.list();
    if (tc.go) next.toolchainGo = await tc.go.list();
    if (tc.python) next.toolchainPython = await tc.python.list();
    if (tc.dotnet) next.toolchainDotnet = await tc.dotnet.list();
    if (tc.rust) next.toolchainRust = await tc.rust.list();
    if (tc.ruby) next.toolchainRuby = await tc.ruby.list();
    if (tc.java) next.toolchainJava = await tc.java.list();
    if (tc.defaults) next.toolchainDefaults = tc.defaults.list();
    if (tc.machinePath) next.toolchainMachinePath = await tc.machinePath.status();
    const tools = await tc.probe();
    next.toolStatuses = tools;
    next.toolchainCheckedAt = tc.now();
    if (tc.preview) {
        const missing = tools.filter((t) => t.tone === 'not-installed');
        next.toolchainInstalls = Object.fromEntries(await Promise.all(missing.map(async (t) => [t.tool, await tc.preview!(t.tool)] as const)));
    }
}

const sameRow = (r: ToolchainRefusal, tool: string, version: string | undefined): boolean => r.tool === tool && r.version === version;

/** The Toolchain rows whose CLI repair is running now (`toolchain.repairCli`): one repair per CLI at a time. */
const repairingCli = new Set<string>();

/** A row's next action starts clean: its old refusal goes; every other row's stays. */
function clearRefusal(next: FeatureState, tool: string, version?: string): void {
    next.toolchainRefusals = (next.toolchainRefusals ?? []).filter((r) => !sameRow(r, tool, version));
}

/**
 * Say a refused or failed toolchain action ON ITS ROW, verbatim. It used to be thrown, which the renderer could put
 * nowhere but its console: the person clicked Update and nothing happened, with no word of who was busy.
 */
function refuse(next: FeatureState, tool: string, reason: string, version?: string, retry?: string): void {
    clearRefusal(next, tool, version);
    next.toolchainRefusals = [...(next.toolchainRefusals ?? []), { tool, reason, ...(version !== undefined ? { version } : {}), ...(retry !== undefined ? { retry } : {}) }];
}

const LABELS: Readonly<Record<string, string>> = { php: 'PHP', node: 'Node', python: 'Python', go: 'Go' };

/**
 * AFTER AN UPDATE (genie#1306; Genie 1 told the person what keeps the old version until it restarts — toolchain-page.ts
 * `defaultChangeNotice`, "restart them to pick this up"): restart what ran on the old version — a site through its OWN
 * restart (its php-cgi re-resolved, its dev server started again), any other process by the supervisor — and say what
 * could not be. Agent sessions are never restarted mid-turn: they are named, and take it up when they next start.
 */
function restartAfterUpdate(services: ComposedServices, ids: readonly string[]): { restarted: string[]; failed: string[] } {
    const restarted: string[] = [];
    const failed: string[] = [];
    const sitesDone = new Set<string>();
    for (const id of ids) {
        const site = services.sites.list().find((s) => s.processIds.includes(id));
        try {
            if (site) {
                if (sitesDone.has(site.id)) continue;
                sitesDone.add(site.id);
                services.sites.restart(site.id);
                restarted.push(site.host);
            } else {
                const label = services.supervisor.status(id)?.name ?? id;
                if (services.supervisor.restart(id)) restarted.push(label);
                else failed.push(`${label} (it is gone)`);
            }
        } catch (error) {
            failed.push(`${site?.host ?? id} (${error instanceof Error ? error.message : String(error)})`);
        }
    }
    return { restarted, failed };
}

function describeInstall(tool: string, outcome: Exclude<InstallOutcome, { kind: 'refused' }>): string {
    switch (outcome.kind) {
        case 'installed':
            return `${tool}${outcome.version ? ` ${outcome.version}` : ''} is installed.${outcome.note ? ` (${outcome.note})` : ''}`;
        case 'already-installed':
            return `${tool} was already installed${outcome.version ? ` (${outcome.version})` : ''}; nothing was run.`;
        case 'not-installed':
            return `${tool} was not installed: ${outcome.reason}.`;
    }
}

function describeUpdate(tool: string, outcome: RepairOutcome): string {
    switch (outcome.kind) {
        case 'repaired':
            return `${tool} updated${outcome.from ? ` from ${outcome.from}` : ''} to ${outcome.to}.${outcome.note ? ` (${outcome.note})` : ''}`;
        case 'unchanged':
        case 'unverified':
            return `${tool}: ${outcome.reason}.`;
    }
}

/** How much of a process's log rides each snapshot: the end of it. All of it is the agents' `processes logs`. */
export const ROW_LOG_LINES = 40;

/** Each site with the end of its processes' output — the same read as the agents' `sites logs` (hosting-actions.ts). */
function sitesWithLogs(services: ComposedServices): HostedSite[] {
    return services.sites.list().map((site) => {
        const logs = siteLogs(services, site.id, ROW_LOG_LINES).filter((l) => l.lines > 0);
        return logs.length > 0 ? { ...site, logs } : site;
    });
}

function withLogTails(services: ComposedServices, rows: readonly HostedProcess[]): HostedProcess[] {
    return rows.map((row) => {
        const log = services.supervisor.readLog(row.id, ROW_LOG_LINES);
        return log && log.lines > 0 ? { ...row, log } : row;
    });
}

/** The account, or a refusal in words: without one nothing pretends to sign in. */
function tynnAccountOf(ports: FeaturePorts): TynnAccountPort {
    if (!ports.tynnAccount) throw new Error('this Genie cannot sign in to Tynn here: it has no Tynn account (doctor mode)');
    return ports.tynnAccount;
}

const NO_GITHUB = 'this Genie cannot sign in to GitHub here: it has no GitHub account (doctor mode)';

/** The GitHub sign-in, or a refusal in words: without one nothing pretends to sign in. */
function githubAccountOf(ports: FeaturePorts): GithubAccountPort {
    if (!ports.githubAccount) throw new Error(NO_GITHUB);
    return ports.githubAccount;
}

/** Tynn in Settings → Integrations: who is signed in where, the sign-in under way, and the rows Tynn gates. */
function tynnIntegration(services: ComposedServices, state: FeatureState, account: TynnAccountPort | undefined) {
    const status = account?.status() ?? { signedIn: false as const };

    const host = account ? account.host() : TYNN_HOST;
    // Out of reach through a proxy reads as that: the sign-in stands, whatever the status says for now.
    const through = account?.unreachableThrough?.() ?? null;
    return {
        tynnSignedIn: status.signedIn,
        tynn: { host, user: status.signedIn ? status.user : null, signInUrl: status.signedIn ? null : state.tynnSignInUrl ?? null, message: state.tynnMessage ?? (through ? unreachableThroughMessage(through) : null) },
        gated: tynnGate([{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true }], { signedIn: status.signedIn }),
    };
}

/**
 * A SNAPSHOT NEVER WAITS ON A SLOW DOCKER FOR LONG (genie#1393). Every snapshot (a click's answer, every push) read the
 * engines' statuses from Docker first: `docker version`, then one `docker container inspect` per engine, each allowed
 * 20 s. So the Hosting tab's state, built before that read, reached the window only when Docker answered, slowest exactly
 * when Genie has just started a dozen sites and every supervisor transition asked for another snapshot. Now: one read at
 * a time (a snapshot asked for while one is in flight joins it), and a snapshot waits at most this long for it before it
 * goes out with the LAST read Docker gave; when the read lands, `onEngineStatusesLate` asks for a fresh push.
 */
export const ENGINE_STATUS_WAIT_MS = 1_500;
const engineReads = new WeakMap<object, { last?: EngineStatusView[]; inFlight?: Promise<EngineStatusView[]> }>();

async function engineStatusesWithin(services: ComposedServices, ports: FeaturePorts): Promise<EngineStatusView[]> {
    let entry = engineReads.get(services);
    if (!entry) { entry = {}; engineReads.set(services, entry); }
    const e = entry;
    const read = e.inFlight ?? (e.inFlight = services.engineStatuses().then(
        (views) => { e.last = views; return views; },
    ).finally(() => { delete e.inFlight; }));
    const prior = e.last;
    if (prior === undefined) return read;
    const late = Symbol('late');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([read.catch(() => late), new Promise<typeof late>((r) => { timer = setTimeout(() => r(late), ports.engineStatusWaitMs ?? ENGINE_STATUS_WAIT_MS); })]);
    clearTimeout(timer);
    if (first !== late) return first as EngineStatusView[];
    // Only when Docker's answer CHANGES what was shown: a push builds a snapshot, which reads Docker again, so a Docker
    // that is merely slow would otherwise push forever.
    read.then((views) => { if (JSON.stringify(views) !== JSON.stringify(prior)) ports.onEngineStatusesLate?.(); }, () => {});
    return prior;
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
    // No query = what the graph holds, newest first (the owner: "the knowledge graph is empty or not rendering" — it held
    // 108 memories and drew skeletons until a search). A query searches.
    const hits = await timed('knowledge', async () => state.knowledgeQuery
        ? (await services.knowledge.search({ query: state.knowledgeQuery, scopes: 'all' })).hits
        : (await services.knowledge.summaries({ scopes: 'all', limit: 200 })).hits);
    const roster = services.agentAddresses();
    const peers = roster.map((a) => ({ address: a.address, agentId: a.agentId, name: a.name, reachable: true }));
    // THE AGENTINBOX'S THREADS (beta.33 item 19, core/inbox-threads.ts): every pair's thread, the person's and the agents'.
    const mail = services.inbox.all();
    const visibleMail = new Set(mail.map((m) => m.id));
    const nameOf = participantNamer(roster, mail);
    return {
        seq,
        knowledge: { hits, query: state.knowledgeQuery, adding: state.knowledgeAdding ?? null, lastAdd: state.knowledgeLastAdd ?? null },
        // Genie's tools as steps (genie#1204): their kinds go to the editor window, which registers them before its canvas mounts.
        flows: { flows: services.flows.list(), adding: state.flowAdding ?? null, ...(state.flowSaved ? { saved: state.flowSaved } : {}), toolKinds: flowToolDefinitions() },
        // The kept processes are listed even when not running (a stop is durable, never a disappearance), each with the last
        // lines of its output — the supervisor's tail, so a crashed process still shows why (P1).
        trust: services.trustSteps(),
        hosting: { sites: sitesWithLogs(services), processes: withLogTails(services, ports.processes ? ports.processes.list().filter((p) => services.workspaceVisible(p.workspaceId)) : []), adding: state.siteAdding ?? null, editing: state.siteEditing ?? null, frontDoor: services.externalFrontDoor, problems: services.hostingProblems() },
        // Status is READ from Docker for every instance, never made up; with Docker down, each says so. A snapshot waits at
        // most ENGINE_STATUS_WAIT_MS for it, then carries Docker's last answer and a fresh push follows (genie#1393).
        services: { instances: await timed('engines', () => engineStatusesWithin(services, ports)), adding: state.serviceAdding ?? null, logs: state.serviceLogs ?? null, ...(state.serviceUpdating !== undefined ? { updating: state.serviceUpdating } : {}) },
        toolchain: toolchainSection(state),
        // `recent`: the human's conversation (both directions, oldest first) — an observed agent's chat is its slice.
        inbox: {
            unread: services.inbox.unread(HUMAN), peers, recent: services.inbox.involving(HUMAN, 200),
            threads: inboxThreads(mail, nameOf), uncollected: uncollected(mail),
            // Served in the answer to the action that asked, once — never in a pushed snapshot.
            thread: state.inboxThread?.messages.every((m) => visibleMail.has(m.id)) ? state.inboxThread : null,
            servedAttachment: state.servedAttachment && mail.some((m) => m.attachments.some((a) => a.id === state.servedAttachment!.id)) ? state.servedAttachment : null,
            search: state.inboxSearch?.hits.every((m) => visibleMail.has(m.id)) ? state.inboxSearch : null,
            question: state.servedQuestion ?? null,
        },
        settings: { values: services.settings.snapshot() },
        browser: { url: state.browserUrl ?? null, routes: services.routes(), canGoBack: state.browserCanGoBack ?? false, canGoForward: state.browserCanGoForward ?? false },
        // GitHub as the account read it from GitHub (beta.33 item 25) — never a value a window sent.
        integrations: { ...tynnIntegration(services, state, ports.tynnAccount), github: ports.githubAccount ? ports.githubAccount.view() : signedOutGithubView(NO_GITHUB), ...services.integrations(), lastSync: state.lastSync ?? null, keyring: ports.keyring?.view() ?? null, ...(ports.keyring?.notice?.() ? { keyringNotice: ports.keyring.notice!() } : {}) },
        issueWatch: ports.issueWatch ? ports.issueWatch() : null,
        version: ports.appVersion ? ports.appVersion() : null,
        whatsNew: ports.whatsNew ? ports.whatsNew(state.whatsNewShown === true) : null,
        plugins: { dir: services.pluginsDir, publisherChecksOff: services.settings.snapshot().publisher_checks_off === true, entries: services.plugins.list(), panels: catalogPanels(services.catalogDefinitions()) as never, editors: catalogEditors(services.catalogDefinitions()) },
        remote: {
            host: services.remote.hostName,
            url: services.remote.url(),
            unavailable: services.remote.unavailable(),
            locked: services.remote.locked(),
            pin: services.remote.activePin(),
            devices: services.remote.devices(),
            pairRequests: services.pairing.requests(),
            connections: services.remote.connections(),
            enabled: services.settings.snapshot().remote_access === true,
            firewall: ports.firewall !== undefined,
            firewallRule: ports.firewall ? ports.firewall.rule() : null,
            firewallOutcome: state.firewallOutcome ?? null,
            tailscale: ports.tailscale ? ports.tailscale.status() : null,
            tailscaleOutcome: state.tailscaleOutcome ?? null,
            tynnWorkstation: ports.tynnWorkstation ? ports.tynnWorkstation() : null,
        },
    };
}

const USER = { kind: 'user' } as const;

/**
 * A participant by name: the person is `you`, an agent its roster name, an APP the label its mail carries
 * (`site:flabs@fancy`, genie#1345), one no longer here its id.
 */
function participantNamer(roster: ReadonlyArray<{ agentId: string; name: string }>, mail: ReadonlyArray<{ from: string; app?: { label: string } }> = []): (participant: string) => string {
    const apps = new Map<string, string>();
    for (const m of mail) if (m.app) apps.set(m.from, m.app.label);
    return (participant) => (participant === HUMAN ? 'you' : apps.get(participant) ?? roster.find((a) => a.agentId === participant)?.name ?? UNNAMED_AGENT);
}

/** An agent a flow would prompt must be one address on the roster NOW — the same rule the run resolves it by. */
function agentProblems(services: ComposedServices, document: unknown): Problem[] {
    return flowNodes(document).flatMap((n) => {
        const agent = n.kind === 'genie/agent_prompt' && typeof n.config?.agent === 'string' ? n.config.agent.trim() : '';
        if (!agent) return [];
        const found = services.resolveAddress(agent);
        if (found.kind === 'none') return [{ field: 'agent', message: `Node ${n.id}: no agent answers to ${agent}.` }];
        if (found.kind === 'human') return [{ field: 'agent', message: `Node ${n.id}: ${agent} is you, not an agent.` }];
        if (found.kind === 'ambiguous') return [{ field: 'agent', message: `Node ${n.id}: ${agent} names more than one agent (${found.forms.join(', ')}); use the full form.` }];
        return [];
    });
}

/**
 * THE CANVAS'S SAVE (genie#1204 item 1), as the person. Refused — nothing stored — with every problem on its node: what
 * only a save can know (core/flow-canvas.ts `saveProblems`: a trigger and a step, the schedule, the workspaces and agents
 * as they are now) and the store's own door (the engine, Genie's kinds, a loop — the door agents pass too). Stored, it is
 * never armed by the save; an ARMED flow whose save changes what it does is DISARMED and the answer says so — Genie 1's
 * `flows:save` (main/flows/ipc.ts:196-230 and `changesConsent` :315-361 at v0.7.0-beta.342): the person armed the flow as
 * it was, and moving a node or renaming it changes nothing they agreed to.
 */
async function saveGraph(services: ComposedServices, action: { flowId?: string; workspaceId: string; name: string; document: unknown }): Promise<FlowSaved> {
    const name = action.name.trim();
    const existing = action.flowId !== undefined ? services.flows.get(action.flowId) : null;
    if (action.flowId !== undefined && !existing) return { ok: false, problems: [{ message: 'that flow is gone; nothing was saved' }] };
    const workspaceId = existing?.workspaceId ?? action.workspaceId;
    const workspaces = services.workspaceIds();
    const problems: FlowProblem[] = [];
    if (name === '') problems.push({ message: 'name the flow' });
    if (!workspaces.includes(workspaceId)) problems.push({ message: `there is no workspace "${workspaceId}" in Genie` });
    problems.push(...saveProblems(action.document, { workspaces, agentProblem: (address) => agentWords(services, address) }));
    const door = importFlowDocument(action.document);
    if (!door.ok) for (const p of door.problems.map(problemFromText)) if (!problems.some((q) => q.nodeId === p.nodeId && q.message === p.message)) problems.push(p);
    if (problems.length > 0) return { ok: false, problems };
    if (!existing) {
        const made = await services.flows.create({ workspaceId, name, document: action.document, by: USER });
        return { ok: true, flowId: made.id, disarmed: false };
    }
    const disarm = existing.armed && consentDigest(existing.document) !== consentDigest(action.document);
    await services.flows.update(existing.id, { name, document: action.document }, USER);
    if (disarm) await services.flows.disarm(existing.id, USER);
    return { ok: true, flowId: existing.id, disarmed: disarm };
}

/** An agent address the run could not reach, in words; null when it reaches one agent (the inbox's own rule). */
function agentWords(services: ComposedServices, address: string): string | null {
    const found = services.resolveAddress(address);
    if (found.kind === 'none') return `no agent answers to ${address}`;
    if (found.kind === 'human') return `${address} is you, not an agent`;
    if (found.kind === 'ambiguous') return `${address} names more than one agent (${found.forms.join(', ')}); use the full form`;
    return null;
}

/** What the person agreed to when arming: each node's kind and config, and the wiring — not where nodes sit, or the name. */
function consentDigest(document: unknown): string {
    const nodes = flowNodes(document).map((n) => ({ id: String(n.id), kind: canonicalKind(String(n.kind)), config: n.config ?? null })).sort((a, b) => a.id.localeCompare(b.id));
    const doc = canonicalFlowDocument(document) as { graph?: { edges?: unknown } } | null;
    const edges = (Array.isArray(doc?.graph?.edges) ? (doc!.graph!.edges as Array<Record<string, unknown>>) : [])
        .map((e) => `${String(e.source)}:${String(e.sourceHandle ?? 'out')}->${String(e.target)}:${String(e.targetHandle ?? 'in')}`)
        .sort();
    return JSON.stringify({ nodes, edges });
}

/** The Add-a-site form's PHP version choices: the versions Genie manages, newest first (none wired = no choices, the PATH PHP). */
async function phpChoices(services: ComposedServices, ports: FeaturePorts): Promise<{ phpVersions?: string[] }> {
    const php = ports.toolchain?.php;
    if (!php) return {};
    return { phpVersions: (await php.list(sitePins(services))).managed.map((m) => m.version) };
}

/** Apply one action as the person, then answer with the next snapshot. Refusals throw with the reason — except a toolchain row's, which comes back IN the snapshot, on that row (`toolchain.refusals`). */
export async function handleFeatureAction(services: ComposedServices, action: FeatureAction, state: FeatureState = { toolStatuses: null, knowledgeQuery: '' }, ports: FeaturePorts = {}, origin: FeatureOrigin = REMOTE_ORIGIN): Promise<FeatureData> {
    // genie#1583: which half of a slow action waits, the action itself or the snapshot it answers with.
    const actStarted = Date.now();
    const slow = (part: string, started: number): void => { const ms = Date.now() - started; if (ports.slowPart && ms >= ports.slowPart.ms) ports.slowPart.log(part, ms); };
    const next: FeatureState = { ...state };
    switch (action.kind) {
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
        case 'knowledge.search':
            next.knowledgeQuery = action.query;
            break;
        case 'flows.arm': {
            const r = await services.flows.arm(action.flowId, USER);
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'flows.disarm':
            await services.flows.disarm(action.flowId, USER);
            break;
        case 'flows.remove':
            if (!(await services.flows.remove(action.flowId))) throw new Error(`no flow ${action.flowId}`);
            break;
        case 'flows.runNow': {
            // Started, not awaited: a prompted agent's turn can take minutes. The outcome lands in the flow's run history,
            // and the store's change pushes the snapshot that shows it.
            if (!services.flows.get(action.flowId)) throw new Error(`no flow ${action.flowId}`);
            void services.flowScheduler.runNow(action.flowId).catch((error: unknown) => console.error(`[flows] run now: ${error instanceof Error ? error.message : String(error)}`));
            break;
        }
        // (the old no-op cases for flows.add / hosting.addSite were removed: a switch takes the first match)
        case 'hosting.addSite':
            // Named Genie 1's way, `<folder>.<workspace>` — the agents' `sites add` and `detect` get the same defaults.
            next.siteAdding = { workspaceId: action.workspaceId, repoPath: action.repoPath, defaults: await siteDefaultsIn(services, action.workspaceId, action.repoPath), problems: [], ...(await phpChoices(services, ports)) };
            next.siteEditing = null;
            break;
        case 'hosting.cancelForm':
            next.siteAdding = null;
            next.siteEditing = null;
            break;
        case 'hosting.editSite': {
            // The form opens on the site as it is declared now; a site that cannot be edited says why (thrown).
            const target = siteEditTarget(services, action.siteId);
            // The PHP version choices Add offers, so the form shows the site's pin and saving it never drops it.
            next.siteEditing = { siteId: action.siteId, host: target.site.host, defaults: target.form, problems: [], ...(await phpChoices(services, ports)) };
            next.siteAdding = null;
            break;
        }
        case 'hosting.updateSite': {
            // The same call an agent's `sites update` makes (hosting-actions.ts): the Add form's validation, one envelope write.
            const r = await updateSite(services, { siteId: action.siteId, form: action.form, person: true });
            if (r.kind === 'problems') {
                const open = state.siteEditing ?? { siteId: action.siteId, host: services.sites.get(action.siteId)?.host ?? action.siteId, defaults: action.form, problems: [], ...(await phpChoices(services, ports)) };
                next.siteEditing = { ...open, defaults: action.form, problems: r.problems };
                break;
            }
            next.siteEditing = null;
            break;
        }
        case 'hosting.restartSite':
            // The same call an agent's `sites restart` makes: stopped and started again, and a remembered Stop lifted.
            await restartSite(services, action.siteId, { person: true });
            break;
        case 'hosting.openSite': {
            // The same call an agent's `sites open` makes: checked against the front door's routes, then shown in Genie's browser.
            if (!ports.openInBrowser) throw new Error('this Genie has no browser to open a site in');
            next.browserUrl = (await openSite(services, action.siteId, ports.openInBrowser)).url;
            break;
        }
        case 'flows.openEditor':
            if (!ports.openFlowEditor) throw new Error('this Genie has no flow editor window');
            ports.openFlowEditor(`genie://flow/${encodeURIComponent(action.flowId)}`);
            break;
        case 'flows.newFlow':
            if (!ports.openFlowEditor) throw new Error('this Genie has no flow editor window');
            ports.openFlowEditor(`genie://flow/new?workspace=${encodeURIComponent(action.workspaceId)}`);
            break;
        case 'flows.saveGraph':
            next.flowSaved = await saveGraph(services, action);
            break;
        case 'flows.add':
            next.flowAdding = { defaults: flowFormDefaults({ workspaceId: action.workspaceId }), problems: [] };
            break;
        case 'flows.cancelForm':
            next.flowAdding = null;
            break;
        case 'hosting.createSite': {
            // The same call an agent's `sites add` makes (hosting-actions.ts): one validation, one env, one envelope write.
            const r = await createSite(services, { workspaceId: action.workspaceId, repoPath: action.repoPath, form: action.form });
            if (r.kind === 'problems') {
                // A refused submit is DATA for the form: shown beside the fields, where it was caused.
                const open = state.siteAdding ?? { workspaceId: action.workspaceId, repoPath: action.repoPath, defaults: await siteDefaultsIn(services, action.workspaceId, action.repoPath), problems: [] };
                next.siteAdding = { ...open, problems: r.problems };
                break;
            }
            next.siteAdding = null;
            break;
        }
        case 'flows.edit': {
            const flow = services.flows.get(action.flowId);
            if (!flow) throw new Error('That flow is gone.');
            if (!formEditable(flow.document)) throw new Error(`"${flow.name}" has more than one step, so this form cannot show all of it; it is edited by an agent (flows update) until the canvas editor lands.`);
            next.flowAdding = { defaults: { workspaceId: flow.workspaceId, name: flow.name, document: flow.document, armed: flow.armed }, problems: [], flowId: flow.id };
            break;
        }
        case 'flows.save': {
            const problems = [...validateFlowForm(action.form), ...agentProblems(services, action.form.document)];
            if (problems.length > 0) {
                const open = state.flowAdding ?? { defaults: action.form, problems: [], flowId: action.flowId };
                next.flowAdding = { ...open, problems };
                break;
            }
            // The form's own fields only: the armed state is the person's separate choice (Arm / Disarm), never the form's.
            await services.flows.update(action.flowId, { name: action.form.name, document: action.form.document }, USER);
            next.flowAdding = null;
            break;
        }
        case 'flows.create': {
            const problems = [...validateFlowForm(action.form), ...agentProblems(services, action.form.document)];
            if (problems.length > 0) {
                const open = state.flowAdding ?? { defaults: action.form, problems: [] };
                next.flowAdding = { ...open, problems };
                break;
            }
            next.flowAdding = null;
            await services.flows.create({ workspaceId: action.form.workspaceId, name: action.form.name, document: action.form.document, by: USER, armed: action.form.armed });
            break;
        }
        case 'hosting.trustCertificate': {
            const r = await services.trustCertificate();
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'hosting.syncHosts':
            await services.syncHosts();
            break;
        case 'hosting.retryFrontDoor':
            // The person's Try again on a front door whose port another process held: asked again; started when free.
            await services.retryFrontDoor();
            break;
        case 'hosting.startSite':
            // The person's Start: serves a listed site that is not running, and lifts a remembered Stop.
            await startSite(services, action.siteId, { person: true });
            break;
        case 'hosting.stopSite':
            // The person's Stop, remembered on this machine: the next launch leaves it down.
            await stopSite(services, action.siteId);
            break;
        case 'hosting.removeSite':
            // Removed from the workspace's envelope too, so it does not come back on the next launch.
            await removeSite(services, action.siteId);
            break;
        // A process the person keeps goes through the book, so their start/stop is written down and
        // holds through a restart; a site's or the front door's process is the supervisor's alone.
        case 'hosting.restartProcess':
            if (ports.processes?.owns(action.processId)) await ports.processes.restart(action.processId);
            else if (!services.supervisor.restart(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.stopProcess':
            if (ports.processes?.owns(action.processId)) await ports.processes.stop(action.processId);
            else if (!services.supervisor.stop(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.createProcess': {
            const book = ports.processes;
            if (!book) throw new Error('no process book is wired into this Genie; a background process cannot be kept');
            // With a schedule it is a SCHEDULED TASK (genie#1204, Genie 1's form): kept, enabled, fired by its schedule.
            const cron = action.schedule?.trim();
            await book.create({ workspaceId: action.workspaceId, workspacePath: action.workspacePath, name: action.name, command: action.command, folder: action.folder, restart: action.restart, ...(cron ? { schedule: { cron, kind: 'command' as const }, enabled: true } : {}) });
            break;
        }
        case 'hosting.runScheduledNow': {
            if (!ports.processes?.owns(action.processId)) throw new Error(`no scheduled task ${action.processId} that you keep`);
            if (!ports.processScheduler) throw new Error('this Genie runs no scheduled tasks');
            await ports.processScheduler.runNow(action.processId);
            break;
        }
        case 'hosting.enableSchedule':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no scheduled task ${action.processId} that you keep`);
            await ports.processes.enableSchedule(action.processId);
            break;
        case 'hosting.pauseSchedule':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no scheduled task ${action.processId} that you keep`);
            await ports.processes.pauseSchedule(action.processId);
            break;
        case 'hosting.startProcess':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no background process ${action.processId} that you keep`);
            await ports.processes.start(action.processId);
            break;
        case 'hosting.removeProcess':
            // A site's process goes with its site; only one the person keeps is removed here.
            if (!ports.processes?.owns(action.processId)) throw new Error(`no background process ${action.processId} that you keep; a site's process is removed with its site`);
            await ports.processes.remove(action.processId);
            break;
        case 'services.add':
            next.serviceAdding = { workspaceId: action.workspaceId, defaults: serviceFormDefaults({ workspaceId: action.workspaceId }), problems: [], consent: null };
            break;
        case 'services.cancelForm':
            next.serviceAdding = null;
            break;
        case 'services.create': {
            const open: ServiceAdding = state.serviceAdding ?? { workspaceId: action.form.workspaceId, defaults: action.form, problems: [], consent: null };
            // The same call an agent's `services add` makes (hosting-actions.ts); for an agent, the person's approval is the consent.
            const r = await createService(services, action.form, action.consent);
            if (r.kind === 'problems') {
                next.serviceAdding = { ...open, problems: r.problems, consent: null };
                break;
            }
            if (r.kind === 'needs-consent') {
                // The pull is a download the person should know about: the form stays open, ASKING, with the image named.
                next.serviceAdding = { ...open, problems: [], consent: { image: r.image, note: r.note, form: action.form } };
                break;
            }
            next.serviceAdding = null;
            break;
        }
        case 'services.setActive':
            await setActiveService(services, action.workspaceId, action.engine, action.version);
            break;
        case 'services.use':
            // The PERSON's choice, from the Services tab: no approval (an agent's `use` waits for this person's).
            await useService(services, action.workspaceId, action.serviceId);
            break;
        case 'services.detach':
            await detachService(services, action.workspaceId, action.serviceId);
            break;
        case 'services.start':
            await startService(services, action.serviceId);
            break;
        case 'services.stop':
            await stopService(services, action.serviceId);
            break;
        case 'services.update': {
            const previous = state.serviceUpdating?.serviceId === action.serviceId ? state.serviceUpdating : null;
            const r = await updateService(services, action.serviceId, { ...action, ...(previous ? { expectedImage: previous.image, approvedDependents: previous.dependents } : {}) });
            next.serviceUpdating = r.kind === 'needs-consent' ? r : null;
            break;
        }
        case 'services.cancelUpdate':
            next.serviceUpdating = null;
            break;
        case 'services.remove':
            // A delete-data acts for `workspaceId` (the Services tab sends the engine's sole data holder, core/service-tenancy.ts);
            // refused, with the other holders named, while anyone else keeps data in it.
            await removeService(services, action.serviceId, { deleteData: action.deleteData, ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}) });
            if (state.serviceLogs?.serviceId === action.serviceId) next.serviceLogs = null;
            break;
        case 'services.logs':
            // Read when asked — never on every snapshot: `docker logs` is a call per engine, and a log is looked at, not watched.
            next.serviceLogs = { serviceId: action.serviceId, ...(await serviceLogs(services, action.serviceId, action.tail)) };
            break;
        case 'services.hideLogs':
            next.serviceLogs = null;
            break;
        case 'toolchain.check': {
            const tc = ports.toolchain;
            if (!tc) throw new Error('no toolchain runner is wired into this Genie; the scan cannot run');
            if (shouldCheckUpdates(state.toolchainCheckedAt ?? null, tc.now(), action.force === true)) {
                await rescanToolchain(next, tc, sitePins(services));
            }
            break;
        }
        case 'toolchain.update': {
            const tc = ports.toolchain;
            if (!tc) throw new Error('no toolchain runner is wired into this Genie; the update cannot run');
            clearRefusal(next, action.tool);
            if (next.toolchainUpdated?.tool === action.tool) next.toolchainUpdated = null;
            // THE UPDATE-RISK GUARD (core/toolchain-risk.ts), read here in main from what is running NOW — never from the
            // renderer, and never optional: a guard that can be left unwired is not one.
            if (!tc.activity) {
                refuse(next, action.tool, 'the update guard is not wired into this Genie, so nothing is updated');
                break;
            }
            const known = (state.toolStatuses ?? []).find((t) => t.tool === action.tool);
            const activity = await tc.activity();
            const risk = updateRisk(action.tool, activity, { installed: known ? known.installed !== null : true });
            if (risk.risk === 'blocked') {
                refuse(next, action.tool, risk.reason);
                break;
            }
            if (risk.risk === 'warn' && action.confirmed !== true) {
                next.toolchainWarning = { tool: action.tool, ...(action.version ? { version: action.version } : {}), reason: risk.reason, affected: risk.affected };
                break;
            }
            next.toolchainWarning = null;
            // What runs on the old version NOW — the ones a restart would move (sessions are never restarted).
            const onOld = risk.risk === 'warn' ? activity.processes.filter((p) => p.id !== undefined && risk.affected.includes(p.label)) : [];
            const row = (step: string) => tc.updating?.({ tool: action.tool, ...(action.version ? { version: action.version } : {}), step });
            let outcome: Awaited<ReturnType<typeof tc.update>>;
            try {
                row('Starting');
                outcome = await tc.update(action.tool, action.version, (step) => { if (step) row(step); });
                if (outcome.kind === 'repaired' && onOld.length > 0 && action.restart !== false) row('Restarting');
            } finally {
                tc.updating?.(null);
            }
            if (outcome.kind === 'refused') {
                refuse(next, action.tool, outcome.reason);
                break;
            }
            next.toolchainResult = describeUpdate(action.tool, outcome);
            // It ran and did not take (the re-probe shows the same version, or nothing): said on the row, with a Retry.
            if (outcome.kind !== 'repaired') refuse(next, action.tool, outcome.reason, undefined, action.version ?? '');
            if (outcome.kind === 'repaired') {
                next.toolchainUpdated = { tool: action.tool, version: outcome.to };
                const label = LABELS[action.tool] ?? action.tool;
                const sessions = risk.risk === 'warn' ? risk.affected.filter((a) => !onOld.some((p) => p.label === a)) : [];
                const notes: string[] = [];
                if (onOld.length > 0 && action.restart !== false) {
                    const { restarted, failed } = restartAfterUpdate(services, onOld.map((p) => p.id!));
                    if (restarted.length > 0) notes.push(`Restarted ${restarted.length}.`);
                    if (failed.length > 0) notes.push(`Not restarted: ${failed.join(', ')}.`);
                } else if (onOld.length > 0) {
                    notes.push(`Restart to use it: ${onOld.map((p) => p.label).join(', ')}.`);
                }
                if (sessions.length > 0) notes.push(`${sessions.join(', ')} ${sessions.length === 1 ? 'picks' : 'pick'} it up when next started.`);
                next.toolchainResult = `${label} ${outcome.from ?? ''}${outcome.from ? ' → ' : ''}${outcome.to}.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}${outcome.note ? ` (${outcome.note})` : ''}`;
            }
            // The snapshot shows the RE-PROBE, never the command's word; and the cache is dropped.
            await rescanToolchain(next, tc, sitePins(services));
            break;
        }
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
        case 'toolchain.install': {
            clearRefusal(next, action.tool);
            // Consent first, before anything is asked of the machine: no consent, nothing runs.
            if (action.consent !== true) {
                refuse(next, action.tool, `Genie installs nothing without your go-ahead; ${action.tool} was not installed`);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.install) {
                refuse(next, action.tool, 'no installer is wired into this Genie; nothing was installed');
                break;
            }
            const outcome = await tc.install(action.tool, true);
            if (outcome.kind === 'refused') {
                refuse(next, action.tool, outcome.reason);
                break;
            }
            next.toolchainResult = describeInstall(action.tool, outcome);
            if (outcome.kind === 'not-installed') refuse(next, action.tool, outcome.reason);
            // A prerequisite now present is no longer a finding.
            if (outcome.kind !== 'not-installed' && next.toolchainFindings) {
                next.toolchainFindings = next.toolchainFindings.filter((f) => !(f.result.kind === 'needs-install' && f.result.tool === action.tool));
            }
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
        case 'toolchain.installNode': {
            clearRefusal(next, 'node', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'node', `Genie installs nothing without your go-ahead; Node ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.node) {
                refuse(next, 'node', 'no Node version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.node.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'node', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Node ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Node ${outcome.version} was already installed; nothing was downloaded.`
                    : `Node ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainNode = await tc.node.list();
            break;
        }
        case 'toolchain.removeNode': {
            {
                const current = ports.toolchain?.defaults?.list()['node'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'node', action.version);
                    refuse(next, 'node', `${LANG_LABEL['node']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'node', action.version);
            if (!tc?.node) {
                refuse(next, 'node', 'no Node version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.node.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'node', outcome.reason, action.version);
            else next.toolchainResult = `Node ${outcome.version} was removed.`;
            next.toolchainNode = await tc.node.list();
            break;
        }
        case 'toolchain.installGo': {
            clearRefusal(next, 'go', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'go', `Genie installs nothing without your go-ahead; Go ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.go) {
                refuse(next, 'go', 'no Go version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.go.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'go', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Go ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Go ${outcome.version} was already installed; nothing was downloaded.`
                    : `Go ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainGo = await tc.go.list();
            break;
        }
        case 'toolchain.removeGo': {
            {
                const current = ports.toolchain?.defaults?.list()['go'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'go', action.version);
                    refuse(next, 'go', `${LANG_LABEL['go']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'go', action.version);
            if (!tc?.go) {
                refuse(next, 'go', 'no Go version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.go.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'go', outcome.reason, action.version);
            else next.toolchainResult = `Go ${outcome.version} was removed.`;
            next.toolchainGo = await tc.go.list();
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
        case 'toolchain.machinePath': {
            const tc = ports.toolchain;
            clearRefusal(next, 'machine-path');
            if (!tc?.machinePath) {
                refuse(next, 'machine-path', 'no machine-PATH switch is wired into this Genie; nothing was changed');
                break;
            }
            const outcome = action.apply ? await tc.machinePath.apply(action.consent === true) : await tc.machinePath.remove();
            if (outcome.kind === 'refused' || outcome.kind === 'not-applied') refuse(next, 'machine-path', outcome.reason);
            else next.toolchainResult = outcome.kind === 'applied'
                ? `Genie's defaults are on your PATH (${outcome.where.join(', ')}): terminals outside Genie use them once they are opened again.`
                : `Genie's defaults are off your PATH again (${outcome.where.join(', ') || 'nothing to remove'}); it is as it was.`;
            next.toolchainMachinePath = await tc.machinePath.status();
            break;
        }
        case 'toolchain.setDefault': {
            const tc = ports.toolchain;
            const lang = action.lang;
            const label = LANG_LABEL[lang];
            clearRefusal(next, `${lang}-default`);
            if (!tc?.defaults) {
                refuse(next, `${lang}-default`, `no default switch is wired into this Genie; ${label}'s default was not changed`);
                break;
            }
            const outcome = tc.defaults.set(lang, action.version);
            if (outcome.kind === 'refused') refuse(next, `${lang}-default`, outcome.reason);
            else next.toolchainResult = outcome.kind === 'set'
                ? `${label} ${outcome.version} is now the default — what \`${lang}\` means for Genie's terminals, processes and agents.`
                : `${label}'s default is the one on your PATH again.`;
            next.toolchainDefaults = tc.defaults.list();
            break;
        }
        case 'toolchain.repair': {
            const tc = ports.toolchain;
            if (!tc?.repair) throw new Error('Check and repair is not wired into this Genie; nothing was checked');
            const report = await tc.repair();
            next.toolchainFindings = report.findings;
            next.toolchainRepairedAt = report.checkedAt;
            const repaired = report.findings.filter((f) => f.result.kind === 'repaired').length;
            next.toolchainResult =
                report.findings.length === 0
                    ? "Nothing to repair: each tool runs its newest copy, PHP has a CA bundle, and nothing PHP needs is missing."
                    : `${report.findings.length} problem${report.findings.length === 1 ? '' : 's'} found, ${repaired} repaired.`;
            await rescanToolchain(next, tc, sitePins(services));
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
        case 'knowledge.openAdd':
            next.knowledgeAdding = { defaults: knowledgeFormDefaults(action.workspaceId ? { workspaceId: action.workspaceId } : {}), problems: [] };
            break;
        case 'knowledge.cancelForm':
            next.knowledgeAdding = null;
            break;
        case 'knowledge.create': {
            const problems = validateKnowledgeForm(action.form);
            if (problems.length > 0) {
                next.knowledgeAdding = { defaults: action.form, problems };
                break;
            }
            const added = await services.knowledge.add({ title: action.form.title.trim(), body: action.form.body, class: action.form.class, scope: action.form.scope, source: 'user' });
            next.knowledgeAdding = null;
            // Show what was done: the search lands on the new title, and every link that did not
            // resolve is named with why — an ambiguous link resolves to nothing rather than guessing.
            next.knowledgeLastAdd = { id: added.id, title: action.form.title.trim(), unresolved: added.unresolved.map((u) => ({ ref: u.ref, reason: u.reason })) };
            next.knowledgeQuery = action.form.title.trim();
            break;
        }
        case 'knowledge.add': {
            const r = await services.knowledge.add({ title: action.title, body: action.body, ...(action.class ? { class: action.class } : {}), ...(action.tags ? { tags: action.tags } : {}), scope: action.scope, source: 'user' });
            void r;
            break;
        }
        case 'inbox.send': {
            const hibernated = services.mailRefusal(action.to);
            if (hibernated) throw new Error(hibernated);
            const target = services.resolveAddress(action.to);
            if (target.kind === 'none') throw new Error(`nobody at ${action.to}`);
            if (target.kind === 'ambiguous') throw new Error(`${action.to} names more than one agent — use one of: ${target.forms.join(', ')}`);
            if (target.kind === 'human') throw new Error('that is you');
            // A HOST PATH only from the host's own window, and only what its picker picked (genie#1354): a remote client
            // attaches bytes it uploads (`inbox.sendFile`). `origin` is main's, never the request's — see host-picks.ts.
            const refusal = hostPathRefusal(origin, action.attachments ?? []);
            if (refusal !== null) throw new Error(refusal);
            // One unreadable or executable path fails the whole send; the store says which (§6.4).
            await services.inbox.send({ from: HUMAN, to: target.id, text: action.text, ...(action.attachments && action.attachments.length > 0 ? { attachments: action.attachments } : {}) });
            break;
        }
        // THE AGENTINBOX FLYOUT (beta.33 item 19). A thread's history, by its key or by a message in it (a chat's mail row).
        case 'inbox.thread': {
            const mail = services.inbox.all();
            const key = action.key ?? (action.messageId ? threadKeyOfMessage(mail, action.messageId) : null);
            if (!key) throw new Error(action.messageId ? `no message ${action.messageId}` : 'which thread?');
            const limit = Math.min(Math.max(action.limit, 1), INBOX_THREAD_MAX);
            // A window by seq (the owner, 2026-11-01: sort and page): older BEFORE a seq, a live refresh FROM one.
            const t = threadWindow(mail, key, { limit, beforeSeq: action.beforeSeq, fromSeq: action.fromSeq });
            next.inboxThread = { key, messages: t.messages, more: t.more, newer: t.newer, limit, focus: action.messageId ?? null };
            break;
        }
        // Search ONE thread over its stored mail (the owner, 2026-11-01): history the flyout has not loaded is found too.
        case 'inbox.search': {
            if (!pairOf(action.key)) throw new Error(`${action.key} is not a thread`);
            const mail = services.inbox.all();
            const r = searchThread(mail, action.key, action.query, participantNamer(services.agentAddresses(), mail), INBOX_SEARCH_MAX);
            next.inboxSearch = { key: action.key, query: action.query, hits: r.hits, total: r.total };
            break;
        }
        // The questions an FTQ answer answered (the owner, 2026-11-01), read from the attention store's records.
        case 'inbox.question':
            next.servedQuestion = { id: action.questionId, record: services.attention.asked(action.questionId) };
            break;
        case 'inbox.markAllRead': {
            // The person's own receive, to the end: the only thing that marks mail read.
            const n = services.inbox.unread(HUMAN).length;
            if (n > 0) await services.inbox.receive({ participant: HUMAN, limit: n });
            break;
        }
        case 'inbox.attachment': {
            const a = await services.inbox.attachmentForPerson(action.attachmentId);
            next.servedAttachment = { id: action.attachmentId, name: a.name, base64: a.bytes.toString('base64') };
            break;
        }
        case 'inbox.deleteThread': {
            const pair = pairOf(action.key);
            if (!pair) throw new Error(`${action.key} is not a thread`);
            await services.inbox.deleteThread(pair[0] as never, pair[1] as never);
            break;
        }
        case 'inbox.markRead': {
            const unread = services.inbox.unread(HUMAN);
            const target = unread.find((m) => m.id === action.messageId);
            if (!target) throw new Error(`no unread message ${action.messageId}`);
            // Commit the human's cursor through the human's own receive, up to and including this
            // message — the only thing that marks mail read.
            const before = unread.filter((m) => m.seq < target.seq).length;
            await services.inbox.receive({ participant: HUMAN, limit: before + 1 });
            break;
        }
        case 'issueWatch.setRepo':
            // A Watched repos checkbox: Tynn's switch, one field; Tynn pushes the changed feed, main re-reads the switches.
            await ports.issueWatchSetRepo?.(action.workspaceId, action.owner, action.repo, {
                ...(typeof action.enabled === 'boolean' ? { enabled: action.enabled } : {}),
                ...(typeof action.includeUpstream === 'boolean' ? { includeUpstream: action.includeUpstream } : {}),
            });
            break;
        case 'issueWatch.refresh':
            // The GitHub panel's Refresh: Tynn reads the workspace's repos now and pushes what it finds.
            await ports.issueWatchRefresh?.(action.workspaceId);
            break;
        case 'settings.set':
            await services.settings.set(action.key, action.value);
            // Publisher checks decide whether unsigned plugins are admitted (ADF B5): re-read the folder under the new rule.
            if (action.key === 'publisher_checks_off') await services.pluginsRefresh();
            // The host's switch (Tynn #820): the listener starts or stops with it, now.
            if (action.key === 'remote_access') await ports.remoteAccess?.apply();
            break;
        case 'settings.setSoundFile': {
            // Your own file for an alert (Tynn #766 B2): picked in the window over the host's disk (Tynn #835).
            if (!isAlertSoundKey(action.key)) throw new Error(`${action.key} is not an alert sound`);
            const path = action.path;
            if (!soundFileMime(path)) throw new Error(`${path.split(/[\\/]/).pop()} is not a sound file Genie can play (wav, mp3, ogg, m4a, aac, flac or webm)`);
            await services.settings.set(`${action.key}_custom`, path);
            await services.settings.set(action.key, 'custom');
            break;
        }
        case 'settings.reset':
            await services.settings.reset(action.key);
            break;
        case 'remote.issuePin':
            // `replaces`: Re-pair on a device's row — the device that pairs (and is allowed) takes that one's place.
            await services.remote.issuePin(action.replaces ? { replaces: action.replaces } : {});
            break;
        case 'remote.answerPair': {
            // Allow or Deny on "Pair this device?", from this machine's own window (a remote connection is refused upstream).
            const r = await services.pairing.answer(action.id, action.allow);
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'remote.revokeDevice':
            if (!(await services.remote.revokeDevice(action.deviceId))) throw new Error(`no device ${action.deviceId}`);
            break;
        case 'remote.lock':
            await services.remote.lock();
            break;
        case 'remote.unlock':
            await services.remote.unlock();
            break;
        case 'remote.restart':
            await ports.remoteAccess?.restart();
            break;
        case 'tailscale.up': {
            if (!ports.tailscale) throw new Error('Tailscale is not available here');
            const r = await ports.tailscale.up();
            next.tailscaleOutcome = r.ok ? 'Connected to your tailnet.' : r.authUrl ? 'Tailscale needs you to sign in: the sign-in page opened in your browser.' : (r.message ?? 'Tailscale could not connect.');
            break;
        }
        case 'tailscale.install': {
            if (!ports.tailscale) throw new Error('Tailscale is not available here');
            const r = await ports.tailscale.install();
            next.tailscaleOutcome = r.started ? 'Tailscale’s installer is open: finish it, then Connect.' : r.url ? 'Tailscale’s download page opened in your browser.' : (r.message ?? 'Tailscale could not be installed from here.');
            break;
        }
        // Each goes through Windows' own prompt, then READS WINDOWS AGAIN, so the row shows what Windows now has (Tynn #685).
        case 'remote.allowFirewall': {
            if (!ports.firewall) throw new Error('the firewall rule is only on Windows');
            const r = await ports.firewall.allow();
            await ports.firewall.refresh();
            next.firewallOutcome = r.ok ? 'Allowed: devices on your tailnet can reach this port.' : r.cancelled ? 'Cancelled: Windows asked, and nothing was changed.' : (r.error ?? 'The firewall rule could not be added.');
            break;
        }
        case 'remote.removeFirewall': {
            if (!ports.firewall) throw new Error('the firewall rule is only on Windows');
            const r = await ports.firewall.remove();
            await ports.firewall.refresh();
            next.firewallOutcome = r.ok
                ? 'Removed: Windows Firewall no longer lets devices on your tailnet reach this port.'
                : r.cancelled ? 'Cancelled: Windows asked, and nothing was changed.'
                // netsh failed, and Windows now has no such rule: someone removed it first; say that, not "failed".
                : ports.firewall.rule()?.state === 'absent' ? `Windows has no rule named “${FIREWALL_RULE_NAME}” now: there is nothing to remove.`
                : (r.error ?? 'The firewall rule could not be removed.');
            break;
        }
        // TYNN SIGN-IN, the way Genie 1 did it: open Tynn in the browser, take the code back, Sign out revokes the key.
        case 'integrations.tynnSignIn': {
            // NO KEYRING: no trip to Tynn for a sign-in that could not be kept. The keyring card says why, and its button
            // is the next step (the owner, 2026-11-01).
            if (ports.keyring?.view()) { next.tynnSignInUrl = null; next.tynnMessage = null; break; }
            const { url } = await tynnAccountOf(ports).startSignIn();
            next.tynnSignInUrl = url;
            next.tynnMessage = null;
            break;
        }
        // THE KEYRING CARD'S ONE BUTTON: install, start, restart or check again, whichever the session needs next.
        case 'keyring.fix': {
            if (!ports.keyring) throw new Error('this Genie has no keyring to set up here');
            // Answered once the step is done, or the keyring's own unlock dialog is up (it waits on the person, not on this).
            await (ports.keyring.press ? ports.keyring.press() : ports.keyring.fix());
            break;
        }
        // THE CARD'S CANCEL while the keyring's unlock dialog is up (Tynn story #388).
        case 'keyring.cancel': {
            await ports.keyring?.cancel?.();
            break;
        }
        case 'integrations.tynnCode': {
            const r = await tynnAccountOf(ports).signIn(action.code);
            if (r.ok) { next.tynnSignInUrl = null; next.tynnMessage = null; } else next.tynnMessage = r.reason;
            break;
        }
        case 'integrations.tynnSignOut': {
            const r = await tynnAccountOf(ports).signOut();
            next.tynnSignInUrl = null;
            next.tynnMessage = r.revoked ? null : r.reason;
            break;
        }
        // GITHUB, Genie 1's way (beta.33 item 25): one button starts the device flow (the code comes back in the snapshot and
        // the account waits for GitHub by itself, pushing when it lands); the pages are the account's own URLs.
        case 'integrations.githubSignIn':
            await githubAccountOf(ports).startSignIn();
            break;
        case 'integrations.githubCancelSignIn':
            githubAccountOf(ports).cancelSignIn();
            break;
        case 'integrations.githubRefresh':
            await githubAccountOf(ports).refresh();
            break;
        case 'integrations.githubOpen':
            await githubAccountOf(ports).openPage(action.target);
            break;
        case 'integrations.githubSignOut':
            await githubAccountOf(ports).signOut();
            break;
        case 'plugins.setEnabled':
            // ADF B8: a change the host refuses is a failure the page shows, with Retry; never dropped.
            if (!(await services.plugins.setEnabled(action.id, action.enabled))) throw new Error(`${action.id} could not be ${action.enabled ? 'enabled' : 'disabled'}: it is not an installable plugin here`);
            break;
        case 'plugins.setNetworkAllowed':
            if (!(await services.plugins.setNetworkAllowed(action.id, action.allowed))) throw new Error(`${action.id}: its network can only be allowed or blocked while it is an Unverified plugin here`);
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

