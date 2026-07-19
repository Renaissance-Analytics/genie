/**
 * Typed handle on the contextBridge surface exposed in main/preload.ts.
 * Always go through this — no direct ipcRenderer use anywhere in the
 * renderer.
 */

import { makeRemoteBridge } from './remote-bridge';

export type BackendKind = 'tynn' | 'aionima';

export interface BackendUser {
    backend: BackendKind;
    id: string;
    name: string;
    email?: string;
    kind?: string;
}

export interface TynnProject {
    /** Backend the project lives in. New field — older code without it falls back to 'tynn'. */
    backend?: BackendKind;
    id: string;
    name: string;
    slug: string;
    owner_type?: string;
    owner_name?: string;
    base_url?: string;
}

/**
 * An owner the signed-in user may create a Tynn project under, for the
 * "Create new project" form. "Personal" is always offered first (kind=user);
 * the user's orgs/teams follow.
 */
export interface OwnerOption {
    kind: 'user' | 'organization' | 'team';
    id: string;
    label: string;
}

export interface WorkspaceRow {
    id: string;
    backend: BackendKind;
    project_id: string;
    project_name: string;
    /** Mirrored from project_id / project_name for v1 schema reads. */
    tynn_project_id: string;
    tynn_project_name: string;
    shape: 'agi' | 'simple';
    path: string;
    editor: string | null;
    editor_cmd: string | null;
    start_cmd: string | null;
    env_file: string | null;
    last_opened_at: string | null;
    created_by_genie: number;
    /** User-defined sidebar order (lower = higher). Assigned by main; optional on create. */
    sort_order?: number;
    /** Agent-integration MCP enabled for this workspace's terminals (1/0). */
    mcp_enabled?: number;
    /** Require user approval before an agent (manageProcess) starts a background
     *  process. 1=require approval (default), 0=auto-run. */
    process_approval?: number;
    /** Require user approval before an agent (manageTerminals / runAgent) spawns
     *  a terminal, writes to one, or launches/drives a coding agent. 1=require
     *  approval (default), 0=auto-run. */
    terminal_approval?: number;
    /** Per-workspace IssueWatch remediation policy (null reads as 'surface'). */
    issuewatch_policy?: 'surface' | 'fix' | 'fix-and-ship' | null;
    /** Per-workspace IssueWatch granularity, JSON-encoded (null reads as the
     *  all-on + upstream-issues+prs defaults). Resolve via the dedicated
     *  `workspaces.getIssuewatchGranularity` IPC rather than parsing here. */
    issuewatch_granularity?: string | null;
    /** Per-workspace local-site tunnel settings (serve-local-sites), JSON-encoded
     *  ({ [siteId]: { enabled, genName, scheme, port } }) — the allowlist. Resolve
     *  via the `sites.*` IPC rather than parsing here. */
    tunnel_sites?: string | null;
}

export interface DetectResult {
    state: 'EMPTY' | 'SIMPLE_REPO' | 'PRE_INIT' | 'FULL_ENVELOPE';
    has_project_json: boolean;
    has_root_git: boolean;
    has_gitmodules: boolean;
    repos: string[];
}

/** A ForceTheQuestion question pushed to the modal (mirrors the MCP schema). */
export interface ForceQuestionSpec {
    header: string;
    question: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
}

/** The user's answer to one ForceTheQuestion question. */
export interface ForceAnswerSpec {
    header: string;
    question: string;
    selected: string[];
    note: string;
}

/**
 * Issue Watch: per-workspace tallies by bucket (the 3-dot pill). The three
 * security-alert kinds (dependabot / code-scanning / secret-scanning) collapse
 * into one `security` bucket — the pill shows one security dot, not three.
 * Mirrors `TypeCounts` in main/issue-watch/index.ts.
 */
export interface WatchTypeCounts {
    issue: number;
    pr: number;
    /** dependabot + code-scanning + secret-scanning. */
    security: number;
}

/**
 * Why an Issue Watch read came back empty. `null` means the read SUCCEEDED
 * (genuinely no items) — distinct from a swallowed failure, so the flyout can
 * say "no open issues" only when true and otherwise explain why it can't see
 * them. Mirrors `WatchFetchError` in main/github/api.ts.
 */
export type WatchFetchError =
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'unknown';

/**
 * Issue Watch: a classified read failure PLUS the raw HTTP status + GitHub
 * message behind it, so the flyout can show the EXACT cause ("GitHub returned
 * 401: Bad credentials") rather than a vague "unexpected error". Mirrors
 * `WatchErrorDetail` in main/github/api.ts.
 */
export interface WatchErrorDetail {
    error: WatchFetchError;
    /** Underlying HTTP status when the failure came from GitHub's API. */
    status?: number;
    /** GitHub's message (or the auth-error message) for the failure. */
    message?: string;
}

/** Issue Watch: a detected repo + its watch state for the flyout. */
export interface WatchRepoView {
    owner: string;
    repo: string;
    enabled: boolean;
    unread: number;
    /** Why this repo's last read was empty (null = read ok / never polled). */
    error: WatchFetchError | null;
    /** Raw detail (HTTP status + message) behind `error`, or null. */
    detail: WatchErrorDetail | null;
    /** When this repo is a fork AND the workspace watches upstream, the parent
     *  repo whose Issues/PRs are folded in — drives the "⬆ owner/repo" badge.
     *  Null/absent for a non-fork, an orphan fork, or upstream watching off. */
    upstream?: { owner: string; repo: string } | null;
}

/**
 * Issue Watch granularity — WHAT a workspace watches + pings about (mirrors
 * `IssuewatchGranularity` in main/db.ts). `own` toggles each own-repo kind;
 * `upstream` chooses how much of a fork's parent to watch.
 */
export interface IssuewatchGranularity {
    own: { issues: boolean; pulls: boolean; security: boolean };
    upstream: 'none' | 'issues' | 'issues+prs';
}

/** How an agent acts on an IssueWatch bucket: 'surface' (report only / hold),
 *  'fix' (fix the root cause, report before shipping), or 'fix-and-ship'
 *  (remediate + ship right away). Mirrors `IssuewatchPolicy` in main/db.ts. */
export type IssuewatchPolicy = 'surface' | 'fix' | 'fix-and-ship';

/** The scheme a discovered local site is served under on loopback. */
export type SiteScheme = 'http' | 'https';

/** A discovered local dev site merged with its tunnel settings (mirrors
 *  `SiteView` in main/mobile/hosts.ts) — one `sites.list` row. */
export interface SiteView {
    /** Loopback-mapped hostname from the hosts file (e.g. `tynn.test`). */
    hostname: string;
    /** Measured (or overridden/convention-default) scheme. */
    scheme: SiteScheme;
    /** Measured (or overridden/convention-default) port. */
    port: number;
    /** `'site'` (a real dev vhost) or `'infra'` (docker/minikube/WSL helper). */
    kind: 'site' | 'infra';
    /** Whether this site is tunnelled (the allowlist toggle; default OFF). */
    enabled: boolean;
    /** The assigned `*.gen` name (stored override, else derived from hostname). */
    genName: string;
    /** Opaque, stable allowlist key — pass it to `sites.set`. */
    siteId: string;
    companions?: Array<{
        id: string;
        enabled?: boolean;
        hostname: string;
        scheme: SiteScheme;
        port: number;
        loopback?: '127.0.0.1' | '::1';
        siteId?: string;
    }>;
}

/** One local dev site in the header `.gen` popover — opens in the Testing
 *  Browser via the loopback carrier. */
export interface LocalGenSite {
    genName: string;
    /** The upstream loopback vhost the `.gen` maps to (e.g. tynn.test). */
    hostname: string;
}

/** One connected host's enabled `.gen` site in the header popover. */
export interface HostGenSite {
    genName: string;
    siteId: string;
    hostname: string;
}

/** The header `.gen` popover payload: local sites + per-connected-host sites. */
export interface GenSitesAll {
    local: LocalGenSite[];
    hosts: Array<{ connKey: string; hostname: string; sites: HostGenSite[] }>;
}

/** A per-site tunnel-config patch (mirrors `TunnelSiteConfig` in
 *  main/mobile/hosts.ts). Every field optional — send only what changed. */
export interface TunnelSiteConfig {
    enabled?: boolean;
    genName?: string;
    scheme?: SiteScheme;
    port?: number;
    companions?: Array<{
        id: string;
        enabled?: boolean;
        hostname: string;
        scheme: SiteScheme;
        port: number;
        loopback?: '127.0.0.1' | '::1';
    }>;
}

/** Per-bucket IssueWatch remediation policy (mirrors main/db.ts). The three count
 *  buckets — security (dependabot + code-scanning + secret-scanning), issue, pr —
 *  each carry their own policy. */
export interface IssuewatchPolicyBuckets {
    security: IssuewatchPolicy;
    issue: IssuewatchPolicy;
    pr: IssuewatchPolicy;
}

/** Issue Watch: the surfaced per-workspace status (why the feed is what it is). */
export interface WorkspaceWatchStatus {
    connected: boolean;
    error: WatchFetchError | null;
    /** Raw detail (HTTP status + message) behind `error`, or null. */
    detail: WatchErrorDetail | null;
    /** True when the stored GitHub session is dead — show a Reconnect CTA. */
    needsReauth: boolean;
    /**
     * The Issue Watch capabilities the SERVING machine's GitHub App is missing
     * (the `issue-watch.*` keys the flyout gates on). Host-sourced in a remote
     * window (via the bridge's `/api/desktop/issue-watch/status`) so the gate
     * reflects the HOST's App grants, not the client's. Optional so an older
     * host that predates the field degrades to "nothing gated" instead of
     * breaking. Empty when GitHub isn't connected.
     */
    missingCapabilities?: GithubCapabilityKey[];
    serviceState?: 'connecting' | 'connected' | 'signed-out' | 'disabled' | 'disconnected';
}

/** Issue Watch: one feed item (issue / PR / security alert). */
export interface WatchFeedItem {
    kind: 'issue' | 'pr' | 'dependabot' | 'code-scanning' | 'secret-scanning';
    key: string;
    number: number | null;
    title: string;
    url: string;
    updatedAt: string;
    author?: string;
    severity?: string;
    owner: string;
    repo: string;
    /** Whether this item is from the watched repo itself or its fork-upstream —
     *  the flyout groups the feed into "This repo" and "Upstream" sections. */
    source: 'own' | 'upstream';
    unread: boolean;
}

/**
 * A GitHub-dependent Genie capability key (mirrors `CapabilityKey` in
 * main/github/capabilities.ts). The renderer gates features off these keys.
 */
export type GithubCapabilityKey =
    | 'issue-watch.issues'
    | 'issue-watch.pulls'
    | 'issue-watch.dependabot'
    | 'issue-watch.code-scanning'
    | 'issue-watch.secret-scanning'
    | 'github.provision';

/** A GitHub App permission name Genie depends on (mirrors `GhPermission`). */
export type GithubPermission =
    | 'metadata'
    | 'issues'
    | 'pull_requests'
    | 'vulnerability_alerts'
    | 'security_events'
    | 'secret_scanning_alerts'
    | 'contents'
    | 'administration';

/** The access level a permission is granted/required at (mirrors `GhAccess`). */
export type GithubAccess = 'read' | 'write' | 'admin';

/**
 * One installation missing a permission, with the deep-link to ITS own review
 * page (mirrors `MissingInstallation` in capability-service.ts). GitHub has no
 * bulk-approve, so the resolve flow lists each one with its own link.
 */
export interface GithubMissingInstallation {
    login: string;
    installationId: number | null;
    isOrg: boolean;
    reviewUrl: string;
}

/**
 * Per missing permission, the installations not granting it (mirrors
 * `MissingPermissionGroup`). Drives the resolve flow's per-install list.
 */
export interface GithubMissingPermissionGroup {
    permission: GithubPermission;
    access: GithubAccess;
    installations: GithubMissingInstallation[];
}

/**
 * The GitHub capability status (mirrors `GithubCapabilities` in
 * main/github/capability-service.ts). `connected:false` ⇒ no token; the gate is
 * inert and features use their normal not-connected handling. `missing` is the
 * set of capabilities the installed App's granted permissions don't cover —
 * those are gated OFF and surfaced via the resolve modal + header warning.
 */
export interface GithubCapabilities {
    connected: boolean;
    satisfiedFeatures: GithubCapabilityKey[];
    missing: GithubCapabilityKey[];
    missingPermissions: GithubPermission[];
    /**
     * Per missing permission, the SPECIFIC installations not granting it (each
     * with a deep-link to its own review page). The resolve flow lists these so
     * the user knows which installs to approve (no GitHub bulk-approve). Empty
     * while disconnected / before the first check.
     */
    missingByPermission: GithubMissingPermissionGroup[];
    /**
     * Deep-link to the App's permission-settings page, where the App OWNER adds
     * a missing permission (the real first step — until they do, there's nothing
     * pending for any install to approve).
     */
    appPermissionsUrl: string;
    checked: boolean;
}

export interface Settings {
    primary_workspace?: string;
    /** Last-activated workspace id in the master view. */
    active_workspace?: string;
    /** Collapsed sidebar workspace rows — JSON-encoded string[] of workspace
     *  ids. Persists the expand/collapse state across restarts. */
    collapsed_workspaces?: string;
    default_env_file?: string;
    global_hotkey?: string;
    tynn_host?: string;
    notifications_muted?: string;
    auto_update?: 'on' | 'off';
    /** Default shell id ('git-bash' | 'pwsh' | … | 'custom'). Empty = auto-detect. */
    terminal_shell?: string;
    /** Manual executable line, used when terminal_shell === 'custom'. */
    terminal_custom_cmd?: string;
    /** Max panels visible at once per workspace. String-encoded; default '4'. */
    max_views?: string;
    /** Per-workspace draggable-grid track sizes, JSON-encoded. Keyed per window
     *  (`${connKey}|${workspaceId}|${signature}`). */
    layout_json?: string;
    /** CLIENT-LOCAL panel view state (visible set, focus, maximize, layout) per
     *  `${connKey}|${workspaceId}`, JSON-encoded. Local-only (never bridged to a
     *  host). See `renderer/lib/view-state.ts`. */
    view_state_json?: string;
    /** Tier 3: keep terminals running in a detached host so they survive a full
     *  quit. Defaults 'off' (in-process). 'on' opts in. */
    detached_terminals?: 'on' | 'off';
    /** Whether Genie launches minimized to the tray (default 'off' = start open). */
    start_minimized?: 'on' | 'off';
    /** Play a chime when an agent calls imDone. Defaults 'off'. */
    notify_sound?: 'on' | 'off';
    /** Show an OS notification (tray popup) when an agent calls imDone.
     *  Defaults 'off'. */
    notify_toast?: 'on' | 'off';
    /** Which sound the imDone alert plays (gated by notify_sound): 'synth' (the
     *  built-in chime, default), a bundled wav ('3tootpipe' | 'dingdongdoink'),
     *  'custom' (sound_imdone_custom file), or 'off'. */
    sound_imdone?: 'off' | 'synth' | '3tootpipe' | 'dingdongdoink' | 'sparkle' | 'triumphant' | 'winddown' | 'custom';
    /** Absolute path to the custom imDone sound (used when sound_imdone === 'custom'). */
    sound_imdone_custom?: string;
    /** Which sound the ForceTheQuestion alert plays. Same value set as
     *  sound_imdone; default 'synth'. */
    sound_forcequestion?: 'off' | 'synth' | '3tootpipe' | 'dingdongdoink' | 'sparkle' | 'triumphant' | 'winddown' | 'custom';
    /** Absolute path to the custom ForceTheQuestion sound (used when
     *  sound_forcequestion === 'custom'). */
    sound_forcequestion_custom?: string;
    /** Fixed loopback port for the agent-integration MCP server. String-encoded;
     *  default '51717'. Changing it requires restarting the MCP server. */
    mcp_port?: string;
    /** Phone web UI (mobile) server. Opt-in: 'off' (default) | 'on'. */
    mobile_enabled?: 'on' | 'off';
    /** Desktop Genie Remote — allow another Genie in Remote mode to drive this host.
     *  Opt-in: 'off' (default) | 'on'. Independent of `mobile_enabled`: either can be
     *  on alone; the host server binds while either is on. */
    remote_enabled?: 'on' | 'off';
    remote_network_local?: 'on' | 'off';
    remote_network_lan?: 'on' | 'off';
    remote_network_tailscale?: 'on' | 'off';
    remote_network_tynn?: 'on' | 'off';
    /** Fixed port for the mobile server (bound on the Tailscale IP). String-
     *  encoded; default '51718'. Changing it requires restarting the server. */
    mobile_port?: string;
    /** Serve-local-sites master switch (serve-local-sites). Opt-in: 'off'
     *  (default) | 'on'. Distinct from mobile_enabled — exposing your dev sites
     *  is a separate, deliberate decision. Per-repo `.gen` enables sit on top. */
    local_sites_enabled?: 'on' | 'off';
    /** Keep the Genie endpoint synced into each workspace's Claude `.mcp.json`.
     *  Default 'on'; 'off' leaves that file alone. */
    mcp_sync_claude?: 'on' | 'off';
    /** Keep it synced into Cursor `.cursor/mcp.json`. Default 'on'. */
    mcp_sync_cursor?: 'on' | 'off';
    /** Inject workspace-scoped MCP config into Codex Agent Terminal launches. */
    mcp_sync_codex?: 'on' | 'off';
    /** Keep the Genie brief synced into AGENTS.md. Default 'on'. */
    mcp_sync_agents?: 'on' | 'off';
    /** Terminal copy/paste behaviour: 'contextmenu' (default) | 'linux'
     *  (highlight-to-copy, right/middle-click paste) | 'winmac' (Ctrl/Cmd+C / +V). */
    terminal_copy_paste?: 'contextmenu' | 'linux' | 'winmac';
    /** Ai.System — instruction set injected into every workspace's AGENTS.md
     *  (inside the Genie Protocol block). Capped at 2000 chars. Default ''. */
    ai_system?: string;
    /** Split Add-Terminal button: the last terminal type the user created
     *  (`regular` | `claude` | `codex` | `custom`). Drives the main button's
     *  default action. RUNTIME-owned — written by the master as terminals are
     *  created, never by the Settings UI. Default 'regular'. */
    last_terminal_type?: string;
    /** Specialized terminals: the launch command for a Claude Code agent
     *  (resolved server-side; blank = the built-in default `claude`). */
    agent_command_claude?: string;
    /** Specialized terminals: the launch command for a Codex agent (blank =
     *  the built-in default). */
    agent_command_codex?: string;
    /** Specialized terminals: the launch command for a Custom agent — no
     *  built-in default, so a per-terminal command is required when blank. */
    agent_command_custom?: string;
    /** Specialized terminals: always-on launch flags for a Claude Code agent —
     *  appended after the command, before Genie's `--session-id` (e.g.
     *  `--dangerously-skip-permissions`). Blank = none. */
    agent_flags_claude?: string;
    /** Specialized terminals: always-on launch flags for a Codex agent. */
    agent_flags_codex?: string;
    /** Specialized terminals: always-on launch flags for a Custom agent. */
    agent_flags_custom?: string;
}

/** Health of a workspace's agent docs (AGENTS.md + Genie section + CLAUDE sync). */
export interface WorkspaceDocHealth {
    hasAgents: boolean;
    hasGenieSection: boolean;
    /** missing | symlink | broken-pointer | mirror | divergent */
    claude: string;
    claudeDivergent: boolean;
    healthy: boolean;
}

/** Result of a re-runnable workspace-doc repair pass. */
export interface RepairDocsResult {
    health: WorkspaceDocHealth;
    actions: string[];
    claudeDivergent: boolean;
    backedUpTo?: string;
}

/** Live state of the agent-integration MCP server (Settings → Agent MCP). */
export interface McpServerState {
    running: boolean;
    /** The port actually bound (null when not running). */
    port: number | null;
    /** The port the user configured (what the server tries to bind). */
    configuredPort: number;
    /** True when the configured port was taken and the server fell back. */
    conflict: boolean;
}

/**
 * Live state of the mobile remote-control server (Settings → Mobile), bundled
 * with the pairing PIN + a QR data-URL of the pairing link. The phone NEVER sees
 * this — it's the desktop Settings view's status. `url` is the tailnet phone URL
 * `http://<ip>:<port>/m/` (null when not bound); `tailnetNotDetected` is true
 * when the server is enabled but no Tailscale interface was found (fail closed);
 * `conflict` is true when the configured port was taken (no silent fallback);
 * `locked` reflects the global kill-switch.
 */
/** One paired device in the host-side Devices roster (no bearer token). */
export interface MobileDevice {
    /** Stable, non-secret roster id (used to revoke this one device). */
    id: string;
    /** Short human label derived from the device's User-Agent. */
    label: string;
    /** The tailnet IP it paired from ('' if unknown / pre-upgrade). */
    ip: string;
    /** When it paired (epoch ms). */
    createdAt: number;
}

export interface MobileStatus {
    running: boolean;
    /** True when the host server is bound (either the phone UI or desktop remote is on). */
    enabled: boolean;
    /** True when the phone web UI (`/m`) is being served. */
    mobileUiEnabled: boolean;
    /** True when desktop Genie Remote connections are allowed (independent of the phone UI). */
    remoteEnabled: boolean;
    /** The bound Tailscale IPv4 (null when not running). */
    ip: string | null;
    /** The bound port (null when not running). */
    port: number | null;
    /** The port the user configured. */
    configuredPort: number;
    /** The phone URL `http://<ip>:<port>/m/`, or null when not running. */
    url: string | null;
    /** True when the configured port was taken (restart on a free port to fix). */
    conflict: boolean;
    /** True when enabled but no Tailscale interface was detected (fail closed). */
    tailnetNotDetected: boolean;
    listeners: Array<{
        network: 'local' | 'lan' | 'tailscale';
        ip: string;
        port: number;
        secure: boolean;
    }>;
    /** True when the global kill-switch ("Lock") is engaged. */
    locked: boolean;
    /** The 6-digit pairing PIN (shown big + in the QR). */
    pin: string;
    /** A data-URL PNG QR of `<url>?pair=<pin>`, or null when not bound. */
    qrDataUrl: string | null;
    /** Remotes currently connected (drives the host's "remote session" overlay). */
    peers: MobilePeer[];
    /** win32 only: server is listening but no inbound Windows Firewall rule for the
     *  live port exists — a paired phone can't connect until it's allowed. Always
     *  false on non-win32 / when a matching rule is present. */
    needsFirewallRule: boolean;
    /** True when served over browser-trusted HTTPS (a Tailscale cert was issued);
     *  false = http-over-WireGuard (still encrypted — the fail-open fallback). */
    secure: boolean;
}

/** A remote/phone currently controlling THIS host. */
export interface MobilePeer {
    ip: string;
    since: number;
}

/** A peer node on the tailnet (from `tailscale status`). */
export interface TailnetPeer {
    hostname: string;
    ip: string | null;
    online: boolean;
    os: string;
}

/** Tailscale lifecycle status for the Work Mode settings (mirrors main/tailscale). */
export interface TailscaleStatus {
    installed: boolean;
    running: boolean;
    self: { ip: string | null; hostname: string; online: boolean } | null;
    peers: TailnetPeer[];
    authUrl?: string | null;
}

/** A Genie host discovered on the tailnet (Work Mode remote). */
export interface GenieHost {
    hostname: string;
    peerName: string;
    ip: string;
    port: number;
    /** Stable per-install identity (from the beacon); absent for an old host. */
    hostId?: string;
    /** MagicDNS dial address advertised by the beacon. */
    dnsName?: string;
    /** `host:<hostId>` once identified, else `ip:port` — the merge/connect key. */
    connKey: string;
}

/** One enabled `.gen` tunnel site shown in the Testing Browser chrome. */
export interface TestingBrowserSite {
    genName: string;
    hostname: string;
    scheme: string;
    port: number;
}

/** One Testing Browser tab (the site content is a main-owned WebContentsView). */
export interface TestingBrowserTab {
    id: string;
    url: string;
    title: string;
}

/** The Testing Browser chrome's render state (serve-local-sites Phase D). Mirrors
 *  `chromeState` in main/testing-browser/index.ts. */
export interface TestingBrowserState {
    connKey: string;
    hostname: string;
    tabs: TestingBrowserTab[];
    activeTabId: string | null;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    presetId: string;
    presets: Array<{ id: string; label: string }>;
    sites: TestingBrowserSite[];
}

/** The host this Genie is driving in remote mode (no token — main holds that). */
export interface RemoteHost {
    ip: string;
    port: number;
    hostname: string;
    /** Stable per-install identity (survives IP changes); absent for an old host. */
    hostId?: string;
    /** MagicDNS dial address. */
    dnsName?: string;
}

/** Remote-mode status surfaced to the renderer (titlebar indicator + bridge). */
export interface RemoteStatus {
    connected: boolean;
    host: RemoteHost | null;
}

/**
 * Bridge link health for a host window — drives the upgrade/limbo overlay:
 *   - connected     — versions match, normal operation,
 *   - mismatch      — incompatible bridge protocol (direction → upgrade host vs
 *                     update this Genie),
 *   - reconnecting  — host dropped / upgrading; overlay + auto-reconnect,
 *   - lost          — host didn't return within the limbo timeout (manual retry).
 */
export interface RemoteLinkState {
    phase: 'connected' | 'mismatch' | 'reconnecting' | 'lost';
    direction?: 'host-behind' | 'client-behind';
    hostVersion?: number;
    localVersion?: number;
    reason?: 'upgrade' | 'dropped';
    /** Soft, non-blocking nudge (phase 'connected' only): host is on an older
     *  RELEASE build than this client, but still wire-compatible. `hostVersion`
     *  is null when the host is provably older but reports no version. */
    hostBuildBehind?: { hostVersion: string | null; localVersion: string };
}

/** A host remembered in the Hosts picker (persisted; survives discovery gaps). */
export interface KnownHost {
    ip: string;
    port: number;
    hostname: string;
    /** User-chosen label; the UI falls back to hostname. */
    name?: string;
    /** Stable per-install identity (when known); the record is keyed by it. */
    hostId?: string;
    /** Last-seen MagicDNS dial address. */
    dnsName?: string;
    /** `host:<hostId>` once identified, else `ip:port` — the registry key. */
    connKey: string;
    /** Whether this host currently has a live connection (a host window open). */
    connected: boolean;
    /** Whether that live connection currently has terminal streams attached. */
    activeTerminals: boolean;
}

/** A Virtual Workstation the signed-in member may connect to (Hosts picker).
 *  `connectable` is true only when it's active AND the member is entitled. */
export interface ConnectableWorkstation {
    id: string;
    name: string;
    status: string;
    is_local: boolean;
    relay_endpoint: string;
    connectable: boolean;
    capability: string | null;
    scopes: string[];
    source: 'owner' | 'grant' | 'invite' | null;
}

export interface DocEntry {
    slug: string;
    title: string;
}

export interface ShellDetection {
    id: string;
    label: string;
    command: string;
    args: string[];
}

export interface AionimaConfig {
    host?: string;
    token?: string | null;
}

export interface InboxPayload {
    count: number;
    events: Array<{
        id: string;
        backend: BackendKind;
        kind: string;
        actor: string;
        subject: string;
        url: string;
        when: string;
    }>;
}

export interface SignedInSummaryItem {
    backend: BackendKind;
    user: BackendUser;
    host: string;
}

export type UpdaterState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'applying'      // phase 1
    | 'downloading'   // phase 2
    | 'ready-to-restart'
    | 'error'
    | 'disabled';

export interface UpdaterStatus {
    state: UpdaterState;
    currentVersion: string;
    latestVersion: string | null;
    publishedAt: string | null;
    releaseUrl: string | null;
    log: string[];
    error: string | null;
    /** Only meaningful for the phase-1 backend. */
    repo?: string | null;
    /** Only meaningful during phase-2 download: 0..1. */
    progress?: number | null;
    /**
     * True when APPLYING this update will restart the detached pty-host —
     * i.e. a host-backed build with detached terminals running. On the update
     * path the host pins Genie's binary so it must be killed for NSIS to
     * replace it; live terminals come back from a snapshot (history kept,
     * running processes stop). The update pill warns the user when this is set.
     */
    willRestartPtyHost?: boolean;
    /**
     * Set when auto-update can't apply on this platform (macOS, where an
     * unsigned/ad-hoc build fails Squirrel.Mac signature validation). The UI
     * shows a "Download manually" button pointing here instead of a dead error.
     */
    manualDownloadUrl?: string | null;
    /**
     * Present at 'ready-to-restart' ONLY when applying would INTERRUPT live work
     * (running terminals / agent chats the restart tears down). When set, the
     * hands-free auto-apply is HELD: the pill shows an explicit "Restart & update"
     * confirm with the count, so an upgrade never silently kills a live session.
     */
    interruption?: { terminals: number; agentChats: number } | null;
}

export interface UpdaterConfig {
    repo: string;
    pollHours: number;
}

export interface ChangelogGroup {
    version: string;
    changes: string[];
}
export interface Changelog {
    current: string;
    latest: string;
    groups: ChangelogGroup[];
    partial: boolean;
}

/** A view spec is a terminal, a fancy-code editor, or a background process runner. */
export type ViewType = 'terminal' | 'code' | 'process' | 'plugin';

/** Lifecycle status of a background Process service runner. */
export type ProcessStatus =
    | 'running'
    | 'stopped'
    | 'crashed'
    | 'restarting'
    | 'failed';

/**
 * One Task Manager row: a background process plus the workspace that spawned
 * it. `workspace` is the spawning workspace's display name, or "System" for a
 * System-Workspace process (and `workspaceId` is null for those).
 */
export interface ProcessListItem {
    id: string;
    /** Discriminates a background process from an interactive terminal/pty. */
    kind: 'process' | 'terminal';
    label: string;
    command: string;
    workspace: string;
    workspaceId: string | null;
    status: ProcessStatus;
    autostart: boolean;
}

/** Per-type spec metadata. Code views persist the open file's relative path. */
export interface ViewMeta {
    file_path?: string;
    /** When true, this code view is pinned to `root` + reopens `file_path`. */
    locked?: boolean;
    /** Workspace-relative folder the tree is rooted at when locked. '' = workspace root. */
    root?: string;
    /** Code view: workspace-relative paths of the open editor tabs (in tab order). */
    open_files?: string[];
    /** Code view: workspace-relative path of the active (front) tab. */
    active_file?: string;
    /** Code view: when true, the file tree stays open after opening a file. */
    tree_pinned?: boolean;
    /** Code view: ids of the tree folders left expanded, restored on relaunch. */
    expanded_tree_ids?: string[];
    /** Code view: word-wrap toggle state. */
    word_wrap?: boolean;
    /**
     * Code view: a TRANSIENT 1-based line to reveal when a freshly-created
     * editor panel mounts (openFileForUser at a line that opened a new panel).
     * Consumed + cleared by CodePanel on mount so it never re-reveals on a
     * later relaunch — it is not persisted scroll state.
     */
    reveal_line?: number;
    /** Process view: the command line run (non-interactively) by the runner. */
    command?: string;
    /** Process view: start automatically when the workspace/app opens. */
    autostart?: boolean;
    /** Process view: relaunch the command (with backoff) if it exits/crashes. */
    restart_on_exit?: boolean;
    /** Process view: persisted "was running" intent — restores the process on
     *  next launch if Genie went down while it was running (service-like). */
    was_running?: boolean;
    /** System Workspace tag (unattached spec grouped under the System Workspace). */
    system?: boolean;
    /** Plugin editor view: the owning plugin id (§6.1). */
    plugin_id?: string;
    /** Plugin editor view: the plugin's editor id from its manifest. */
    editor_id?: string;
    /** Plugin editor view: the workspace-relative file the editor is bound to. */
    file?: string;
    /** Plugin editor view: the declared first-party Fancy component export. */
    fancy_export?: string;
    /** Plugin editor view: the declared Fancy package + version (provenance). */
    fancy_package?: string;
    fancy_version?: string;
    /** Specialized terminal: the AI-TUI kind this terminal launches (claude /
     *  codex / custom). Set on agent terminals created via terminalSpec.createAgent;
     *  absent on a plain shell. Gates the AgentInbox identity + the sidebar badge. */
    agent?: AgentType;
    /** Specialized terminal: the resolved command line the agent was launched with
     *  (informational — the launch profile / resolveAgentCommand fills this). */
    agent_command?: string;
    /** AgentInbox: this agent's channel purpose (kebab, ≤6 words; default `general`). */
    purpose?: string;
    /** AgentInbox: who can discover / DM this agent — see {@link AgentInboxScope}. */
    scope?: AgentInboxScope;
    /** AgentInbox: the chosen workspace ids when `scope === 'specific'`. */
    scope_workspaces?: string[];
    [key: string]: unknown;
}

/** The AI-TUI kind a specialized terminal launches. */
export type AgentType = 'claude' | 'codex' | 'custom';

/**
 * AgentInbox accessibility scope — who can DISCOVER + DM this agent:
 *  - `none`     — hidden (may still lurk-and-broadcast in a channel it joined),
 *  - `self`     — same-workspace agents only (DEFAULT),
 *  - `specific` — the workspaces the owner picks (∪ its own),
 *  - `all`      — every agent on the workstation.
 * Channel broadcasts reach members regardless of scope.
 */
export type AgentInboxScope = 'none' | 'self' | 'specific' | 'all';

/** A discoverable AgentInbox agent (directory row / presence payload). */
export interface AgentInboxAgentInfo {
    agentId: string;
    terminalId: string;
    workspaceId: string | null;
    workspaceName: string;
    /** The workspace slug the channel name is built from. */
    slug: string;
    /** 'claude' | 'codex' | 'custom' (or another launched TUI kind). */
    agentType: string;
    label: string;
    purpose: string;
    scope: AgentInboxScope;
    scopeWorkspaces: string[];
    status: 'online' | 'away' | 'offline';
    /** The captured AI chat-session uuid, or null when not yet detected. */
    chatSessionId: string | null;
}

/** An AgentInbox broadcast channel (`slug:purpose`), keyed internally by workspace. */
export interface AgentInboxChannelInfo {
    /** Opaque internal key (`workspaceId:purpose`). */
    key: string;
    /** The workspace slug displayed in the `slug:purpose` label. */
    slug: string;
    purpose: string;
    workspaceId: string | null;
    workspaceName: string;
    memberCount: number;
}

/** An AgentInbox DM thread (a message-carrying pair) — human↔agent OR
 *  agent↔agent — as the human panel's DMs list reports it. */
export interface AgentInboxDmThreadInfo {
    /** Order-independent pair key (`idA|idB`). */
    key: string;
    /** Participant ids (either may be `'human'`). */
    a: string;
    b: string;
    /** Display labels (`You` for the human; a logged label for a departed agent). */
    aLabel: string;
    bLabel: string;
    /** True when the human is a participant (else agent↔agent). */
    withHuman: boolean;
    lastFromLabel: string;
    lastPreview: string;
    lastSeq: number;
    lastTs: number;
    count: number;
}

/** One AgentInbox message (channel broadcast or 1:1 DM). */
export interface AgentInboxMessage {
    seq: number;
    id: string;
    /** Sender agentId, or `'human'` for a message posted from the panel. */
    from: string;
    fromLabel: string;
    kind: 'dm' | 'channel';
    /** Channel key when `kind === 'channel'`. */
    channel?: string;
    /** Recipient agentId when `kind === 'dm'`. */
    to?: string;
    text: string;
    ts: number;
}

/** Live presence event: a full agent snapshot, or a terse offline/left tick. */
export type AgentInboxPresenceEvent =
    | AgentInboxAgentInfo
    | { agentId: string; status: 'offline'; left: true };

/** Live message event (preview only — the full body is fetched via history). */
export interface AgentInboxMessageEvent {
    kind: 'dm' | 'channel';
    channelKey?: string;
    toAgentId?: string;
    from: string;
    fromLabel: string;
    seq: number;
    ts: number;
    preview: string;
}

/** Track C — an unACKed urgent DM escalating to the human oversight surface, or
 *  (`resolved: true`) the clearing of a previously-raised alert. */
export interface AgentInboxEscalationEvent {
    messageId: string;
    targetAgentId: string;
    targetLabel?: string;
    fromLabel?: string;
    preview?: string;
    sinceTs?: number;
    resolved?: boolean;
}

/** Result of a plugin-editor binary read (base64 payload) (§6.2). */
export interface PluginEditorReadResult {
    ok: boolean;
    value?: { base64: string; bytes: number; relPath: string };
    error?: string;
}

/** Result of a plugin-editor binary write (§6.2). */
export interface PluginEditorWriteResult {
    ok: boolean;
    value?: { relPath: string; bytes: number };
    error?: string;
}

export interface TerminalSpec {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    shell: string | null;
    args: string[];
    env: Record<string, string>;
    type: ViewType;
    meta: ViewMeta;
    sort_order: number;
    created_at: string;
    last_opened_at: string | null;
    /** Epoch ms of the last persisted session snapshot, or null when none (Tier 1). */
    snapshot_at: number | null;
    /** On-disk encrypted snapshot size in bytes, or null when none (Tier 1). */
    snapshot_bytes: number | null;
    /** Last cwd the shell reported via OSC-7, or null when unknown (Tier 1.5). */
    live_cwd: string | null;
    /**
     * Tier 2: true when live/visible, false when DISABLED (suspended-but-
     * retained — spec kept, pty kept alive while the app is open). Pre-v6 rows
     * read back as true.
     */
    enabled: boolean;
}

/**
 * One node in the Code View file tree. Shape-compatible with react-fancy's
 * `TreeNodeData` so it can be fed straight into `<TreeNav>`. Produced by
 * the main-side `files:list-tree` walk.
 */
export interface TreeNodeData {
    id: string;
    label: string;
    type?: 'file' | 'folder';
    ext?: string;
    children?: TreeNodeData[];
}

/**
 * Normalised git status token for one file, produced by `files:git-status`.
 * Maps a workspace-relative path → one of these. Used to colour the tree.
 */
export type GitFileStatus =
    | 'untracked'
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'ignored';

export type GitStatusMap = Record<string, GitFileStatus>;

interface CreateAgiOpts {
    slug: string;
    name: string;
    parent_path: string;
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

export interface CreateAgiResult {
    path: string;
    git_log_count: number;
    remote?: string;
}

/** A member repo of an envelope as the workspace settings window sees it. */
export interface EnvelopeRepoView {
    name: string;
    url: string | null;
    role: 'host' | 'package' | null;
    /** Checkout path inside the envelope (`repos/<name>`). */
    path: string;
    /** Present in project.json `repos[]`. */
    inRegistry: boolean;
    /** A git checkout exists at `repos/<name>` on disk. */
    onDisk: boolean;
}

export interface EnvelopeReposResult {
    /** False for a plain-folder (non-`.agi`) workspace — UI hides the section. */
    isEnvelope: boolean;
    repos: EnvelopeRepoView[];
}

/** Result of an envelope repo / knowledge mutation. */
export interface RepoMutationResult {
    ok: boolean;
    error?: string;
}

/** One `.ai/` knowledge folder's state. */
export interface KnowledgeFolderView {
    name: string;
    /** Envelope-relative path, e.g. `.ai/knowledge`. */
    relPath: string;
    exists: boolean;
    /** Entries directly inside (0 when absent; `.gitkeep` excluded). */
    entryCount: number;
}

export interface KnowledgeResult {
    isEnvelope: boolean;
    /** Whether the `.ai/` folder itself exists. */
    aiExists: boolean;
    folders: KnowledgeFolderView[];
}

export interface ConvertToAgiOpts {
    slug: string;
    name: string;
    parent_path: string;
    source:
        | { kind: 'local'; path: string }
        | { kind: 'remote'; url: string };
    sub_name?: string;
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

export interface ConvertToAgiResult extends CreateAgiResult {
    submodule_path: string;
    submodule_url: string;
}

export interface AnalyseRepoCandidate {
    rel_path: string;
    abs_path: string;
    default_name: string;
    origin_url: string | null;
    head_ref: string | null;
}

export interface AnalyseKnowledgeCandidate {
    rel_path: string;
    abs_path: string;
    kind: 'file' | 'directory';
    suggested_target: string;
    size?: number;
}

export interface AnalyseOtherEntry {
    rel_path: string;
    kind: 'file' | 'directory';
}

export interface StructureDocStatus {
    isEnvelope: boolean;
    hasReadme: boolean;
    hasAgents: boolean;
    hasClaude: boolean;
    missing: boolean;
    hasRemote: boolean;
}
export interface AddStructureDocsResult {
    added: string[];
    committed: boolean;
    pushed: boolean;
    pushError?: string;
}
export interface McpStatus {
    repoServers: string[];
    rootServers: string[];
    missingAtRoot: string[];
    needsConsolidation: boolean;
}
export interface ConsolidateMcpResult {
    servers: string[];
    files: string[];
    committed: boolean;
    pushed: boolean;
    pushError?: string;
    gitignored?: boolean;
}

export type SourceKind = 'single-repo' | 'monorepo' | 'repo-collection' | 'plain-folder';

export interface SubmoduleEntry {
    name: string;
    path: string;
    url: string;
}

export interface RootEntry {
    rel_path: string;
    abs_path: string;
    kind: 'file' | 'directory';
    git_state: 'tracked' | 'untracked' | 'ignored';
    suggested: 'codebase' | 'knowledge' | 'root';
    suggested_target: string;
}

export interface AnalyseResult {
    source_kind: SourceKind;
    root: string;
    repos: AnalyseRepoCandidate[];
    knowledge: AnalyseKnowledgeCandidate[];
    other: AnalyseOtherEntry[];
    /** Present for 'single-repo' AND 'monorepo' sources (root is a repo). */
    root_entries?: RootEntry[];
    /** Root repo's declared submodules; non-empty when source_kind === 'monorepo'. */
    submodules: SubmoduleEntry[];
}

export type ProjectJsonRepoRole = 'host' | 'package';

/** A member repo as recorded in the envelope's project.json. */
export interface ProjectJsonRepo {
    name: string;
    url?: string;
    /** Checkout path inside the envelope, always `repos/<name>`. */
    path?: string;
    /** 'host' = the primary build target; 'package' = a consumed dependency. */
    role?: ProjectJsonRepoRole;
    /** Tracked branch for `git submodule update --remote`. */
    branch?: string;
}

export interface AgiPlanRepo {
    source: string;
    is_local: boolean;
    submodule_name: string;
}
export interface AgiPlanKnowledge {
    source_abs_path: string;
    kind: 'file' | 'directory';
    target_subdir: string;
    /** Copy beside project.json instead of into .ai/. */
    to_envelope_root?: boolean;
}
export interface ConvertPlanOpts {
    slug: string;
    name: string;
    parent_path: string;
    repos: AgiPlanRepo[];
    knowledge: AgiPlanKnowledge[];
    /** `submodule_name` of the host (primary) member — the repo Aionima builds/hosts. */
    primary?: string;
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

// --- Plugin System (Settings → Plugins) -------------------------------------

/** One toggleable granular permission grant (§12.1). */
export interface PluginPermissionView {
    category: 'fs' | 'network' | 'genieApi';
    key: string;
    label: string;
    granted: boolean;
}

/** A plugin's evaluated provenance verdict (Plugin System Phase 3). */
export type PluginTrustStatus = 'trusted' | 'unsigned' | 'untrusted';

/** An installed plugin as Settings → Plugins renders it. */
export interface InstalledPluginView {
    id: string;
    name: string;
    version: string;
    namespace: string;
    description: string | null;
    enabled: boolean;
    sourceType: 'repo' | 'folder' | 'marketplace';
    sourceUrl: string | null;
    marketplaceId: string | null;
    publisher: string | null;
    tools: Array<{ name: string; description: string }>;
    editors: Array<{ id: string; title: string; extensions: string[]; fancyEditor: string }>;
    permissions: PluginPermissionView[];
    integrity: string | null;
    signed: boolean;
    /** Trust verdict: trusted / unsigned / untrusted (Phase 3). */
    trust: PluginTrustStatus;
    publisherKeyId: string | null;
    devApproved: boolean;
}

/** Developer Mode state + the user's developer-trusted signing keys. */
export interface PluginDeveloperModeState {
    enabled: boolean;
    keys: Array<{ keyId: string; label: string }>;
}

/** A 3rd-party marketplace + its indexed member plugins. */
export interface MarketplaceView {
    id: string;
    name: string;
    url: string;
    official: boolean;
    plugins: Array<{ id: string; name: string; description: string | null; installed: boolean }>;
}

export interface OfficialPluginEntry {
    id: string;
    name: string;
    description: string;
    repo: string;
}

/** A bundled first-party plugin Genie ships in the box (Hello World / Presentation / Spreadsheet). */
export interface BundledPlugin {
    id: string;
    name: string;
    description: string;
    path: string;
}

export interface OfficialPluginsResult {
    curated: OfficialPluginEntry[];
    bundled: BundledPlugin[];
}

export type PluginActionResult<T = { id: string; name: string; version: string }> =
    | { ok: true; value: T }
    | { ok: false; error: string };

// --- Workstation Knowledge Graph (Wish #87) --------------------------------
// A workstation-wide, local knowledge/memory store the Knowledge Graph window
// reads/writes over `knowledge.*`. Each node is a markdown memory; the
// `[[wikilink]]` refs between memories are the graph's edges. DISTINCT from the
// envelope `.ai/` KnowledgeFolderView/KnowledgeResult above — those are one
// workspace's on-disk knowledge FOLDERS; this is the cross-workspace memory
// STORE that replaces bloated system-wide agent prompt instructions.

/** One memory in the Knowledge Graph store. */
export interface KnowledgeNode {
    id: string;
    title: string;
    /** The memory body, as markdown. */
    body: string;
    tags: string[];
    /** Ids of the memories this one links to — its out-edges. Resolved main-side
     *  from the body's `[[wikilinks]]` (by title/slug, at read time) PLUS any
     *  explicit links passed to add/update. */
    links: string[];
    /** Who wrote it: an agent (RAG/MCP) or the user (this window). */
    source: 'agent' | 'user';
    /** Epoch ms. */
    createdAt: number;
    updatedAt: number;
}

/** One `knowledge.search` hit — a lightweight node projection + match snippet. */
export interface KnowledgeSearchResult {
    id: string;
    title: string;
    /** A short excerpt around the match, for the results list. */
    snippet: string;
    /** Relevance score (higher = better). The result ORDER is authoritative. */
    score: number;
    tags: string[];
}

/** A directed edge: `source` (the memory containing the link) → `target` (the
 *  linked memory's id). Only edges whose BOTH ends resolve to real nodes appear. */
export interface KnowledgeGraphEdge {
    source: string;
    target: string;
}

/** The whole store as a graph: the full nodes + the edges between them. */
export interface KnowledgeGraphData {
    nodes: KnowledgeNode[];
    edges: KnowledgeGraphEdge[];
}

/**
 * Fields accepted when creating / updating a memory. Only `title` is required;
 * edges are derived main-side from the body's `[[wikilinks]]`, so `links` is
 * reserved for EXPLICIT extra edges (ids/titles/slugs) — this window omits it,
 * letting the body be the single source of truth for links.
 */
export interface KnowledgeInput {
    title: string;
    body?: string;
    tags?: string[];
    links?: string[];
}

export interface GenieApi {
    auth: {
        startSignIn: (kind?: BackendKind) => Promise<{
            ok: boolean;
            message?: string;
            /** The Tynn sign-in URL. Shown for manual copy when there is no
             *  local browser (open it on any device → sign in → paste code). */
            url?: string;
        }>;
        redeemCode: (code: string) => Promise<{ ok: boolean }>;
        signOut: (kind?: BackendKind) => Promise<{ ok: boolean }>;
        whoami: (kind?: BackendKind) => Promise<BackendUser | null | Record<string, BackendUser | null>>;
        summary: () => Promise<SignedInSummaryItem[]>;
    };
    issueWatch: {
        repos: (workspaceId: string) => Promise<WatchRepoView[]>;
        set: (
            workspaceId: string,
            owner: string,
            repo: string,
            enabled: boolean,
        ) => Promise<{ ok: boolean }>;
        feed: (workspaceId: string) => Promise<WatchFeedItem[]>;
        markSeen: (workspaceId: string) => Promise<{ ok: boolean }>;
        counts: () => Promise<Record<string, WatchTypeCounts>>;
        /** Why this workspace's feed is what it is (connected + worst read error). */
        status: (workspaceId: string) => Promise<WorkspaceWatchStatus>;
    };
    /**
     * Serve-local-sites (Phase B). HOST-SOURCED content: discovery reads the
     * HOST's hosts file + probes the HOST's loopback, and the per-site enable set
     * is the allowlist the HOST serves from — so in a remote window these route
     * through the bridge to the host (remote-bridge.ts), like the IssueWatch rail.
     *   - `list(workspaceId, {refresh})` — discovered sites merged with the
     *     workspace's stored tunnel settings; `refresh` re-probes scheme/port.
     *   - `set(workspaceId, siteId, patch)` — persist one site's config (enable /
     *     `.gen` name / scheme+port), keyed by the opaque siteId.
     */
    sites: {
        list: (
            workspaceId: string,
            opts?: { refresh?: boolean },
        ) => Promise<SiteView[]>;
        set: (
            workspaceId: string,
            siteId: string,
            patch: TunnelSiteConfig,
        ) => Promise<{ ok: boolean }>;
        /** The header `.gen` popover's data, CONTEXTUAL to this window: a local
         *  window's own sites, or a host window's host sites. */
        all: () => Promise<GenSitesAll>;
        /** Open a `.gen` site in the Testing Browser (contextual: local loopback
         *  or the host's tunnel, by which window asked). */
        open: (genName: string) => Promise<{ ok: boolean; error?: string }>;
    };
    mcp: {
        status: () => Promise<McpServerState>;
        restart: () => Promise<McpServerState>;
        docHealth: (workspaceId: string) => Promise<WorkspaceDocHealth | null>;
        repairDocs: (workspaceId: string) => Promise<RepairDocsResult | null>;
    };
    /** Plugin System (Settings → Plugins). Install from a repo URL / folder /
     *  marketplace; enable/disable; toggle granular permissions; uninstall. */
    plugins: {
        list: () => Promise<InstalledPluginView[]>;
        installRepo: (url: string, ref?: string) => Promise<PluginActionResult>;
        installFolder: (folder?: string) => Promise<PluginActionResult>;
        enable: (id: string, enabled: boolean) => Promise<PluginActionResult<boolean>>;
        setGrant: (
            id: string,
            category: 'fs' | 'network' | 'genieApi',
            key: string,
            granted: boolean,
        ) => Promise<PluginActionResult<boolean>>;
        uninstall: (id: string) => Promise<PluginActionResult<boolean>>;
        marketplaces: () => Promise<MarketplaceView[]>;
        addMarketplace: (url: string, ref?: string) => Promise<PluginActionResult>;
        refreshMarketplace: (id: string) => Promise<PluginActionResult>;
        removeMarketplace: (id: string) => Promise<PluginActionResult<boolean>>;
        installMarketplacePlugin: (
            marketplaceId: string,
            pluginId: string,
        ) => Promise<PluginActionResult>;
        official: () => Promise<OfficialPluginsResult>;
        installBundled: (id: string) => Promise<PluginActionResult>;
        /** Capability-scoped binary read/write for a granted plugin editor (§6.2). */
        editorRead: (
            pluginId: string,
            root: string,
            relPath: string,
        ) => Promise<PluginEditorReadResult>;
        editorWrite: (
            pluginId: string,
            root: string,
            relPath: string,
            base64: string,
        ) => Promise<PluginEditorWriteResult>;
        /** Which enabled plugin's editor claims this file's extension (§6.1),
         *  or null when the default code editor should open it. */
        editorFor: (fileName: string) => Promise<{
            pluginId: string;
            editorId: string;
            fancyExport: string;
            fancyPackage: string;
            fancyVersion: string;
        } | null>;
        /** Markdown <-> DOCX conversion for the Document editor (runs in main,
         *  keeping mammoth/docx out of the renderer bundle). */
        convertDocument: (req: {
            to: 'markdown' | 'docx';
            base64?: string;
            markdown?: string;
        }) => Promise<{ ok: boolean; markdown?: string; base64?: string; error?: string }>;
        /** Developer Mode + trusted signing keys (Phase 3). */
        developerMode: () => Promise<PluginDeveloperModeState>;
        setDeveloperMode: (enabled: boolean) => Promise<PluginActionResult<boolean>>;
        addTrustedKey: (
            publicKeyPem: string,
            label?: string,
        ) => Promise<PluginActionResult<{ keyId: string }>>;
        removeTrustedKey: (keyId: string) => Promise<PluginActionResult<boolean>>;
    };
    /**
     * Mobile remote-control server (Settings → Mobile). Desktop-only namespace —
     * the phone talks to the tailnet server directly, never via this bridge.
     *   - `status()` — live state + PIN + QR data-URL.
     *   - `restart(enabled?)` — persist the toggle (caller sets `mobile_enabled`
     *     first), then (re)bind/unbind; returns the fresh status.
     *   - `regeneratePin()` — roll the PIN (sessions kept).
     *   - `revokeSessions()` — drop every paired session (returns the count).
     *   - `lock(locked)` — engage/release the global kill-switch.
     */
    mobile: {
        status: () => Promise<MobileStatus>;
        restart: (enabled?: boolean) => Promise<MobileStatus>;
        /** Toggle desktop Genie Remote independently of the phone UI. */
        setRemoteEnabled: (enabled: boolean) => Promise<MobileStatus>;
        regeneratePin: () => Promise<MobileStatus>;
        /** win32: add the inbound firewall rule for the live port (one UAC prompt).
         *  `cancelled` when the user declines UAC; `error` on any other failure. */
        allowFirewall: () => Promise<
            MobileStatus & { ok: boolean; cancelled?: boolean; error?: string }
        >;
        revokeSessions: () => Promise<MobileStatus & { revoked: number }>;
        /** Host-side roster of paired devices (no bearer tokens). */
        sessions: () => Promise<MobileDevice[]>;
        /** Unpair one device by its roster id. */
        revokeSession: (id: string) => Promise<MobileStatus & { ok: boolean }>;
        lock: (locked: boolean) => Promise<MobileStatus>;
    };
    tailscale: {
        status: () => Promise<TailscaleStatus>;
        up: () => Promise<{ ok: boolean; authUrl?: string | null; message?: string }>;
        openAuth: (url: string) => Promise<{ ok: boolean }>;
        install: () => Promise<{ started: boolean; url?: string; message?: string }>;
    };
    workmode: {
        discoverHosts: () => Promise<GenieHost[]>;
        openRemote: (host: {
            ip: string;
            port: number;
            hostname: string;
        }) => Promise<{ ok: boolean }>;
    };
    remote: {
        disconnect: () => Promise<{ ok: boolean }>;
        status: () => Promise<RemoteStatus>;
        /** This window's binding — `local`, or `remote` to a specific host. Read
         *  once on boot to route api() per-window (host window vs local window). */
        myBinding: () => Promise<{ mode: 'local' | 'remote'; host: RemoteHost | null }>;
        request: (path: string, init?: { method?: string; json?: unknown }) => Promise<unknown>;
        onStatus: (cb: (s: RemoteStatus) => void) => () => void;
        /** Bridge link health (version match + upgrade/limbo). Read on mount;
         *  live changes arrive via `onLink`. Drives the host-window overlay. */
        linkState: () => Promise<RemoteLinkState>;
        /** Trigger the HOST's self-update over the bridge (download + restart). */
        upgradeHost: () => Promise<{ ok: boolean; error?: string }>;
        /** Manually restart the bridge after the limbo auto-retry gave up ('lost'). */
        reconnect: () => Promise<{ ok: boolean; error?: string }>;
        onLink: (cb: (s: RemoteLinkState) => void) => () => void;
        /** Control state: `locked:true` ⇒ the host has taken control and this
         *  driver is view-only. Read on mount; live changes arrive via `onControl`.
         *  Drives the view-only banner + the remote-bridge input gate. */
        controlState: () => Promise<{ locked: boolean }>;
        onControl: (cb: (s: { locked: boolean }) => void) => () => void;
        /** Attach to a host pty. `cols`/`rows` (the client's fitted grid, when known)
         *  are held by main and applied once the term socket opens — a resize sent
         *  before then would hit a CONNECTING socket and be discarded. */
        terminalAttach: (
            id: string,
            workspaceId?: string,
            cols?: number,
            rows?: number,
        ) => Promise<{ ok: boolean }>;

        terminalInput: (id: string, data: string) => Promise<boolean>;
        terminalResize: (id: string, cols: number, rows: number) => Promise<boolean>;
        terminalDetach: (id: string) => Promise<{ ok: boolean }>;
        /** Connect a host (handling the PIN) and open its OWN native Floor window.
         *  The local window stays local — only the new host window is remote. */
        open: (
            host: RemoteHost,
            pin?: string,
        ) => Promise<{ ok: boolean; connKey?: string; error?: string; needsPin?: boolean }>;
        /** The persisted known-hosts list (for the picker), each tagged connected. */
        known: () => Promise<KnownHost[]>;
        forget: (connKey: string) => Promise<{ ok: boolean }>;
        rename: (connKey: string, name: string) => Promise<{ ok: boolean }>;
    };
    /** Serve-local-sites (Phase D): the Testing Browser. `open` shows the browser
     *  for a connected host; the rest are driven BY the chrome window (each resolves
     *  to that window's browser instance in main). The site content is a
     *  main-owned WebContentsView; the chrome renders `onState`. */
    testingBrowser: {
        open: (connKey: string, hostname: string) => Promise<{ ok: boolean; error?: string }>;
        state: () => Promise<TestingBrowserState | null>;
        navigate: (input: string) => Promise<{ ok: boolean; error?: string }>;
        back: () => Promise<{ ok: boolean }>;
        forward: () => Promise<{ ok: boolean }>;
        reload: () => Promise<{ ok: boolean }>;
        newTab: (input?: string) => Promise<{ ok: boolean; error?: string }>;
        closeTab: (tabId: string) => Promise<{ ok: boolean }>;
        activateTab: (tabId: string) => Promise<{ ok: boolean }>;
        setBounds: (bounds: {
            x: number;
            y: number;
            width: number;
            height: number;
        }) => Promise<{ ok: boolean }>;
        setViewport: (presetId: string) => Promise<{ ok: boolean }>;
        refreshSites: () => Promise<void>;
        onState: (cb: (s: TestingBrowserState) => void) => () => void;
        onLoadError: (
            cb: (e: { tabId: string; code: number; description: string; url: string }) => void,
        ) => () => void;
    };
    /** Virtual Workstations (relay transport): the signed-in member's entitled
     *  workstations + opening one over the Tynn relay (grant minted main-side). */
    workstations: {
        connectable: () => Promise<ConnectableWorkstation[]>;
        open: (
            workstationId: string,
            name: string,
        ) => Promise<{ ok: boolean; connKey?: string; error?: string }>;
    };
    aionima: {
        getConfig: () => Promise<AionimaConfig>;
        setConfig: (patch: AionimaConfig) => Promise<{
            config: AionimaConfig;
            user: BackendUser | null;
            /** Probe failure detail when user is null (e.g. bad host / network). */
            error?: string;
        }>;
        hostInfo: () => Promise<string>;
    };
    /** System clipboard via Electron main (reliable; the renderer's
     *  navigator.clipboard fails silently in a sandboxed window). */
    clipboard: {
        write: (text: string) => Promise<{ ok: boolean }>;
        read: () => Promise<string>;
        /**
         * The LOCAL clipboard image as a PNG data-URL, or null when there's no
         * image. NOT re-pointed by the remote bridge, so in a host window this
         * still reads the LOCAL clipboard (the machine the user copied on) — the
         * source of a remote image paste.
         */
        readImage: () => Promise<string | null>;
        /**
         * Place a PNG (base64, no data-URL prefix) where the CLI on the machine the
         * terminal runs on will read it: locally that's this machine; in a host
         * window the remote bridge re-points it to the HOST over the authed bridge.
         * On Windows/macOS it lands on the OS clipboard; on a LINUX host it's written
         * to a temp file and `path` is its absolute HOST path — the caller pastes the
         * path instead of a clipboard trigger (Claude Code can't reliably read a Linux
         * clipboard image). `supported:false` ⇒ the target can't accept an image (a
         * legacy unwired host) — the caller no-ops gracefully and never breaks text
         * paste.
         */
        writeImage: (
            dataBase64: string,
        ) => Promise<{ ok: boolean; supported: boolean; path?: string }>;
    };
    /** Built-in editor — reply to a main `editor:open-file` request
     *  (openFileForUser MCP tool), keyed by the request id main awaits. */
    editor: {
        openFileResult: (
            requestId: string,
            result: { reused: boolean; opened: boolean },
        ) => Promise<{ ok: boolean }>;
    };
    settings: {
        get: () => Promise<Settings>;
        set: (patch: Partial<Settings>) => Promise<Settings>;
        chooseFolder: (label?: string, defaultPath?: string) => Promise<string | null>;
        chooseFile: (label?: string) => Promise<string | null>;
        /** Read a sound file into a base64 data-URL (null when unreadable).
         *  Backs the per-alert "Custom file…" choice + the Settings Preview. */
        soundDataUrl: (path: string) => Promise<string | null>;
        detectShells: () => Promise<{
            shells: ShellDetection[];
            defaultId: string | null;
        }>;
    };
    workspaces: {
        list: () => Promise<WorkspaceRow[]>;
        add: (row: WorkspaceRow) => Promise<WorkspaceRow>;
        update: (
            id: string,
            patch: Partial<WorkspaceRow>,
        ) => Promise<WorkspaceRow | undefined>;
        remove: (id: string) => Promise<{ ok: boolean }>;
        touch: (id: string) => Promise<{ ok: boolean }>;
        /** Persist a new sidebar order (full ordered list of workspace ids). */
        reorder: (ids: string[]) => Promise<{ ok: boolean }>;
        /** Toggle the agent-integration MCP for a workspace's terminals. */
        setMcp: (id: string, enabled: boolean) => Promise<{ ok: boolean }>;
        /** Toggle "require approval before an agent starts a background process". */
        setProcessApproval: (
            id: string,
            require: boolean,
        ) => Promise<{ ok: boolean }>;
        /** Toggle "require approval before an agent spawns a terminal / launches
         *  a coding agent" (manageTerminals / runAgent). */
        setTerminalApproval: (
            id: string,
            require: boolean,
        ) => Promise<{ ok: boolean }>;
        /** This workspace's resolved per-bucket IssueWatch remediation policy
         *  (legacy single value applied to all buckets as the fallback). */
        getIssuewatchPolicy: (id: string) => Promise<IssuewatchPolicyBuckets>;
        /** Persist this workspace's per-bucket IssueWatch remediation policy. */
        setIssuewatchPolicy: (
            id: string,
            buckets: IssuewatchPolicyBuckets,
        ) => Promise<{ ok: boolean }>;
        /** This workspace's resolved IssueWatch granularity (defaults applied). */
        getIssuewatchGranularity: (id: string) => Promise<IssuewatchGranularity>;
        /** Persist this workspace's IssueWatch granularity (what to watch + ping). */
        setIssuewatchGranularity: (
            id: string,
            granularity: IssuewatchGranularity,
        ) => Promise<{ ok: boolean }>;
        /** This workspace's DESIGNATED IssueWatch handler set + the candidate agents
         *  to choose from (their live handle/action state), for the designation UI. */
        getIssuewatchHandlers: (id: string) => Promise<{
            designated: string[];
            agents: Array<{
                terminalId: string;
                label: string;
                handle: boolean;
                action: 'notify' | 'wake';
            }>;
        }>;
        /** Persist the designated IssueWatch handler set (empty = fan out to all
         *  handle-enabled agents). */
        setIssuewatchHandlers: (
            id: string,
            terminalIds: string[],
        ) => Promise<{ ok: boolean }>;
        /** Repo subfolder names under the workspace envelope (for Add Process cwd). */
        repos: (id: string) => Promise<string[]>;
        open: (id: string) => Promise<{ ok: boolean }>;
        /** Clone a remote git repo to parentPath/<folder>; returns the local path. */
        clone: (
            url: string,
            parentPath: string,
            folder?: string,
        ) => Promise<{ path: string }>;
        /** Reveal a workspace-relative path in the OS file manager (guarded). */
        reveal: (
            workspacePath: string,
            relPath: string,
        ) => Promise<{ ok: boolean; error?: string }>;
    };
    agi: {
        detect: (folder: string) => Promise<DetectResult>;
        create: (opts: CreateAgiOpts) => Promise<CreateAgiResult>;
        importExisting: (folder: string) => Promise<DetectResult>;
        convert: (opts: ConvertToAgiOpts) => Promise<ConvertToAgiResult>;
        analyse: (folder: string) => Promise<AnalyseResult>;
        convertPlan: (opts: ConvertPlanOpts) => Promise<CreateAgiResult>;
        push: (envelopePath: string, branch?: string) => Promise<{ ok: boolean }>;
        docStatus: (envelopePath: string) => Promise<StructureDocStatus>;
        addDocs: (
            envelopePath: string,
            name: string,
            slug: string,
        ) => Promise<AddStructureDocsResult>;
        mcpStatus: (envelopePath: string) => Promise<McpStatus>;
        consolidateMcp: (envelopePath: string) => Promise<ConsolidateMcpResult>;
        /** Envelope member repos (project.json registry ∪ on-disk submodules). */
        reposList: (workspacePath: string) => Promise<EnvelopeReposResult>;
        /** Add a repo as a submodule under repos/<name> and register it. */
        repoAdd: (
            workspacePath: string,
            url: string,
            name: string,
        ) => Promise<RepoMutationResult>;
        /** Remove a repo (deinit + rm + unregister). Host repo is protected. */
        repoRemove: (
            workspacePath: string,
            name: string,
        ) => Promise<RepoMutationResult>;
        /** The envelope's `.ai/` knowledge folders + whether each exists. */
        knowledgeList: (workspacePath: string) => Promise<KnowledgeResult>;
        /** Scaffold a standard `.ai/<name>` knowledge folder. */
        knowledgeCreate: (
            workspacePath: string,
            name: string,
        ) => Promise<RepoMutationResult>;
    };
    tynn: {
        projects: () => Promise<TynnProject[]>;
        /** Owners the user may create a project under (personal first). */
        ownerOptions: () => Promise<OwnerOption[]>;
        /** Create a Tynn project (defaults to the personal account). Returns it
         *  in the same shape as `projects()` so it can back a new workspace. */
        createProject: (input: {
            name: string;
            owner_type?: 'user' | 'organization' | 'team';
            owner_id?: string;
            slug?: string;
        }) => Promise<TynnProject>;
        captureWish: (
            projectId: string,
            content: string,
            backendKind?: BackendKind,
        ) => Promise<{ id: string; backend: BackendKind }>;
        inbox: () => Promise<InboxPayload>;
        openInBrowser: (
            urlOrPath: string,
            backendKind?: BackendKind,
        ) => Promise<{ ok: boolean }>;
        /** Link a workspace to a Tynn project (writes the secret-free project.json block). */
        link: (
            workspacePath: string,
            link: { host?: string; owner?: string; project?: string; projectId?: string },
        ) => Promise<{ ok: boolean }>;
        /** Clear the workspace's Tynn project link (drops the project.json block). */
        unlink: (workspacePath: string) => Promise<{ ok: boolean }>;
        /** Where the workspace stands without minting anything (UI display). */
        provisionStatus: (workspacePath: string) => Promise<{
            status: 'unlinked' | 'signed-out' | 'already' | 'provision';
            link: { host?: string; owner?: string; project?: string; projectId?: string } | null;
        }>;
        /** Mint the agent token + write the workspace Agent MCP config. */
        provision: (
            workspacePath: string,
            force?: boolean,
        ) => Promise<{
            status: 'unlinked' | 'signed-out' | 'already' | 'provision' | 'error';
            agent?: { id: string; name: string };
            isOpsProject?: boolean;
            error?: string;
        }>;
        /** Ops-project repo reconcile plan (read-only). */
        opsPlan: (workspacePath: string) => Promise<{
            isOps: boolean;
            signedIn: boolean;
            toAdd: Array<{ name: string; url: string; projectId: string }>;
            toRemove: Array<{ name: string }>;
            missingLocally: Array<{ name: string; projectId: string }>;
        }>;
        /** Apply the user-approved add/remove subset (mutates the envelope). */
        opsApply: (
            workspacePath: string,
            approved: {
                add?: Array<{ name: string; url: string; projectId: string }>;
                remove?: string[];
            },
        ) => Promise<{ added: string[]; removed: string[]; errors: string[] }>;
        /** Ops-project WORKSPACE provisioning plan (read-only). For each governed
         *  child project: whether a local workspace exists, and the `*.agi` URL
         *  Genie would clone for a missing one. */
        opsProvisionPlan: (workspacePath: string) => Promise<{
            isOps: boolean;
            signedIn: boolean;
            parentPath: string;
            autoProvision: boolean;
            children: Array<{
                projectId: string;
                name: string;
                slug: string;
                status: 'present' | 'missing';
                cloneUrl: string | null;
                workspacePath?: string;
            }>;
        }>;
        /** Clone + register the approved child workspaces (mutates disk + db). */
        opsProvisionApply: (
            workspacePath: string,
            targets: Array<{
                projectId: string;
                name: string;
                slug: string;
                cloneUrl: string;
            }>,
        ) => Promise<{
            provisioned: Array<{ name: string; workspaceId: string; path: string }>;
            errors: string[];
        }>;
        /** The ops-auto-provision-workspaces toggle (default off). */
        opsAutoProvisionGet: () => Promise<{ on: boolean }>;
        opsAutoProvisionSet: (on: boolean) => Promise<{ on: boolean }>;
    };
    tynnHost: {
        get: () => Promise<string>;
    };
    app: {
        hideCapture: () => Promise<{ ok: boolean }>;
        getCurrentProject: () => Promise<{ id: string; name: string } | null>;
        /** The user's home directory (roots the synthetic System Workspace). */
        homeDir: () => Promise<string>;
        /** Open Settings. `fromRemote:true` (a remote/host window) restricts it to
         *  the connection-relevant subset (Appearance / Notifications / copy-paste). */
        showSettings: (fromRemote?: boolean) => Promise<{ ok: boolean }>;
        showDocs: () => Promise<{ ok: boolean }>;
        showMain: () => Promise<{ ok: boolean }>;
        openStage: (workspaceId?: string) => Promise<{ ok: boolean }>;
        quit: () => Promise<{ ok: boolean }>;
        /**
         * Reply to the manual-quit terminal confirmation (see
         * on.confirmQuitTerminals). `confirmed:false` aborts the quit; otherwise
         * `keepIds` are the host terminals to leave running. Fire-and-forget.
         */
        quitDecision: (payload: { confirmed: boolean; keepIds: string[] }) => void;
        autostart: {
            get: () => Promise<{
                enabled: boolean;
                supported: boolean;
                platform: string;
            }>;
            set: (enabled: boolean) => Promise<{ enabled: boolean }>;
        };
    };
    shell: {
        /** Open an http/https URL in the OS default browser (terminal links). */
        openExternal: (url: string) => Promise<{ ok: boolean }>;
    };
    docs: {
        list: () => Promise<DocEntry[]>;
        read: (slug: string) => Promise<string | null>;
    };
    /**
     * Workstation Knowledge Graph (Wish #87) — a local, cross-workspace memory
     * store. Nodes are markdown memories; `[[wikilink]]` refs between them are
     * edges. `openWindow` opens the standalone, Genie-skinned Knowledge Graph
     * window (renderer/pages/knowledge.tsx); the rest are the store's CRUD +
     * search + graph read that window drives. `source` is set main-side —
     * anything added here is `'user'`.
     */
    knowledge: {
        /** Full-text search across memories; results are pre-ranked by `score`. */
        search: (
            query: string,
            opts?: { limit?: number; tags?: string[] },
        ) => Promise<KnowledgeSearchResult[]>;
        /** Every memory (optionally filtered by tag / capped), newest first. */
        list: (opts?: { tag?: string; limit?: number }) => Promise<KnowledgeNode[]>;
        get: (id: string) => Promise<KnowledgeNode | null>;
        add: (input: KnowledgeInput) => Promise<KnowledgeNode>;
        update: (
            id: string,
            patch: Partial<KnowledgeInput>,
        ) => Promise<KnowledgeNode | null>;
        delete: (id: string) => Promise<{ ok: boolean }>;
        /** The whole store as nodes + edges, for the relationship view. */
        graph: () => Promise<KnowledgeGraphData>;
        /** Open the standalone Knowledge Graph window (the header button). */
        openWindow: () => Promise<{ ok: boolean }>;
    };
    process: {
        /** Start a background Process service runner. */
        start: (id: string) => Promise<{ ok: boolean }>;
        /** Stop a Process (deliberate — won't auto-restart). */
        stop: (id: string) => Promise<{ ok: boolean }>;
        /** Restart a Process. */
        restart: (id: string) => Promise<{ ok: boolean }>;
        /** Current status of every managed Process (id → status). */
        statuses: () => Promise<Record<string, ProcessStatus>>;
        /** Recent output tail for a Process (ANSI-stripped) — the hover log. */
        log: (id: string) => Promise<string>;
        /** Drop a Process's recorded output tail (the log popover's "Clear log"). */
        clearLog: (id: string) => Promise<{ ok: boolean }>;
        /** Every process across every workspace (+ System) for the Task Manager. */
        list: () => Promise<ProcessListItem[]>;
    };
    updater: {
        mode: () => Promise<'phase1' | 'phase2'>;
        status: () => Promise<UpdaterStatus>;
        check: () => Promise<UpdaterStatus>;
        apply: () => Promise<{ ok: boolean; error?: string }>;
        restart: () => Promise<{ ok: boolean; error?: string }>;
        getConfig: () => Promise<UpdaterConfig>;
        setConfig: (
            patch: Partial<UpdaterConfig>,
        ) => Promise<UpdaterConfig>;
        changelog: (latest: string) => Promise<Changelog>;
    };
    terminalSpec: {
        list: () => Promise<TerminalSpec[]>;
        create: (input: {
            id: string;
            workspace_id: string | null;
            label: string;
            cwd: string;
            shell?: string | null;
            args?: string[];
            env?: Record<string, string>;
            type?: ViewType;
            meta?: ViewMeta;
        }) => Promise<TerminalSpec>;
        update: (id: string, patch: Partial<TerminalSpec>) => Promise<TerminalSpec | null>;
        remove: (id: string) => Promise<boolean>;
        get: (id: string) => Promise<TerminalSpec | null>;
        touch: (id: string) => Promise<{ ok: boolean }>;
        /**
         * Persist the grid's drag-reorder. `ids` is the full ordered list of
         * spec ids for ONE workspace; each index becomes that spec's
         * sort_order, which is what `list()` sorts by. Mirrors
         * `workspaces.reorder` for the sidebar.
         */
        reorder: (ids: string[]) => Promise<{ ok: boolean }>;
        /**
         * Create a SPECIALIZED (AI-TUI) terminal: main resolves the launch command
         * (`resolveAgentCommand` + the `agent_command_*` settings), spawns the pty,
         * submits the boot command, stamps the AgentInbox identity/scope onto the
         * spec meta, and joins the AgentInbox broker. Returns the persisted spec so the
         * renderer can select it into view.
         */
        createAgent: (input: {
            workspace_id: string | null;
            agent: AgentType;
            /** Required for `custom`; overrides the resolved command otherwise. */
            command?: string;
            cwd?: string;
            label?: string;
            /** Channel purpose (kebab, ≤6 words). */
            purpose: string;
            scope: AgentInboxScope;
            /** The chosen workspace ids when `scope === 'specific'`. */
            scope_workspaces?: string[];
            /** Opt-in wake-on-DM: a direct message wakes this agent when idle (issue #9). */
            wake_on_dm?: boolean;
            /** IssueWatch pings: participate in this workspace's IssueWatch deltas. */
            issuewatch_handle?: boolean;
            /** IssueWatch pings: react by glow (`notify`) or idle-wake (`wake`). */
            issuewatch_action?: 'notify' | 'wake';
        }) => Promise<{ ok: boolean; spec?: TerminalSpec; error?: string }>;
    };
    /**
     * AgentInbox — the local inter-agent messaging network. Local-only in v1
     * (one Genie instance; no relay). The human panel reads the directory /
     * channels / history and posts as the human; live updates arrive on
     * `on.agentInboxPresence` / `on.agentInboxMessage`.
     */
    agentPulse: {
        /** Last-60s per-workspace byte buckets (index 0 = 59s ago … 59 = now),
         *  fetched once when the workspace menu opens to backfill each sparkline. */
        snapshot: () => Promise<{ pulses: Record<string, number[]> }>;
    };
    agentInbox: {
        /** Every discoverable agent (the directory pane). */
        directory: () => Promise<{ agents: AgentInboxAgentInfo[] }>;
        /** Every broadcast channel (`slug:purpose`). */
        channels: () => Promise<{ channels: AgentInboxChannelInfo[] }>;
        /** Every DM thread with messages — human↔agent AND agent↔agent. */
        dmThreads: () => Promise<{ threads: AgentInboxDmThreadInfo[] }>;
        /** Message history for a channel, an arbitrary DM `dmPair`, OR the
         *  human↔agent thread (`agentId`) — paginate via `before`. */
        history: (opts: {
            channelKey?: string;
            agentId?: string;
            dmPair?: [string, string];
            limit?: number;
            before?: number;
        }) => Promise<{ messages: AgentInboxMessage[] }>;
        /** Post as the human — to a channel (`channelKey`) or an agent (`toAgentId`). */
        post: (input: {
            channelKey?: string;
            toAgentId?: string;
            text: string;
        }) => Promise<{ ok: boolean; error?: string }>;
        /** Edit an agent's channel identity (purpose / scope) — re-emits presence. */
        updateChannel: (
            specId: string,
            patch: {
                purpose?: string;
                scope?: AgentInboxScope;
                scope_workspaces?: string[];
                /** Opt-in wake-on-DM (issue #9): a direct message wakes this agent when idle. */
                wake_on_dm?: boolean;
                /** IssueWatch pings: participate in this workspace's IssueWatch deltas. */
                issuewatch_handle?: boolean;
                /** IssueWatch pings: react by glow (`notify`) or idle-wake (`wake`). */
                issuewatch_action?: 'notify' | 'wake';
            },
        ) => Promise<{ ok: boolean; error?: string }>;
    };
    files: {
        listTree: (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string; system?: boolean },
        ) => Promise<TreeNodeData[]>;
        read: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ content: string; truncated: boolean }>;
        write: (
            workspacePath: string,
            relPath: string,
            content: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        createFile: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        createFolder: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        rename: (
            workspacePath: string,
            fromRel: string,
            toRel: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        duplicate: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean; relPath: string }>;
        /** Copy an external OS path into a workspace folder; returns the new rel path. */
        importExternal: (
            workspacePath: string,
            srcAbs: string,
            destFolderRel: string,
            system?: boolean,
        ) => Promise<{ ok: boolean; relPath: string }>;
        /** OS path of a File from an external drag (webUtils.getPathForFile). */
        pathForFile: (file: File) => string;
        /** Read a LOCAL absolute file's bytes (base64) — the client half of a remote
         *  external-file drop (bytes shipped to the host to write into a folder). */
        readExternalBytes: (
            absPath: string,
        ) => Promise<{ name: string; base64: string }>;
        delete: (
            workspacePath: string,
            relPath: string,
            system?: boolean,
        ) => Promise<{ ok: boolean }>;
        gitStatus: (
            workspacePath: string,
            opts?: { ignored?: boolean },
        ) => Promise<GitStatusMap>;
        /** Start/stop live fs-watching of a workspace root; drives on.treeChanged. */
        watch: (workspacePath: string) => Promise<{ ok: boolean }>;
        unwatch: (workspacePath: string) => Promise<{ ok: boolean }>;
    };
    github: {
        status: () => Promise<{
            connected: boolean;
            username: string | null;
            needsReauth: boolean;
            clientIdSet: boolean;
            builtInClientId: boolean;
            usingOverride: boolean;
            activeClientId: string;
            storageOk: boolean;
            flow:
                | { kind: 'idle' }
                | {
                      kind: 'pending';
                      userCode: string;
                      verificationUri: string;
                      expiresInSec: number;
                  }
                | {
                      kind: 'success';
                      user: { login: string; name: string | null; avatar_url: string };
                  }
                | { kind: 'error'; code: string; message: string };
        }>;
        startDevice: () => Promise<{
            user_code: string;
            verification_uri: string;
            expires_in: number;
            interval: number;
        }>;
        cancelDevice: () => Promise<{ ok: boolean }>;
        resetClientId: () => Promise<{ ok: boolean }>;
        /**
         * Install URL for the "Genie IDE" GitHub App. With no arg this is the
         * account chooser (personal + every installable org); pass a numeric
         * account id to pre-target the chooser at that account.
         */
        installUrl: (targetId?: number | null) => Promise<string>;
        disconnect: () => Promise<{ ok: boolean }>;
        user: () => Promise<{ login: string; name: string | null; avatar_url: string }>;
        /** Org accounts where the GitHub App is installed (for the owner picker). */
        orgs: () => Promise<
            Array<{
                login: string;
                avatar_url: string;
            }>
        >;
        /** Every account the App is installed on — personal AND orgs. Source of
         *  truth for "is Genie installed anywhere / on this account". */
        installations: () => Promise<
            Array<{
                login: string;
                avatar_url: string;
                id: number | null;
                isOrg: boolean;
            }>
        >;
        /** Resolve a source repo's owner (login + id + isOrg) so create/fork
         *  can target the SAME account the original repo lives in. */
        repoOwner: (
            owner: string,
            repo: string,
        ) => Promise<{ login: string; id: number | null; isOrg: boolean }>;
        createRepo: (opts: {
            name: string;
            owner?: string | null;
            ownerId?: number | null;
            description?: string;
            private?: boolean;
        }) => Promise<{
            full_name: string;
            clone_url: string;
            ssh_url: string;
            html_url: string;
            default_branch: string;
        }>;
        forkRepo: (opts: {
            owner: string;
            repo: string;
            intoOrg?: string | null;
            intoOrgId?: number | null;
            name?: string;
        }) => Promise<{
            full_name: string;
            clone_url: string;
            ssh_url: string;
            html_url: string;
            default_branch: string;
        }>;
        parseRemote: (
            url: string,
        ) => Promise<{ owner: string; repo: string } | null>;
        /**
         * Current GitHub capability status: which GitHub-dependent features the
         * installed App's granted permissions allow, and which are gated off
         * for want of a permission. Drives the resolve modal + header warning.
         */
        capabilities: () => Promise<GithubCapabilities>;
        /** Whether a single GitHub-dependent capability is usable right now. */
        canAccess: (key: GithubCapabilityKey) => Promise<boolean>;
        /**
         * Force a re-detection (after a reconnect / the owner approving a
         * permission update on GitHub). Returns + broadcasts the fresh status,
         * so a resolved warning clears across every window.
         */
        recheckCapabilities: () => Promise<GithubCapabilities>;
    };

    terminal: {
        create: (opts: {
            id: string;
            cwd: string;
            shell?: string;
            args?: string[];
            cols?: number;
            rows?: number;
            env?: Record<string, string>;
            /** The terminal's workspace id. Used only on a relay REMOTE session,
             *  where it's tagged onto the term `open` frame so the host scopes the
             *  terminal to the grant's workspaces; ignored for a local pty spawn. */
            workspaceId?: string;
        }) => Promise<{
            id: string;
            pid: number;
            shell: string;
            existing: boolean;
            scrollback: string;
            snapshot?: { serialized: string; savedAt: number };
        }>;
        write: (id: string, data: string) => Promise<boolean>;
        resize: (id: string, cols: number, rows: number) => Promise<boolean>;
        /** Persist a SerializeAddon snapshot of this terminal's buffer (Tier 1). */
        snapshot: (id: string, serialized: string) => Promise<boolean>;
        detach: (id: string) => Promise<boolean>;
        /**
         * Tier 2: keep a pty alive on zero owners (retained=true, for disable)
         * or release it (retained=false). Set true BEFORE the last detach.
         * Refused (ok=false) when retaining would exceed the cap.
         */
        setRetained: (
            id: string,
            retained: boolean,
        ) => Promise<{ ok: boolean; retainedCount: number; max: number; reason?: string }>;
        kill: (id: string) => Promise<boolean>;
        list: () => Promise<Array<{ id: string; pid: number; shell: string }>>;
        /** Agent-integration MCP: clear a terminal's attention glow (imDone). */
        clearAttention: (id: string) => Promise<void>;
    };
    /** Agent-integration MCP: the ForceTheQuestion OS-level modal. */
    ask: {
        onShow: (
            cb: (payload: {
                id: string;
                workspaceLabel?: string;
                questions: ForceQuestionSpec[];
                /** How many other requests are still queued behind this one. */
                queued?: number;
            }) => void,
        ) => () => void;
        answer: (id: string, answers: ForceAnswerSpec[]) => Promise<void>;
        cancel: (id: string) => Promise<void>;
        /** Signal main the show-listener is attached (race-free delivery). */
        ready: () => Promise<void>;
        /** Close this modal window regardless of state (resolves cancelled). */
        dismiss: () => Promise<void>;
    };
    on: {
        authChanged: (
            cb: (payload: {
                backend?: BackendKind;
                signedIn: boolean;
            }) => void,
        ) => () => void;
        inboxUpdated: (cb: (payload: { count: number }) => void) => () => void;
        /** Customization: play a notification chime. The `sound` descriptor is
         *  resolved main-side from the per-alert setting (synth / bundled asset /
         *  custom data-URL); a legacy payload without it falls back to synth. */
        notifySound: (
            cb: (payload: {
                kind: string;
                sound?:
                    | { mode: 'synth' }
                    | { mode: 'asset'; name: string }
                    | { mode: 'data'; dataUrl: string };
            }) => void,
        ) => () => void;
        /** The tray "Task Manager…" item asks the master window to open it. */
        openTaskManager: (cb: () => void) => () => void;
        /** Issue Watch: per-workspace unread counts (by type) + per-workspace
         *  worst read detail (bucket + raw HTTP status/message, so the flyout
         *  can explain a silent-empty pill precisely) + whether the GitHub
         *  session is dead (drives the Reconnect CTA live, no reopen needed). */
        issueWatchUpdate: (
            cb: (payload: {
                counts: Record<string, WatchTypeCounts>;
                errors?: Record<string, WatchErrorDetail>;
                needsReauth?: boolean;
            }) => void,
        ) => () => void;
        terminalData: (
            cb: (payload: { id: string; data: string }) => void,
        ) => () => void;
        terminalExit: (
            cb: (payload: { id: string; exitCode: number; signal?: number }) => void,
        ) => () => void;
        /** Main asks every window to serialize its terminals before quit (Tier 1). */
        terminalSnapshotRequest: (cb: () => void) => () => void;
        /** Live pty count broadcast (Tier 2 resource awareness). */
        terminalCount: (cb: (payload: { count: number }) => void) => () => void;
        /** A setting changed (payload = changed keys) — live UI re-reads with no
         *  restart (e.g. a terminal's copy/paste mode). */
        settingsChanged: (cb: (changedKeys: string[]) => void) => () => void;
        /** Agent-integration MCP: a terminal asked for attention (imDone) or cleared. */
        terminalAttention: (
            cb: (payload: { id: string; on: boolean }) => void,
        ) => () => void;
        /** Agent-integration MCP: pulse a workspace row — a terminal in it called
         *  imDone (workspaceId is the synthetic System Workspace id for a
         *  System-Workspace terminal). A transient sidebar-level cue. */
        workspacePulse: (
            cb: (payload: { workspaceId: string }) => void,
        ) => () => void;
        /** AgentPulse — per-workspace real-time terminal-activity. `active` drives
         *  the rail-icon glow; `bytes` (since the last emit) feeds the live
         *  1-minute sparkline. */
        agentPulse: (
            cb: (payload: { workspaceId: string; active: boolean; bytes: number }) => void,
        ) => () => void;
        /** A workspace was "opened" (tray / menu / MCP) — focus it in the master
         *  window and open its in-app editor scoped to the workspace folder. */
        workspaceOpen: (
            cb: (payload: { workspaceId: string }) => void,
        ) => () => void;
        /** openFileForUser (MCP) — open a file in the workspace's built-in editor,
         *  reusing an open Code panel or opening a new one. Reply with
         *  api().editor.openFileResult(requestId, …). */
        editorOpenFile: (
            cb: (payload: {
                requestId: string;
                workspaceId: string;
                root: string;
                relPath: string;
                line?: number;
            }) => void,
        ) => () => void;
        /** A background Process changed status. */
        processStatus: (
            cb: (payload: { id: string; status: ProcessStatus }) => void,
        ) => () => void;
        /** The set of terminal specs changed outside the renderer's own edits
         *  (e.g. an MCP-created process) — re-fetch the spec list to stay live. */
        terminalSpecsChanged: (cb: () => void) => () => void;
        /** The set of workspaces changed outside the renderer's own edits (e.g.
         *  MCP-provisioned child workspaces) — re-fetch the workspace list. */
        workspacesChanged: (cb: () => void) => () => void;
        /** A file changed on disk in a watched workspace (an agent, a git op, a
         *  tool) — the Files panel re-lists its tree AND reloads ONLY the open
         *  tabs whose file is named in `changed` (forward-slashed rel paths). A
         *  null `changed` (too many, or an unnamed event) re-lists the tree only
         *  and reloads no open viewer. Debounced in main. */
        treeChanged: (
            cb: (payload: { workspacePath: string; changed: string[] | null }) => void,
        ) => () => void;
        /** Tier 3 detached-host status — fired on fallback to in-process. */
        terminalHostStatus: (
            cb: (payload: { message: string; level: 'info' | 'warn' }) => void,
        ) => () => void;
        /**
         * Manual-quit terminal confirmation (T3). Main asks the master window to
         * pick which detached terminals to keep running vs shut down before quit.
         * Reply via app.quitDecision().
         */
        confirmQuitTerminals: (
            cb: (payload: {
                terminals: Array<{ id: string; pid: number; shell: string }>;
            }) => void,
        ) => () => void;
        updaterStatus: (cb: (status: UpdaterStatus) => void) => () => void;
        updaterLog: (cb: (payload: { line: string }) => void) => () => void;
        /** GitHub capability status changed (boot check, connect, reconnect,
         *  disconnect, or an explicit recheck). The renderer raises/clears the
         *  resolve modal + header warning and re-gates features from this. */
        githubCapabilities: (
            cb: (payload: GithubCapabilities) => void,
        ) => () => void;
        /** AgentInbox: an agent joined / changed accessibility / went offline —
         *  the panel re-renders its directory + channel list live. */
        agentInboxPresence: (
            cb: (payload: AgentInboxPresenceEvent) => void,
        ) => () => void;
        /** AgentInbox: a new message (preview only) — the panel bumps its unread
         *  badge and, if the relevant thread is open, re-fetches history. */
        agentInboxMessage: (
            cb: (payload: AgentInboxMessageEvent) => void,
        ) => () => void;
        /** AgentInbox (Track C): an urgent DM went unACKed past the window — the
         *  panel shows a "waiting on <agent>" oversight alert (cleared when the
         *  same event arrives with `resolved: true`). */
        agentInboxEscalation: (
            cb: (payload: AgentInboxEscalationEvent) => void,
        ) => () => void;
        /** Knowledge Graph: any change (add / update / delete / link), INCLUDING
         *  an agent's MCP write — the window re-fetches its list + graph so the
         *  view stays live. Returns an unsubscribe fn. */
        knowledgeChanged: (
            cb: (payload: {
                action: 'add' | 'update' | 'delete' | 'link';
                id?: string;
            }) => void,
        ) => () => void;
    };
}

declare global {
    interface Window {
        genie: GenieApi;
    }
}

let activeRemoteBridge: GenieApi | null = null;
let remoteBindingResolved = false;

/**
 * Bind THIS WINDOW's api() to local-or-remote ONCE, by the window's OWN binding —
 * NOT a global status swap. Multi-host coexistence depends on this: a HOST window
 * (opened by the factory, loaded with `?host=<connKey>`) routes api() to its host
 * over the bridge for its whole lifetime, while the LOCAL window — and every other
 * host window — is unaffected. There is no `onStatus`-driven global flip, so
 * opening or closing a host can NEVER turn another window remote.
 *
 * The URL `?host=` hint decides SYNCHRONOUSLY (so a host window never flashes the
 * local desktop before an async call resolves); we then confirm against main's
 * authoritative `myBinding()` once and correct any mismatch.
 */
function ensureRemoteBinding(local: GenieApi): void {
    if (remoteBindingResolved) return;
    remoteBindingResolved = true;
    const isHostWindow =
        typeof window !== 'undefined' && /[?&]host=/.test(window.location?.search ?? '');
    if (isHostWindow) activeRemoteBridge = makeRemoteBridge(local);
    // Confirm against main (authoritative): a host window stays remote, the local
    // window stays local. Defensive — corrects a stale/absent URL hint.
    local.remote
        .myBinding()
        .then((b) => {
            activeRemoteBridge = b.mode === 'remote' ? makeRemoteBridge(local) : null;
        })
        .catch(() => {});
}

/**
 * True when THIS window is a remote HOST window (opened by the host-window factory
 * with `?host=<connKey>`), driving another machine over the bridge. The same
 * synchronous URL signal `ensureRemoteBinding` seeds `api()` from — so callers can
 * cheaply decide "is the terminal here running on a remote host?" without an async
 * `myBinding()` round-trip.
 */
export function isRemoteWindow(): boolean {
    return typeof window !== 'undefined' && /[?&]host=/.test(window.location?.search ?? '');
}

/**
 * The connection key that scopes THIS window's CLIENT-LOCAL per-device state
 * (panel view layout — see `renderer/lib/view-state.ts`). A host window
 * (`?host=<connKey>`) uses that host's key; the local desktop window uses the
 * `'local'` sentinel. Derived SYNCHRONOUSLY from the same URL signal `api()`
 * binds from, so callers never need an async `remote.myBinding()` round-trip to
 * decide which layout bucket to read/write.
 */
export function currentConnKey(): string {
    if (typeof window === 'undefined') return 'local';
    const m = /[?&]host=([^&]*)/.exec(window.location?.search ?? '');
    return m && m[1] ? decodeURIComponent(m[1]) : 'local';
}

export function api(): GenieApi {
    if (typeof window === 'undefined' || !window.genie) {
        throw new Error(
            'window.genie unavailable — preload.ts did not run. Either the page is being rendered outside Electron (e.g. opened directly in a browser) or the preload script failed to compile. Check the Electron main-process console for a load error.',
        );
    }
    ensureRemoteBinding(window.genie);
    return activeRemoteBridge ?? window.genie;
}

/** Returns true when the preload bridge is wired and callable. */
export function hasGenieBridge(): boolean {
    return typeof window !== 'undefined' && !!window.genie;
}

/**
 * Synthetic "System Workspace" — a hardcoded sidebar entry that is NOT a real
 * workspace: it has no project.json and never enters the persisted workspace
 * store. Its `path` is the user's home directory, so terminals/editors opened
 * in it root there. It exists to host SYSTEM PROCESSES — background processes
 * not tied to any project, whose cwd is an arbitrary directory the user picks.
 *
 * The id is a fixed sentinel so the renderer can recognise it everywhere a
 * workspace id flows; it is never written to the DB. System Workspace
 * terminal specs persist with `workspace_id: null` (FK-safe — `__system__`
 * has no `workspaces` row) and a `meta.system === true` tag so the sidebar can
 * group them under the System Workspace rather than the generic Unattached
 * bucket.
 */
export const SYSTEM_WORKSPACE_ID = '__system__';

/** True for the synthetic System Workspace row (see {@link SYSTEM_WORKSPACE_ID}). */
export function isSystemWorkspace(ws: { id: string }): boolean {
    return ws.id === SYSTEM_WORKSPACE_ID;
}

/**
 * A workspace does NOT require a Tynn/Aionima project — associating one is
 * optional. When absent, `project_id`/`project_name` are empty, so display the
 * folder's leaf name instead of a blank. (The System Workspace keeps its own
 * non-empty project fields, so this only ever fills in for project-less rows.)
 */
export function workspaceDisplayName(
    ws: Pick<WorkspaceRow, 'project_name' | 'tynn_project_name' | 'path'>,
): string {
    const name = (ws.project_name || ws.tynn_project_name || '').trim();
    if (name) return name;
    const leaf = (ws.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return leaf || 'Workspace';
}

/** True when a workspace has no associated project (project association is optional). */
export function hasProjectAssociation(ws: Pick<WorkspaceRow, 'project_id'>): boolean {
    return !!ws.project_id && ws.project_id !== SYSTEM_WORKSPACE_ID;
}

/**
 * A workspace's AgentInbox slug — the base of the `slug:purpose` channel name.
 * Mirrors main's slug resolution FALLBACK: the envelope folder leaf (minus a
 * `.agi` suffix), else the kebab of the project name. This is the renderer-side
 * PREVIEW; the authoritative slug (a Tynn-linked project's real slug) is computed
 * on the host, which owns the backend project record.
 */
export function workspaceSlug(
    ws: Pick<WorkspaceRow, 'path' | 'project_name'>,
): string {
    const leaf = (ws.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const base = leaf.replace(/\.agi$/i, '') || ws.project_name || '';
    return (
        base
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'workspace'
    );
}

/**
 * Build the in-memory System Workspace row. `homePath` is `os.homedir()` from
 * main (see `api().app.homeDir()`). Shaped as a `WorkspaceRow` so it slots into
 * the sidebar's workspace list without special-casing the renderer everywhere,
 * but it is never persisted and has no repos.
 */
export function makeSystemWorkspace(homePath: string): WorkspaceRow {
    return {
        id: SYSTEM_WORKSPACE_ID,
        backend: 'tynn',
        project_id: SYSTEM_WORKSPACE_ID,
        project_name: 'System',
        tynn_project_id: SYSTEM_WORKSPACE_ID,
        tynn_project_name: 'System',
        shape: 'simple',
        path: homePath,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        mcp_enabled: 0,
        process_approval: 1,
        terminal_approval: 1,
    };
}

export function ulid(): string {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 10);
    return (t + r).padEnd(20, '0').slice(0, 20).toUpperCase();
}

/**
 * Detected shells, cached for the window's lifetime. Detection walks the
 * filesystem in main, so every TerminalPanel sharing one promise beats N
 * panels firing N IPC round-trips on a grid render. Installing a new
 * shell mid-session just needs a window reload to show up.
 */
let shellsPromise: Promise<{
    shells: ShellDetection[];
    defaultId: string | null;
}> | null = null;
export function detectedShells(): Promise<{
    shells: ShellDetection[];
    defaultId: string | null;
}> {
    if (!shellsPromise) {
        shellsPromise = api()
            .settings.detectShells()
            .catch(() => ({ shells: [], defaultId: null }));
    }
    return shellsPromise;
}
