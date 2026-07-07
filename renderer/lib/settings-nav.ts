/**
 * Settings navigation model + the remote-window restriction — kept free of React
 * so the gating logic is unit-testable without a DOM (the renderer test env is
 * Node-only). settings.tsx renders from this data and honours these predicates.
 */

import type { Settings } from './genie';

/** The Settings sidebar sections. */
export type SectionId =
    | 'general'
    | 'tools'
    | 'workspaces'
    | 'customization'
    | 'agent-mcp'
    | 'plugins'
    | 'mobile'
    | 'sites'
    | 'connections'
    | 'devices'
    | 'updates';

export interface NavItem {
    id: SectionId;
    label: string;
    icon: string;
}
export interface NavGroup {
    label: string;
    items: NavItem[];
}

/**
 * Left-sidebar information architecture. `icon` values are kebab-case lucide names
 * resolved by react-fancy's <Icon>.
 */
export const NAV_GROUPS: NavGroup[] = [
    {
        label: 'Workspace',
        items: [
            { id: 'general', label: 'General', icon: 'settings' },
            { id: 'tools', label: 'Tools', icon: 'terminal' },
            { id: 'workspaces', label: 'Workspaces', icon: 'layout-grid' },
            { id: 'customization', label: 'Customization', icon: 'palette' },
        ],
    },
    {
        label: 'Agents & network',
        items: [
            { id: 'agent-mcp', label: 'Agent MCP', icon: 'plug' },
            { id: 'plugins', label: 'Plugins', icon: 'puzzle' },
            { id: 'mobile', label: 'Work Mode', icon: 'monitor' },
            { id: 'sites', label: '.gen Sites', icon: 'globe' },
            { id: 'connections', label: 'Connections', icon: 'link' },
            { id: 'devices', label: 'Devices', icon: 'smartphone' },
        ],
    },
    {
        label: 'System',
        items: [{ id: 'updates', label: 'Updates', icon: 'download' }],
    },
];

/**
 * The 3-way split for a remote/host window (the client is driving ANOTHER machine):
 *
 *  1. DEVICE / UI prefs — CLIENT-LOCAL. "How the client experiences THIS window":
 *     theme, notifications, terminal copy/paste (all under Customization) + panel
 *     layout. Edit the CLIENT's own prefs; api() stays local for these.
 *  2. WORKSPACE / AGENT-ENVIRONMENT — HOST-SOURCED. The settings that govern how the
 *     AGENT runs in the workspace, and the agent runs on the HOST: the Ai.System
 *     workspace-instructions injected into the host's AGENTS.md, the Agent-MCP config
 *     the host binds + syncs into its workspaces, and the host terminal toolkit env
 *     (`Tools`). Their VALUES come from + write to the HOST via the settings bridge
 *     (remote-bridge.ts) — see HOST_SOURCED_SETTINGS_KEYS.
 *  3. HOST-MACHINE-ONLY / wrong-scoped — HIDDEN. Everything else configures the
 *     CLIENT's own machine / app launch / connections / Work-Mode role (General's
 *     primary-workspace folder picker, Startup, Quick-capture hotkey, Work Mode,
 *     Connections, Devices, Updates), meaningless or mis-targeted in a driving
 *     window, so it stays hidden.
 */

/**
 * Settings keys whose VALUE is sourced from the HOST in a remote/host window
 * (bucket 2). In a remote window the settings bridge reads/writes these against the
 * HOST; every OTHER key stays CLIENT-LOCAL. MIRRORED as `HOST_SOURCED_SETTINGS_KEYS`
 * in main/mobile/api.ts, which enforces the SAME allow-list server-side (a remote
 * can only read/set these host keys — never arbitrary ones like a github token).
 */
export const HOST_SOURCED_SETTINGS_KEYS = [
    // Ai.System — the workspace-instructions injected into every host workspace's
    // AGENTS.md (read lazily on the host at doc-sync time).
    'ai_system',
    // Host terminal environment: prepend the bundled toolkit + inject GENIE_* env
    // into the pty the agent runs in (read on the host at terminal spawn).
    'cli_tools_in_terminals',
    // Agent-MCP config: the loopback port the HOST binds + which agent configs it
    // keeps synced into its workspaces.
    'mcp_port',
    'mcp_sync_claude',
    'mcp_sync_cursor',
    'mcp_sync_agents',
] as const satisfies readonly (keyof Settings)[];

export type HostSourcedSettingKey = (typeof HOST_SOURCED_SETTINGS_KEYS)[number];

const HOST_KEY_SET: ReadonlySet<string> = new Set(HOST_SOURCED_SETTINGS_KEYS);

/** Whether a settings key is HOST-sourced in a remote window (bucket 2). */
export function isHostSourcedSettingKey(key: string): key is HostSourcedSettingKey {
    return HOST_KEY_SET.has(key);
}

/**
 * RUNTIME/SESSION-owned settings keys — written CONTINUOUSLY by the master Floor
 * (and its grid) as the user works, NOT by the Settings UI. They live in the same
 * k/v `settings` table only because it's the single local key/value store, but the
 * Settings window has NO control that edits them:
 *
 *  - `view_state_json`  — this window's panel VIEW state (which panels are open/
 *    closed, focus, maximize, layout mode) per `${connKey}|${workspace}` (see
 *    view-state.ts). The master persists it debounced on every open/close/focus.
 *  - `layout_json`      — the draggable-grid track SIZES per `${connKey}|${ws}|${sig}`
 *    (TerminalGrid). The master persists it on every gutter drag.
 *  - `active_workspace` — which workspace fills the grid (master).
 *  - `collapsed_workspaces` — sidebar expand/collapse state (master).
 *
 * The Settings window loads the WHOLE Settings object ONCE on open and writes it
 * back wholesale on Save. Without excluding these, that write-back REVERTS them to
 * the stale snapshot taken at Settings-open (or the defaults on a fresh install) —
 * so a panel the user closed after opening Settings reopens, panel sizes reset, and
 * because `view_state_json` is one blob spanning every connKey, it clobbers the
 * saved layout of the local window AND every host window at once (closed panels
 * reappear on the next reconnect / restart). They are STRIPPED from the Settings
 * save so only the master/grid — which always writes them with targeted patches —
 * ever owns them.
 */
export const RUNTIME_OWNED_SETTINGS_KEYS = [
    'view_state_json',
    'layout_json',
    'active_workspace',
    'collapsed_workspaces',
    // The split Add-Terminal button writes this each time the user creates a
    // terminal (last-used type). Like the panel-layout keys it must NOT be
    // clobbered by the Settings window's stale-snapshot Save.
    'last_terminal_type',
] as const satisfies readonly (keyof Settings)[];

export type RuntimeOwnedSettingKey = (typeof RUNTIME_OWNED_SETTINGS_KEYS)[number];

const RUNTIME_KEY_SET: ReadonlySet<string> = new Set(RUNTIME_OWNED_SETTINGS_KEYS);

/** Whether a settings key is master/grid runtime-owned (never written by Settings). */
export function isRuntimeOwnedSettingKey(key: string): key is RuntimeOwnedSettingKey {
    return RUNTIME_KEY_SET.has(key);
}

/**
 * Drop the RUNTIME-owned keys from a Settings snapshot so the Settings window's
 * whole-object Save can't clobber the master/grid's live panel view + layout state.
 * Returns a new object; the input is untouched.
 */
export function withoutRuntimeOwnedSettings(s: Partial<Settings>): Partial<Settings> {
    const out: Partial<Settings> = {};
    for (const key of Object.keys(s) as (keyof Settings)[]) {
        if (!isRuntimeOwnedSettingKey(key)) {
            (out as Record<string, unknown>)[key] = s[key];
        }
    }
    return out;
}

/**
 * Sections whose content survives when Settings is opened FROM a remote/host window.
 * Two kinds (see the 3-way split above):
 *  - DEVICE-LOCAL: `customization` — theme / notifications / copy-paste; edits the
 *    CLIENT's own prefs.
 *  - HOST-SOURCED: `tools` + `agent-mcp` — the workspace / agent environment, whose
 *    values come from + write to the HOST (badged "On the host" in the UI).
 * Every other section is host-machine-only / wrong-scoped and stays hidden.
 */
export const REMOTE_SECTIONS = new Set<SectionId>(['customization', 'tools', 'agent-mcp']);

/**
 * The remote-visible sections whose content is HOST-sourced (bucket 2) — the UI
 * badges these "On the host" so it's clear they edit the AGENT's environment on the
 * host, not the client. `customization` is device-local and NOT included.
 */
export const HOST_SOURCED_SECTIONS = new Set<SectionId>(['tools', 'agent-mcp']);

/** Whether a section's values are HOST-sourced in a remote window (drives the badge). */
export function isHostSourcedSection(id: SectionId): boolean {
    return HOST_SOURCED_SECTIONS.has(id);
}

/** Whether a section's content renders at all under the given restriction. */
export function isSectionVisible(id: SectionId, restricted: boolean): boolean {
    return !restricted || REMOTE_SECTIONS.has(id);
}

/** The nav groups to show: in a restricted (remote) window only the device-local +
 *  host-sourced sections survive, and any now-empty group is dropped. */
export function filterNavGroups(groups: NavGroup[], restricted: boolean): NavGroup[] {
    if (!restricted) return groups;
    return groups
        .map((g) => ({ ...g, items: g.items.filter((it) => REMOTE_SECTIONS.has(it.id)) }))
        .filter((g) => g.items.length > 0);
}

/** The section selected on open: the first visible one for this window (the first
 *  surviving nav item in a restricted window, General otherwise). */
export function defaultSection(restricted: boolean): SectionId {
    return filterNavGroups(NAV_GROUPS, restricted)[0]?.items[0]?.id ?? 'general';
}

/**
 * True when the Settings window was opened FROM a remote/host window — it carries
 * `?remote=1` (set by showSettingsWindow). DISTINCT from a `?host=` host window:
 * api() stays LOCAL here (the KEEP rows edit the CLIENT's own settings); we only
 * hide the machine/host/app config that's wrong-scoped in a driving window.
 */
export function isRestrictedSettings(): boolean {
    return (
        typeof window !== 'undefined' &&
        /[?&]remote=1(?:&|$)/.test(window.location?.search ?? '')
    );
}
