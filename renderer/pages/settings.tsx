import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from 'react';
import {
    Accordion,
    Action,
    Badge,
    Callout,
    CodeView,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Switch,
    Tabs,
    Text,
} from '@particle-academy/react-fancy';
import {
    api,
    type McpServerState,
    type ServerPushDiagnostics,
    type GenieHost,
    type MobileStatus,
    type MobileDevice,
    type Settings,
    type TailscaleStatus,
    type ShellDetection,
    type UpdaterConfig,
    type UpdaterStatus,
    type InstalledPluginView,
    type MarketplaceView,
    type OfficialPluginsResult,
    type PluginDeveloperModeState,
    type DevEngineInfo,
    type DevWorkstationInfo,
    type WorkspaceRow,
    type ToolUpdate,
    type HostToolName,
    type EngineInstall,
    type LanguageTool,
    type ToolchainInstallsInfo,
} from '../lib/genie';
import {
    agentCliRows,
    defaultChangeNotice,
    devToolRows,
    formatBytes,
    languageSections,
    removeConfirmation,
} from '../lib/toolchain-page';
import { isolationNote } from '../lib/dev-server';
import { ToolchainSetupWizard } from '../components/Master/ToolchainSetupWizard';
import { checkedAgoLabel, pluginSummaryLine } from '../lib/plugins-view';
import {
    engineActionAvailability,
    engineGroups,
    engineStatusLabel,
    engineStatusTone,
    engineUsageNote,
    engineGroupOf,
    engineInstalledNote,
    runtimeDiagnostics,
    stopEngineWarning,
    toolUpdateCount,
    toolUpdateRows,
    type ToolUpdateRow,
    type ToolUpdateTone,
} from '../lib/workstation-dev-server';
import {
    NAV_GROUPS,
    filterNavGroups,
    isSectionVisible,
    isRestrictedSettings,
    defaultSection,
    withoutRuntimeOwnedSettings,
    type SectionId,
} from '../lib/settings-nav';
import { pickPath } from '../components/FilePickerModal';

/** Hard cap on the Ai.System instruction set (mirrors main's AI_SYSTEM_MAX).
 *  Enforced here in the UI (`maxLength` + slice) and again server-side in the
 *  `settings:set` IPC handler so AGENTS.md can't bloat. */
const AI_SYSTEM_MAX = 2000;

export default function SettingsPage() {
    const [s, setS] = useState<Settings | null>(null);
    const [shells, setShells] = useState<ShellDetection[]>([]);
    const [shellDefault, setShellDefault] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    // Opened FROM a remote/host window? Then restrict to the connection-relevant
    // subset (see settings-nav.ts). Constant per window (reads the ?remote=1 flag).
    const restricted = isRestrictedSettings();
    // New IA: which sidebar section is showing + the cross-row search filter.
    const [section, setSection] = useState<SectionId>(defaultSection(restricted));
    const [filter, setFilter] = useState('');

    useEffect(() => {
        (async () => {
            const cur = await api().settings.get();
            setS(cur);
            const det = await api().settings.detectShells().catch(() => ({
                shells: [] as ShellDetection[],
                defaultId: null,
            }));
            setShells(det.shells);
            setShellDefault(det.defaultId);
        })();
    }, []);

    const patch = (p: Partial<Settings>) => setS((cur) => (cur ? { ...cur, ...p } : cur));

    const save = async () => {
        if (!s) return;
        setSaving(true);
        try {
            // Persist the WHOLE Settings object MINUS the master/grid runtime-owned
            // keys (panel view + grid sizes + active workspace + sidebar collapse).
            // `s` is snapshotted at open time; writing those back wholesale would
            // REVERT the live panel layout to that stale snapshot — reopening panels
            // the user closed, resetting sizes, and (since `view_state_json` is one
            // blob across every connKey) wiping the saved layout of the local AND
            // every host window at once. The master owns them via targeted patches.
            await api().settings.set(withoutRuntimeOwnedSettings(s));
            setSavedAt(Date.now());
            setTimeout(() => setSavedAt(null), 1800);
        } finally {
            setSaving(false);
        }
    };

    const pickPrimary = async () => {
        const p = await pickPath({
            mode: 'directory',
            title: 'Choose primary workspace folder',
            initialPath: s?.primary_workspace,
        });
        if (p) patch({ primary_workspace: p });
    };

    if (!s) return <div className="surface" style={{ padding: 24 }}>Loading…</div>;

    // Global cross-section search: when a query is present, EVERY tab's rows are
    // mounted (so matches surface from any tab), each under its tab's group
    // label; CSS collapses tabs/sections with no matching `.set-row`.
    const searching = filter.trim().length > 0;
    // A section renders when it's the active tab (or a search is on) AND it's not
    // hidden by the remote-window restriction — so cross-section search also only
    // surfaces the KEEP rows in a remote window.
    const show = (id: SectionId): boolean =>
        (searching || section === id) && isSectionVisible(id, restricted);
    const activeLabel = searching
        ? 'Search results'
        : NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === section)?.label ??
          'Settings';

    return (
        <SettingsFilterCtx.Provider value={filter.trim().toLowerCase()}>
            <div className="set-shell">
                <nav className="set-nav">
                    <div className="set-nav-title">
                        <Icon name="settings" size="sm" className="text-zinc-500" />
                        Settings
                    </div>
                    {filterNavGroups(NAV_GROUPS, restricted).map((g) => (
                        <div className="set-nav-group" key={g.label}>
                            <div className="set-nav-group-label">{g.label}</div>
                            {g.items.map((it) => (
                                <button
                                    key={it.id}
                                    type="button"
                                    className={`set-nav-item${section === it.id ? ' active' : ''}`}
                                    onClick={() => {
                                        setSection(it.id);
                                        setFilter('');
                                    }}
                                >
                                    <Icon name={it.icon} size="sm" />
                                    {it.label}
                                </button>
                            ))}
                        </div>
                    ))}
                </nav>

                <div className="set-main">
                    <div className="set-main-head">
                        <h1>{activeLabel}</h1>
                        <div className="set-search">
                            <Input
                                type="search"
                                value={filter}
                                onValueChange={setFilter}
                                placeholder="Search settings…"
                                leading={<Icon name="search" size="sm" />}
                            />
                        </div>
                    </div>

                    <div className={`set-body${searching ? ' set-searching' : ''}`}>
                        {show('general') && (
                            <SearchGroup label="General" searching={searching}>

            <SetSection title="General" desc="Core defaults for new projects and panels">
                <SettingRow
                    label="Primary workspace"
                    desc="Default destination for NEW projects created from Genie. Existing projects can live anywhere — this is a default, not a constraint."
                    keywords="primary workspace folder default destination new projects path"
                    vertical
                >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <Input
                                readOnly
                                value={s.primary_workspace ?? ''}
                                placeholder="No primary workspace chosen"
                            />
                        </div>
                        <Action variant="ghost" icon="folder" onClick={pickPrimary}>
                            Browse
                        </Action>
                    </div>
                </SettingRow>

                <SettingRow
                    label="Default terminal"
                    desc={`Shell used when a terminal panel doesn't specify one.${
                        shellDefault
                            ? ` ${shells.find((d) => d.id === shellDefault)?.label ?? shellDefault} is the recommended default.`
                            : ''
                    } Each panel can still switch shells from its toolbar.`}
                    keywords="default terminal shell bash pwsh powershell git custom executable"
                    vertical
                >
                    <Select
                        value={s.terminal_shell || shellDefault || ''}
                        onValueChange={(v) => patch({ terminal_shell: v })}
                        list={[
                            ...shells.map((d) => ({
                                value: d.id,
                                label:
                                    d.id === shellDefault
                                        ? `${d.label} (recommended)`
                                        : d.label,
                            })),
                            { value: 'custom', label: 'Custom executable' },
                        ]}
                    />
                    {(s.terminal_shell === 'custom' || shells.length === 0) && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', width: '100%' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <Input
                                    label="Executable line"
                                    description='Full command line; quote paths with spaces, e.g. "C:\Program Files\Git\bin\bash.exe" --login -i'
                                    value={s.terminal_custom_cmd ?? ''}
                                    onValueChange={(v) => patch({ terminal_custom_cmd: v })}
                                    placeholder="pwsh -NoLogo"
                                />
                            </div>
                            <Action
                                variant="ghost"
                                icon="folder"
                                onClick={async () => {
                                    const p = await pickPath({
                                        mode: 'file',
                                        title: 'Choose shell executable',
                                    });
                                    if (p) {
                                        patch({
                                            terminal_shell: 'custom',
                                            terminal_custom_cmd: p.includes(' ') ? `"${p}"` : p,
                                        });
                                    }
                                }}
                            >
                                Browse
                            </Action>
                        </div>
                    )}
                </SettingRow>

                <SettingRow
                    label="Keep terminals running after quit"
                    desc={s.detached_terminals === 'off'
                        ? 'Off — quitting or updating Genie will close every terminal and agent. Turn this on to preserve them and reattach on next launch.'
                        : 'On by default. Runs terminals in a detached background process so long-running commands, shells, and the agents running in them survive a full quit of Genie and reattach on next launch. Falls back to in-process terminals if the background process can’t start.'}
                    keywords="detached terminals keep running quit background survive reattach"
                >
                    <Switch
                        checked={s.detached_terminals === 'on'}
                        onCheckedChange={(on: boolean) =>
                            patch({ detached_terminals: on ? 'on' : 'off' })
                        }
                    />
                </SettingRow>
            </SetSection>

                            </SearchGroup>
                        )}
                        {show('tools') && (
                            <SearchGroup label="Tools" searching={searching}>

            <SetSection
                title="Specialized terminals"
                desc="The launch command and always-on flags for each AI-agent terminal type"
                host={restricted}
            >
                <SettingRow
                    label="Claude Code command"
                    desc="Launched when you add a Claude Code terminal. Blank uses the built-in default (claude)."
                    keywords="claude code agent command specialized terminal launch"
                    grow
                >
                    <Input
                        value={s.agent_command_claude ?? ''}
                        onValueChange={(v) => patch({ agent_command_claude: v })}
                        placeholder="claude"
                    />
                </SettingRow>
                <SettingRow
                    label="Claude Code extra flags"
                    desc="Always passed when launching this agent (after the command, before Genie's --session-id)."
                    keywords="claude code agent flags specialized terminal launch dangerously skip permissions"
                    grow
                >
                    <Input
                        value={s.agent_flags_claude ?? ''}
                        onValueChange={(v) => patch({ agent_flags_claude: v })}
                        placeholder="--dangerously-skip-permissions"
                    />
                </SettingRow>
                <SettingRow
                    label="Codex command"
                    desc="Launched when you add a Codex terminal. Blank uses the built-in default."
                    keywords="codex agent command specialized terminal launch openai"
                    grow
                >
                    <Input
                        value={s.agent_command_codex ?? ''}
                        onValueChange={(v) => patch({ agent_command_codex: v })}
                        placeholder="codex"
                    />
                </SettingRow>
                <SettingRow
                    label="Codex extra flags"
                    desc="Always passed when launching this agent (after the command, before Genie's --session-id)."
                    keywords="codex agent flags specialized terminal launch openai"
                    grow
                >
                    <Input
                        value={s.agent_flags_codex ?? ''}
                        onValueChange={(v) => patch({ agent_flags_codex: v })}
                        placeholder="--dangerously-skip-permissions"
                    />
                </SettingRow>
                <SettingRow
                    label="Custom agent command"
                    desc="The default command for a Custom agent terminal. You can still override it per-terminal when creating one."
                    keywords="custom agent command specialized terminal launch"
                    grow
                >
                    <Input
                        value={s.agent_command_custom ?? ''}
                        onValueChange={(v) => patch({ agent_command_custom: v })}
                        placeholder="e.g. my-agent --interactive"
                    />
                </SettingRow>
                <SettingRow
                    label="Custom agent extra flags"
                    desc="Always passed when launching this agent (after the command, before Genie's --session-id)."
                    keywords="custom agent flags specialized terminal launch"
                    grow
                >
                    <Input
                        value={s.agent_flags_custom ?? ''}
                        onValueChange={(v) => patch({ agent_flags_custom: v })}
                        placeholder="--dangerously-skip-permissions"
                    />
                </SettingRow>
            </SetSection>

                            </SearchGroup>
                        )}
                        {show('workspaces') && (
                            <SearchGroup label="Workspaces" searching={searching}>

            <SetSection title="Defaults" desc="Applied to newly-created workspaces">
                <SettingRow
                    label="Max views"
                    desc="Maximum panels visible at once per workspace. Reaching the limit disables the Add Terminal / Add Files buttons until you raise it or close a view."
                    keywords="max views panels limit layout terminals editors workspace"
                    grow
                >
                    <Input
                        type="number"
                        min={1}
                        max={9}
                        value={String(s.max_views ?? '4')}
                        onValueChange={(v) => {
                            // Clamp to 1–9; ignore empty/garbage so the field stays usable.
                            const n = parseInt(v, 10);
                            if (Number.isFinite(n)) {
                                patch({ max_views: String(Math.min(9, Math.max(1, n))) });
                            } else if (v === '') {
                                patch({ max_views: '' });
                            }
                        }}
                    />
                </SettingRow>
                <SettingRow
                    label="Env file name"
                    desc="Default environment file name for new workspaces."
                    keywords="env file name environment default new workspace dotenv"
                    grow
                >
                    <Input
                        value={s.default_env_file ?? ''}
                        onValueChange={(v) => patch({ default_env_file: v })}
                    />
                </SettingRow>
            </SetSection>

                            </SearchGroup>
                        )}
                        {show('customization') && (
                            <SearchGroup label="Customization" searching={searching}>

            <AppearanceCard />

            <SetSection
                title="Notifications"
                desc="How Genie alerts you when an agent finishes (imDone) or asks a question"
            >
                <SettingRow
                    label="Play a sound"
                    desc="Master switch for the alert sounds below. The terminal always glows in the sidebar; this adds an audible alert on top."
                    keywords="notifications sound play alert audio imdone question chime"
                >
                    <Switch
                        checked={s.notify_sound === 'on'}
                        onCheckedChange={(on: boolean) =>
                            patch({ notify_sound: on ? 'on' : 'off' })
                        }
                    />
                </SettingRow>
                {s.notify_sound === 'on' && (
                    <>
                        <SetSubhead>Alert sounds</SetSubhead>
                        <AlertSoundRow
                            label="Agent finishes — imDone"
                            choice={s.sound_imdone ?? 'synth'}
                            customPath={s.sound_imdone_custom ?? ''}
                            kind="imDone"
                            onChoice={(v) => patch({ sound_imdone: v })}
                            onCustom={(p) => patch({ sound_imdone_custom: p })}
                        />
                        <AlertSoundRow
                            label="Agent asks a question"
                            choice={s.sound_forcequestion ?? 'synth'}
                            customPath={s.sound_forcequestion_custom ?? ''}
                            kind="force-question"
                            onChoice={(v) => patch({ sound_forcequestion: v })}
                            onCustom={(p) => patch({ sound_forcequestion_custom: p })}
                        />
                    </>
                )}
                <SettingRow
                    label="Show a tray popup"
                    desc="A system notification from the tray; click it to bring Genie to the front."
                    keywords="notifications tray popup toast system notification"
                >
                    <Switch
                        checked={s.notify_toast === 'on'}
                        onCheckedChange={(on: boolean) =>
                            patch({ notify_toast: on ? 'on' : 'off' })
                        }
                    />
                </SettingRow>
                <SetSubhead>Agent questions</SetSubhead>
                <SettingRow
                    label="Do Not Disturb"
                    desc="When on, an agent's question no longer pops the always-on-top prompt or chimes — it waits in the top-bar question inbox for you to answer at your leisure. This is the global default; override it per workspace (Workspace settings) or per connection (Connections)."
                    keywords="dnd do not disturb availability forcethequestion pending questions interrupt focus popup"
                >
                    <Switch
                        checked={s.ftq_availability === 'dnd'}
                        onCheckedChange={(on: boolean) =>
                            patch({ ftq_availability: on ? 'dnd' : 'available' })
                        }
                    />
                </SettingRow>
                <SettingRow
                    label="Reply to agents while in DND"
                    desc="What an agent is told when it asks a question while you're in Do Not Disturb, so it can decide to hold or proceed. Blank uses the built-in default."
                    keywords="dnd message reply agent response do not disturb hold"
                    vertical
                >
                    <Input
                        value={s.ftq_dnd_message ?? ''}
                        onValueChange={(v: string) => patch({ ftq_dnd_message: v })}
                        placeholder="the user has notifications set to DND, if this is a show-stopper then hold off until they answer"
                    />
                </SettingRow>
            </SetSection>

            {/* Startup + the quick-capture hotkey configure THIS machine's app
                launch — hidden in a remote window (wrong-scoped when driving another
                machine). */}
            {!restricted && (
                <SetSection title="Startup" desc="What Genie does on launch">
                    <SettingRow
                        label="Start minimized to the tray"
                        desc="Off by default — Genie opens its window on launch. Turn on to start in the tray only; the window opens on the first tray click or the quick-capture hotkey."
                        keywords="startup start minimized tray launch window boot"
                    >
                        <Switch
                            checked={s.start_minimized === 'on'}
                            onCheckedChange={(on: boolean) =>
                                patch({ start_minimized: on ? 'on' : 'off' })
                            }
                        />
                    </SettingRow>
                </SetSection>
            )}

            {!restricted && (
                <SetSection title="Quick capture hotkey" desc="Global shortcut to pop the capture window">
                    <SettingRow
                        label="Accelerator"
                        desc="Electron accelerator string, e.g. CommandOrControl+Shift+W"
                        keywords="quick capture hotkey accelerator global shortcut keybinding"
                        vertical
                    >
                        <Input
                            value={s.global_hotkey ?? ''}
                            onValueChange={(v) => patch({ global_hotkey: v })}
                            placeholder="CommandOrControl+Shift+W"
                        />
                    </SettingRow>
                </SetSection>
            )}

            <SetSection title="Terminal copy & paste" desc="How copy and paste work inside terminals">
                <SettingRow
                    label="Copy &amp; paste mode"
                    desc="Pasting always refocuses the terminal so you can keep typing. Applies to newly-opened terminals."
                    keywords="terminal copy paste clipboard context menu linux windows mac"
                    vertical
                >
                    <Select
                        value={s.terminal_copy_paste ?? 'contextmenu'}
                        onValueChange={(v) =>
                            patch({ terminal_copy_paste: v as 'contextmenu' | 'linux' | 'winmac' })
                        }
                        list={[
                            { value: 'contextmenu', label: 'Context menu — right-click for Copy/Paste (+ Ctrl+Shift+C/V)' },
                            { value: 'linux', label: 'Linux — highlight to copy, right-/middle-click to paste' },
                            { value: 'winmac', label: 'Windows / Mac — Ctrl/Cmd+C copies, Ctrl/Cmd+V pastes' },
                        ]}
                    />
                </SettingRow>
            </SetSection>

            {/* Ai.System is the workspace-instructions injected into every workspace's
                AGENTS.md, read by the agents that run there. In a remote window the
                agent runs on the HOST, so this is HOST-sourced (bucket 2) — the
                settings bridge routes ai_system to the host — and badged accordingly. */}
            <SetSection
                title="Ai.System"
                desc="Instructions Genie injects into every workspace's AGENTS.md"
                host={restricted}
            >
                <SettingRow
                    label="Workspace instructions"
                        desc="Injected into every workspace's AGENTS.md, inside the auto-managed Genie Protocol block, so every agent in every workspace reads it. Keep it tight — capped at 2000 characters."
                        keywords="ai system instructions agents.md genie protocol customization prompt workspace"
                        vertical
                    >
                        <textarea
                            className="input"
                            value={s.ai_system ?? ''}
                            onChange={(e) => patch({ ai_system: e.target.value.slice(0, AI_SYSTEM_MAX) })}
                            maxLength={AI_SYSTEM_MAX}
                            rows={6}
                            placeholder="e.g. Prefer TypeScript. Never edit files under /vendor. Ask before force-pushing."
                        />
                        <div style={{ marginTop: 4, textAlign: 'right' }}>
                            <Text size="xs" className="text-zinc-500">
                                {(s.ai_system ?? '').length} / {AI_SYSTEM_MAX}
                            </Text>
                        </div>
                    </SettingRow>
                </SetSection>

                            </SearchGroup>
                        )}
                        {show('agent-mcp') && (
                            <SearchGroup label="Agent MCP" searching={searching}>

            <AgentMcpSection
                restricted={restricted}
                port={s.mcp_port ?? '51717'}
                onPortChange={(v) => patch({ mcp_port: v })}
                syncClaude={s.mcp_sync_claude !== 'off'}
                syncCursor={s.mcp_sync_cursor !== 'off'}
                syncCodex={s.mcp_sync_codex !== 'off'}
                syncAgents={s.mcp_sync_agents !== 'off'}
                onSyncChange={(target, on) =>
                    patch({ [`mcp_sync_${target}`]: on ? 'on' : 'off' })
                }
            />

                            </SearchGroup>
                        )}
                        {show('plugins') && (
                            <SearchGroup label="Plugins" searching={searching}>

            <PluginsSection />

                            </SearchGroup>
                        )}
                        {show('mobile') && (
                            <SearchGroup label="Work Mode" searching={searching}>

            {/* Every Genie IS a host (workstation) — the old Host|Remote MODE is
                retired (design brief genie-service-separation §2a). This machine's
                host controls (remote-access toggle, phone UI, port, local sites)
                are ALWAYS shown; reaching another host is an ACTION, not a mode, so
                the connect card sits alongside them, always available. */}
            <TailscaleSection />
            <MobileSection
                enabled={s.mobile_enabled === 'on'}
                onEnabledChange={(on) => patch({ mobile_enabled: on ? 'on' : 'off' })}
                remoteEnabled={s.remote_enabled === 'on'}
                onRemoteEnabledChange={(on) => patch({ remote_enabled: on ? 'on' : 'off' })}
                networkAccess={{
                    local: s.remote_network_local !== 'off',
                    lan: s.remote_network_lan === 'on',
                    tailscale: s.remote_network_tailscale !== 'off',
                    tynn: s.remote_network_tynn !== 'off',
                }}
                onNetworkAccessChange={(network, on) => patch({
                    [`remote_network_${network}`]: on ? 'on' : 'off',
                })}
                port={s.mobile_port ?? '51718'}
                onPortChange={(v) => patch({ mobile_port: v })}
                persistSettings={save}
            />
            <RemoteHostCard />

                            </SearchGroup>
                        )}
                        {show('toolchain') && (
                            <SearchGroup label="Toolchain" searching={searching}>

            <ToolchainSection />

                            </SearchGroup>
                        )}
                        {show('dev-server') && (
                            <SearchGroup label="Hosting Manager" searching={searching}>

            <DevServerSection
                genieBrowserEnabled={s.genie_browser_enabled !== 'off'}
                onGenieBrowserChange={(on) => {
                    const value = on ? 'on' : 'off';
                    patch({ genie_browser_enabled: value });
                    // Persist THIS key directly rather than through the page's
                    // whole-object Save: that closes over the pre-toggle
                    // snapshot, so it would write back the value we just changed.
                    void api().settings.set({ genie_browser_enabled: value });
                }}
            />

                            </SearchGroup>
                        )}
                        {show('connections') && (
                            <SearchGroup label="Connections" searching={searching}>

            <TynnSection
                hostOverride={s.tynn_host ?? ''}
                onHostOverrideChange={(v) => patch({ tynn_host: v })}
            />

            <GitHubSection />

            <AionimaSection />

                            </SearchGroup>
                        )}
                        {show('devices') && (
                            <SearchGroup label="Devices" searching={searching}>

            <DevicesSection />

                            </SearchGroup>
                        )}
                        {show('updates') && (
                            <SearchGroup label="Updates" searching={searching}>

            <UpdaterSection />

            <StartupSection />

                            </SearchGroup>
                        )}
                    </div>

                    <div className="set-foot">
                        {savedAt && (
                            <Text size="xs" style={{ color: 'var(--emerald-500)' }}>
                                <Icon name="check" size="xs" /> Saved
                            </Text>
                        )}
                        <Action color="blue" icon="check" onClick={save} disabled={saving}>
                            {saving ? 'Saving…' : 'Save'}
                        </Action>
                    </div>
                </div>
            </div>
        </SettingsFilterCtx.Provider>
    );
}

/* ===================================================================== *
 *  Reimagined Settings shell — sidebar IA, dense rows, filter context.
 *  Layout primitives are bespoke (for density); every value control inside
 *  a row is a reused react-fancy primitive (Switch / Select / Input /
 *  Action / Icon).
 * ===================================================================== */

/**
 * The settings search box publishes its (lowercased, trimmed) query here.
 * Dense `SettingRow`s read it and hide themselves when they don't match;
 * `SetSubhead`s collapse while a query is active so results read as a flat
 * list. Legacy card-based panes don't consume it yet (see migration plan).
 */
const SettingsFilterCtx = createContext('');

/**
 * Per-tab wrapper for the body. In normal browsing it's a transparent
 * `.settings-tab` (one tab visible). During a global search EVERY tab is
 * mounted, so this prefixes each tab's rows with its nav label — and the
 * `.set-searching` CSS collapses any tab/section whose rows don't match.
 */
function SearchGroup({
    label,
    searching,
    children,
}: {
    label: string;
    searching: boolean;
    children: ReactNode;
}) {
    if (!searching) return <div className="settings-tab">{children}</div>;
    return (
        <div className="set-search-group">
            <div className="set-search-group-label">{label}</div>
            <div className="settings-tab">{children}</div>
        </div>
    );
}

/**
 * A small "On the host" chip. Marks a section whose VALUES are sourced from — and
 * written to — the HOST this window is driving (a remote/host window), so it's clear
 * the control edits the AGENT's environment on the host, not this device. See the
 * bucket-2 split in settings-nav.ts. Inline-styled (with token fallbacks) so it
 * needs no CSS change.
 */
function HostBadge() {
    return (
        <span
            title="This lives on the host you're connected to — it configures the agent's workspace environment there, not this device."
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: 999,
                color: 'var(--blue-600, #2563eb)',
                background: 'var(--blue-50, rgba(37,99,235,0.10))',
                border: '1px solid var(--blue-200, rgba(37,99,235,0.25))',
                whiteSpace: 'nowrap',
            }}
        >
            <Icon name="monitor" size="xs" /> On the host
        </span>
    );
}

/**
 * A settings section — a slim heading (+ optional one-line description and a
 * right-aligned status pill) over a stack of dense rows. Replaces the old
 * heavy padded <Card> per section. `host` badges it "On the host" (bucket-2,
 * host-sourced) — used in a remote window.
 */
function SetSection({
    title,
    desc,
    status,
    statusColor,
    statusIcon,
    host,
    className,
    children,
}: {
    title: string;
    desc?: string;
    status?: ReactNode;
    statusColor?: string;
    statusIcon?: string;
    host?: boolean;
    /** Extra class on the section — e.g. to make its head stick while scrolling. */
    className?: string;
    children: ReactNode;
}) {
    return (
        <section className={`set-section${className ? ` ${className}` : ''}`}>
            <div className="set-section-head">
                <h2>{title}</h2>
                {host && <HostBadge />}
                {desc && <span className="set-section-desc">{desc}</span>}
                {status != null && (
                    <span className="set-section-status" style={{ color: statusColor }}>
                        {statusIcon && <Icon name={statusIcon} size="xs" />} {status}
                    </span>
                )}
            </div>
            {children}
        </section>
    );
}

/** Slim subsection heading inside a section. Collapses while searching. */
function SetSubhead({ children }: { children: ReactNode }) {
    const filter = useContext(SettingsFilterCtx);
    if (filter) return null;
    return <div className="set-subhead">{children}</div>;
}

/**
 * One dense setting row: label + muted subtext on the left, the control on the
 * right (or full-width underneath when `vertical`). Pass searchable `keywords`
 * for rows whose label is not a plain string. Hides itself when a search query
 * is active and nothing matches.
 */
function SettingRow({
    label,
    desc,
    keywords,
    vertical,
    grow,
    children,
}: {
    label: ReactNode;
    desc?: ReactNode;
    keywords?: string;
    vertical?: boolean;
    grow?: boolean;
    children: ReactNode;
}) {
    const filter = useContext(SettingsFilterCtx);
    if (filter) {
        const labelText = typeof label === 'string' ? label : '';
        const descText = typeof desc === 'string' ? desc : '';
        const hay = `${labelText} ${descText} ${keywords ?? ''}`.toLowerCase();
        if (!hay.includes(filter)) return null;
    }
    return (
        <div className={`set-row${vertical ? ' vertical' : ''}`}>
            <div className="set-row-main">
                <span className="set-row-label">{label}</span>
                {desc && <span className="set-row-desc">{desc}</span>}
            </div>
            <div className={`set-row-control${grow ? ' grow' : ''}`}>{children}</div>
        </div>
    );
}

/** Compact segmented control — a tighter alternative to a row of buttons. */
function Segmented<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: Array<{ value: T; label: string }>;
    onChange: (v: T) => void;
}) {
    return (
        <div className="set-seg" role="tablist">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={value === o.value}
                    className={value === o.value ? 'active' : ''}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/** The selectable alert-sound choices, shared by both alert rows. */
type SoundChoice =
    | 'off'
    | 'synth'
    | '3tootpipe'
    | 'dingdongdoink'
    | 'sparkle'
    | 'triumphant'
    | 'winddown'
    | 'custom';

const SOUND_OPTIONS: Array<{ value: SoundChoice; label: string }> = [
    { value: 'synth', label: 'Default chime' },
    { value: '3tootpipe', label: '3 Toot Pipe' },
    { value: 'dingdongdoink', label: 'Ding Dong Doink' },
    { value: 'sparkle', label: 'Sparkle' },
    { value: 'triumphant', label: 'Triumphant' },
    { value: 'winddown', label: 'Wind Down' },
    { value: 'custom', label: 'Custom file…' },
    { value: 'off', label: 'None' },
];

/**
 * Play the sound a choice resolves to, locally, for the Settings Preview button.
 * Mirrors the master-window playback: a bundled name plays ./sounds/<name>.wav,
 * 'custom' reads the file to a data-URL via the IPC bridge, 'synth' fires the
 * built-in per-kind Web Audio chime, 'off' is silent. Best-effort.
 */
async function previewSound(
    choice: SoundChoice,
    customPath: string,
    kind: 'imDone' | 'force-question',
): Promise<void> {
    try {
        if (choice === 'off') return;
        if (choice === 'custom') {
            if (!customPath) return;
            const dataUrl = await api().settings.soundDataUrl(customPath);
            if (dataUrl) await new Audio(dataUrl).play().catch(() => {});
            return;
        }
        if (choice !== 'synth') {
            // Any bundled wav (3tootpipe / dingdongdoink / sparkle / triumphant /
            // winddown) → ./sounds/<name>.wav. 'off'/'custom' handled above.
            await new Audio(`./sounds/${choice}.wav`).play().catch(() => {});
            return;
        }
        // 'synth' — reuse the master window's per-kind motif.
        const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const now = ctx.currentTime;
        const tone = (freq: number, start: number, dur: number, type: OscillatorType = 'sine') => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now + start);
            gain.gain.exponentialRampToValueAtTime(0.18, now + start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + start);
            osc.stop(now + start + dur);
        };
        if (kind === 'force-question') {
            tone(880, 0, 0.1, 'triangle');
            tone(880, 0.14, 0.1, 'triangle');
            tone(1175, 0.28, 0.26, 'triangle');
            setTimeout(() => void ctx.close().catch(() => {}), 900);
        } else {
            tone(660, 0, 0.18);
            tone(880, 0.16, 0.24);
            setTimeout(() => void ctx.close().catch(() => {}), 700);
        }
    } catch {
        /* preview is best-effort */
    }
}

/** Basename of a path for the chosen-file label (handles \ and /). */
function baseName(p: string): string {
    return p.split(/[\\/]/).pop() || p;
}

/**
 * One per-alert sound row: the alert's label, a Select of the sound choices, a
 * Preview button, and — when 'Custom file…' is selected — a file picker showing
 * the chosen filename. Bound to a `sound_*` / `sound_*_custom` settings pair via
 * the onChoice / onCustom callbacks (which call the page's `patch`).
 */
function AlertSoundRow({
    label,
    choice,
    customPath,
    kind,
    onChoice,
    onCustom,
}: {
    label: string;
    choice: SoundChoice;
    customPath: string;
    kind: 'imDone' | 'force-question';
    onChoice: (v: SoundChoice) => void;
    onCustom: (path: string) => void;
}) {
    const pickCustom = async () => {
        const p = await pickPath({ mode: 'file', title: 'Choose a sound file' });
        if (p) onCustom(p);
    };
    return (
        <SettingRow
            label={label}
            keywords={`alert sound ${kind} ${label} preview synth chime custom file`}
            vertical
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <div style={{ flex: 1 }}>
                    <Select
                        value={choice}
                        onValueChange={(v) => onChoice(v as SoundChoice)}
                        list={SOUND_OPTIONS}
                    />
                </div>
                <Action
                    variant="ghost"
                    icon="play"
                    onClick={() => void previewSound(choice, customPath, kind)}
                    disabled={choice === 'off' || (choice === 'custom' && !customPath)}
                >
                    Preview
                </Action>
            </div>
            {choice === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Action variant="ghost" icon="folder" onClick={pickCustom}>
                        Choose file…
                    </Action>
                    <Text size="xs" className="text-zinc-500">
                        {customPath ? baseName(customPath) : 'No file chosen'}
                    </Text>
                </div>
            )}
        </SettingRow>
    );
}

/**
 * Appearance — light/dark/system theme. The theme is renderer-local (it toggles
 * the `.dark` class on <html> and is read on boot by _app.tsx), NOT a persisted
 * Genie setting, so it lives in localStorage under 'genie.theme'. Default
 * 'system', which tracks the OS preference live. Applies immediately on change.
 */
function AppearanceCard() {
    const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem('genie.theme');
            if (saved === 'light' || saved === 'dark') setTheme(saved);
            else setTheme('system');
        } catch {
            /* private mode */
        }
    }, []);

    const applyTheme = (next: 'system' | 'light' | 'dark') => {
        setTheme(next);
        try {
            window.localStorage.setItem('genie.theme', next);
        } catch {
            /* private mode — still apply for this session */
        }
        const dark =
            next === 'dark' ||
            (next === 'system' &&
                window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', dark);
    };

    return (
        <SetSection title="Appearance" desc="The colour theme for Genie">
            <SettingRow
                label="Theme"
                desc="“System” follows your operating system and updates live when you switch it."
                keywords="appearance theme colour color light dark system"
                grow
            >
                <Select
                    value={theme}
                    onValueChange={(v) => applyTheme(v as 'system' | 'light' | 'dark')}
                    list={[
                        { value: 'system', label: 'System' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                    ]}
                />
            </SettingRow>
        </SetSection>
    );
}

/**
 * Tynn connection — surfaces login state ("Connected as X") and
 * routes sign-in / sign-out through the standard browser handoff.
 * The host is auto-selected per environment (tynn.test in dev,
 * tynn.ai in production) and can be overridden via Advanced for
 * self-hosters / staging. Replaces the bare "Tynn host" Input that
 * used to live in the main settings list.
 */
function TynnSection({
    hostOverride,
    onHostOverrideChange,
}: {
    hostOverride: string;
    onHostOverrideChange: (v: string) => void;
}) {
    const [user, setUser] = useState<{ name: string; email?: string } | null>(null);
    const [host, setHost] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showAdvanced, setShowAdvanced] = useState(false);

    const refresh = async () => {
        try {
            const u = await api().auth.whoami('tynn');
            const single = (u && 'name' in (u as object))
                ? (u as { name: string; email?: string })
                : null;
            setUser(single);
            setHost(await api().tynnHost.get());
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    useEffect(() => {
        void refresh();
        // Listen for the auth:changed event the main process broadcasts
        // after the genie:// callback drops a session cookie.
        const off = api().on.authChanged?.(() => {
            void refresh();
        });
        return () => off?.();
    }, []);

    const signIn = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await api().auth.startSignIn('tynn');
            if (!r.ok) setError(r.message ?? 'Sign-in could not be started.');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const signOut = async () => {
        setBusy(true);
        try {
            await api().auth.signOut('tynn');
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    // Pretty-print the host: chop the protocol so the chip reads
    // "tynn.ai" instead of "https://tynn.ai".
    const hostLabel = host.replace(/^https?:\/\//, '');

    return (
        <SetSection
            title="Tynn"
            desc={`Project management · browser sign-in via ${hostLabel || 'tynn.ai'}`}
            status={user ? `Connected as ${user.name}` : undefined}
            statusColor="var(--emerald-600)"
            statusIcon={user ? 'check' : undefined}
        >
            <SettingRow
                label="Account"
                desc="Sign in through your browser to manage work in Tynn."
                keywords="tynn account sign in out connect project management browser"
                grow
            >
                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        justifyContent: 'flex-end',
                    }}
                >
                    {!user && (
                        <Action color="blue" size="sm" onClick={signIn} disabled={busy}>
                            {busy ? 'Opening…' : `Sign in at ${hostLabel || 'tynn.ai'}…`}
                        </Action>
                    )}
                    {user && (
                        <Action variant="ghost" size="sm" onClick={signOut} disabled={busy}>
                            Sign out
                        </Action>
                    )}
                    {/* Dev/staging-only escape hatch. Tynn is SaaS-only (not
                        self-hostable), so end users never need a host override —
                        compile it out of the packaged app. process.env.NODE_ENV
                        is inlined by Next at build time. */}
                    {process.env.NODE_ENV !== 'production' && (
                        <Action
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAdvanced((s) => !s)}
                        >
                            {showAdvanced ? 'Hide Advanced' : 'Advanced'}
                        </Action>
                    )}
                </div>
            </SettingRow>

            {error && <div className="set-note bad">{error}</div>}

            {process.env.NODE_ENV !== 'production' && showAdvanced && (
                <SettingRow
                    label="Tynn host override"
                    desc="Dev/staging only — point Genie at a non-default Tynn instance (e.g. a staging URL). Leave blank for the environment default: tynn.test in dev, tynn.ai when installed."
                    keywords="tynn host override staging url advanced instance dev"
                    vertical
                >
                    <Input
                        value={hostOverride}
                        onValueChange={onHostOverrideChange}
                        placeholder={host || 'https://tynn.ai'}
                    />
                </SettingRow>
            )}
        </SetSection>
    );
}

/**
 * Aionima connection — separate save flow because it probes the
 * configured host immediately so the user gets a "Connected as X" or
 * "Failed to reach" signal without leaving the page. Bearer-token paste
 * is the placeholder UX; a proper pairing flow lands when
 * https://github.com/Civicognita/agi/issues/178 Q5.2a is answered.
 */
function AionimaSection() {
    const [host, setHost] = useState('');
    const [token, setToken] = useState('');
    const [user, setUser] = useState<{ name: string; email?: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        api()
            .aionima.getConfig()
            .then((c) => {
                setHost(c.host ?? '');
                setToken(c.token ?? '');
            });
        api()
            .auth.whoami('aionima')
            .then((u) => setUser((u as any) ?? null));
    }, []);

    const save = async () => {
        setBusy(true);
        setStatus(null);
        try {
            const res = await api().aionima.setConfig({
                host: host.trim() || undefined,
                token: token.trim() || null,
            });
            setUser(res.user as any);
            setStatus(
                res.user
                    ? `Connected as ${res.user.name}`
                    : res.error
                      ? `Couldn't reach Aionima: ${res.error}`
                      : 'Saved — could not reach Aionima with that host + token.',
            );
        } catch (e: unknown) {
            setStatus(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const disconnect = async () => {
        setBusy(true);
        await api().aionima.setConfig({ token: null });
        setToken('');
        setUser(null);
        setStatus('Disconnected.');
        setBusy(false);
    };

    return (
        <SetSection
            title="Aionima"
            desc="Local LAN AGI gateway"
            status={user ? `Connected as ${user.name}` : undefined}
            statusColor="var(--emerald-600)"
            statusIcon={user ? 'check' : undefined}
        >
            <SettingRow
                label="Aionima host"
                desc="e.g. http://192.168.0.144:3100 (the machine running AGI)"
                keywords="aionima host agi gateway lan ip address"
                vertical
            >
                <Input
                    value={host}
                    onValueChange={setHost}
                    placeholder="http://192.168.0.144:3100"
                />
            </SettingRow>
            <SettingRow
                label="Bearer token"
                desc="Mint a token in your Aionima dashboard and paste it here."
                keywords="aionima bearer token auth paste dashboard"
                vertical
            >
                <Input
                    value={token}
                    onValueChange={setToken}
                    placeholder="(paste token)"
                />
            </SettingRow>
            <div className="set-actions">
                <Action color="blue" icon="check" onClick={save} disabled={busy}>
                    {busy ? 'Saving…' : 'Save + test'}
                </Action>
                {user && (
                    <Action variant="ghost" onClick={disconnect} disabled={busy}>
                        Disconnect
                    </Action>
                )}
                {status && (
                    <Text
                        size="xs"
                        style={{
                            alignSelf: 'center',
                            color: user ? 'var(--emerald-600)' : 'var(--fg-3)',
                        }}
                    >
                        {status}
                    </Text>
                )}
            </div>
        </SetSection>
    );
}

/**
 * GitHub connection — Device Flow against the "Genie IDE" GitHub App, so
 * we don't ship a client secret or run an embedded browser. The App's
 * fine-grained permissions are declared on the App (no scopes are
 * requested at sign-in) and only apply where the App is installed.
 *
 * Connect: click Connect → modal shows the user_code + the URL to
 * visit. While the modal is open, we poll the main-side status until
 * GitHub returns a token (success) or the code expires. Tokens are
 * non-expiring (App configured with token-expiry off), so there's no
 * refresh handling; old OAuth-App tokens keep working until the user
 * reconnects here to switch to the App.
 */
function GitHubSection() {
    const [connected, setConnected] = useState(false);
    const [username, setUsername] = useState<string | null>(null);
    const [clientId, setClientId] = useState('');
    const [clientIdSet, setClientIdSet] = useState(false);
    const [builtInClientId, setBuiltInClientId] = useState(false);
    const [usingOverride, setUsingOverride] = useState(false);
    const [activeClientId, setActiveClientId] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [storageOk, setStorageOk] = useState(true);
    const [needsReauth, setNeedsReauth] = useState(false);
    const [reauthFailure, setReauthFailure] = useState<{
        code: string;
        occurredAt: number;
        message: string;
    } | null>(null);
    const [installations, setInstallations] = useState<
        Array<{ login: string; avatar_url: string; id: number | null; isOrg: boolean }>
    >([]);
    const [installationsLoaded, setInstallationsLoaded] = useState(false);
    const [installError, setInstallError] = useState(false);
    const [flow, setFlow] = useState<
        | { kind: 'idle' }
        | { kind: 'starting' }
        | {
              kind: 'pending';
              userCode: string;
              verificationUri: string;
              expiresInSec: number;
          }
        | { kind: 'success'; user: { login: string; name: string | null } }
        | { kind: 'error'; code: string; message: string }
    >({ kind: 'idle' });

    const refresh = async () => {
        const st = await api().github.status();
        setConnected(st.connected);
        setUsername(st.username);
        setClientIdSet(st.clientIdSet);
        setBuiltInClientId(st.builtInClientId);
        setUsingOverride(st.usingOverride);
        setActiveClientId(st.activeClientId);
        setStorageOk(st.storageOk);
        setNeedsReauth(st.needsReauth);
        setReauthFailure(st.reauthFailure);
        // Where the App is installed — drives the zero-install prompt + the
        // "installed on X" summary. Authorizing alone grants no repo access.
        if (st.connected) {
            try {
                const list = await api().github.installations();
                setInstallations(
                    list.map((i) => ({
                        login: i.login,
                        avatar_url: i.avatar_url,
                        id: i.id,
                        isOrg: i.isOrg,
                    })),
                );
                setInstallError(false);
            } catch {
                // Distinct from "installed nowhere": the fetch itself failed
                // (almost always a dead token). Keep the prior list and flag
                // the error so the UI shows "reconnect", not "install nowhere".
                setInstallError(true);
            } finally {
                setInstallationsLoaded(true);
            }
        } else {
            setInstallations([]);
            setInstallationsLoaded(false);
            setInstallError(false);
        }
        if (st.flow.kind === 'pending') {
            setFlow({
                kind: 'pending',
                userCode: st.flow.userCode,
                verificationUri: st.flow.verificationUri,
                expiresInSec: st.flow.expiresInSec,
            });
        } else if (st.flow.kind === 'success') {
            setFlow({ kind: 'success', user: st.flow.user });
            // Auto-close the success state after a brief moment.
            setTimeout(() => setFlow({ kind: 'idle' }), 1200);
        } else if (st.flow.kind === 'error') {
            setFlow({ kind: 'error', code: st.flow.code, message: st.flow.message });
        }
    };

    useEffect(() => {
        void refresh();
        const ssn = api()
            .settings.get()
            .then((s) => setClientId((s as { github_client_id?: string }).github_client_id ?? ''));
        void ssn;
    }, []);

    // Poll for flow progress while it's running.
    useEffect(() => {
        if (flow.kind !== 'pending' && flow.kind !== 'starting') return;
        const t = setInterval(refresh, 1500);
        return () => clearInterval(t);
    }, [flow.kind]);

    // Installing on an org happens in the browser and gives no callback into
    // the app, so the mount-time installations snapshot goes stale the moment
    // the user adds an account. Re-fetch when the window regains focus while
    // connected — that's how a freshly-installed org appears in "Installed on".
    useEffect(() => {
        const onFocus = () => {
            if (connected) void refresh();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);

    const start = async () => {
        try {
            setFlow({ kind: 'starting' });
            const code = await api().github.startDevice();
            setFlow({
                kind: 'pending',
                userCode: code.user_code,
                verificationUri: code.verification_uri,
                expiresInSec: code.expires_in,
            });
        } catch (e) {
            setFlow({
                kind: 'error',
                code: 'start_failed',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    const cancel = async () => {
        await api().github.cancelDevice();
        setFlow({ kind: 'idle' });
    };

    const disconnect = async () => {
        await api().github.disconnect();
        await refresh();
    };

    // Clear the dead token, then start a fresh device flow. Used by the
    // "session expired" banner so the user fixes it in one click instead of
    // hunting for Disconnect → Connect.
    const reconnect = async () => {
        await api().github.disconnect();
        setNeedsReauth(false);
        setReauthFailure(null);
        setInstallError(false);
        await start();
    };

    const saveClientId = async () => {
        await api().settings.set({
            // The settings table stores k/v; the type signature doesn't include
            // github_client_id explicitly so we widen via Record.
            github_client_id: clientId.trim(),
        } as unknown as Record<string, string>);
        await refresh();
    };

    const resetClientId = async () => {
        await api().github.resetClientId();
        setClientId('');
        await refresh();
    };

    return (
        <SetSection
            title="GitHub"
            desc="GitHub App (Device Flow) · used to create .agi repos"
            status={connected && username ? `Connected as ${username}` : undefined}
            statusColor="var(--emerald-600)"
            statusIcon={connected && username ? 'check' : undefined}
        >
            {!storageOk && (
                <div className="set-note bad">
                    OS keychain unavailable. Genie won't store a GitHub token
                    unencrypted. On Linux: install gnome-keyring / libsecret.
                </div>
            )}

            {!builtInClientId && !showAdvanced && (
                <div className="set-note bad">
                    This Genie build doesn't ship a baked-in GitHub App Client
                    ID. Open Advanced to paste one (you'll need to register your
                    own GitHub App at github.com/settings/apps/new with Device
                    Flow enabled).
                </div>
            )}

            {/* Stale-override guard. A custom client ID shadowing the bundled
                one is the most common reason Device Flow fails on a build
                that ships a working baked-in ID (early alphas prompted users
                to paste their own). Surface it with a one-click reset. */}
            {usingOverride && builtInClientId && !connected && (
                <div
                    className="set-note warn"
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                    <Text size="xs" style={{ flex: 1 }}>
                        Using a custom GitHub App Client ID (<code>{activeClientId}</code>)
                        instead of the one bundled with Genie. If sign-in fails,
                        this is the likely cause.
                    </Text>
                    <Action size="sm" variant="ghost" onClick={resetClientId}>
                        Use bundled default
                    </Action>
                </div>
            )}

            <SettingRow
                label="Account"
                desc="Connect the Genie IDE GitHub App via Device Flow to create and fork .agi repos."
                keywords="github connect device flow app repos install account org disconnect advanced refresh"
                grow
            >
                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        justifyContent: 'flex-end',
                    }}
                >
                    {!connected && (
                        <Action
                            color="blue"
                            size="sm"
                            onClick={start}
                            disabled={!clientIdSet || flow.kind === 'pending' || flow.kind === 'starting' || !storageOk}
                        >
                            Connect GitHub…
                        </Action>
                    )}
                    {connected && (
                        <Action variant="ghost" size="sm" onClick={disconnect}>
                            Disconnect
                        </Action>
                    )}
                    {connected && (
                        <Action
                            variant="ghost"
                            size="sm"
                            icon="external-link"
                            onClick={async () => {
                                const url = await api().github.installUrl();
                                void api().tynn.openInBrowser(url);
                            }}
                        >
                            Add account/org…
                        </Action>
                    )}
                    {connected && (
                        <Action
                            variant="ghost"
                            size="sm"
                            icon="refresh-cw"
                            title="Re-check where Genie is installed"
                            onClick={() => void refresh()}
                        >
                            Refresh
                        </Action>
                    )}
                    <Action
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowAdvanced((s) => !s)}
                    >
                        {showAdvanced ? 'Hide Advanced' : 'Advanced'}
                    </Action>
                </div>
            </SettingRow>

            {/* A stored token that no longer works (expired beyond refresh, or
                revoked) used to masquerade as "installed nowhere" because the
                installations fetch failed silently. Surface it as what it is —
                an expired session — with a one-click reconnect, and suppress
                the install prompt below so the two don't contradict. */}
            {connected && (needsReauth || installError) && (
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'color-mix(in srgb, #f43f5e 12%, transparent)',
                        border: '1px solid color-mix(in srgb, #f43f5e 35%, var(--border-1))',
                    }}
                >
                    <Text size="xs">
                        {reauthFailure?.message ??
                            `Your GitHub session is no longer authorized, so Genie can't reach
                            GitHub right now. Reconnect to restore access; your installs on
                            GitHub are untouched.`}
                    </Text>
                    {reauthFailure && (
                        <Text size="xs" style={{ opacity: 0.7 }}>
                            Diagnostic: {reauthFailure.code} ·{' '}
                            {new Date(reauthFailure.occurredAt).toLocaleString()}
                        </Text>
                    )}
                    <div>
                        <Action
                            color="blue"
                            size="sm"
                            icon="github"
                            onClick={reconnect}
                            disabled={flow.kind === 'pending' || flow.kind === 'starting'}
                        >
                            Reconnect GitHub…
                        </Action>
                    </div>
                </div>
            )}

            {/* Installation is a distinct step from authorizing: a GitHub App's
                repo access only exists where it's INSTALLED. When connected but
                installed nowhere, lead with a prominent install action; once
                installed, confirm where so the user knows which accounts/orgs
                Genie can create + fork on. */}
            {connected && installationsLoaded && !needsReauth && !installError && installations.length === 0 && (
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
                        border: '1px solid color-mix(in srgb, #f59e0b 35%, var(--border-1))',
                    }}
                >
                    <Text size="xs">
                        You're signed in, but Genie isn't installed on any account
                        yet — so it can't create or fork repositories. Install it to
                        choose which of your accounts/orgs Genie can act on.
                    </Text>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Action
                            color="blue"
                            size="sm"
                            icon="github"
                            onClick={async () => {
                                const url = await api().github.installUrl();
                                void api().tynn.openInBrowser(url);
                            }}
                        >
                            Install Genie on your accounts/orgs…
                        </Action>
                        <Action
                            variant="ghost"
                            size="sm"
                            icon="refresh-cw"
                            onClick={refresh}
                        >
                            I've installed it
                        </Action>
                    </div>
                </div>
            )}

            {connected && installationsLoaded && !installError && installations.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Text size="xs" className="text-zinc-500">
                        Genie can create &amp; fork repos on{' '}
                        {installations.length} account
                        {installations.length === 1 ? '' : 's'} — add more with
                        “Add account/org…”.
                    </Text>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {installations.map((i) => (
                            <span
                                key={i.login}
                                title={i.isOrg ? 'Organization' : 'Personal account'}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '3px 8px 3px 4px',
                                    borderRadius: 999,
                                    background: 'var(--bg-2)',
                                    border: '1px solid var(--border-1)',
                                }}
                            >
                                {i.avatar_url ? (
                                    <img
                                        src={i.avatar_url}
                                        alt=""
                                        width={16}
                                        height={16}
                                        style={{ borderRadius: i.isOrg ? 4 : '50%' }}
                                    />
                                ) : (
                                    <Icon name={i.isOrg ? 'building-2' : 'user'} size="xs" />
                                )}
                                <Text size="xs" style={{ fontWeight: 600 }}>
                                    {i.login}
                                </Text>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {showAdvanced && (
                <SettingRow
                    label="GitHub App Client ID override"
                    desc={
                        builtInClientId
                            ? 'This Genie build ships with a baked-in GitHub App Client ID. Use this field only to point Genie at a different GitHub App (self-hosters, devs testing forks). Leave blank to use the bundle default. The Client ID is public, not a secret.'
                            : 'Register a GitHub App at github.com/settings/apps/new with Device Flow enabled, then paste its Client ID here. The Client ID is public, not a secret.'
                    }
                    keywords="github client id override app advanced self-hosted device flow"
                    vertical
                >
                    <Input
                        value={clientId}
                        onValueChange={setClientId}
                        placeholder="e.g. Iv23liXXXXXXXXXXXXXX"
                    />
                    <div>
                        <Action color="blue" size="sm" onClick={saveClientId}>
                            Save client ID
                        </Action>
                    </div>
                </SettingRow>
            )}

            {(flow.kind === 'pending' || flow.kind === 'starting') && (
                <DeviceFlowPanel
                    flow={flow}
                    onCancel={cancel}
                />
            )}

            {flow.kind === 'error' && (
                <div className="set-note bad">{flow.message}</div>
            )}
        </SetSection>
    );
}

function DeviceFlowPanel({
    flow,
    onCancel,
}: {
    flow:
        | { kind: 'starting' }
        | {
              kind: 'pending';
              userCode: string;
              verificationUri: string;
              expiresInSec: number;
          };
    onCancel: () => void;
}) {
    const open = () => {
        if (flow.kind !== 'pending') return;
        api().tynn.openInBrowser(flow.verificationUri);
    };
    return (
        <div
            style={{
                padding: 12,
                borderRadius: 8,
                background: 'var(--bg-2)',
                border: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <Text size="xs" className="text-zinc-500">
                {flow.kind === 'starting'
                    ? 'Requesting a device code…'
                    : '1. Open GitHub and paste the code below. 2. Wait — Genie will catch the token automatically.'}
            </Text>
            {flow.kind === 'pending' && (
                <>
                    <button
                        type="button"
                        title="Click to copy"
                        onClick={() => {
                            navigator.clipboard
                                .writeText(flow.userCode)
                                .catch(() => {});
                        }}
                        style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 22,
                            fontWeight: 600,
                            letterSpacing: '0.1em',
                            background: 'var(--card)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 8,
                            padding: '10px 14px',
                            textAlign: 'center',
                            cursor: 'pointer',
                            color: 'var(--fg-1)',
                            width: '100%',
                        }}
                    >
                        {flow.userCode}
                    </button>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Action color="blue" size="sm" onClick={open}>
                            Open {flow.verificationUri}
                        </Action>
                        <Action variant="ghost" size="sm" onClick={onCancel}>
                            Cancel
                        </Action>
                    </div>
                </>
            )}
        </div>
    );
}

/**
 * Phase 1 git-pull updater UI. Shows current vs latest, an inline log
 * during apply, and a non-blocking Restart-when-ready prompt when the
 * rebuild finishes. Auto-poll cadence is user-configurable; 0 = manual.
 */
function UpdaterSection() {
    const [config, setConfig] = useState<UpdaterConfig>({ repo: '', pollHours: 6 });
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    const [mode, setMode] = useState<'phase1' | 'phase2' | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void (async () => {
            const [m, c, s] = await Promise.all([
                api().updater.mode(),
                api().updater.getConfig(),
                api().updater.status(),
            ]);
            setMode(m);
            setConfig(c);
            setStatus(s);
        })();
        const off = api().on.updaterStatus((s) => setStatus(s));
        return () => off();
    }, []);

    const check = async () => {
        setBusy(true);
        try {
            const next = await api().updater.check();
            setStatus(next);
        } finally {
            setBusy(false);
        }
    };
    const apply = async () => {
        setBusy(true);
        try {
            await api().updater.apply();
        } finally {
            setBusy(false);
        }
    };
    const saveConfig = async () => {
        const next = await api().updater.setConfig(config);
        setConfig(next);
    };

    const stateLabel: Record<string, string> = {
        idle: 'Idle',
        checking: 'Checking…',
        available: `Update available`,
        'up-to-date': 'Up to date',
        applying: 'Applying update…',
        downloading: 'Downloading installer…',
        'ready-to-restart': 'Ready — restart to load',
        error: 'Error',
        disabled: 'Disabled',
    };
    const restart = async () => {
        if (mode === 'phase2') {
            await api().updater.restart();
        } else {
            await api().app.quit();
        }
    };

    return (
        <SetSection
            title="Updates"
            desc={mode === 'phase2' ? 'Signed installer (auto-update)' : 'git-pull + rebuild (dev)'}
            status={status ? stateLabel[status.state] ?? status.state : '—'}
            statusColor="var(--fg-3)"
        >
            {mode === 'phase1' && (
                <>
                    <SettingRow
                        label="Source repository"
                        desc="GitHub owner/repo. Default renaissance-analytics/genie; change only if you’re tracking a fork. Empty disables the updater."
                        keywords="updates source repository github owner repo updater fork"
                        vertical
                    >
                        <Input
                            value={config.repo}
                            onValueChange={(v) => setConfig((c) => ({ ...c, repo: v }))}
                            placeholder="renaissance-analytics/genie"
                        />
                    </SettingRow>
                    <SettingRow
                        label="Poll every (hours)"
                        desc="0 disables automatic polling."
                        keywords="updates poll hours interval automatic check frequency"
                        grow
                    >
                        <Input
                            value={String(config.pollHours)}
                            onValueChange={(v) =>
                                setConfig((c) => ({ ...c, pollHours: Number(v) || 0 }))
                            }
                            placeholder="6"
                        />
                        <Action color="blue" size="sm" onClick={saveConfig}>
                            Save
                        </Action>
                    </SettingRow>
                </>
            )}

            {mode === 'phase2' && (
                <div className="set-note">
                    Updates are downloaded from{' '}
                    <a
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            void api().tynn.openInBrowser(
                                'https://github.com/Renaissance-Analytics/genie/releases',
                            );
                        }}
                        style={{ color: 'var(--blue-400)' }}
                    >
                        the canonical Genie releases page
                    </a>
                    . Installer is checksum-verified before applying.
                </div>
            )}

            <SettingRow
                label="Version"
                desc={
                    status?.publishedAt
                        ? `Published ${new Date(status.publishedAt).toLocaleString()}`
                        : undefined
                }
                keywords="updates version current latest check apply restart download"
                vertical
            >
                <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
                    <Text size="xs" className="text-zinc-500">
                        Current
                    </Text>
                    <Text size="sm" style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        v{status?.currentVersion ?? '0.0.0'}
                    </Text>
                    <Text size="xs" className="text-zinc-500" style={{ marginLeft: 16 }}>
                        Latest
                    </Text>
                    <Text size="sm" style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        {status?.latestVersion ? `v${status.latestVersion}` : '—'}
                    </Text>
                </div>
            </SettingRow>

            <div className="set-actions">
                <Action
                    size="sm"
                    variant="ghost"
                    onClick={check}
                    disabled={
                        busy ||
                        (mode === 'phase1' && !config.repo) ||
                        status?.state === 'applying' ||
                        status?.state === 'downloading'
                    }
                >
                    Check for updates
                </Action>
                {status?.state === 'available' && (
                    <Action color="blue" size="sm" onClick={apply} disabled={busy}>
                        {mode === 'phase2'
                            ? `Update to v${status.latestVersion}`
                            : `Update now (v${status.latestVersion})`}
                    </Action>
                )}
                {status?.state === 'ready-to-restart' && (
                    <Action color="blue" size="sm" onClick={restart}>
                        Restart Genie now
                    </Action>
                )}
                {status?.state === 'downloading' && status.progress != null && (
                    <Text size="xs" className="text-zinc-500">
                        {mode === 'phase2' ? 'Updating… ' : ''}
                        {Math.round(status.progress * 100)}%
                    </Text>
                )}
            </div>

            {status?.manualDownloadUrl ? (
                <div className="set-note warn" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Text size="xs">
                        Automatic update isn&apos;t available on macOS for this build (it
                        isn&apos;t Developer-ID signed yet). Download the latest version and
                        drag it into Applications to update.
                    </Text>
                    <div>
                        <Action
                            size="sm"
                            color="blue"
                            icon="download"
                            onClick={() => {
                                const url = status.manualDownloadUrl;
                                if (url) void api().shell.openExternal(url);
                            }}
                        >
                            Download {status.latestVersion ? `v${status.latestVersion}` : 'the latest'} for macOS
                        </Action>
                    </div>
                </div>
            ) : status?.error ? (
                <div className="set-note bad">{status.error}</div>
            ) : null}

            {status &&
                (status.state === 'applying' ||
                    status.state === 'downloading' ||
                    status.state === 'ready-to-restart' ||
                    status.state === 'error') &&
                status.log.length > 0 && (
                    <UpdaterLogPanel log={status.log} />
                )}
        </SetSection>
    );
}

/**
 * Settings → Startup. Single toggle: "Launch Genie when I sign in."
 *
 *   - Reads + writes via the `app.autostart` IPC, which forwards to
 *     Electron's `setLoginItemSettings` on macOS / Windows and a
 *     `~/.config/autostart/genie.desktop` file on Linux.
 *   - On dev (non-packaged) builds, the toggle is shown but disabled —
 *     writing an autostart entry that points at a one-time dev path
 *     would just rot once the dev session ends.
 *   - Autostart launches Genie with `openAsHidden: true`, so Genie
 *     boots into the tray quietly. The master window only appears
 *     when the user clicks the tray icon — no surprise pop-ups on
 *     every login.
 */
function StartupSection() {
    const [enabled, setEnabled] = useState(false);
    const [supported, setSupported] = useState(true);
    const [platform, setPlatform] = useState<string>('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api()
            .app.autostart.get()
            .then((s) => {
                setEnabled(s.enabled);
                setSupported(s.supported);
                setPlatform(s.platform);
            })
            .catch(() => { /* tolerant of older preload shapes */ });
    }, []);

    async function toggle(next: boolean) {
        setBusy(true);
        try {
            const r = await api().app.autostart.set(next);
            setEnabled(r.enabled);
        } finally {
            setBusy(false);
        }
    }

    const platformLabel =
        platform === 'darwin'
            ? 'macOS login items'
            : platform === 'win32'
                ? 'Windows Run-at-startup registry entry'
                : platform === 'linux'
                    ? '~/.config/autostart/genie.desktop'
                    : 'OS login items';

    return (
        <SetSection title="Launch at startup" desc="Start Genie automatically when you sign in">
            <SettingRow
                label="Launch Genie when I sign in"
                desc={`Starts hidden in the tray every time you sign in; click the tray icon to open the workspace window. Backed by ${platformLabel}.`}
                keywords="startup launch sign-in autostart login boot tray run at startup"
            >
                <Switch
                    checked={enabled}
                    disabled={busy || !supported}
                    onCheckedChange={(on: boolean) => toggle(on)}
                />
            </SettingRow>
            {!supported && (
                <div className="set-note">
                    Dev builds can&apos;t register a stable autostart path. Install the
                    packaged release to use this.
                </div>
            )}
        </SetSection>
    );
}

/**
 * Settings → Agent MCP. Surfaces the loopback MCP server's live state (running
 * on which port, or a port-conflict fallback), lets the user set the fixed
 * `mcp_port`, and exposes a Restart button. The port input writes the
 * `mcp_port` setting (saved with the page's Save button); Restart rebinds the
 * server on the configured port and rewrites enabled workspaces' .mcp.json.
 */
function AgentMcpSection({
    restricted,
    port,
    onPortChange,
    syncClaude,
    syncCursor,
    syncCodex,
    syncAgents,
    onSyncChange,
}: {
    /** Remote/host window — the Agent-MCP CONFIG (port + sync toggles) is the
     *  host's (host-sourced via the settings bridge), but the live server
     *  status + restart are the HOST's own process controls, hidden here. */
    restricted: boolean;
    port: string;
    onPortChange: (v: string) => void;
    syncClaude: boolean;
    syncCursor: boolean;
    syncCodex: boolean;
    syncAgents: boolean;
    onSyncChange: (target: 'claude' | 'cursor' | 'codex' | 'agents', on: boolean) => void;
}) {
    const [state, setState] = useState<McpServerState | null>(null);
    const [push, setPush] = useState<ServerPushDiagnostics | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        try {
            setState(await api().mcp.status());
        } catch {
            setState(null);
        }
        try {
            setPush(await api().mcp.pushStatus());
        } catch {
            setPush(null);
        }
    };

    useEffect(() => {
        // In a remote window api().mcp.status() would report the CLIENT's own
        // server, not the host's — so skip it and don't show a misleading pill.
        if (!restricted) void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [restricted]);

    const restart = async () => {
        setBusy(true);
        try {
            setState(await api().mcp.restart());
        } finally {
            setBusy(false);
        }
    };

    const statusLabel = !state
        ? '—'
        : state.conflict
            ? `Port conflict — fell back to ${state.port ?? '?'}`
            : state.running
                ? `Running on port ${state.port}`
                : 'Not running';
    const statusColor = !state
        ? 'var(--fg-3)'
        : state.conflict
            ? 'var(--amber-500)'
            : state.running
                ? 'var(--emerald-600)'
                : 'var(--rose-500)';

    // The bound port doesn't match the configured one → a restart is needed to
    // pick up a port change (or to retry after a conflict).
    const needsRestart =
        !!state &&
        (state.conflict ||
            (state.running && state.port !== state.configuredPort) ||
            String(state.configuredPort) !== String(port));

    return (
        <SetSection
            title="Agent MCP server"
            desc="Loopback server that lets agents call imDone / ForceTheQuestion"
            host={restricted}
            // In a remote window there's no host status pill (host process control),
            // so leave it off; locally it shows the live server state.
            status={restricted ? undefined : statusLabel}
            statusColor={statusColor}
            statusIcon={
                restricted
                    ? undefined
                    : state?.conflict
                        ? 'alert-triangle'
                        : state?.running
                            ? 'check'
                            : 'circle'
            }
        >
            {!restricted && state?.conflict && (
                <div className="set-note warn">
                    The configured port {state.configuredPort} was in use, so the
                    server bound a temporary port instead. Workspace{' '}
                    <code>.mcp.json</code> URLs point at {state.configuredPort} and
                    won&apos;t resolve until you free that port (or pick another) and
                    restart the server below.
                </div>
            )}

            <SettingRow
                label="Server port"
                desc="A fixed, obscure loopback port baked into each workspace's .mcp.json (e.g. 51717). Changing it requires a restart; open terminals keep their old endpoint until recreated."
                keywords="agent mcp server port loopback 51717 restart imdone forcethequestion"
            >
                {/* Fixed width so all 5 port digits show (the type=number spinner
                    otherwise clips it) — matches the mobile "Server port" row. */}
                <div style={{ width: 120 }}>
                    <Input
                        type="number"
                        min={1024}
                        max={65535}
                        value={port}
                        onValueChange={(v) => {
                            const n = parseInt(v, 10);
                            if (v === '') onPortChange('');
                            else if (Number.isFinite(n))
                                onPortChange(String(Math.min(65535, Math.max(1, n))));
                        }}
                        placeholder="51717"
                    />
                </div>
            </SettingRow>

            {/* Restart is a host PROCESS control and api().mcp.restart() isn't
                bridged, so in a remote window it would restart the CLIENT's server.
                Hide it there; the port change is saved to the host and takes effect
                when the host's MCP server restarts. */}
            {restricted ? (
                <Text size="xs" className="text-zinc-500">
                    Saved to the host. A port change takes effect when the host&apos;s
                    Agent MCP server restarts.
                </Text>
            ) : (
                <div className="set-actions">
                    <Action
                        color={needsRestart ? 'blue' : undefined}
                        variant={needsRestart ? 'default' : 'ghost'}
                        icon="refresh-cw"
                        onClick={restart}
                        disabled={busy}
                    >
                        {busy ? 'Restarting…' : 'Restart MCP server'}
                    </Action>
                    <Text size="xs" className="text-zinc-500">
                        Save the page first if you changed the port, then restart to
                        rebind and rewrite workspace configs.
                    </Text>
                </div>
            )}

            <SetSubhead>Config sync</SetSubhead>
            <Text size="xs" className="text-zinc-500" style={{ marginBottom: 2 }}>
                Keep the Genie endpoint available to these agent clients. Unchecking
                one leaves that target alone — your manual edits stick.
            </Text>
            {([
                ['claude', syncClaude, 'Claude', '.mcp.json'],
                ['cursor', syncCursor, 'Cursor', '.cursor/mcp.json'],
                ['codex', syncCodex, 'Codex', 'launch -c overrides'],
                ['agents', syncAgents, 'AGENTS.md', 'Genie brief block'],
            ] as const).map(([target, on, label, file]) => (
                <SettingRow
                    key={target}
                    label={label}
                    desc={file}
                    keywords={`config sync ${target} ${label} ${file} agent endpoint mcp`}
                >
                    <Switch
                        checked={on}
                        onCheckedChange={(v: boolean) => onSyncChange(target, v)}
                    />
                </SettingRow>
            ))}

            {!restricted && (
                <>
                    <SetSubhead>Server-push (SSE) — experimental</SetSubhead>
                    <Text size="xs" className="text-zinc-500" style={{ marginBottom: 6 }}>
                        Whether connected agents open the MCP server-push stream so an
                        AgentInbox message can be pushed to them (vs a blocking poll).
                        This measures what your actual agent clients do — run an agent,
                        then refresh.
                    </Text>
                    <SettingRow
                        label="Client opens the stream"
                        desc="A real agent client connected to the GET SSE endpoint"
                        keywords="server push sse stream mcp agentinbox measurement"
                    >
                        <PushStat
                            ok={(push?.streamsOpened ?? 0) > 0}
                            yes={`yes — ${push?.streamsOpened} opened, ${push?.open} open now`}
                            no="not yet"
                        />
                    </SettingRow>
                    <SettingRow
                        label="Echoes a session id"
                        desc="Mcp-Session-Id echoed back — required for per-agent routing"
                        keywords="server push session id per-agent routing mcp"
                    >
                        <PushStat
                            ok={(push?.sessionsCorrelated ?? 0) > 0}
                            yes={`yes — ${push?.sessionsCorrelated} correlated`}
                            no={
                                (push?.streamsOpened ?? 0) > 0
                                    ? 'no — falls back to workspace-wide'
                                    : '—'
                            }
                        />
                    </SettingRow>
                    <SettingRow
                        label="Pushes delivered"
                        desc="Notifications that reached an open stream"
                        keywords="server push delivered reached notifications mcp"
                    >
                        <PushStat
                            ok={(push?.pushesReached ?? 0) > 0}
                            yes={`${push?.pushesReached} of ${push?.pushesSent} reached`}
                            no={
                                (push?.pushesSent ?? 0) > 0
                                    ? `0 of ${push?.pushesSent} reached`
                                    : 'none sent yet'
                            }
                        />
                    </SettingRow>
                    <div className="set-actions">
                        <Action variant="ghost" icon="refresh-cw" onClick={() => void refresh()}>
                            Refresh
                        </Action>
                    </div>
                </>
            )}
        </SetSection>
    );
}

/** A yes/no measurement pill for the server-push diagnostics. */
function PushStat({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
    return (
        <Text size="xs" style={{ color: ok ? 'var(--emerald-600)' : 'var(--fg-3)' }}>
            {ok ? yes : no}
        </Text>
    );
}

/**
 * Settings → Plugins. The Plugin System manager (Phase 0):
 *   - An "Installed" block: every installed plugin with enable/disable, its
 *     namespaced tools, DECLARED editor mappings (§12.2), and a per-permission
 *     toggle for each granular grant (§12.1), plus uninstall. Install a single
 *     plugin by pasting its REPO URL (the primary path) or from a local folder
 *     (dev convenience).
 *   - Two discovery tabs: OFFICIAL (curated, Genie-maintained — signing lands in
 *     Phase 3) and MARKETPLACES (a git repo that INDEXES many plugins; add one
 *     by URL, browse its members, install each individually).
 */
function PluginsSection() {
    const [installed, setInstalled] = useState<InstalledPluginView[]>([]);
    const [marketplaces, setMarketplaces] = useState<MarketplaceView[]>([]);
    const [official, setOfficial] = useState<OfficialPluginsResult | null>(null);
    const [tab, setTab] = useState<'official' | 'marketplaces'>('official');
    const [repoUrl, setRepoUrl] = useState('');
    const [marketUrl, setMarketUrl] = useState('');
    const [dev, setDev] = useState<PluginDeveloperModeState>({ enabled: false, keys: [] });
    const [pubKey, setPubKey] = useState('');
    const [keyLabel, setKeyLabel] = useState('');
    const [busy, setBusy] = useState(false);
    const [checking, setChecking] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const filter = useContext(SettingsFilterCtx);

    // The discover lists offer only what ISN'T installed yet — an Install card
    // for a plugin you already have reads as "not installed" and confuses.
    // Installed plugins are managed in the Installed section above instead.
    const installedIds = new Set(installed.map((p) => p.id));
    const curatedAvailable = (official?.curated ?? []).filter((c) => !installedIds.has(c.id));
    const bundledAvailable = (official?.bundled ?? []).filter((b) => !installedIds.has(b.id));

    const refresh = async () => {
        try {
            const [ins, mk, off, dm] = await Promise.all([
                api().plugins.list(),
                api().plugins.marketplaces(),
                api().plugins.official(),
                api().plugins.developerMode(),
            ]);
            setInstalled(ins);
            setMarketplaces(mk);
            setOfficial(off);
            setDev(dm);
        } catch {
            /* leave prior state */
        }
    };

    useEffect(() => {
        void refresh();
    }, []);

    /**
     * Re-read the marketplace indexes from their repos. A marketplace's plugin
     * list is a CACHE written when it was added, so without this you keep seeing
     * whatever it listed that day and a plugin published since is simply absent.
     * `maxAgeMs: 0` forces every index (the explicit "Check for new plugins").
     */
    const checkMarketplaces = async (maxAgeMs?: number) => {
        setChecking(true);
        try {
            const r = await api().plugins.refreshMarketplaces(maxAgeMs);
            if (!r.ok) {
                setMsg({ kind: 'err', text: r.error });
                return;
            }
            // Fail-soft per marketplace, but never silent: name the ones that
            // couldn't be re-read, so a list frozen by a broken repo says so.
            const failed = r.value.filter((m) => !m.ok);
            if (failed.length > 0) {
                setMsg({
                    kind: 'err',
                    text: `Couldn't re-read ${failed.map((f) => f.name).join(', ')}: ${failed[0].error ?? 'unknown error'}`,
                });
            } else if (maxAgeMs === 0) {
                setMsg({
                    kind: 'ok',
                    text: r.value.length === 0 ? 'No marketplaces to check.' : `Re-read ${r.value.length} marketplace index${r.value.length === 1 ? '' : 'es'}.`,
                });
            }
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setChecking(false);
            await refresh();
        }
    };

    // Opening the Marketplaces tab is the moment the member lists matter, so that
    // is when stale indexes are re-read (event-driven — never a poll; the main
    // side skips any index read recently, so flipping tabs costs nothing).
    useEffect(() => {
        if (tab !== 'marketplaces') return;
        void checkMarketplaces();
    }, [tab]);

    /** Run an action, surface ok/err, then refresh the lists. */
    const run = async (
        fn: () => Promise<{ ok: boolean; error?: string }>,
        okText: string,
    ) => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await fn();
            if (r.ok) setMsg({ kind: 'ok', text: okText });
            else setMsg({ kind: 'err', text: r.error ?? 'Failed.' });
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setBusy(false);
            await refresh();
        }
    };

    return (
        <>
            <SetSection
                title="Installed plugins"
                desc="Extend Genie with agent tools + (soon) file-type editors — installed from git repos, never bundled"
            >
                {msg && (
                    <div className={`set-note${msg.kind === 'err' ? ' warn' : ''}`}>{msg.text}</div>
                )}

                <SettingRow
                    label="Install from a repo URL"
                    desc="Paste a plugin's git repo URL — Genie clones it, validates its genie-plugin.json, and installs it (disabled until you enable it)."
                    keywords="install plugin repo url git clone genie-plugin.json"
                    grow
                >
                    <div className="set-actions" style={{ width: '100%' }}>
                        <Input
                            value={repoUrl}
                            onValueChange={setRepoUrl}
                            placeholder="https://github.com/owner/my-genie-plugin.git"
                        />
                        <Action
                            icon="download"
                            disabled={busy || !repoUrl.trim()}
                            onClick={() =>
                                run(() => api().plugins.installRepo(repoUrl.trim()), 'Plugin installed — enable it below.').then(
                                    () => setRepoUrl(''),
                                )
                            }
                        >
                            Install
                        </Action>
                        <Action
                            variant="ghost"
                            icon="folder"
                            disabled={busy}
                            onClick={() => run(() => api().plugins.installFolder(), 'Plugin installed from folder.')}
                        >
                            From folder…
                        </Action>
                    </div>
                </SettingRow>

                {installed.length === 0 ? (
                    <Text size="xs" className="text-zinc-500">
                        No plugins installed yet. Install one from a repo URL above, or from the Official / Marketplaces tabs below.
                    </Text>
                ) : (
                    // Each plugin collapses to a summary; `multiple` so opening one
                    // to compare permissions doesn't shut the one you just read.
                    //
                    // While a settings SEARCH is running every card opens: the
                    // permission rows inside filter themselves, and a row that
                    // matched your query but stayed folded away would read as
                    // "settings search can't find it". The Accordion is
                    // uncontrolled, so the key remounts it as search starts/stops.
                    <Accordion
                        key={filter ? 'searching' : 'browsing'}
                        type="multiple"
                        defaultOpen={filter ? installed.map((p) => p.id) : []}
                    >
                        {installed.map((p) => (
                            <PluginCard
                                key={p.id}
                                plugin={p}
                                busy={busy}
                                onEnable={(on) =>
                                    run(() => api().plugins.enable(p.id, on), on ? `Enabled ${p.name}.` : `Disabled ${p.name}.`)
                                }
                                onToggleGrant={(perm, granted) =>
                                    run(
                                        () => api().plugins.setGrant(p.id, perm.category, perm.key, granted),
                                        `${granted ? 'Granted' : 'Revoked'} ${perm.label}.`,
                                    )
                                }
                                onUninstall={() => run(() => api().plugins.uninstall(p.id), `Uninstalled ${p.name}.`)}
                            />
                        ))}
                    </Accordion>
                )}
            </SetSection>

            <SetSection title="Discover plugins" desc="Official curated plugins, or 3rd-party marketplaces you add by URL">
                <div className="set-seg" role="tablist" style={{ marginBottom: 8 }}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'official'}
                        className={tab === 'official' ? 'active' : ''}
                        onClick={() => setTab('official')}
                    >
                        Official
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'marketplaces'}
                        className={tab === 'marketplaces' ? 'active' : ''}
                        onClick={() => setTab('marketplaces')}
                    >
                        Marketplaces
                    </button>
                </div>

                {tab === 'official' ? (
                    <div className="plugin-list">
                        <Text size="xs" className="text-zinc-500">
                            Curated, Genie-maintained plugins. Each install is verified against Genie's
                            trusted publisher key (signature + integrity); unsigned installs require
                            Developer Mode below.
                        </Text>
                        {curatedAvailable.length === 0 && bundledAvailable.length === 0 && (
                            <Text size="xs" className="text-zinc-500">
                                {(official?.curated ?? []).length + (official?.bundled ?? []).length > 0
                                    ? 'Everything here is already installed — manage it under Installed plugins above.'
                                    : 'No curated plugins published yet.'}
                            </Text>
                        )}
                        {curatedAvailable.map((c) => (
                            <div className="plugin-row" key={c.id}>
                                <div className="set-row-main">
                                    <span className="set-row-label">{c.name}</span>
                                    <span className="set-row-desc">{c.description}</span>
                                </div>
                                <Action
                                    icon="download"
                                    disabled={busy}
                                    onClick={() => run(() => api().plugins.installRepo(c.repo), `Installing ${c.name}…`)}
                                >
                                    Install
                                </Action>
                            </div>
                        ))}
                        {bundledAvailable.length > 0 && (
                            <Text size="xs" className="text-zinc-500">
                                Bundled first-party plugins (shipped with Genie).
                            </Text>
                        )}
                        {bundledAvailable.map((b) => (
                            <div className="plugin-row" key={b.id}>
                                <div className="set-row-main">
                                    <span className="set-row-label">{b.name}</span>
                                    <span className="set-row-desc">{b.description}</span>
                                </div>
                                <Action
                                    variant="ghost"
                                    icon="download"
                                    disabled={busy}
                                    onClick={() =>
                                        run(() => api().plugins.installBundled(b.id), `${b.name} installed — enable it above.`)
                                    }
                                >
                                    Install
                                </Action>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="plugin-list">
                        <SettingRow
                            label="Add a marketplace"
                            desc="Paste a marketplace repo URL (a git repo whose genie-marketplace.json indexes many plugins)."
                            keywords="add marketplace repo url genie-marketplace.json index"
                            grow
                        >
                            <div className="set-actions" style={{ width: '100%' }}>
                                <Input
                                    value={marketUrl}
                                    onValueChange={setMarketUrl}
                                    placeholder="https://github.com/owner/my-genie-marketplace.git"
                                />
                                <Action
                                    icon="plus"
                                    disabled={busy || !marketUrl.trim()}
                                    onClick={() =>
                                        run(() => api().plugins.addMarketplace(marketUrl.trim()), 'Marketplace added.').then(() =>
                                            setMarketUrl(''),
                                        )
                                    }
                                >
                                    Add
                                </Action>
                            </div>
                        </SettingRow>

                        {marketplaces.length === 0 ? (
                            <Text size="xs" className="text-zinc-500">
                                No marketplaces added. Paste a marketplace repo URL above to browse its plugins.
                            </Text>
                        ) : (
                            <div className="set-actions">
                                <Action
                                    variant="ghost"
                                    icon="refresh-cw"
                                    disabled={busy || checking}
                                    onClick={() => void checkMarketplaces(0)}
                                >
                                    {checking ? 'Checking…' : 'Check for new plugins'}
                                </Action>
                                <Text size="xs" className="text-zinc-500">
                                    Genie re-reads each index when you open this tab; this checks them all again now.
                                </Text>
                            </div>
                        )}
                        {marketplaces.map((m) => (
                            <div className="plugin-market" key={m.id}>
                                <div className="plugin-market-head">
                                    <span className="set-row-label">{m.name}</span>
                                    <span className="set-row-desc">{m.url}</span>
                                    <span className="set-row-desc">{checkedAgoLabel(m.checkedAt, Date.now())}</span>
                                    <div className="set-actions">
                                        <Action
                                            variant="ghost"
                                            icon="refresh-cw"
                                            disabled={busy || checking}
                                            onClick={() => run(() => api().plugins.refreshMarketplace(m.id), 'Refreshed.')}
                                        >
                                            Refresh
                                        </Action>
                                        <Action
                                            variant="ghost"
                                            color="red"
                                            icon="trash-2"
                                            disabled={busy}
                                            onClick={() => run(() => api().plugins.removeMarketplace(m.id), 'Marketplace removed.')}
                                        >
                                            Remove
                                        </Action>
                                    </div>
                                </div>
                                {/* A member Genie can't read is REPORTED, never just missing — otherwise a
                                    published plugin that never appears looks like Genie failing to notice it. */}
                                {m.issues.length > 0 && (
                                    <div className="set-note warn">
                                        {m.issues.length === 1 ? '1 plugin in this index' : `${m.issues.length} plugins in this index`}{' '}
                                        can&apos;t be installed — the marketplace author needs to fix{' '}
                                        {m.issues.length === 1 ? 'it' : 'them'}:
                                        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                                            {m.issues.map((issue) => (
                                                <li key={issue.at}>
                                                    <strong>{issue.name ?? issue.id ?? issue.at}</strong> ({issue.at}) —{' '}
                                                    {issue.errors.join('; ')}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {m.plugins.length === 0 ? (
                                    <Text size="xs" className="text-zinc-500">
                                        This marketplace lists no plugins Genie can install.
                                    </Text>
                                ) : m.plugins.every((mp) => mp.installed) ? (
                                    <Text size="xs" className="text-zinc-500">
                                        All of this marketplace&apos;s plugins are installed — manage them under
                                        Installed plugins above.
                                    </Text>
                                ) : (
                                    m.plugins
                                        .filter((mp) => !mp.installed)
                                        .map((mp) => (
                                            <div className="plugin-row" key={mp.id}>
                                                <div className="set-row-main">
                                                    <span className="set-row-label">{mp.name}</span>
                                                    {mp.description && <span className="set-row-desc">{mp.description}</span>}
                                                </div>
                                                <Action
                                                    icon="download"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(
                                                            () => api().plugins.installMarketplacePlugin(m.id, mp.id),
                                                            `Installing ${mp.name}…`,
                                                        )
                                                    }
                                                >
                                                    Install
                                                </Action>
                                            </div>
                                        ))
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </SetSection>

            <SetSection
                title="Developer Mode"
                desc="For plugin authors. The signed registry is the safe default; Developer Mode lets you run UNSIGNED plugins and trust your own signing keys."
            >
                <SettingRow
                    label="Allow unsigned plugins"
                    desc="When off, only plugins signed by a trusted publisher (or Genie's own bundled plugins) can be enabled. When on, you can enable UNSIGNED plugins — they run in a restricted sandbox (no network) after an explicit warning."
                    keywords="developer mode unsigned plugin signing key trust"
                >
                    <Switch
                        checked={dev.enabled}
                        onCheckedChange={(v: boolean) =>
                            run(() => api().plugins.setDeveloperMode(v), v ? 'Developer Mode on.' : 'Developer Mode off.')
                        }
                    />
                </SettingRow>

                {dev.enabled && (
                    <>
                        <SetSubhead>Trusted signing keys</SetSubhead>
                        {dev.keys.length === 0 ? (
                            <Text size="xs" className="text-zinc-500">
                                No developer keys trusted. Paste an Ed25519 public key (PEM) below to trust plugins signed by it.
                            </Text>
                        ) : (
                            dev.keys.map((k) => (
                                <div className="plugin-row" key={k.keyId}>
                                    <div className="set-row-main">
                                        <span className="set-row-label">{k.label}</span>
                                        <span className="set-row-desc">
                                            <code>{k.keyId}</code>
                                        </span>
                                    </div>
                                    <Action
                                        variant="ghost"
                                        color="red"
                                        icon="trash-2"
                                        disabled={busy}
                                        onClick={() => run(() => api().plugins.removeTrustedKey(k.keyId), 'Key removed — plugins re-checked.')}
                                    >
                                        Remove
                                    </Action>
                                </div>
                            ))
                        )}
                        <SettingRow
                            label="Trust a signing key"
                            desc="Paste an Ed25519 public key (PEM). Plugins signed by the matching private key will verify as Trusted."
                            keywords="add trusted signing key ed25519 public pem"
                            grow
                        >
                            <div className="set-actions" style={{ width: '100%', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                                <textarea
                                    className="set-input"
                                    value={pubKey}
                                    onChange={(e) => setPubKey(e.target.value)}
                                    placeholder={'-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'}
                                    rows={4}
                                    style={{ fontFamily: 'monospace', fontSize: 11, width: '100%' }}
                                />
                                <div className="set-actions" style={{ width: '100%' }}>
                                    <Input value={keyLabel} onValueChange={setKeyLabel} placeholder="Label (e.g. My dev key)" />
                                    <Action
                                        icon="plus"
                                        disabled={busy || !pubKey.trim()}
                                        onClick={() =>
                                            run(
                                                () => api().plugins.addTrustedKey(pubKey.trim(), keyLabel.trim() || undefined),
                                                'Key trusted — plugins re-checked.',
                                            ).then(() => {
                                                setPubKey('');
                                                setKeyLabel('');
                                            })
                                        }
                                    >
                                        Trust key
                                    </Action>
                                </div>
                            </div>
                        </SettingRow>
                    </>
                )}
            </SetSection>
        </>
    );
}

/** A small colour-coded provenance chip: Trusted / Unsigned / Needs update / Untrusted. */
function TrustBadge({ plugin }: { plugin: InstalledPluginView }) {
    const map = {
        trusted: { label: 'Trusted', bg: 'rgba(34,197,94,0.15)', fg: '#4ade80' },
        unsigned: { label: 'Unsigned', bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24' },
        // A schema-outdated manifest is a "needs an update" state, not a red flag —
        // orange, and worded distinctly from the tamper-red Untrusted.
        outdated: { label: 'Needs update', bg: 'rgba(251,146,60,0.15)', fg: '#fb923c' },
        untrusted: { label: 'Untrusted', bg: 'rgba(248,113,113,0.15)', fg: '#f87171' },
    } as const;
    const s = map[plugin.trust];
    const title =
        plugin.trust === 'trusted'
            ? plugin.signed
                ? `Signed and verified${plugin.publisherKeyId ? ` (${plugin.publisherKeyId})` : ''}`
                : 'First-party — bundled with Genie'
            : plugin.trust === 'unsigned'
              ? 'Not signed by a trusted publisher'
              : plugin.trust === 'outdated'
                ? "Manifest predates a newer Genie requirement — reinstall to update; it can't load until then"
                : 'Signature invalid or code tampered';
    return (
        <span
            title={title}
            style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '1px 6px',
                borderRadius: 4,
                background: s.bg,
                color: s.fg,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
            }}
        >
            {s.label}
        </span>
    );
}

/**
 * One installed-plugin card, COLLAPSED by default.
 *
 * The list is a settings pane, not a dossier: a row shows its name, what it is
 * ({@link pluginSummaryLine}) and its trust chip, and the two controls you
 * actually reach for — the enable switch and Uninstall — stay live without
 * expanding anything. Everything descriptive (description, source, editors, the
 * permission switches) lives behind the disclosure.
 *
 * The switch and Uninstall sit OUTSIDE `Accordion.Trigger` on purpose: the
 * trigger renders a `<button>`, and nesting controls inside one both breaks the
 * markup and swallows their clicks into a toggle. A NON-trusted plugin also
 * keeps its one-line explanation in the head — a dark switch with no reason
 * given is the thing that sends you looking for a bug.
 */
function PluginCard({
    plugin,
    busy,
    onEnable,
    onToggleGrant,
    onUninstall,
}: {
    plugin: InstalledPluginView;
    busy: boolean;
    onEnable: (on: boolean) => void;
    onToggleGrant: (perm: InstalledPluginView['permissions'][number], granted: boolean) => void;
    onUninstall: () => void;
}) {
    return (
        <Accordion.Item value={plugin.id} className="plugin-card border-b-0">
            <div className="plugin-card-head">
                {/* `py-0` so twMerge drops the trigger's own vertical padding — the
                    card supplies its own, and this must not depend on CSS order. */}
                <Accordion.Trigger className="plugin-card-summary py-0">
                    <span className="set-row-main">
                        <span className="set-row-label">
                            {plugin.name} <span className="text-zinc-500">{pluginSummaryLine(plugin)}</span>{' '}
                            <TrustBadge plugin={plugin} />
                        </span>
                        {plugin.trust === 'untrusted' && (
                            <span className="set-row-desc" style={{ color: '#f87171' }}>
                                Untrusted — its signature is invalid or its code was tampered with. This plugin cannot be enabled.
                            </span>
                        )}
                        {plugin.trust === 'outdated' && (
                            <span className="set-row-desc" style={{ color: '#fb923c' }}>
                                Needs an update — this plugin&apos;s manifest predates a newer Genie requirement. Reinstall it to
                                update; it can&apos;t load until then.
                            </span>
                        )}
                        {plugin.trust === 'unsigned' && (
                            <span className="set-row-desc" style={{ color: '#fbbf24' }}>
                                Unsigned — not verified by a trusted publisher. Requires Developer Mode to enable.
                            </span>
                        )}
                    </span>
                </Accordion.Trigger>
                <div className="set-actions">
                    <Switch checked={plugin.enabled} onCheckedChange={onEnable} />
                    <Action variant="ghost" color="red" icon="trash-2" disabled={busy} onClick={onUninstall}>
                        Uninstall
                    </Action>
                </div>
            </div>

            <Accordion.Content className="plugin-card-details">
                {plugin.description && <Text size="xs" className="text-zinc-500">{plugin.description}</Text>}
                <Text size="xs" className="text-zinc-500">
                    Source: {plugin.sourceType}
                    {plugin.sourceUrl ? ` — ${plugin.sourceUrl}` : ''}
                    {plugin.publisher ? ` · by ${plugin.publisher}` : ''}
                </Text>
                {plugin.sides.client && !plugin.sides.host && (
                    <Text size="xs" className="text-zinc-500">
                        Client-side — it only contributes editors, so it runs no code here. This switch
                        controls whether files open in it in THIS window; a remote client connecting to
                        this Genie uses its own setting and its own copy of the editor.
                    </Text>
                )}

                {plugin.tools.length > 0 && (
                    <>
                        <SetSubhead>Agent tools (run on this machine)</SetSubhead>
                        {plugin.tools.map((t) => (
                            <div className="plugin-row" key={t.name}>
                                <div className="set-row-main">
                                    <span className="set-row-label">
                                        <code>{t.name}</code>
                                    </span>
                                    <span className="set-row-desc">{t.description}</span>
                                </div>
                            </div>
                        ))}
                    </>
                )}

                {plugin.editors.length > 0 && (
                    <>
                        <SetSubhead>Editors (client-side)</SetSubhead>
                        <Text size="xs" className="text-zinc-500">
                            These render in whichever Genie window opens the file. The file types listed are
                            also the sandbox: an editor only ever reads or writes those, inside the workspace.
                        </Text>
                        {plugin.editors.map((e) => (
                            <div className="plugin-row" key={e.id}>
                                <div className="set-row-main">
                                    <span className="set-row-label">
                                        {e.title} — {e.extensions.join(', ')}
                                    </span>
                                    <span className="set-row-desc">
                                        <code>{e.fancyEditor}</code>
                                    </span>
                                </div>
                            </div>
                        ))}
                    </>
                )}

                <SetSubhead>Permissions</SetSubhead>
                {!plugin.sides.host ? (
                    <Text size="xs" className="text-zinc-500">
                        None needed — this plugin runs no code on this machine.
                    </Text>
                ) : plugin.permissions.length === 0 ? (
                    <Text size="xs" className="text-zinc-500">
                        This plugin declares no capabilities.
                    </Text>
                ) : (
                    plugin.permissions.map((perm) => (
                        <SettingRow
                            key={`${perm.category}:${perm.key}`}
                            label={perm.label}
                            keywords={`permission grant ${perm.category} ${perm.key}`}
                        >
                            <Switch
                                checked={perm.granted}
                                onCheckedChange={(v: boolean) => onToggleGrant(perm, v)}
                            />
                        </SettingRow>
                    ))
                )}
            </Accordion.Content>
        </Accordion.Item>
    );
}

/**
 * Settings → Work Mode → Mode. Host (default) vs Remote. Host means this Genie
 * runs your projects and lets phones / (Phase 2) other Genies connect to it;
 * Remote means this Genie connects out to a host Genie over the tailnet. Phase 1
 * persists the choice + drives the section below it; the remote client is Phase 2.
 */
/**
 * Settings → Work Mode → Tailscale. Genie MANAGES Tailscale (no separate app):
 * shows live status (installed / online / tailnet IP + online peers), installs
 * it (downloads Tailscale's signed installer on Windows, else opens the download
 * page), and brings the node online (`tailscale up`, opening the login URL when
 * interactive auth is needed). All via the `tailscale:*` IPC.
 */
function TailscaleSection() {
    const [status, setStatus] = useState<TailscaleStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);

    const refresh = async () => {
        try {
            setStatus(await api().tailscale.status());
        } catch {
            setStatus(null);
        }
    };
    useEffect(() => {
        void refresh();
    }, []);

    const install = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().tailscale.install();
            setMsg(
                r.started
                    ? 'Tailscale installer launched — finish it, then click Refresh.'
                    : r.url
                        ? 'Opened the Tailscale download page — install it, then Refresh.'
                        : (r.message ?? 'Could not start the installer.'),
            );
        } finally {
            setBusy(false);
        }
    };

    const connect = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().tailscale.up();
            if (r.ok) {
                setMsg('Tailscale is online.');
            } else if (r.authUrl) {
                await api().tailscale.openAuth(r.authUrl);
                setMsg('Opened the Tailscale login — sign in, then click Refresh.');
            } else {
                setMsg(r.message ?? 'Could not bring Tailscale online.');
            }
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const installed = status?.installed ?? false;
    const running = status?.running ?? false;
    const selfIp = status?.self?.ip ?? null;
    const onlinePeers = (status?.peers ?? []).filter((p) => p.online);

    const label = !status
        ? '—'
        : !installed
            ? 'Not installed'
            : running
                ? `Connected${selfIp ? ` · ${selfIp}` : ''}`
                : 'Installed · offline';
    const color = !status
        ? 'var(--fg-3)'
        : !installed
            ? 'var(--rose-500)'
            : running
                ? 'var(--emerald-600)'
                : 'var(--amber-600)';

    return (
        <SetSection
            title="Tailscale"
            desc="The encrypted network Work Mode runs over"
            status={label}
            statusColor={color}
            statusIcon={!installed ? 'alert-triangle' : running ? 'check' : 'circle'}
        >
            <SettingRow
                label="Connection"
                keywords="tailscale install online connect network vpn tailnet"
                desc="Genie manages Tailscale for you — no separate app. Work Mode binds only to your tailnet, so your projects are reachable from your own devices and nothing else."
            >
                {!installed && (
                    <Action
                        size="sm"
                        color="blue"
                        icon="download"
                        disabled={busy}
                        onClick={() => void install()}
                    >
                        Install
                    </Action>
                )}
                {installed && !running && (
                    <Action
                        size="sm"
                        color="blue"
                        icon="zap"
                        disabled={busy}
                        onClick={() => void connect()}
                    >
                        Bring online
                    </Action>
                )}
                <Action
                    size="sm"
                    variant="ghost"
                    icon="refresh-cw"
                    disabled={busy}
                    onClick={() => void refresh()}
                >
                    Refresh
                </Action>
            </SettingRow>

            {running && (
                <SettingRow
                    label="Devices on your tailnet"
                    keywords="peers devices online tailnet"
                >
                    <Text size="xs" className="text-zinc-500">
                        {onlinePeers.length === 0
                            ? 'None online yet'
                            : `${onlinePeers.length} online: ${onlinePeers
                                  .map((p) => p.hostname || p.ip)
                                  .filter(Boolean)
                                  .slice(0, 6)
                                  .join(', ')}`}
                    </Text>
                </SettingRow>
            )}

            {msg && <div className="set-note">{msg}</div>}
        </SetSection>
    );
}

/**
 * Settings → Work Mode → Remote host (shown in remote mode). Discovers Genie
 * hosts on the tailnet (the unauthed /api/ping beacon) and connects to one:
 * Connect opens a dedicated, clearly-marked Genie window driving that host's
 * remote-control surface over Tailscale (the host must approve the pairing PIN).
 * Manual host:port entry covers hosts on a non-default port.
 */
function RemoteHostCard() {
    const [hosts, setHosts] = useState<GenieHost[] | null>(null);
    const [scanning, setScanning] = useState(false);
    const [pins, setPins] = useState<Record<string, string>>({});
    const [pinNeeded, setPinNeeded] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState<string | null>(null);
    // Live connKeys per host row (from a successful connect) → enables the
    // Testing Browser button for serving that host's `.gen` dev sites (Phase D).
    const [connKeys, setConnKeys] = useState<Record<string, string>>({});
    const [manualIp, setManualIp] = useState('');
    const [manualPort, setManualPort] = useState('51718');
    const [manualPin, setManualPin] = useState('');
    const [msg, setMsg] = useState<string | null>(null);

    const scan = async () => {
        setScanning(true);
        setMsg(null);
        try {
            setHosts(await api().workmode.discoverHosts());
        } catch {
            setHosts([]);
            setMsg('Discovery failed — make sure Tailscale is online.');
        } finally {
            setScanning(false);
        }
    };
    useEffect(() => {
        void scan();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const connect = async (
        host: {
            ip: string;
            port: number;
            hostname: string;
            hostId?: string;
            dnsName?: string;
        },
        pin?: string,
    ) => {
        const key = `${host.ip}:${host.port}`;
        setBusy(key);
        setMsg(null);
        try {
            // Open the host in its OWN native Floor window (the local window
            // stays local). No PIN → reconnect with the remembered token; the
            // host answers needsPin only for a first-time pair (or a dead token).
            // The discovered host's stable hostId/dnsName ride along so pairing
            // keys on identity, not the mutable ip:port.
            const r = await api().remote.open(host, pin?.trim() || undefined);
            if (r.ok) {
                setPinNeeded((p) => ({ ...p, [key]: false }));
                if (r.connKey) setConnKeys((c) => ({ ...c, [key]: r.connKey! }));
                setMsg(`Opened ${host.hostname} in its own window.`);
            } else if (r.needsPin) {
                setPinNeeded((p) => ({ ...p, [key]: true }));
                setMsg(
                    pin
                        ? 'That PIN was rejected — check the host and try again.'
                        : `First time pairing ${host.hostname}: enter the PIN shown on it.`,
                );
            } else {
                setMsg(r.error ?? 'Could not connect.');
            }
        } finally {
            setBusy(null);
        }
    };

    const setPin = (key: string, v: string) => setPins((p) => ({ ...p, [key]: v }));

    // NOTE: in the per-window model this Settings window is always LOCAL, so the
    // old "active session / Disconnect / HostUpdate" branch (which assumed the
    // whole desktop went remote) is gone. Connecting opens the host in its OWN
    // window; manage live host sessions from the titlebar Hosts picker or by
    // closing the host window. (Follow-on: re-home the host-updater UI inside the
    // host window, where api() is remote.)

    const connectManual = () => {
        const ip = manualIp.trim();
        if (!ip) return;
        void connect(
            { ip, port: Number(manualPort) || 51718, hostname: ip },
            manualPin.trim() || undefined,
        );
    };

    return (
        <SetSection
            title="Remote host"
            desc="Connect to another Genie and control it from this desktop"
        >
            <SettingRow
                label="Discover hosts"
                keywords="remote host discover scan tailnet connect pair"
                desc="Drive another Genie's workspaces, terminals, editor and processes over Tailscale. The FIRST connect pairs with the PIN shown on the host; after that, Connect reconnects with no PIN."
            >
                <Action
                    size="sm"
                    variant="ghost"
                    icon="refresh-cw"
                    disabled={scanning}
                    onClick={() => void scan()}
                >
                    {scanning ? 'Scanning…' : 'Rescan'}
                </Action>
            </SettingRow>

            {hosts === null ? (
                <Text size="xs" className="text-zinc-500">Scanning the tailnet…</Text>
            ) : hosts.length === 0 ? (
                <Text size="xs" className="text-zinc-500">
                    No Genie hosts found. A host needs Work Mode host (mobile remote
                    control) enabled; use manual connect below for a non-default port.
                </Text>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {hosts.map((h) => {
                        const key = `${h.ip}:${h.port}`;
                        return (
                            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                                <Icon name="monitor" size="xs" style={{ marginBottom: 9 }} />
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                                    <Text size="sm" style={{ fontWeight: 600 }}>
                                        {h.hostname}
                                    </Text>
                                    <Text size="xs" className="text-zinc-500">
                                        {h.ip}:{h.port}
                                    </Text>
                                </div>
                                {pinNeeded[key] && (
                                    <div style={{ width: 88 }}>
                                        <Input
                                            label="PIN"
                                            value={pins[key] ?? ''}
                                            onValueChange={(v) => setPin(key, v)}
                                            placeholder="123456"
                                        />
                                    </div>
                                )}
                                <Action
                                    size="sm"
                                    color="blue"
                                    icon="link"
                                    disabled={busy === key}
                                    onClick={() =>
                                        void connect(
                                            h,
                                            pinNeeded[key] ? (pins[key] ?? '') : undefined,
                                        )
                                    }
                                >
                                    {busy === key
                                        ? pinNeeded[key]
                                            ? 'Pairing…'
                                            : 'Connecting…'
                                        : pinNeeded[key]
                                            ? 'Pair'
                                            : 'Connect'}
                                </Action>
                                {connKeys[key] && (
                                    <Action
                                        size="sm"
                                        color="green"
                                        icon="globe"
                                        title="Open the Testing Browser to view this host's hosted sites (*.gen) with a valid https lock"
                                        onClick={() =>
                                            void api().testingBrowser.open(
                                                connKeys[key],
                                                h.hostname,
                                            )
                                        }
                                    >
                                        Testing Browser
                                    </Action>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 130 }}>
                    <Input
                        label="Manual connect"
                        description="Host tailnet IP"
                        value={manualIp}
                        onValueChange={setManualIp}
                        placeholder="100.x.y.z"
                    />
                </div>
                <div style={{ width: 76 }}>
                    <Input
                        label="Port"
                        value={manualPort}
                        onValueChange={setManualPort}
                        placeholder="51718"
                    />
                </div>
                <div style={{ width: 88 }}>
                    <Input
                        label="PIN"
                        value={manualPin}
                        onValueChange={setManualPin}
                        placeholder="123456"
                    />
                </div>
                <Action
                    size="sm"
                    variant="ghost"
                    icon="link"
                    disabled={!manualIp.trim()}
                    onClick={connectManual}
                >
                    Connect
                </Action>
            </div>

            {msg && <div className="set-note">{msg}</div>}
        </SetSection>
    );
}

/**
 * Settings → Hosting Manager — the WORKSTATION view: what this MACHINE can
 * build and serve, and what it is serving.
 *
 * ## Why a machine-level page
 *
 * Everything else in the Hosting Manager is scoped to a workspace, because a
 * site is: one container, one project, gone when the project is. Three things
 * are not. The container RUNTIME is a property of the computer. The base IMAGE
 * is pulled once and mounted into every workspace. And a service ENGINE is
 * SHARED — one `postgres:16` serves every workspace pinned to Postgres 16, with
 * a reference-counted lifecycle across all of them. None of those has a
 * workspace to belong to, and a workspace panel answering for them is how a
 * user stops "their" database and takes five other projects down with it.
 *
 * So the split is: WHICH sites a project HOSTS and which services it uses
 * lives in its Site Manager; WHAT exists on this machine, and the shared
 * engines' start/stop, live here.
 *
 * ## Everything is a READ until you press something
 *
 * Opening this page never pulls an image, builds anything or starts a
 * container. A settings page that downloads several gigabytes because someone
 * looked at it is the failure this rule exists to prevent.
 *
 * All the judgements render from pure functions in `lib/workstation-dev-server.ts`
 * (the renderer test env has no DOM); this is the wiring.
 *
 * Exported for the `e2e-hosting` harness page, which mounts THIS component
 * (never a stand-in) so the E2E spec drives the shipped surface.
 */
/** Badge color + label per tool-update tone (#242 P2). The tone decision is
 *  workstation-dev-server's (pure, unit-tested); this is only its presentation. */
function toolToneBadge(tone: ToolUpdateTone): { color: 'amber' | 'emerald' | 'zinc'; label: string } {
    switch (tone) {
        case 'update-available':
            return { color: 'amber', label: 'Update available' };
        case 'up-to-date':
            return { color: 'emerald', label: 'Up to date' };
        case 'not-installed':
            return { color: 'zinc', label: 'Not installed' };
        case 'unknown':
            return { color: 'zinc', label: 'Installed' };
    }
}

/**
 * One single-version tool's rows — the shared body of the Dev tools and Agent
 * CLIs tabs. Presentational only: the row model and badge tone are decided in
 * `workstation-dev-server.ts`, and which tools belong on which tab in
 * `toolchain-page.ts`, both pure and unit-tested.
 */
function ToolUpdateList({
    rows,
    busy,
    onUpdate,
    empty,
    testId,
}: {
    rows: ToolUpdateRow[];
    busy: HostToolName | null;
    onUpdate: (name: HostToolName) => void;
    empty: string;
    /** Distinct per tab — both tabs render this list, and two identical ids in
     *  one document make a test assert about whichever it found first. */
    testId: string;
}) {
    if (rows.length === 0) return <div className="set-note">{empty}</div>;
    return (
        <div className="ws-tools" data-testid={testId}>
            {rows.map((row) => {
                const badge = toolToneBadge(row.tone);
                return (
                    <div className="ws-engine" key={row.name} data-testid={`devtool-${row.name}`}>
                        <div className="ws-engine-head">
                            <div className="ws-engine-name">
                                <Text size="sm" style={{ fontWeight: 600 }}>
                                    {row.label}
                                </Text>
                                <Text size="xs" className="text-zinc-500">
                                    {row.installed ? `Installed ${row.installed}` : 'Not installed'}
                                    {row.tone === 'update-available' && row.latest
                                        ? ` — ${row.latest} available`
                                        : ''}
                                </Text>
                            </div>
                            <Badge color={badge.color}>{badge.label}</Badge>
                            <div className="ws-engine-actions">
                                {row.action === 'update' && (
                                    <Action
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy !== null}
                                        onClick={() => onUpdate(row.name)}
                                    >
                                        {busy === row.name ? 'Updating…' : 'Update'}
                                    </Action>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** What an Add / Remove is currently asking about. Both are modals because both
 *  cost something real — a download, or a directory that is gone. */
type VersionAsk =
    | { kind: 'add'; tool: LanguageTool; label: string; versions: string[] }
    | { kind: 'remove'; install: EngineInstall; label: string; message: string };

/**
 * The Languages tab: php / node / python / go / rust, each with every version on
 * this machine.
 *
 * Two kinds of row, and telling them apart is the whole point. A GENIE row is a
 * directory Genie installed under `<userData>/toolchain` — it can be made the
 * default, and removed. A FOREIGN row (Herd, XAMPP, nvm, a system package) is
 * there so the machine is legible: "yes, Genie knows Herd has PHP 8.4", without
 * implying a site can use it. Every row states its SOURCE and its DIRECTORY,
 * because "which php is this?" is the actual question on a machine carrying
 * three of them.
 */
function LanguagesTab({
    info,
    busy,
    onAsk,
    onSetDefault,
}: {
    info: ToolchainInstallsInfo | null;
    busy: string | null;
    onAsk: (ask: VersionAsk) => void;
    onSetDefault: (tool: LanguageTool, version: string) => void;
}) {
    if (!info) return <div className="set-note">Reading this machine&apos;s toolchain…</div>;
    const sections = languageSections({
        installs: info.installs,
        defaults: info.defaults,
        addable: info.addable,
        sites: info.sites,
    });
    return (
        <div className="tc-langs">
            {sections.map((section) => (
                <div
                    className="tc-lang"
                    key={section.tool}
                    data-testid={`toolchain-lang-${section.tool}`}
                >
                    <div className="tc-lang-head">
                        <Text size="sm" style={{ fontWeight: 600 }}>
                            {section.label}
                        </Text>
                        {section.defaultVersion ? (
                            <Badge color="emerald">default {section.defaultVersion}</Badge>
                        ) : (
                            <Badge color="zinc">no default</Badge>
                        )}
                        <div className="ws-engine-actions">
                            {section.canAdd && (
                                <Action
                                    size="sm"
                                    variant="ghost"
                                    icon="plus"
                                    disabled={busy !== null}
                                    onClick={() =>
                                        onAsk({
                                            kind: 'add',
                                            tool: section.tool,
                                            label: section.label,
                                            versions: section.addable,
                                        })
                                    }
                                    title={`Download and install a ${section.label} version into Genie's own toolchain directory.`}
                                >
                                    Add a version
                                </Action>
                            )}
                        </div>
                    </div>

                    {section.rows.length === 0 ? (
                        <div className="set-note">{section.emptyNote}</div>
                    ) : (
                        <div className="tc-installs">
                            {section.rows.map((row) => (
                                <div
                                    className="ws-engine"
                                    key={row.key}
                                    data-testid={`toolchain-install-${row.tool}-${row.version}`}
                                >
                                    <div className="ws-engine-head">
                                        <div className="ws-engine-name">
                                            <Text size="sm" style={{ fontWeight: 600 }}>
                                                {section.label} {row.version}
                                            </Text>
                                            {/* SOURCE and PATH, always. An install is a
                                                DIRECTORY, and which directory is the
                                                difference between a site that serves and
                                                genie#206. */}
                                            <Text
                                                size="xs"
                                                className="text-zinc-500"
                                                title={row.path}
                                            >
                                                {row.sourceLabel} · {row.path}
                                                {row.sizeLabel ? ` · ${row.sizeLabel}` : ''}
                                            </Text>
                                        </div>
                                        {row.isDefault && <Badge color="emerald">Default</Badge>}
                                        {!row.managed && <Badge color="zinc">Not managed</Badge>}
                                        <div className="ws-engine-actions">
                                            {row.canSetDefault && (
                                                <Action
                                                    size="sm"
                                                    variant="ghost"
                                                    disabled={busy !== null}
                                                    onClick={() =>
                                                        onSetDefault(row.tool, row.version)
                                                    }
                                                >
                                                    Set default
                                                </Action>
                                            )}
                                            {row.canRemove && (
                                                <Action
                                                    size="sm"
                                                    variant="ghost"
                                                    icon="trash-2"
                                                    disabled={busy !== null}
                                                    onClick={() => {
                                                        const install = info.installs.find(
                                                            (i) =>
                                                                i.tool === row.tool &&
                                                                i.version === row.version &&
                                                                i.dir === row.path,
                                                        );
                                                        if (!install) return;
                                                        onAsk({
                                                            kind: 'remove',
                                                            install,
                                                            label: section.label,
                                                            message: removeConfirmation(install, {
                                                                freedBytes: install.sizeBytes,
                                                            }),
                                                        });
                                                    }}
                                                >
                                                    Remove
                                                </Action>
                                            )}
                                        </div>
                                    </div>
                                    {row.note && (
                                        <Text size="xs" className="text-zinc-500">
                                            {row.note}
                                        </Text>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Who this language's default actually moves. */}
                    {section.usedBy && <div className="set-note">{section.usedBy}</div>}
                </div>
            ))}
        </div>
    );
}

/**
 * Settings → **Toolchain**: THIS MACHINE's languages, dev tools and agent CLIs.
 *
 * ## Why it is its own page
 *
 * It used to be a section inside the Hosting Manager, sitting directly below a
 * chip row reading `Node 24 · PHP 8.4 · Python 3.13 · …`. Those chips describe
 * the CONTAINER DEV-BASE IMAGE — a constant mirrored from its Dockerfile, which
 * nothing on that page can change — and they looked exactly like the rows below
 * them that describe this computer. Two unrelated machines sharing one surface
 * is most of the reason the page read as "I see no UX at all for my toolchain".
 * The chips now live beside the image they describe, on the Hosting page, and
 * the toolchain has a page of its own: it is the MACHINE's concern, and hosting
 * merely consumes it.
 *
 * ## Three tabs, because there are three genuinely different models
 *
 *  - **Languages** — MULTI-version. Many installs side by side, one machine
 *    default, and a site follows that default unless it pins a version.
 *  - **Dev tools** — git / docker / composer. One install, update-to-latest.
 *  - **Agent CLIs** — claude-code / codex. Their own group because updating one
 *    is the single action Genie REFUSES mid-turn, so that rule is stated once.
 *
 * The guided first-run wizard stays a separate thing this page can OPEN: the
 * wizard is the front door, the page is where you live afterwards.
 *
 * Every judgement (tab membership, row actions, the sentence a default change
 * prints) is a pure function in `lib/toolchain-page.ts` — the renderer test env
 * has no DOM, so a decision inside a component is a decision nobody checks.
 */
export function ToolchainSection() {
    const [tab, setTab] = useState('languages');
    const [info, setInfo] = useState<ToolchainInstallsInfo | null>(null);
    const [updates, setUpdates] = useState<ToolUpdate[] | null>(null);
    /** The tool or version with an action in flight — one at a time, because
     *  these are installs. */
    const [busy, setBusy] = useState<string | null>(null);
    const [toolBusy, setToolBusy] = useState<HostToolName | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** What just happened. Setting a default, adding and removing a version all
     *  change something invisible (a directory, a machine-wide pointer), so each
     *  one says what it did and what it affects. */
    const [notice, setNotice] = useState<string | null>(null);
    const [ask, setAsk] = useState<VersionAsk | null>(null);
    /** The version chosen in the Add dialog. */
    const [addVersion, setAddVersion] = useState('');
    const [wizardOpen, setWizardOpen] = useState(false);
    /** An update main held back because live work would be hit. */
    const [confirmUpdate, setConfirmUpdate] = useState<{ tool: HostToolName; reason: string } | null>(
        null,
    );

    /** `force` re-reads the machine now instead of reusing main’s cached scan
     *  (which spawns a PATH lookup per language and walks install directories). */
    const refreshInstalls = useCallback((force = false) => {
        void api()
            .devServer.toolchainInstalls(force)
            .then(setInfo)
            .catch(() =>
                setInfo({ installs: [], defaults: {}, addable: {}, sites: [], root: '' }),
            );
    }, []);

    /** `force` re-runs the (slow, network-touching) package-manager scan instead
     *  of reusing main's cached answer. */
    const refreshUpdates = useCallback((force = false) => {
        void api()
            .devServer.toolchainUpdates(force)
            .then(setUpdates)
            .catch(() => setUpdates([]));
    }, []);

    useEffect(() => {
        refreshInstalls();
        refreshUpdates();
        // Push-driven, like every other live surface: main fires this when an
        // install finishes or a default moves. Wrapped so the event payload can
        // never arrive as `force` and turn a notification into a fresh scan.
        return api().on.devServerChanged(() => {
            refreshInstalls();
            refreshUpdates();
        });
    }, [refreshInstalls, refreshUpdates]);

    const setDefault = async (tool: LanguageTool, version: string) => {
        setBusy(`${tool}:${version}`);
        setError(null);
        setNotice(null);
        try {
            const res = await api().devServer.toolchainSetDefault(tool, version);
            if (!res.ok) setError(res.error ?? 'The default did not change.');
            // NAME what moved. "Default" is a live link, not a snapshot, so the
            // moment it moves is the moment to say which sites go with it.
            else setNotice(defaultChangeNotice(tool, version, info?.sites ?? []));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
            refreshInstalls(true);
        }
    };

    const addVersionNow = async (tool: LanguageTool, label: string, version: string) => {
        setAsk(null);
        setBusy(`${tool}:${version}`);
        setError(null);
        setNotice(null);
        try {
            const res = await api().devServer.toolchainAddVersion(tool, version);
            if (!res.ok) setError(res.error ?? `${label} ${version} could not be installed.`);
            else setNotice(`${label} ${version} is installed and ready for sites to use.`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
            refreshInstalls(true);
        }
    };

    const removeVersionNow = async (install: EngineInstall, label: string) => {
        setAsk(null);
        setBusy(`${install.tool}:${install.version}`);
        setError(null);
        setNotice(null);
        try {
            const res = await api().devServer.toolchainRemoveVersion(
                install.tool,
                install.version,
            );
            if (!res.ok) {
                setError(res.error ?? `${label} ${install.version} could not be removed.`);
                return;
            }
            const freed =
                res.freedBytes !== undefined ? `, freeing ${formatBytes(res.freedBytes)}` : '';
            const moved =
                res.nextDefault === null
                    ? ` Genie now manages no ${label}.`
                    : res.nextDefault
                      ? ` ${label} ${res.nextDefault} is now the default.`
                      : '';
            setNotice(`Removed ${label} ${install.version}${freed}.${moved}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
            refreshInstalls(true);
        }
    };

    const update = async (name: HostToolName, confirmed = false) => {
        setToolBusy(name);
        setError(null);
        try {
            const res = await api().devServer.toolchainUpdate(name, confirmed);
            // Main REFUSED because live work would be hit. `blocked` is final —
            // replacing a binary an agent is mid-turn on fails on Windows and
            // corrupts the turn elsewhere, so there is no "do it anyway". `warn`
            // is a real choice, so it gets a dialog that NAMES the cost.
            if (!res.ok && res.risk) {
                if (res.risk === 'blocked') setError(res.error ?? 'Not safe to update right now.');
                else setConfirmUpdate({ tool: name, reason: res.error ?? '' });
                return;
            }
            if (!res.ok) {
                const failed = res.results.find((r) => r.status === 'failed');
                setError(failed?.error ?? 'The update did not complete.');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setToolBusy(null);
            refreshUpdates();
        }
    };

    const devRows = updates ? toolUpdateRows(devToolRows(updates)) : [];
    const agentRows = updates ? toolUpdateRows(agentCliRows(updates)) : [];
    const pendingUpdates = updates ? toolUpdateCount(devToolRows(updates)) : 0;
    const managedCount = info
        ? info.installs.filter((i) => i.source === 'genie').length
        : 0;

    return (
        <SetSection
            className="set-section--sticky"
            title="Toolchain"
            desc="The languages and tools on THIS machine — the ones Genie installs and owns, and the ones other installers left here"
            {...(pendingUpdates > 0
                ? {
                      status: `${pendingUpdates} update${pendingUpdates === 1 ? '' : 's'}`,
                      statusColor: '#f59e0b',
                  }
                : {})}
        >
            {error && <div className="set-note bad">{error}</div>}
            {notice && (
                <div className="set-note" role="status" data-testid="toolchain-notice">
                    {notice}
                </div>
            )}
            {/* Grouped, never a flat list: three different management models
                would otherwise read as one confusing table. */}
            <Tabs activeTab={tab} onTabChange={setTab}>
                {/* The tab list AND the in-flight install travel with the sticky
                    head, so scrolling a long version list never hides which tab
                    you are in, or the fact that something is installing. Tabs
                    context flows through this wrapper. */}
                <div className="set-sticky-band">
                    {busy && (
                        <div className="set-note">Working on {busy.replace(':', ' ')}…</div>
                    )}
                    <Tabs.List>
                        <Tabs.Tab value="languages">Languages ({managedCount})</Tabs.Tab>
                        <Tabs.Tab value="tools">Dev tools ({devRows.length})</Tabs.Tab>
                        <Tabs.Tab value="agents">Agent CLIs ({agentRows.length})</Tabs.Tab>
                    </Tabs.List>
                </div>
                <Tabs.Panels>
                    <Tabs.Panel value="languages">
                        <div className="set-note">
                            Genie installs languages — and their config — into its own folder
                            {info?.root ? ` (${info.root})` : ''}, so a site always runs on a
                            version nothing else can change underneath it. Versions other
                            installers put on this machine are listed for reference and cannot
                            be used by a site.
                        </div>
                        <LanguagesTab
                            info={info}
                            busy={busy}
                            onAsk={(next) => {
                                setAsk(next);
                                setAddVersion(next.kind === 'add' ? (next.versions[0] ?? '') : '');
                            }}
                            onSetDefault={(tool, version) => void setDefault(tool, version)}
                        />
                    </Tabs.Panel>

                    <Tabs.Panel value="tools">
                        {updates === null ? (
                            <div className="set-note">Checking for updates…</div>
                        ) : (
                            <ToolUpdateList
                                rows={devRows}
                                busy={toolBusy}
                                onUpdate={(name) => void update(name)}
                                empty="No dev tools detected on this machine yet — the guided setup installs them."
                                testId="dev-tools"
                            />
                        )}
                    </Tabs.Panel>

                    <Tabs.Panel value="agents">
                        <div className="set-note">
                            Genie refuses to update an agent CLI while that agent is mid-turn:
                            replacing the binary under a running turn fails outright on Windows
                            and corrupts the turn elsewhere. Finish the turn, then update.
                        </div>
                        {updates === null ? (
                            <div className="set-note">Checking for updates…</div>
                        ) : (
                            <ToolUpdateList
                                rows={agentRows}
                                busy={toolBusy}
                                onUpdate={(name) => void update(name)}
                                empty="No agent CLIs on this machine yet."
                                testId="agent-clis"
                            />
                        )}
                    </Tabs.Panel>
                </Tabs.Panels>
            </Tabs>

            {/* The update scan is CACHED (it queries winget/brew/npm), so there
                has to be a way to ask again on purpose — and the way BACK into
                the first-run wizard, which is otherwise offered once and its
                dismissal remembered forever. */}
            <div className="set-actions">
                <Action
                    size="sm"
                    variant="ghost"
                    icon="refresh-cw"
                    disabled={busy !== null || toolBusy !== null}
                    onClick={() => {
                        refreshInstalls(true);
                        refreshUpdates(true);
                    }}
                    title="Re-read this machine's toolchain and re-query the package managers now, instead of reusing the last answer."
                >
                    Check again
                </Action>
                <Action
                    size="sm"
                    variant="ghost"
                    icon="sparkles"
                    disabled={busy !== null || toolBusy !== null}
                    onClick={() => setWizardOpen(true)}
                    title="Re-run the guided setup: re-detect what this machine has and install anything still missing."
                >
                    Set up toolchain
                </Action>
            </div>

            <ToolchainSetupWizard
                open={wizardOpen}
                onClose={() => {
                    setWizardOpen(false);
                    // It may have installed something — re-read rather than
                    // leaving the page showing the pre-setup machine.
                    refreshInstalls(true);
                    refreshUpdates(true);
                }}
            />

            {/* Add: a download and a few hundred megabytes, so it says WHAT it
                will fetch and WHERE it lands before it starts. */}
            {ask?.kind === 'add' && (
                <Modal open onClose={() => setAsk(null)} size="sm">
                    <div className="ws-confirm">
                        <Heading as="h3" size="xs">
                            Add a {ask.label} version
                        </Heading>
                        <Select
                            value={addVersion}
                            onValueChange={setAddVersion}
                            list={ask.versions.map((v) => ({ value: v, label: `${ask.label} ${v}` }))}
                        />
                        <Text size="xs" className="text-zinc-500">
                            Genie downloads it from the official source and installs it into its
                            own toolchain folder. Nothing already on this machine is changed, and
                            removing it later is deleting that one folder.
                        </Text>
                        <div className="ws-confirm-actions">
                            <Action variant="ghost" onClick={() => setAsk(null)}>
                                Cancel
                            </Action>
                            <Action
                                disabled={!addVersion}
                                onClick={() => void addVersionNow(ask.tool, ask.label, addVersion)}
                            >
                                Install
                            </Action>
                        </div>
                    </div>
                </Modal>
            )}

            {/* Remove: names the directory, the disk it frees and the default
                that takes over — the same rule as stopping a shared engine. */}
            {ask?.kind === 'remove' && (
                <Modal open onClose={() => setAsk(null)} size="sm">
                    <div className="ws-confirm">
                        <Heading as="h3" size="xs">
                            Remove {ask.label} {ask.install.version}?
                        </Heading>
                        <Callout color="amber" icon={<Icon name="triangle-alert" size="sm" />}>
                            <span data-testid="toolchain-remove-risk">{ask.message}</span>
                        </Callout>
                        <div className="ws-confirm-actions">
                            <Action variant="ghost" onClick={() => setAsk(null)}>
                                Keep it
                            </Action>
                            <Action
                                color="amber"
                                onClick={() => void removeVersionNow(ask.install, ask.label)}
                            >
                                Remove
                            </Action>
                        </div>
                    </div>
                </Modal>
            )}

            {/* The update would hit live work. Not "are you sure" — the sentence
                NAMES the containers or sites at stake. */}
            {confirmUpdate && (
                <Modal open onClose={() => setConfirmUpdate(null)} size="sm">
                    <div className="ws-confirm">
                        <Heading as="h3" size="xs">
                            Update {confirmUpdate.tool} now?
                        </Heading>
                        <Callout color="amber" icon={<Icon name="triangle-alert" size="sm" />}>
                            <span data-testid="update-risk">{confirmUpdate.reason}</span>
                        </Callout>
                        <div className="ws-confirm-actions">
                            <Action variant="ghost" onClick={() => setConfirmUpdate(null)}>
                                Not now
                            </Action>
                            <Action
                                color="amber"
                                onClick={() => {
                                    const tool = confirmUpdate.tool;
                                    setConfirmUpdate(null);
                                    void update(tool, true);
                                }}
                            >
                                Update anyway
                            </Action>
                        </div>
                    </div>
                </Modal>
            )}
        </SetSection>
    );
}


export function DevServerSection({
    genieBrowserEnabled,
    onGenieBrowserChange,
}: {
    genieBrowserEnabled: boolean;
    onGenieBrowserChange: (on: boolean) => void;
}) {
    const [info, setInfo] = useState<DevWorkstationInfo | null>(null);
    const [engineTab, setEngineTab] = useState('active');
    /** The row with an action in flight — disables just that row. */
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** What just finished, shown until the next action. An install MOVES the row
     *  to another tab, so without this the click reads as "nothing happened". */
    const [done, setDone] = useState<string | null>(null);
    /** The one engine whose log is open, and its tail. */
    const [logs, setLogs] = useState<{ recordKey: string; text: string } | null>(null);
    /** A stop that would hit other workspaces, held until it is confirmed. */
    const [confirmStop, setConfirmStop] = useState<DevEngineInfo | null>(null);

    const refresh = useCallback(() => {
        void api()
            .devServer.workstation()
            .then(setInfo)
            .catch(() =>
                setInfo({
                    runtime: { kind: 'none', probes: [] },
                    devBase: { image: '', installed: false, toolchain: [] },
                    engines: [],
                }),
            );
    }, []);

    useEffect(() => {
        refresh();
        // Push-driven, like every other live surface: main fires this whenever a
        // site or service is configured, starts or stops.
        return api().on.devServerChanged(refresh);
    }, [refresh]);

    const runtime = info ? runtimeDiagnostics(info) : null;
    const groups = engineGroups(info?.engines ?? []);

    const act = async (engine: DevEngineInfo, action: 'start' | 'stop' | 'logs' | 'install') => {
        setBusy(engine.recordKey);
        setError(null);
        setDone(null);
        try {
            const res = await api().devServer.engine({
                recordKey: engine.recordKey,
                action,
                ...(action === 'logs' ? { tail: 200 } : {}),
            });
            if (!res.ok && res.error) setError(res.error);
            if (action === 'logs' && res.ok) {
                setLogs({ recordKey: engine.recordKey, text: res.logs ?? '' });
            }
            // A download changes the row's STATE, which is what the tabs group by
            // — so the row leaves the tab it was clicked in. FOLLOW it and say what
            // happened, rather than letting it vanish (entry → action → visible
            // confirm → next).
            if (action === 'install' && res.ok) {
                setEngineTab(engineGroupOf({ ...engine, installed: true }));
                setDone(engineInstalledNote(engine));
            }
            refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    /** A stop is the one action that can hurt someone else, so it asks first —
     *  but only when there IS someone else. Confirming a harmless stop trains
     *  people to click through the one that matters. */
    const stop = (engine: DevEngineInfo) => {
        if (stopEngineWarning(engine)) setConfirmStop(engine);
        else void act(engine, 'stop');
    };

    const toggleLog = (engine: DevEngineInfo) => {
        if (logs?.recordKey === engine.recordKey) setLogs(null);
        else void act(engine, 'logs');
    };

    return (
        <>
            <SetSection
                title="Container runtime"
                desc="What Genie builds and serves a workspace's sites in — one container per site, sandboxed to its workspace, backed by the shared services below"
            >
                <SettingRow
                    label="Docker or Podman"
                    desc={runtime?.headline ?? 'Checking…'}
                    keywords="docker podman container runtime hosting manager engine install"
                >
                    <span
                        className={`site-dot site-${runtime?.usable ? 'running' : 'idle'}`}
                        aria-hidden="true"
                    />
                </SettingRow>

                {/* Each candidate, not just the verdict. "docker: found, engine
                    unreachable" is the line that ends a support thread — and it
                    is the difference between "install Docker" and "start it". */}
                {!!runtime?.probes.length && (
                    <div className="ws-probes">
                        {runtime.probes.map((probe) => (
                            <div className="ws-probe" key={probe.kind}>
                                <span
                                    className={`site-dot site-${probe.tone}`}
                                    aria-hidden="true"
                                />
                                <Text size="xs">{probe.label}</Text>
                                {probe.detail && (
                                    <Text size="xs" className="text-zinc-500">
                                        {probe.detail}
                                    </Text>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {runtime?.guidance ? (
                    <div className="set-note">
                        {runtime.guidance} Genie re-detects on every action, so once one is
                        installed there is nothing to restart — and it never downloads anything
                        because you opened this page.
                    </div>
                ) : (
                    <div className="set-note">
                        Each workspace gets its own isolated container network and a dev
                        container with the workspace mounted in. Set a workspace&apos;s sites up
                        in its Site Manager — its server icon in the sidebar, or right-click the
                        workspace.
                    </div>
                )}
            </SetSection>

            <SetSection
                title="Workspace dev image"
                desc="The one image every workspace's containers are built on, and the language runtimes baked into it"
            >
                <SettingRow
                    label={info?.devBase.image || 'Dev base image'}
                    desc={
                        info?.devBase.installed
                            ? 'On this machine — a workspace starts without downloading anything.'
                            : 'Not downloaded yet. Genie fetches it the first time a workspace serves a site, and asks before it does.'
                    }
                    keywords="dev base image container toolchain runtime versions"
                >
                    <Badge color={info?.devBase.installed ? 'emerald' : 'zinc'}>
                        {info?.devBase.installed ? 'Downloaded' : 'Not downloaded'}
                    </Badge>
                </SettingRow>

                {/* These chips describe the IMAGE, not this computer — and for a
                    long time they sat directly above rows that described the
                    computer, with nothing saying which was which. That single
                    ambiguity is most of why the page read as "I see no UX at all
                    for my toolchain": the only versions on screen were ones
                    nothing here could change. They stay beside the image they
                    belong to, they say so, and they point at the page that DOES
                    manage this machine.

                    The versions themselves are a CONSTANT mirrored from the
                    image's Dockerfile (a drift test keeps them honest) — asking
                    the image would mean pulling gigabytes to render a settings
                    page. */}
                {!!info?.devBase.toolchain.length && (
                    <>
                        <div className="set-note" data-testid="dev-base-toolchain-caption">
                            Inside this container image — <strong>not this machine</strong>. These
                            versions ship with the image and change only when it is rebuilt. To
                            install and choose the versions on THIS computer, use Settings →
                            Toolchain.
                        </div>
                        <div
                            className="ws-toolchain"
                            data-testid="dev-base-toolchain"
                            aria-label="Language runtimes inside the workspace dev image"
                        >
                            {info.devBase.toolchain.map((tool) => (
                                <div className="ws-tool" key={tool.id}>
                                    <Text size="sm" style={{ fontWeight: 600 }}>
                                        {tool.label} {tool.version}
                                    </Text>
                                    {tool.extras?.length ? (
                                        <Text size="xs" className="text-zinc-500">
                                            {tool.extras.join(' · ')}
                                        </Text>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </SetSection>

            <SetSection
                title="Service engines"
                desc="Postgres, Redis and friends — ONE container per engine and major version, shared by every workspace on this machine"
            >
                {error && <div className="set-note bad">{error}</div>}
                {/* The visible confirmation for an action whose row moved tabs.
                    Dismissible, and replaced by the next action's outcome. */}
                {done && (
                    <div className="set-note" role="status" data-testid="engine-done">
                        {done}
                    </div>
                )}

                {/* Grouped, not flat: a dozen catalog rows would bury the two
                    that are actually running, which are the only ones anyone
                    opens this page for. */}
                <Tabs activeTab={engineTab} onTabChange={setEngineTab}>
                    <Tabs.List>
                        <Tabs.Tab value="active">Running ({groups.active.length})</Tabs.Tab>
                        <Tabs.Tab value="installed">
                            On this machine ({groups.installed.length})
                        </Tabs.Tab>
                        <Tabs.Tab value="available">
                            Available ({groups.available.length})
                        </Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panels>
                        <Tabs.Panel value="active">
                            <EngineList
                                engines={groups.active}
                                empty="Nothing is running. A workspace starts its engines when you start a site that needs one."
                                hasRuntime={!!runtime?.usable}
                                busy={busy}
                                logs={logs}
                                onStart={(e) => void act(e, 'start')}
                                onStop={stop}
                                onToggleLog={toggleLog}
                                onInstall={(e) => void act(e, 'install')}
                            />
                        </Tabs.Panel>
                        <Tabs.Panel value="installed">
                            <EngineList
                                engines={groups.installed}
                                empty="No engine images on this machine yet."
                                hasRuntime={!!runtime?.usable}
                                busy={busy}
                                logs={logs}
                                onStart={(e) => void act(e, 'start')}
                                onStop={stop}
                                onToggleLog={toggleLog}
                                onInstall={(e) => void act(e, 'install')}
                            />
                        </Tabs.Panel>
                        <Tabs.Panel value="available">
                            <EngineList
                                engines={groups.available}
                                empty="Every engine Genie knows about is already here."
                                hasRuntime={!!runtime?.usable}
                                busy={busy}
                                logs={logs}
                                onStart={(e) => void act(e, 'start')}
                                onStop={stop}
                                onToggleLog={toggleLog}
                                onInstall={(e) => void act(e, 'install')}
                            />
                        </Tabs.Panel>
                    </Tabs.Panels>
                </Tabs>

                <div className="set-note">
                    A workspace gets its own database, role and credentials on the shared engine
                    — add one from that workspace&apos;s Site Manager. Engines are managed here
                    because they are shared: stopping one here stops it for every workspace
                    using it.
                </div>
            </SetSection>

            <SetSection
                title="Genie Browser"
                desc="Genie's own browser — how a hosted .gen site is opened, locally or over a remote connection"
            >
                <SettingRow
                    label="Enable the Genie Browser"
                    desc="On by default. It renders this machine's hosted sites with a valid https lock and device presets. Turning it off means a .gen site opens nowhere."
                    keywords="genie browser testing browser gen sites preview enable"
                >
                    <Switch checked={genieBrowserEnabled} onCheckedChange={onGenieBrowserChange} />
                </SettingRow>
            </SetSection>

            {confirmStop && (
                <Modal open onClose={() => setConfirmStop(null)} size="sm">
                    <div className="ws-confirm">
                        <Heading as="h3" size="xs">
                            Stop {confirmStop.label} {confirmStop.version}?
                        </Heading>
                        <Callout color="amber" icon={<Icon name="triangle-alert" size="sm" />}>
                            {stopEngineWarning(confirmStop)}
                        </Callout>
                        <Text size="xs" className="text-zinc-500">
                            Nothing is deleted — the data volume stays, and the engine starts
                            again the next time a workspace asks for it.
                        </Text>
                        <div className="ws-confirm-actions">
                            <Action variant="ghost" onClick={() => setConfirmStop(null)}>
                                Cancel
                            </Action>
                            <Action
                                color="rose"
                                icon="square"
                                onClick={() => {
                                    const engine = confirmStop;
                                    setConfirmStop(null);
                                    void act(engine, 'stop');
                                }}
                            >
                                Stop it for everyone
                            </Action>
                        </div>
                    </div>
                </Modal>
            )}
        </>
    );
}

/** One group of engines, or the sentence that says why it is empty. */
function EngineList({
    engines,
    empty,
    hasRuntime,
    busy,
    logs,
    onStart,
    onStop,
    onToggleLog,
    onInstall,
}: {
    engines: DevEngineInfo[];
    empty: string;
    hasRuntime: boolean;
    busy: string | null;
    logs: { recordKey: string; text: string } | null;
    onStart: (engine: DevEngineInfo) => void;
    onStop: (engine: DevEngineInfo) => void;
    onToggleLog: (engine: DevEngineInfo) => void;
    onInstall: (engine: DevEngineInfo) => void;
}) {
    if (engines.length === 0) {
        return (
            <Text size="xs" className="text-zinc-500" style={{ padding: '8px 0' }}>
                {empty}
            </Text>
        );
    }
    return (
        <div className="ws-engines">
            {engines.map((engine) => (
                <EngineRow
                    key={engine.recordKey}
                    engine={engine}
                    hasRuntime={hasRuntime}
                    busy={busy === engine.recordKey}
                    log={logs?.recordKey === engine.recordKey ? logs.text : null}
                    onStart={onStart}
                    onStop={onStop}
                    onToggleLog={onToggleLog}
                    onInstall={onInstall}
                />
            ))}
        </div>
    );
}

/**
 * ONE engine on this machine.
 *
 * Three independent facts, deliberately not collapsed into a single status:
 * whether the image is here, whether a container is up, and who is holding it.
 * Every pair of those occurs in practice — an image pulled once and never
 * started is several gigabytes nothing else in Genie reports, and an engine up
 * with zero holders is what a reboot leaves behind, because engines carry
 * `restart: unless-stopped`.
 */
function EngineRow({
    engine,
    hasRuntime,
    busy,
    log,
    onStart,
    onStop,
    onToggleLog,
    onInstall,
}: {
    engine: DevEngineInfo;
    hasRuntime: boolean;
    busy: boolean;
    log: string | null;
    onStart: (engine: DevEngineInfo) => void;
    onStop: (engine: DevEngineInfo) => void;
    onToggleLog: (engine: DevEngineInfo) => void;
    onInstall: (engine: DevEngineInfo) => void;
}) {
    const actions = engineActionAvailability(engine, hasRuntime);
    const usage = engineUsageNote(engine);
    return (
        <div className="ws-engine">
            <div className="ws-engine-head">
                <span className={`site-dot site-${engineStatusTone(engine)}`} aria-hidden="true" />
                <div className="ws-engine-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {engine.label}
                        {engine.engine === 'custom' ? '' : ` ${engine.version}`}
                    </Text>
                    <Text size="xs" className="text-zinc-500">
                        {engine.image}
                    </Text>
                </div>
                {engine.dedicated && <Badge color="violet">Dedicated</Badge>}
                {engine.installed && engine.state !== 'running' && (
                    <Badge color="zinc">Downloaded</Badge>
                )}
                <div className="ws-engine-actions">
                    {/* Pre-download another major (#242 P3). Offered with NO
                        consumer on purpose: holding 17 ready while 16 serves is
                        the point of multi-version. Pulls only — never starts. */}
                    {actions.canInstall && (
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="download"
                            disabled={busy}
                            onClick={() => onInstall(engine)}
                        >
                            {/* A pull is hundreds of megabytes — a button that just
                                goes quiet for a minute reads as broken. */}
                            {busy ? 'Downloading…' : 'Install'}
                        </Action>
                    )}
                    {actions.canStart && (
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="play"
                            disabled={busy}
                            onClick={() => onStart(engine)}
                        >
                            Start
                        </Action>
                    )}
                    {actions.canStop && (
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="square"
                            disabled={busy}
                            onClick={() => onStop(engine)}
                        >
                            Stop
                        </Action>
                    )}
                    {actions.canLogs && (
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="scroll-text"
                            disabled={busy}
                            onClick={() => onToggleLog(engine)}
                        >
                            {log === null ? 'Log' : 'Hide log'}
                        </Action>
                    )}
                </div>
            </div>

            <Text size="xs" className="text-zinc-500">
                {engineStatusLabel(engine)}
            </Text>
            {usage && (
                <Text size="xs" className="text-zinc-500">
                    {usage}
                </Text>
            )}
            {/* Names what a workspace's boundary on this engine ACTUALLY is.
                Postgres gives a server-enforced database + role; the namespace
                engines share a master key and are separated by a prefix.
                Rendering both as "isolated" would claim a wall that is not there. */}
            <Text size="xs" className="text-zinc-500">
                {isolationNote(engine.provision)}
            </Text>

            {log !== null && (
                <div className="ws-engine-log">
                    <CodeView
                        value={log || 'Nothing logged yet.'}
                        readOnly
                        minHeight={0}
                        maxHeight={240}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * Settings → Mobile. Drives the tailnet remote-control server: the enable
 * toggle + fixed `mobile_port`, plus a live status block (tailnet URL when
 * running, a "Tailscale not detected" notice when fail-closed, a port-conflict
 * banner), the pairing PIN + QR, and the control buttons (Restart / Regenerate
 * PIN / Disconnect all / Lock kill-switch).
 *
 * The page-level Save persists `mobile_enabled` / `mobile_port`; the toggle and
 * port both persist FIRST (via `persistSettings`) and then call
 * `mobile.restart(enabled)` so the server rebinds on the new setting without
 * waiting for the user to hit Save. `status()` is loaded on mount and after
 * every action so the block always reflects the live server.
 */
function MobileSection({
    enabled,
    onEnabledChange,
    remoteEnabled,
    onRemoteEnabledChange,
    networkAccess,
    onNetworkAccessChange,
    port,
    onPortChange,
    persistSettings,
}: {
    enabled: boolean;
    onEnabledChange: (on: boolean) => void;
    remoteEnabled: boolean;
    onRemoteEnabledChange: (on: boolean) => void;
    networkAccess: { local: boolean; lan: boolean; tailscale: boolean; tynn: boolean };
    onNetworkAccessChange: (network: 'local' | 'lan' | 'tailscale' | 'tynn', on: boolean) => void;
    port: string;
    onPortChange: (v: string) => void;
    persistSettings: () => Promise<void>;
}) {
    const [status, setStatus] = useState<MobileStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);

    const refresh = async () => {
        try {
            setStatus(await api().mobile.status());
        } catch {
            setStatus(null);
        }
    };

    useEffect(() => {
        void refresh();
    }, []);

    // Persist the settings the server reads (mobile_enabled / mobile_port) BEFORE
    // restarting, so the rebind picks up the new values. Used by the toggle and
    // the port input so a change takes effect without a separate Save.
    const persistThenRestart = async (on: boolean) => {
        setBusy(true);
        setMsg(null);
        try {
            await persistSettings();
            setStatus(await api().mobile.restart(on));
        } finally {
            setBusy(false);
        }
    };

    // Desktop Genie Remote toggle — independent of the phone UI. Binds/unbinds the
    // same host server (server stays up while either surface is on), so a desktop
    // can connect without the Mobile UI toggle on.
    const persistThenSetRemote = async (on: boolean) => {
        setBusy(true);
        setMsg(null);
        try {
            await persistSettings();
            setStatus(await api().mobile.setRemoteEnabled(on));
        } finally {
            setBusy(false);
        }
    };

    const restart = async () => {
        setBusy(true);
        setMsg(null);
        try {
            setStatus(await api().mobile.restart(enabled));
        } finally {
            setBusy(false);
        }
    };

    const regeneratePin = async () => {
        setBusy(true);
        setMsg(null);
        try {
            setStatus(await api().mobile.regeneratePin());
            setMsg('New PIN generated — re-pair your phone with it.');
        } finally {
            setBusy(false);
        }
    };

    // Windows: add the inbound firewall allow-rule for the live port (one UAC
    // prompt). The returned status re-checks needsFirewallRule, so the prompt hides
    // itself on success; a declined UAC is a gentle "click again", not a failure.
    const allowFirewall = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().mobile.allowFirewall();
            setStatus(r);
            if (r.ok) {
                setMsg('Allowed through Windows Firewall — your phone should connect now.');
            } else if (r.cancelled) {
                setMsg('Firewall change cancelled — click Allow again when you’re ready.');
            } else {
                setMsg(r.error ?? 'Couldn’t update Windows Firewall.');
            }
        } finally {
            setBusy(false);
        }
    };

    const revokeSessions = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().mobile.revokeSessions();
            setStatus(r);
            setMsg(
                `Disconnected ${r.revoked} device${r.revoked === 1 ? '' : 's'}.`,
            );
        } finally {
            setBusy(false);
        }
    };

    const toggleLock = async () => {
        setBusy(true);
        setMsg(null);
        try {
            setStatus(await api().mobile.lock(!(status?.locked ?? false)));
        } finally {
            setBusy(false);
        }
    };

    const statusLabel = !status
        ? '—'
        : status.tailnetNotDetected
            ? 'Tailscale not detected'
            : status.conflict
                ? `Port ${status.configuredPort} in use`
                : status.running
                    ? `Running on ${status.ip}:${status.port}`
                    : status.enabled
                        ? 'Starting…'
                        : 'Off';
    const statusColor = !status
        ? 'var(--fg-3)'
        : status.tailnetNotDetected || status.conflict
            ? 'var(--rose-500)'
            : status.running
                ? 'var(--emerald-600)'
                : 'var(--fg-3)';

    return (
        <SetSection
            title="Remote control"
            desc="Let another Genie (desktop) — or your phone — drive this Genie over Tailscale. Each surface is a separate switch; the server runs while either is on."
            status={statusLabel}
            statusColor={statusColor}
            statusIcon={
                status?.tailnetNotDetected || status?.conflict
                    ? 'alert-triangle'
                    : status?.running
                        ? 'check'
                        : 'circle'
            }
        >
            <SettingRow
                label="Enable Genie Remote (desktop)"
                keywords="genie remote desktop control connect host enable server pairing tailscale work mode"
                desc="Off by default. Lets another Genie in Remote mode connect to and drive this desktop over your tailnet. Independent of the phone UI below — you do NOT need to enable Mobile to use Genie Remote. Pairing is confirmed here, then the remote can drive terminals until you Disconnect or Lock."
            >
                <Switch
                    checked={remoteEnabled}
                    disabled={busy}
                    onCheckedChange={(on: boolean) => {
                        onRemoteEnabledChange(on);
                        void persistThenSetRemote(on);
                    }}
                />
            </SettingRow>

            <SettingRow
                label="Enable Mobile UI (phone)"
                keywords="mobile remote control phone enable server pairing tailscale web ui"
                desc="Off by default. Serves a small web UI on your Tailscale interface so a paired phone can reach this desktop. Independent of Genie Remote above — turn this off and desktop remote still works."
            >
                <Switch
                    checked={enabled}
                    disabled={busy}
                    onCheckedChange={(on: boolean) => {
                        onEnabledChange(on);
                        void persistThenRestart(on);
                    }}
                />
            </SettingRow>

            <SettingRow
                label="Server port"
                keywords="port server"
                desc="A fixed port bound on your Tailscale IP (default 51718). The phone URL embeds it, so changing it requires a restart of the server below."
            >
                <div style={{ width: 120 }}>
                    <Input
                        type="number"
                        min={1024}
                        max={65535}
                        value={port}
                        onValueChange={(v) => {
                            const n = parseInt(v, 10);
                            if (v === '') onPortChange('');
                            else if (Number.isFinite(n)) onPortChange(String(Math.min(65535, Math.max(1, n))));
                        }}
                        placeholder="51718"
                    />
                </div>
            </SettingRow>

            <SettingRow
                label="Allowed networks"
                keywords="local lan tailscale tynn network access remote exposure"
                desc="Choose every transport allowed to reach this workstation. Local has owner priority; LAN is off by default; Tynn uses the authenticated relay and does not open a local socket."
            >
                <div className="grid gap-2">
                    {([
                        ['local', 'Local'],
                        ['lan', 'LAN'],
                        ['tailscale', 'Tailscale'],
                        ['tynn', 'Tynn'],
                    ] as const).map(([network, label]) => (
                        <label key={network} className="flex items-center justify-between gap-4 text-sm">
                            <span>{label}</span>
                            <Switch
                                checked={networkAccess[network]}
                                disabled={busy}
                                onCheckedChange={(on: boolean) => {
                                    onNetworkAccessChange(network, on);
                                    void persistSettings().then(restart);
                                }}
                            />
                        </label>
                    ))}
                </div>
            </SettingRow>

            {status?.tailnetNotDetected && (
                <div className="set-note bad">
                    Tailscale not detected — start Tailscale and click Restart. The
                    server binds only to the tailnet and won&apos;t start without it.
                </div>
            )}

            {status?.conflict && (
                <div className="set-note bad">
                    Port {status.configuredPort} is in use — pick another port and
                    Restart. Genie won&apos;t silently fall back to a random port so
                    the phone URL stays stable.
                </div>
            )}

            {!!status?.listeners?.length && (
                <div className="set-note">
                    <div className="mb-1 font-medium">Active listeners</div>
                    {status.listeners.map((listener) => (
                        <div key={`${listener.network}:${listener.ip}`}>
                            {listener.network}: {listener.secure ? 'https' : 'http'}://{listener.ip}:{listener.port}
                        </div>
                    ))}
                    {networkAccess.tynn && <div>Tynn: authenticated relay enabled</div>}
                    {networkAccess.lan && (
                        <div>LAN: awaiting secure certificate enrollment (no plaintext listener)</div>
                    )}
                </div>
            )}

            {status?.needsFirewallRule && (
                <div className="set-note bad">
                    Windows Firewall is blocking the mobile port — your phone can&apos;t
                    connect until you allow it (scoped to your Tailscale network only).
                    <div style={{ marginTop: 8 }}>
                        <Action
                            size="sm"
                            color="blue"
                            icon="shield"
                            onClick={allowFirewall}
                            disabled={busy}
                        >
                            {busy ? 'Working…' : 'Allow through Windows Firewall'}
                        </Action>
                    </div>
                </div>
            )}

            {status?.running && status.url && (
                <SettingRow
                    label="Phone URL"
                    keywords="url link phone open address https tls"
                    desc="Open this on your phone (must be on the same tailnet)."
                    vertical
                >
                    <MobileCodeChip code={status.url} />
                </SettingRow>
            )}

            {status?.running && (
                <div className={`set-note${status.secure ? '' : ' warn'}`}>
                    {status.secure
                        ? 'Secured with Tailscale TLS — the phone loads over browser-trusted HTTPS (wss for live streams).'
                        : 'Encrypted over Tailscale (HTTP) — traffic is still fully encrypted by your tailnet. For a browser-trusted HTTPS URL, enable “HTTPS Certificates” for your tailnet in the Tailscale admin console (DNS settings), then Restart.'}
                </div>
            )}

            {status?.running && (status.pin || status.qrDataUrl) && (
                <SettingRow
                    label="Pairing code"
                    keywords="pair pin qr code scan"
                    desc="Scan to pair, or enter the PIN on your phone."
                    vertical
                >
                    <div
                        style={{
                            display: 'flex',
                            gap: 16,
                            alignItems: 'center',
                            padding: 12,
                            borderRadius: 8,
                            border: '1px solid var(--border-1)',
                            background: 'var(--bg-2)',
                        }}
                    >
                        {status.qrDataUrl && (
                            <img
                                src={status.qrDataUrl}
                                alt="Pairing QR code"
                                width={140}
                                height={140}
                                style={{
                                    borderRadius: 8,
                                    background: '#fff',
                                    padding: 6,
                                }}
                            />
                        )}
                        {status.pin && (
                            <button
                                type="button"
                                title="Click to copy"
                                onClick={() => {
                                    navigator.clipboard.writeText(status.pin).catch(() => {});
                                }}
                                style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 28,
                                    fontWeight: 600,
                                    letterSpacing: '0.18em',
                                    background: 'var(--card)',
                                    border: '1px solid var(--border-1)',
                                    borderRadius: 8,
                                    padding: '10px 14px',
                                    textAlign: 'center',
                                    cursor: 'pointer',
                                    color: 'var(--fg-1)',
                                }}
                            >
                                {status.pin}
                            </button>
                        )}
                    </div>
                </SettingRow>
            )}

            <div className="set-actions">
                <Action
                    size="sm"
                    color="blue"
                    icon="refresh-cw"
                    onClick={restart}
                    disabled={busy}
                >
                    {busy ? 'Working…' : 'Restart'}
                </Action>
                <Action
                    size="sm"
                    variant="ghost"
                    icon="key-round"
                    onClick={regeneratePin}
                    disabled={busy || !status?.running}
                >
                    Regenerate PIN
                </Action>
                <Action
                    size="sm"
                    variant="ghost"
                    icon="unplug"
                    onClick={revokeSessions}
                    disabled={busy || !status?.running}
                >
                    Disconnect all devices
                </Action>
                <Action
                    size="sm"
                    color={status?.locked ? 'red' : undefined}
                    variant={status?.locked ? 'default' : 'ghost'}
                    icon={status?.locked ? 'lock' : 'lock-open'}
                    onClick={toggleLock}
                    disabled={busy || !status?.running}
                    title="Freeze remote control without disconnecting paired devices"
                >
                    {status?.locked ? 'Unlock' : 'Lock'}
                </Action>
                {msg && (
                    <Text size="xs" className="text-zinc-500">
                        {msg}
                    </Text>
                )}
            </div>
        </SetSection>
    );
}

/**
 * Settings → Devices. The host-side roster of devices that have PAIRED with this
 * Genie over Work Mode (the mobile / remote sessions in main/mobile/auth.ts).
 * Distinct from the Work Mode card (which does the pairing): this is the standing
 * list, with a per-device Unpair and a Disconnect-all. Tokens never reach here —
 * each row carries only a non-secret roster id + label + ip + paired time.
 */
function DevicesSection() {
    const [devices, setDevices] = useState<MobileDevice[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const refresh = async () => {
        try {
            setDevices(await api().mobile.sessions());
        } catch {
            setDevices([]);
        }
    };
    useEffect(() => {
        void refresh();
    }, []);

    const unpair = async (id: string) => {
        setBusy(id);
        try {
            await api().mobile.revokeSession(id);
            await refresh();
        } finally {
            setBusy(null);
        }
    };
    const disconnectAll = async () => {
        setBusy('__all__');
        try {
            await api().mobile.revokeSessions();
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    const count = devices?.length ?? 0;

    return (
        <SetSection
            title="Paired devices"
            desc="Phones and remotes that have paired with this Host over Work Mode"
            status={devices ? `${count} paired` : '—'}
            statusColor="var(--fg-3)"
            statusIcon="smartphone"
        >
            {devices === null ? (
                <SettingRow
                    label="Loading…"
                    keywords="devices paired loading mobile phone remote"
                >
                    <span />
                </SettingRow>
            ) : count === 0 ? (
                <SettingRow
                    label="No paired devices"
                    desc="Pair a phone from the Work Mode page (scan the QR or enter the PIN). Paired devices appear here, where you can unpair them."
                    keywords="devices paired none empty mobile phone remote pair unpair revoke"
                >
                    <span />
                </SettingRow>
            ) : (
                <>
                    {devices.map((d) => (
                        <SettingRow
                            key={d.id}
                            label={d.label || 'Device'}
                            desc={`${d.ip ? d.ip + ' · ' : ''}paired ${new Date(
                                d.createdAt,
                            ).toLocaleString()}`}
                            keywords={`device paired ${d.label} ${d.ip} mobile phone remote revoke unpair`}
                        >
                            <Action
                                size="sm"
                                variant="ghost"
                                color="rose"
                                icon="unplug"
                                disabled={busy !== null}
                                onClick={() => void unpair(d.id)}
                            >
                                {busy === d.id ? 'Unpairing…' : 'Unpair'}
                            </Action>
                        </SettingRow>
                    ))}
                    <div className="set-actions">
                        <Action
                            size="sm"
                            color="rose"
                            icon="unplug"
                            disabled={busy !== null}
                            onClick={() => void disconnectAll()}
                        >
                            {busy === '__all__' ? 'Disconnecting…' : 'Disconnect all'}
                        </Action>
                    </div>
                </>
            )}
        </SetSection>
    );
}

/** Click-to-copy chip for the mobile URL (mirrors GitHubConnect's CodeChip). */
function MobileCodeChip({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(code).then(
            () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            },
            () => {},
        );
    };
    return (
        <button
            type="button"
            className="gh-code"
            onClick={copy}
            title="Click to copy"
        >
            {code}
            <span className="gh-code-hint">{copied ? '✓ Copied' : 'Click to copy'}</span>
        </button>
    );
}

function UpdaterLogPanel({ log }: { log: string[] }) {
    const ref = React.useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [log.length]);
    return (
        <div
            ref={ref}
            style={{
                maxHeight: 240,
                overflowY: 'auto',
                padding: 10,
                borderRadius: 8,
                background: '#0b0b0f',
                color: '#d4d4d8',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
            }}
        >
            {log.join('\n')}
        </div>
    );
}
