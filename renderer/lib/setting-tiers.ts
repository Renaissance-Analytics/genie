import type { Settings } from './genie';

/**
 * WHO OWNS a setting, and how it travels (owner directive 2026-09-02).
 *
 * Three tiers, and **none of them touch each other**. A key belongs to exactly
 * one:
 *
 *   - `workspace`   PORTABLE. Moves with the folder — a collaborator who clones
 *                   the workspace inherits it. Lives in `project.json`, whose
 *                   contract is the shared registry's `project.schema.json`
 *                   (`Civicognita/shared-schemas`), NOT a Genie-local file.
 *   - `workstation` STREAMABLE. About THIS machine. A remote client reads and
 *                   writes it against the host.
 *   - `user`        SYNCABLE via Tynn, per user and global across every project.
 *                   EXPERIENCE, not functionality.
 *
 * ## This is a different axis from the one `settings-nav.ts` already draws
 *
 * That file documents a "3-way split" too, and the two are close enough to be
 * confused. It answers **where a value comes from in a REMOTE window** —
 * client-local, host-sourced, or hidden. This answers **who owns it and how it
 * travels**. Both are needed; neither substitutes for the other.
 *
 * The overlap is real but partial:
 *
 *   - Every host-sourced key is a workstation setting. (Pinned by test.)
 *   - NOT every workstation setting is host-sourced. Startup, updates and the
 *     quick-capture hotkey configure the client's own machine and are *hidden*
 *     in a remote window rather than streamed — still workstation-tier.
 *   - "Client-local" is NOT the user tier. In a LOCAL window the client IS the
 *     workstation, so client-local today holds user preferences (sounds, DND,
 *     copy/paste) and machine settings (ports, startup, updates) with nothing
 *     telling them apart. Separating those is the point of this file.
 *
 * `RUNTIME_OWNED_SETTINGS_KEYS` is a THIRD, orthogonal idea — the keys the
 * Settings window must not clobber on a whole-object save. A runtime-owned key
 * still has exactly one tier; the two questions are independent.
 *
 * ## The workspace tier is empty, on purpose
 *
 * Not one existing setting turned out to be workspace-portable. The keys that
 * read like it are not:
 *
 *   - `ai_system` is injected into **every** workspace's AGENTS.md on this
 *     machine — workstation-wide.
 *   - `max_agent_terminals` here is the workstation DEFAULT; the per-workspace
 *     override is a different store, written only through
 *     `workspaces.setMaxAgentTerminals`.
 *   - `default_env_file` is a machine default.
 *
 * So the portable tier's first members arrive with `project.json`, not by
 * moving keys out of this map. Recording that emptiness is deliberate: forcing
 * a key into `workspace` to make the tier look populated is how a boundary rots
 * on the day it is drawn.
 *
 * PURE — no React, no IPC — so the classification is testable and usable from
 * the main process as well as the renderer.
 */

export type SettingTier = 'workspace' | 'workstation' | 'user';

/**
 * Every settings key, and its tier.
 *
 * `Record<keyof Settings, SettingTier>` is what buys the guarantee: a key added
 * to `Settings` without a tier here is a COMPILE error, not a silent default.
 * That is the same enforcement `TUI_REGISTRY` uses for providers, and for the
 * same reason — the unenforced copies "do not fail to BUILD, they fail to
 * WORK".
 */
export const SETTING_TIERS: Record<keyof Settings, SettingTier> = {
    /* ── user: experience, syncable per person ──────────────────────────── */
    notify_sound: 'user',
    notify_toast: 'user',
    sound_imdone: 'user',
    sound_imdone_custom: 'user',
    sound_forcequestion: 'user',
    sound_forcequestion_custom: 'user',
    notifications_muted: 'user',
    ftq_availability: 'user',
    ftq_availability_workspaces: 'user',
    ftq_availability_workstations: 'user',
    ftq_dnd_message: 'user',
    ftq_dnd_sound: 'user',
    terminal_copy_paste: 'user',
    saved_prompts: 'user',
    whats_new_seen_version: 'user',
    agent_upgrade_announced_version: 'user',
    // Layout habits: how THIS person arranges panels. Runtime-owned as well —
    // the Settings save must not clobber them — which is a separate question.
    layout_json: 'user',
    view_state_json: 'user',
    collapsed_workspaces: 'user',
    active_workspace: 'user',
    last_terminal_type: 'user',
    max_views: 'user',
    // The named EXCEPTION to "experience, not functionality": identity-shaped
    // links belong to the PERSON and travel between machines with them.
    tynn_host: 'user',

    /* ── workstation: this machine, streamable to a remote client ───────── */
    primary_workspace: 'workstation',
    default_env_file: 'workstation',
    global_hotkey: 'workstation',
    ftq_nudge_hotkey: 'workstation',
    command_window_hotkey: 'workstation',
    auto_update: 'workstation',
    start_minimized: 'workstation',
    terminal_shell: 'workstation',
    terminal_custom_cmd: 'workstation',
    detached_terminals: 'workstation',
    max_agent_terminals: 'workstation',
    mcp_port: 'workstation',
    mcp_sync_claude: 'workstation',
    mcp_sync_cursor: 'workstation',
    mcp_sync_codex: 'workstation',
    mcp_sync_agents: 'workstation',
    mobile_enabled: 'workstation',
    mobile_port: 'workstation',
    remote_enabled: 'workstation',
    remote_network_local: 'workstation',
    remote_network_lan: 'workstation',
    remote_network_tailscale: 'workstation',
    remote_network_tynn: 'workstation',
    genie_browser_enabled: 'workstation',
    ai_system: 'workstation',
    toolchain_defaults: 'workstation',
    gapp_ai_provider: 'workstation',
    agent_default: 'workstation',
    agent_enabled: 'workstation',
    genie_os_backup_repo: 'workstation',
    // The launch command + flags the HOST resolves when it spawns each TUI.
    agent_command_claude: 'workstation',
    agent_flags_claude: 'workstation',
    agent_command_codex: 'workstation',
    agent_flags_codex: 'workstation',
    agent_command_kiwi: 'workstation',
    agent_flags_kiwi: 'workstation',
    agent_command_genie: 'workstation',
    agent_flags_genie: 'workstation',
    agent_command_custom: 'workstation',
    agent_flags_custom: 'workstation',

    /* ── workspace: none yet — see the docblock above ───────────────────── */
};

/** The tier a key belongs to, or undefined for a key that is not a setting. */
export function settingTier(key: string): SettingTier | undefined {
    return (SETTING_TIERS as Record<string, SettingTier | undefined>)[key];
}

/** Every key in one tier, in declaration order. */
export function keysInTier(tier: SettingTier): string[] {
    return Object.entries(SETTING_TIERS)
        .filter(([, value]) => value === tier)
        .map(([key]) => key);
}
