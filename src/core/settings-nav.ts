import { isAlertSoundKey } from './alerts.js';

/**
 * WORKSTATION SETTINGS — GENIE 1'S SIDEBAR (the owner, 2026-10-19: "the whole workstation settings view is stupid, ugly
 * hard to use and not even remotely correct"; plan .ai/plans/genie-2-settings-redesign.md, approved FTQ q_3e5257af).
 *
 * The navigation model, pure — as Genie 1's renderer/lib/settings-nav.ts was — so where every setting lives is decided
 * and tested without a DOM. Grouped sections, one page each. EVERY registry key has exactly one page or is deliberately
 * not drawn: internal bookkeeping and one workspace's own layout (changed where its terminals are).
 */

export type SectionId =
    | 'general' | 'notifications' | 'keyboard' | 'appearance'
    | 'tynn' | 'github'
    | 'providers' | 'workspace-defaults' | 'prompts' | 'agent-mcp' | 'plugins'
    | 'remote'
    | 'terminals' | 'toolchain';

export interface NavItem {
    readonly id: SectionId;
    readonly label: string;
    /** A Fancy (lucide) icon name, registered in renderer/icons.ts. */
    readonly icon: string;
}

export interface NavGroup {
    readonly label: string;
    readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
    {
        label: 'Genie',
        items: [
            { id: 'general', label: 'General', icon: 'settings' },
            { id: 'notifications', label: 'Notifications & sounds', icon: 'bell' },
            { id: 'keyboard', label: 'Keyboard', icon: 'keyboard' },
            { id: 'appearance', label: 'Appearance', icon: 'palette' },
        ],
    },
    {
        label: 'Accounts',
        items: [
            { id: 'tynn', label: 'Tynn', icon: 'cloud' },
            { id: 'github', label: 'GitHub', icon: 'github' },
        ],
    },
    {
        label: 'Agents',
        items: [
            { id: 'providers', label: 'Providers', icon: 'square-terminal' },
            { id: 'workspace-defaults', label: 'Defaults for workspaces', icon: 'layout-grid' },
            { id: 'prompts', label: 'Saved prompts', icon: 'message-square' },
            { id: 'agent-mcp', label: 'Agent MCP', icon: 'plug' },
            { id: 'plugins', label: 'Plugins', icon: 'puzzle' },
        ],
    },
    {
        label: 'Network',
        items: [{ id: 'remote', label: 'Remote access', icon: 'smartphone' }],
    },
    {
        label: 'System',
        items: [
            { id: 'terminals', label: 'Terminals', icon: 'square-terminal' },
            { id: 'toolchain', label: 'Toolchain', icon: 'wrench' },
        ],
    },
];

const SECTIONS: readonly SectionId[] = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

/** Kept, never drawn: bookkeeping and one workspace's own layout. (GitHub is no setting: its card reads GitHub itself.) */
export const NOT_DRAWN: readonly string[] = [
    'whats_new_seen_version', 'tray_notice_shown',
    'panel_layout', 'panel_splits', 'workspace_tabs',
    // Drawn as Remote access's own switch, at the top of that section (Tynn #820) — not as a settings row.
    'remote_access',
];

const PLACE: Readonly<Record<string, SectionId>> = {
    update_channel: 'general', launch_at_login: 'general', start_minimized: 'general',
    do_not_disturb: 'general', dnd_reply: 'general', dnd_question_sound: 'general',
    notification_sounds: 'notifications',
    command_window_hotkey: 'keyboard', ftq_nudge_hotkey: 'keyboard',
    // Drawn as its own row (a folder + Browse) on General, not a generic one.
    primary_workspace: 'general',
    theme: 'appearance', sidebar_width: 'appearance',

    default_agent: 'workspace-defaults', approval_gates: 'workspace-defaults', agent_cap: 'workspace-defaults',
    inbox_access: 'workspace-defaults',
    limit_terminals: 'workspace-defaults', limit_processes: 'workspace-defaults',
    saved_prompts: 'prompts',
    mcp_sync_claude: 'agent-mcp', mcp_sync_cursor: 'agent-mcp', mcp_sync_codex: 'agent-mcp', mcp_sync_hooks: 'agent-mcp',
    developer_mode: 'plugins',
    track_cwd: 'terminals', detached_terminals: 'terminals',
};

/** The page a setting is on, or `null` when it is not drawn. Every alert sound (and its custom file) is under Notifications. */
export function sectionOf(key: string): SectionId | null {
    if (NOT_DRAWN.includes(key)) return null;
    if (isAlertSoundKey(key) || /^sound_.+_custom$/.test(key)) return 'notifications';
    return PLACE[key] ?? null;
}

/** Where an older link lands: the four tab groups and the sub-routes lines and signals point at. */
const ALIASES: Readonly<Record<string, SectionId>> = {
    agents: 'workspace-defaults',
    workstation: 'agent-mcp',
    mcp: 'agent-mcp',
    updates: 'general',
};

/** The page for `genie://settings/<x>` (or an older `?group=<x>`): a section, an alias, or General. */
export function sectionFromRoute(raw: string | null): SectionId {
    if (raw === null) return 'general';
    if ((SECTIONS as readonly string[]).includes(raw)) return raw as SectionId;
    return ALIASES[raw] ?? 'general';
}
