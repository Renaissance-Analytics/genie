/**
 * SETTINGS AND ONBOARDING (§6.9) — the pure half.
 *
 * Four groups with search. Every setting declares its SCOPE, and the §6.8 three-way split (what a
 * remote client keeps locally, what it takes from the host, what never leaves the host) is derived
 * from that declaration — so a new setting is placed by what it is, not by a list someone has to
 * remember to extend.
 *
 * v1 settings carry over by an explicit mapping. What still exists comes across typed; what does
 * not is REPORTED with the reason — the agent launch line above all, because agents are sessions
 * now and a carried-over `agent_command` is how every agent would end up on a pty again.
 *
 * Onboarding is two steps: pick a folder, meet an agent. Everything else is a line with a route to
 * fix it, never a gate — Genie is fully usable signed out of Tynn and without GitHub.
 */

export type SettingGroup = 'general' | 'agents' | 'workstation' | 'appearance';
export type SettingScope = 'device' | 'workspace' | 'host';

import { alertSoundSettings } from './alerts.js';

/** INTERNAL settings are remembered, never drawn and never found by search — state the UI writes, not a choice a person makes. */
export type SettingDef =
    | { key: string; group: SettingGroup; scope: SettingScope; label: string; description: string; type: 'boolean'; default: boolean; hidden?: true }
    | { key: string; group: SettingGroup; scope: SettingScope; label: string; description: string; type: 'string'; default: string; hidden?: true }
    | { key: string; group: SettingGroup; scope: SettingScope; label: string; description: string; type: 'enum'; options: readonly string[]; default: string; hidden?: true };

export const SETTINGS: readonly SettingDef[] = [
    { key: 'update_channel', group: 'general', scope: 'host', label: 'Update channel', description: 'Which releases this Genie offers to install.', type: 'enum', options: ['beta', 'stable'], default: 'beta' },
    { key: 'do_not_disturb', group: 'general', scope: 'host', label: 'Do not disturb', description: 'An agent that asks is told your reply at once; its question still waits for you.', type: 'boolean', default: false },
    { key: 'dnd_reply', group: 'general', scope: 'host', label: 'Do-not-disturb reply', description: 'What an agent is told when it asks while you are away.', type: 'string', default: 'Away from the desk — I will answer when I am back.' },
    { key: 'notification_sounds', group: 'general', scope: 'device', label: 'Notification sounds', description: 'Play a sound for each alert kind.', type: 'boolean', default: true },
    { key: 'inbox_access', group: 'agents', scope: 'workspace', label: 'Who may message agents here', description: 'The workspace’s half of the two-tier AgentInbox rule: none, only this workspace (self), or any workspace on this workstation (all). The agent’s own scope must allow it too.', type: 'enum', options: ['none', 'self', 'all'], default: 'self' },
    { key: 'agent_cap', group: 'agents', scope: 'workspace', label: 'Running agents cap', description: 'How many agents may run at once in a workspace. A start past the cap is refused and says so; nothing queues.', type: 'enum', options: ['1', '2', '4', '8', '16'], default: '8' },
    { key: 'restore_agents_on_launch', group: 'agents', scope: 'host', label: 'Restore agents on launch', description: 'Start the agents that were running when Genie last closed. Applies to every path that could restart an agent: launch, crash recovery, transport loss, upgrade.', type: 'boolean', default: false },
    { key: 'default_agent', group: 'agents', scope: 'workspace', label: 'Default agent', description: 'The provider a new agent in this workspace uses unless told otherwise.', type: 'enum', options: ['claude', 'codex'], default: 'claude' },
    { key: 'approval_gates', group: 'agents', scope: 'workspace', label: 'Approval gates', description: 'Which tool calls park for your approval.', type: 'enum', options: ['all', 'writes', 'none'], default: 'writes' },
    { key: 'tynn_token', group: 'general', scope: 'host', label: 'Tynn token', description: 'Signs this Genie in to Tynn, the optional identity layer. Genie is fully usable without it; Tynn-gated rows are annotated, never dropped.', type: 'string', default: '' },
    { key: 'tynn_host', group: 'general', scope: 'host', label: 'Tynn host', description: 'Where Tynn lives. Only a self-hosted Tynn changes this.', type: 'string', default: 'https://tynn.ai' },
    { key: 'github_authorized', group: 'workstation', scope: 'host', label: 'GitHub App authorized', description: 'Step 1 of 2: you authorized the Genie AOS GitHub App for your account.', type: 'boolean', default: false },
    { key: 'github_installed', group: 'workstation', scope: 'host', label: 'GitHub App installed', description: 'Step 2 of 2: the Genie AOS GitHub App is installed on the repositories Genie works in.', type: 'boolean', default: false },
    { key: 'mcp_sync_claude', group: 'workstation', scope: 'host', label: 'Sync Genie into Claude Code (.mcp.json)', description: 'Config sync writes Genie’s MCP endpoint into the workspace’s .mcp.json.', type: 'boolean', default: true },
    { key: 'mcp_sync_cursor', group: 'workstation', scope: 'host', label: 'Sync Genie into Cursor (.cursor/mcp.json)', description: 'Config sync writes Genie’s MCP endpoint into the workspace’s .cursor/mcp.json.', type: 'boolean', default: true },
    { key: 'mcp_sync_codex', group: 'workstation', scope: 'host', label: 'Sync Genie into Codex (.codex/config.toml)', description: 'Config sync writes Genie’s MCP server block into the workspace’s Codex config.', type: 'boolean', default: true },
    { key: 'mcp_sync_hooks', group: 'workstation', scope: 'host', label: 'Seed the imDone Stop hook (.claude/settings.local.json)', description: 'Config sync adds the hook that files a handoff when a Claude Code agent stops.', type: 'boolean', default: true },
    { key: 'developer_mode', group: 'workstation', scope: 'host', label: 'Developer mode', description: 'Run local UNSIGNED plugins from the plugins folder, labelled as such. Off: only plugins signed by a publisher key Genie carries are installed.', type: 'boolean', default: false },
    { key: 'panel_splits', group: 'workstation', scope: 'workspace', label: 'Pane split sizes', description: 'Where the splits between panes sit, per layout — written by dragging, remembered per workspace.', type: 'string', default: '', hidden: true },
    { key: 'panel_layout', group: 'workstation', scope: 'workspace', label: 'Terminal layout', description: 'How this workspace’s terminals are laid out: one at a time, two columns, two rows, or a 2×2 grid. Remembered per workspace.', type: 'enum', options: ['single', 'columns', 'rows', 'grid'], default: 'single' },
    { key: 'track_cwd', group: 'workstation', scope: 'host', label: 'Track terminal directory', description: 'Let terminals report their working directory so a new one opens where the last was.', type: 'boolean', default: true },
    { key: 'detached_terminals', group: 'workstation', scope: 'host', label: 'Keep terminals through a quit', description: 'Terminals survive Genie closing and are rejoined on the next launch.', type: 'boolean', default: false },
    { key: 'theme', group: 'appearance', scope: 'device', label: 'Theme', description: 'Dark, light, or follow the system.', type: 'enum', options: ['dark', 'light', 'system'], default: 'system' },
    { key: 'sidebar_width', group: 'appearance', scope: 'device', label: 'Sidebar width', description: 'Pixels.', type: 'string', default: '208' },
    // One row per alert kind, DERIVED from the registry — never a hand-kept list.
    ...alertSoundSettings(),
];

export function settingGroups(): readonly SettingGroup[] {
    return ['general', 'agents', 'workstation', 'appearance'];
}

export function searchSettings(query: string): Array<SettingDef & { group: SettingGroup }> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return SETTINGS.filter((s) => !s.hidden);
    return SETTINGS.filter((s) => !s.hidden && (s.key.toLowerCase().includes(q) || s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
}

/** v1 key → genie2 key. A v1 key with no entry here does not carry over, and says why. */
const V1_MAP: Readonly<Record<string, string>> = {
    theme: 'theme',
    restore_agents_on_launch: 'restore_agents_on_launch',
    update_channel: 'update_channel',
    track_cwd: 'track_cwd',
    detached_terminals: 'detached_terminals',
    notification_sounds: 'notification_sounds',
    dnd_reply: 'dnd_reply',
};

const V1_DROP_REASONS: Readonly<Record<string, string>> = {
    agent_command: 'agents are sessions in Genie 2; there is no launch line to carry',
};

export interface CarryOver {
    readonly applied: Record<string, boolean | string>;
    readonly dropped: Array<{ key: string; reason: string }>;
}

function coerce(def: SettingDef, raw: string): boolean | string | null {
    if (def.type === 'boolean') {
        const v = raw.trim().toLowerCase();
        if (['true', '1', 'on', 'yes'].includes(v)) return true;
        if (['false', '0', 'off', 'no'].includes(v)) return false;
        return null;
    }
    if (def.type === 'enum') return def.options.includes(raw) ? raw : null;
    return raw;
}

export function carryOverV1(v1: Readonly<Record<string, string>>): CarryOver {
    const applied: Record<string, boolean | string> = {};
    const dropped: Array<{ key: string; reason: string }> = [];
    for (const [key, raw] of Object.entries(v1)) {
        const target = V1_MAP[key];
        if (target === undefined) {
            dropped.push({ key, reason: V1_DROP_REASONS[key] ?? `no Genie 2 setting corresponds to v1's ${key}` });
            continue;
        }
        const def = SETTINGS.find((s) => s.key === target)!;
        const value = coerce(def, raw);
        if (value === null) {
            dropped.push({ key, reason: `${JSON.stringify(raw)} is not a valid value for ${target} (${def.type === 'enum' ? def.options.join(' | ') : def.type})` });
            continue;
        }
        applied[target] = value;
    }
    return { applied, dropped };
}

export interface OnboardingState {
    readonly workspaces: number;
    readonly agents: number;
    /** `null` = not looked yet. A line is drawn only for a MEASURED absence (§5). */
    readonly providers: readonly string[] | null;
    readonly githubConnected: boolean | null;
    readonly tynnSignedIn: boolean | null;
}

export interface OnboardingPlan {
    /** The gates. At most two, ever. */
    readonly steps: Array<{ id: 'pick-folder' | 'meet-agent'; label: string; required: true }>;
    /** Reported, never gating: each with the route that fixes it. */
    readonly lines: Array<{ id: 'no-provider' | 'github' | 'tynn'; label: string; route: string }>;
    readonly done: boolean;
}

export function onboardingPlan(state: OnboardingState): OnboardingPlan {
    const steps: OnboardingPlan['steps'] = [];
    if (state.workspaces === 0) steps.push({ id: 'pick-folder', label: 'Pick a folder to work in', required: true });
    if (state.agents === 0) steps.push({ id: 'meet-agent', label: 'Meet your first agent', required: true });
    const lines: OnboardingPlan['lines'] = [];
    if (state.providers !== null && state.providers.length === 0) lines.push({ id: 'no-provider', label: 'No agent provider is installed yet', route: 'genie://settings/agents' });
    if (state.githubConnected === false) lines.push({ id: 'github', label: 'GitHub is not connected', route: 'genie://settings/github' });
    if (state.tynnSignedIn === false) lines.push({ id: 'tynn', label: 'Not signed in to Tynn (optional)', route: 'genie://settings/tynn' });
    return { steps, lines, done: steps.length === 0 };
}
