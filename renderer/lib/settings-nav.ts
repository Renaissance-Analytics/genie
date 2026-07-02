/**
 * Settings navigation model + the remote-window restriction — kept free of React
 * so the gating logic is unit-testable without a DOM (the renderer test env is
 * Node-only). settings.tsx renders from this data and honours these predicates.
 */

/** The Settings sidebar sections. */
export type SectionId =
    | 'general'
    | 'tools'
    | 'workspaces'
    | 'customization'
    | 'agent-mcp'
    | 'mobile'
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
            { id: 'mobile', label: 'Work Mode', icon: 'monitor' },
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
 * Sections whose content survives when Settings is opened FROM a remote/host
 * window — only "how the client experiences THIS remote window". Theme,
 * notifications, and terminal copy/paste all live under Customization; every other
 * section configures a machine / its workspaces / app launch / connections and is
 * hidden (those edit the CLIENT's local machine, which is wrong-scoped in a window
 * that's driving another machine).
 */
export const RESTRICTED_SECTIONS = new Set<SectionId>(['customization']);

/** Whether a section's content renders at all under the given restriction. */
export function isSectionVisible(id: SectionId, restricted: boolean): boolean {
    return !restricted || RESTRICTED_SECTIONS.has(id);
}

/** The nav groups to show: in a restricted (remote) window only the connection-
 *  relevant sections survive, and any now-empty group is dropped. */
export function filterNavGroups(groups: NavGroup[], restricted: boolean): NavGroup[] {
    if (!restricted) return groups;
    return groups
        .map((g) => ({ ...g, items: g.items.filter((it) => RESTRICTED_SECTIONS.has(it.id)) }))
        .filter((g) => g.items.length > 0);
}

/** The section selected on open: the first visible one (Customization in a
 *  restricted window, General otherwise). */
export function defaultSection(restricted: boolean): SectionId {
    return restricted ? 'customization' : 'general';
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
