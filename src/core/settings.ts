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

import { alertSoundFileSettings, alertSoundSettings, legacySoundChoice } from './alerts.js';
import { LEGACY_CHANNEL_NAMES } from './update-channel.js';

/** INTERNAL settings are remembered, never drawn and never found by search — state the UI writes, not a choice a person makes. */
export type SettingDef =
    | { key: string; group: SettingGroup; scope: SettingScope; label: string; description: string; type: 'boolean'; default: boolean; hidden?: true }
    | { key: string; group: SettingGroup; scope: SettingScope; label: string; description: string; type: 'string'; default: string; hidden?: true }
    | { key: string; group: SettingGroup; scope: SettingScope; label: string; description: string; type: 'enum'; options: readonly string[]; optionLabels?: Readonly<Record<string, string>>; default: string; hidden?: true };

export const SETTINGS: readonly SettingDef[] = [
    { key: 'update_channel', group: 'general', scope: 'host', label: 'Update channel', description: 'stable: full releases only. dev: every build, including prereleases.', type: 'enum', options: ['stable', 'dev'], default: 'dev' },
    { key: 'do_not_disturb', group: 'general', scope: 'host', label: 'Do not disturb', description: 'An agent that asks is told your reply at once; its question still waits for you.', type: 'boolean', default: false },
    // Do not disturb silences every sound; this is Genie 1's one exception, carried over (`ftq_dnd_sound`).
    { key: 'dnd_question_sound', group: 'general', scope: 'host', label: 'Still chime for questions in Do not disturb', description: 'While Do not disturb is on, every alert is silent — except an agent asking you something, when this is on.', type: 'boolean', default: false },
    { key: 'dnd_reply', group: 'general', scope: 'host', label: 'Do-not-disturb reply', description: 'What an agent is told when it asks while you are away.', type: 'string', default: 'Away from the desk — I will answer when I am back.' },
    { key: 'notification_sounds', group: 'general', scope: 'device', label: 'Notification sounds', description: 'Play a sound for each alert kind.', type: 'boolean', default: true },
    // TRAY-RESIDENT (core/tray-resident.ts): closing the window hides Genie; these two decide how it comes up.
    { key: 'start_minimized', group: 'general', scope: 'host', label: 'Start minimized to tray', description: 'Genie starts without opening its window; open it from the tray icon.', type: 'boolean', default: false },
    { key: 'launch_at_login', group: 'general', scope: 'host', label: 'Launch at sign-in', description: 'Start Genie when you sign in to this computer.', type: 'boolean', default: false },
    // GENIE'S REMAPPABLE KEYS (Tynn #759; Genie 1's): empty = Genie's default (Ctrl/⌘+K, F5). Hidden: Settings → General
    // draws them as recorders (core/hotkeys.ts reads them; a malformed one disables its binding).
    { key: 'command_window_hotkey', group: 'general', scope: 'host', label: 'Command Window key', description: 'Opens the Command Window. Empty: Ctrl+K (⌘K on macOS).', type: 'string', default: '', hidden: true },
    { key: 'ftq_nudge_hotkey', group: 'general', scope: 'host', label: 'ForceTheQuestion nudge key', description: 'Tells the agent in front of you to ask its question through ForceTheQuestion. Empty: F5.', type: 'string', default: '', hidden: true },
    // WHAT'S NEW (Tynn #762; Genie 1's): the version whose What's New the person has closed — shown once per version.
    { key: 'whats_new_seen_version', group: 'general', scope: 'host', label: 'What’s new seen', description: 'The version whose What’s new was last closed.', type: 'string', default: '', hidden: true },
    { key: 'tray_notice_shown', group: 'general', scope: 'host', label: 'Tray notice shown', description: 'The one-time “Genie is still running in the tray” notice has been shown.', type: 'boolean', default: false, hidden: true },
    // APPS AND SCRIPTS REPORT TO AGENTS (genie#1345; the owner's D2: on by default): this workspace's sites, background
    // processes and script keys may post into its own agents' AgentInbox. Off: none of them holds a key.
    { key: 'app_inbox', group: 'agents', scope: 'workspace', label: 'Apps and scripts may message agents here', description: 'This workspace’s sites, background processes and script keys may report to its own agents, marked as an app’s message. Off: none of them gets a key.', type: 'boolean', default: true },
    { key: 'inbox_access', group: 'agents', scope: 'workspace', label: 'Who may message agents here', description: 'The workspace’s half of the two-tier AgentInbox rule: none, only this workspace (self), or any workspace on this workstation (all). The agent’s own scope must allow it too.', type: 'enum', options: ['none', 'self', 'all'], default: 'self' },
    // SAVED PROMPTS (Tynn #758; Genie 1's `saved_prompts`): the Command Window's library and each prompt's hotkey, as JSON
    // (core/prompt-library.ts reads it forgivingly). Hidden: Settings → Agents draws it as a list, not a JSON box.
    { key: 'saved_prompts', group: 'agents', scope: 'host', label: 'Saved prompts', description: 'Prompts you send from the Command Window or with their own hotkey.', type: 'string', default: '[]', hidden: true },
    { key: 'agent_cap', group: 'agents', scope: 'workspace', label: 'Running agents cap', description: 'How many agents may run at once in a workspace. A start past the cap is refused and says so; nothing queues.', type: 'enum', options: ['1', '2', '4', '8', '16'], default: '8' },
    // A SHELLS LIMITER, PER WORKSPACE (beta.33; the owner: "we have too many running shells. we need to include a shells
    // limiter"; FTQ q_98d1c350): SEPARATE limits, counted per workspace, the one past it refused and told why — terminals
    // and background processes now; an agent's own shells once they are measured (core/shell-limits.ts).
    { key: 'limit_terminals', group: 'agents', scope: 'workspace', label: 'Terminals per workspace', description: 'How many terminals may be open at once in a workspace — yours and the ones agents open. One more is refused and says why.', type: 'enum', options: ['1', '2', '3', '4', '6', '8', '12', '16', '24'], default: '8' },
    { key: 'limit_processes', group: 'agents', scope: 'workspace', label: 'Background processes per workspace', description: 'How many background processes (queue workers, watchers, servers) may run at once in a workspace. One more is refused and says why.', type: 'enum', options: ['1', '2', '3', '4', '6', '8', '12', '16', '24'], default: '8' },
    { key: 'default_agent', group: 'agents', scope: 'workspace', label: 'Provider for new agents', description: 'The provider a new agent in this workspace uses unless told otherwise.', type: 'enum', options: ['claude', 'codex'], default: 'claude' },
    { key: 'approval_gates', group: 'agents', scope: 'workspace', label: 'Approval gates', description: 'Which tool calls park for your approval.', type: 'enum', options: ['all', 'writes', 'none'], default: 'writes' },
    // PRIMARY WORKSPACE (Genie 1's `primary_workspace`, Settings → General): where a new workspace lands, and where a folder
    // picker opened from the workstation starts (core/add-workspace.ts). Drawn as a folder with Browse, not a text box.
    { key: 'primary_workspace', group: 'general', scope: 'host', label: 'Primary workspace', description: 'Default destination for NEW projects created from Genie. Existing projects can live anywhere — this is a default, not a constraint.', type: 'string', default: '', hidden: true },
    // ENV FILE NAME (Genie 1's `default_env_file`, Settings → General; Add workspace parity 2b): stamped on each new workspace
    // at register (main/workspace-ops-host.ts), and the file its sites' service connection is written to (main/dotenv-sync.ts).
    // Drawn beside Primary workspace in "Defaults for new projects", not under Startup and focus.
    { key: 'default_env_file', group: 'general', scope: 'host', label: 'Env file name', description: 'Default environment file name for new workspaces — the file in each site’s folder Genie keeps the service connection in.', type: 'string', default: '.env' },
    // THIS MACHINE AS A HOST (Tynn #820; the owner: remote access "Off by default", as Genie 1 had it). Drawn in Settings →
    // Remote access as its switch, not as a row.
    { key: 'remote_access', group: 'workstation', scope: 'host', label: 'Remote access', description: 'Let your other machines reach this Genie through Tynn, and devices on your tailnet.', type: 'boolean', default: false, hidden: true },
    { key: 'mcp_sync_claude', group: 'workstation', scope: 'host', label: 'Sync Genie into Claude Code (.mcp.json)', description: 'Config sync writes Genie’s MCP endpoint into the workspace’s .mcp.json.', type: 'boolean', default: true },
    { key: 'mcp_sync_cursor', group: 'workstation', scope: 'host', label: 'Sync Genie into Cursor (.cursor/mcp.json)', description: 'Config sync writes Genie’s MCP endpoint into the workspace’s .cursor/mcp.json.', type: 'boolean', default: true },
    { key: 'mcp_sync_codex', group: 'workstation', scope: 'host', label: 'Sync Genie into Codex (.codex/config.toml)', description: 'Config sync writes Genie’s MCP server block into the workspace’s Codex config.', type: 'boolean', default: true },
    { key: 'mcp_sync_hooks', group: 'workstation', scope: 'host', label: 'Seed the imDone Stop hook (.claude/settings.local.json)', description: 'Config sync adds the hook that files a handoff when a Claude Code agent stops.', type: 'boolean', default: true },
    { key: 'developer_mode', group: 'workstation', scope: 'host', label: 'Developer mode', description: 'Run local UNSIGNED plugins from the plugins folder, labelled as such. Off: only plugins signed by a publisher key Genie carries are installed.', type: 'boolean', default: false },
    { key: 'panel_splits', group: 'workstation', scope: 'workspace', label: 'Pane split sizes', description: 'Where the splits between panes sit, per layout — written by dragging, remembered per workspace.', type: 'string', default: '', hidden: true },
    // WORKSPACE TABS YOU DESIGN (Tynn #282): the tabs between Agents and Settings, their grids and panels, as JSON
    // (core/workspace-tabs.ts reads it forgivingly). Hidden: it is edited on the Workspace view, not in Settings.
    { key: 'workspace_tabs', group: 'workstation', scope: 'workspace', label: 'Workspace tabs', description: 'The tabs you designed in this workspace: their grids and panels.', type: 'string', default: '{"tabs":[]}', hidden: true },
    { key: 'panel_layout', group: 'workstation', scope: 'workspace', label: 'Terminal layout', description: 'How this workspace’s terminals are laid out: one at a time, two columns, two rows, or a 2×2 grid. Remembered per workspace.', type: 'enum', options: ['single', 'columns', 'rows', 'grid'], default: 'single' },
    { key: 'track_cwd', group: 'workstation', scope: 'host', label: 'Track terminal directory', description: 'Let terminals report their working directory so a new one opens where the last was.', type: 'boolean', default: true },
    { key: 'rate_limit_refresh', group: 'workstation', scope: 'host', label: 'Rate-limit refresh on the Dashboard', description: 'How often each provider’s rate-limit reading in the Dashboard header may change, in seconds. A reading that arrives sooner is ignored, so many agents reporting at once do not churn the window.', type: 'enum', options: ['30', '60', '120', '300'], default: '60' },
    { key: 'detached_terminals', group: 'workstation', scope: 'host', label: 'Keep terminals through a quit', description: 'Terminals survive Genie closing and are rejoined on the next launch.', type: 'boolean', default: false },
    { key: 'theme', group: 'appearance', scope: 'device', label: 'Theme', description: 'Dark, light, or follow the system.', type: 'enum', options: ['dark', 'light', 'system'], default: 'system' },
    { key: 'sidebar_width', group: 'appearance', scope: 'device', label: 'Sidebar width', description: 'Pixels.', type: 'string', default: '208' },
    // One row per alert kind, DERIVED from the registry — never a hand-kept list.
    ...alertSoundSettings(),
    ...alertSoundFileSettings(),
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
    update_channel: 'update_channel',
    track_cwd: 'track_cwd',
    detached_terminals: 'detached_terminals',
    // Genie 1's master sound switch is `notify_sound` ('on' / 'off'; genie main/db.ts). This map named
    // `notification_sounds`, which Genie 1 never had, so nobody's sound settings carried over (Tynn #766).
    notify_sound: 'notification_sounds',
    // Genie 1's per-alert choice, for the kinds Genie 2 has (genie main/notify-sound-kinds.ts). A choice Genie 2
    // cannot play yet — its synthesized chime, a custom file — is reported, not guessed.
    sound_forcequestion: 'sound_question',
    sound_imdone: 'sound_finished',
    sound_failure: 'sound_broken',
    // ...and the file each played when set to Custom file (Genie 1's `<setting>_custom`).
    sound_forcequestion_custom: 'sound_question_custom',
    sound_imdone_custom: 'sound_finished_custom',
    sound_failure_custom: 'sound_broken_custom',
    dnd_reply: 'dnd_reply',
    // Genie 1's question inbox's "still chime" while DND is on ('on' / 'off').
    ftq_dnd_sound: 'dnd_question_sound',
    // Genie 1 stored it as 'on' / 'off' (genie main/db.ts). Its "launch at sign-in" lived in the OS, not here: read from the OS at boot (core/tray-resident.ts).
    start_minimized: 'start_minimized',
    // Genie 1's prompt library, as written: the reader is forgiving, so a row Genie 2 cannot use is dropped where it is read.
    saved_prompts: 'saved_prompts',
    // Genie 1's two remappable keys (Tynn #759), as written: a malformed one disables its binding where it is read.
    command_window_hotkey: 'command_window_hotkey',
    ftq_nudge_hotkey: 'ftq_nudge_hotkey',
    // Genie 1's default destination for new projects (the owner, 2026-10-21: "like it was for genie 1").
    primary_workspace: 'primary_workspace',
    // Genie 1's default env file for new workspaces (main/db.ts:3700, default `.env`).
    default_env_file: 'default_env_file',
};

const V1_DROP_REASONS: Readonly<Record<string, string>> = {
    // Genie 2 has no restore switch (the owner, 2026-10-20): every agent that was running always comes back.
    restore_agents_on_launch: 'Genie 2 always starts again the agents that were running; there is no setting',
    agent_command: 'agents are sessions in Genie 2; there is no launch line to carry',
    // Genie 1's global key opened its Feedback window. Genie 2 has none (the owner, 2026-10-18: "drop the feedback feature.
    // It's only issue watch tracked via github issues").
    global_hotkey: 'Genie 2 has no Feedback window; feedback is GitHub issues, which IssueWatch tracks',
};

/**
 * Genie 1's GitHub login (`github_token_enc`, `github_user` and their bookkeeping) is not a setting: the GitHub sign-in
 * carries it over itself, decrypted with this Genie's key and kept encrypted (main/github-account.ts, beta.33 item 25).
 */
const GITHUB_V1_REASON = 'Genie 1’s GitHub sign-in is carried over by the GitHub sign-in itself, encrypted (Settings → GitHub), not as a setting';

export interface CarryOver {
    readonly applied: Record<string, boolean | string>;
    readonly dropped: Array<{ key: string; reason: string }>;
}

/**
 * A value a setting has since RENAMED, read as its new name — a migration, never a rejection.
 * The one place it happens: the store's read of settings.json and the v1 carry-over both pass
 * through here. Today: `update_channel` `beta` → `dev` (the owner, 2026-10-12: "stable and dev
 * update channels"; `src/core/update-channel.ts`).
 */
export function migrateLegacyValue(key: string, value: boolean | string): boolean | string {
    if (key === 'update_channel' && typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_CHANNEL_NAMES, value)) return LEGACY_CHANNEL_NAMES[value]!;
    // An alert's sound was an on/off box before it was a choice (Tynn #766): on is the kind's own sound, off is None.
    return legacySoundChoice(key, value);
}

function coerce(def: SettingDef, raw: string): boolean | string | null {
    if (def.type === 'boolean') {
        const v = raw.trim().toLowerCase();
        if (['true', '1', 'on', 'yes'].includes(v)) return true;
        if (['false', '0', 'off', 'no'].includes(v)) return false;
        return null;
    }
    if (def.type === 'enum') {
        const value = migrateLegacyValue(def.key, raw) as string;
        return def.options.includes(value) ? value : null;
    }
    return raw;
}

export function carryOverV1(v1: Readonly<Record<string, string>>): CarryOver {
    const applied: Record<string, boolean | string> = {};
    const dropped: Array<{ key: string; reason: string }> = [];
    for (const [key, raw] of Object.entries(v1)) {
        const target = V1_MAP[key];
        if (target === undefined) {
            dropped.push({ key, reason: V1_DROP_REASONS[key] ?? (key.startsWith('github_') ? GITHUB_V1_REASON : `no Genie 2 setting corresponds to v1's ${key}`) });
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
