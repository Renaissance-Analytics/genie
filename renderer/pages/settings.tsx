import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from 'react';
import {
    Action,
    Icon,
    Input,
    Select,
    Switch,
    Text,
} from '@particle-academy/react-fancy';
import {
    api,
    type McpServerState,
    type GenieHost,
    type MobileStatus,
    type MobileDevice,
    type Settings,
    type TailscaleStatus,
    type ShellDetection,
    type UpdaterConfig,
    type UpdaterStatus,
} from '../lib/genie';
import {
    NAV_GROUPS,
    filterNavGroups,
    isSectionVisible,
    isRestrictedSettings,
    defaultSection,
    type SectionId,
} from '../lib/settings-nav';

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
    const [cliShipped, setCliShipped] = useState<boolean | null>(null);
    const [cliBusy, setCliBusy] = useState(false);
    const [cliMsg, setCliMsg] = useState<string | null>(null);
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
            const info = await api().cli.info().catch(() => ({ shipped: false }));
            setCliShipped(info.shipped);
        })();
    }, []);

    const patch = (p: Partial<Settings>) => setS((cur) => (cur ? { ...cur, ...p } : cur));

    const save = async () => {
        if (!s) return;
        setSaving(true);
        try {
            await api().settings.set(s);
            setSavedAt(Date.now());
            setTimeout(() => setSavedAt(null), 1800);
        } finally {
            setSaving(false);
        }
    };

    const pickPrimary = async () => {
        const p = await api().settings.chooseFolder('Choose primary workspace folder');
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
                                    const p = await api().settings.chooseFile(
                                        'Choose shell executable',
                                    );
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
                    desc="On by default. Runs terminals in a detached background process so dev servers, shells, and the agents running in them survive a full quit of Genie and reattach on next launch. Falls back to in-process terminals if the background process can't start."
                    keywords="detached terminals keep running quit background survive reattach dev server"
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

            <SetSection title="Tools" desc="The bundled tynn-cli toolkit in Genie terminals">
                <SettingRow
                    label="Make tynn-cli tools available in terminals"
                    desc={
                        <>
                            Prepends the bundled toolkit (<code>resetme</code>,{' '}
                            <code>reload</code>, <code>puse</code>, <code>sandbox</code>,
                            …) to each terminal&apos;s PATH and injects{' '}
                            <code>GENIE_WORKSPACE</code> / <code>GENIE_ENVELOPE_ROOT</code>{' '}
                            / <code>GENIE_REPO</code>. Bash-family shells only (Git Bash
                            on Windows).
                            {cliShipped === false && (
                                <>
                                    {' '}
                                    <strong>Not bundled in this build.</strong>
                                </>
                            )}
                        </>
                    }
                    keywords="cli tools tynn-cli resetme reload puse sandbox path terminal toolkit bundled"
                >
                    <Switch
                        checked={s.cli_tools_in_terminals !== 'off'}
                        onCheckedChange={(on: boolean) =>
                            patch({ cli_tools_in_terminals: on ? 'on' : 'off' })
                        }
                    />
                </SettingRow>

                <SettingRow
                    label="Install system-wide"
                    desc={
                        <>
                            Copies the toolkit to <code>~/.genie/tynn-cli</code> and adds
                            it to your <code>~/.bashrc</code> — so <code>resetme</code>{' '}
                            works in any terminal, not just Genie&apos;s.
                        </>
                    }
                    keywords="install system-wide cli tools bashrc global terminal"
                    grow
                >
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            flexWrap: 'wrap',
                            justifyContent: 'flex-end',
                        }}
                    >
                        {cliMsg && (
                            <Text size="xs" className="text-zinc-500">
                                {cliMsg}
                            </Text>
                        )}
                        <Action
                            variant="ghost"
                            icon="download"
                            disabled={cliBusy || cliShipped === false}
                            onClick={async () => {
                                setCliBusy(true);
                                setCliMsg(null);
                                try {
                                    const r = await api().cli.install();
                                    setCliMsg(
                                        r.ok
                                            ? 'Installed system-wide. Open a new Git Bash session to use the tools everywhere.'
                                            : `Install failed: ${r.output}`,
                                    );
                                } finally {
                                    setCliBusy(false);
                                }
                            }}
                        >
                            {cliBusy ? 'Installing…' : 'Install system-wide…'}
                        </Action>
                    </div>
                </SettingRow>
            </SetSection>

                            </SearchGroup>
                        )}
                        {show('workspaces') && (
                            <SearchGroup label="Workspaces" searching={searching}>

            <SetSection title="Defaults" desc="Applied to newly-created workspaces">
                <SettingRow
                    label="Max views"
                    desc="Maximum panels visible at once per workspace. Reaching the limit disables the Add Terminal / Add Editor buttons until you raise it or close a view."
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

            {/* Ai.System injects into every workspace's AGENTS.md on THIS machine —
                a host/workspace config, hidden in a remote window. */}
            {!restricted && (
                <SetSection title="Ai.System" desc="Instructions Genie injects into every workspace's AGENTS.md">
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
            )}

                            </SearchGroup>
                        )}
                        {show('agent-mcp') && (
                            <SearchGroup label="Agent MCP" searching={searching}>

            <AgentMcpSection
                port={s.mcp_port ?? '51717'}
                onPortChange={(v) => patch({ mcp_port: v })}
                syncClaude={s.mcp_sync_claude !== 'off'}
                syncCursor={s.mcp_sync_cursor !== 'off'}
                syncAgents={s.mcp_sync_agents !== 'off'}
                onSyncChange={(target, on) =>
                    patch({ [`mcp_sync_${target}`]: on ? 'on' : 'off' })
                }
            />

                            </SearchGroup>
                        )}
                        {show('mobile') && (
                            <SearchGroup label="Work Mode" searching={searching}>

            <WorkModeModeCard
                mode={s.work_mode ?? 'host'}
                onModeChange={(m) => patch({ work_mode: m })}
            />
            <TailscaleSection />
            {(s.work_mode ?? 'host') === 'host' ? (
                <MobileSection
                    enabled={s.mobile_enabled === 'on'}
                    onEnabledChange={(on) => patch({ mobile_enabled: on ? 'on' : 'off' })}
                    port={s.mobile_port ?? '51718'}
                    onPortChange={(v) => patch({ mobile_port: v })}
                    persistSettings={save}
                />
            ) : (
                <RemoteHostCard />
            )}

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
 * A settings section — a slim heading (+ optional one-line description and a
 * right-aligned status pill) over a stack of dense rows. Replaces the old
 * heavy padded <Card> per section.
 */
function SetSection({
    title,
    desc,
    status,
    statusColor,
    statusIcon,
    children,
}: {
    title: string;
    desc?: string;
    status?: ReactNode;
    statusColor?: string;
    statusIcon?: string;
    children: ReactNode;
}) {
    return (
        <section className="set-section">
            <div className="set-section-head">
                <h2>{title}</h2>
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
        const p = await api().settings.chooseFile('Choose a sound file');
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
                        Your GitHub session has expired, so Genie can't reach
                        GitHub right now — that's why the install list and
                        IssueWatch may look empty. Reconnect to restore access
                        (your installs on GitHub are untouched).
                    </Text>
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
    port,
    onPortChange,
    syncClaude,
    syncCursor,
    syncAgents,
    onSyncChange,
}: {
    port: string;
    onPortChange: (v: string) => void;
    syncClaude: boolean;
    syncCursor: boolean;
    syncAgents: boolean;
    onSyncChange: (target: 'claude' | 'cursor' | 'agents', on: boolean) => void;
}) {
    const [state, setState] = useState<McpServerState | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        try {
            setState(await api().mcp.status());
        } catch {
            setState(null);
        }
    };

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            status={statusLabel}
            statusColor={statusColor}
            statusIcon={
                state?.conflict ? 'alert-triangle' : state?.running ? 'check' : 'circle'
            }
        >
            {state?.conflict && (
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
                grow
            >
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
                    placeholder="51717"
                />
            </SettingRow>

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

            <SetSubhead>Config sync</SetSubhead>
            <Text size="xs" className="text-zinc-500" style={{ marginBottom: 2 }}>
                Keep the Genie endpoint in these agent configs. Unchecking one leaves
                that file alone — your manual edits stick.
            </Text>
            {([
                ['claude', syncClaude, 'Claude', '.mcp.json'],
                ['cursor', syncCursor, 'Cursor', '.cursor/mcp.json'],
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
        </SetSection>
    );
}

/**
 * Settings → Work Mode → Mode. Host (default) vs Remote. Host means this Genie
 * runs your projects and lets phones / (Phase 2) other Genies connect to it;
 * Remote means this Genie connects out to a host Genie over the tailnet. Phase 1
 * persists the choice + drives the section below it; the remote client is Phase 2.
 */
function WorkModeModeCard({
    mode,
    onModeChange,
}: {
    mode: 'host' | 'remote';
    onModeChange: (m: 'host' | 'remote') => void;
}) {
    return (
        <SetSection title="Mode" desc="How this Genie participates over the tailnet">
            <SettingRow
                label="Participation mode"
                keywords="host remote tailnet participate work mode"
                desc={
                    mode === 'host'
                        ? 'Host — this Genie runs your projects and lets your phone (and, soon, other Genies) connect to it over Tailscale.'
                        : 'Remote — connect this Genie to a host Genie over Tailscale and drive it from here. Desktop-to-desktop control arrives in Phase 2; Tailscale + discovery are set up below.'
                }
            >
                <Segmented
                    value={mode}
                    onChange={onModeChange}
                    options={[
                        { value: 'host', label: 'Host' },
                        { value: 'remote', label: 'Remote' },
                    ]}
                />
            </SettingRow>
        </SetSection>
    );
}

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
        host: { ip: string; port: number; hostname: string },
        pin?: string,
    ) => {
        const key = `${host.ip}:${host.port}`;
        setBusy(key);
        setMsg(null);
        try {
            // Open the host in its OWN native Floor window (the local window
            // stays local). No PIN → reconnect with the remembered token; the
            // host answers needsPin only for a first-time pair (or a dead token).
            const r = await api().remote.open(host, pin?.trim() || undefined);
            if (r.ok) {
                setPinNeeded((p) => ({ ...p, [key]: false }));
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
    port,
    onPortChange,
    persistSettings,
}: {
    enabled: boolean;
    onEnabledChange: (on: boolean) => void;
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
            title="Mobile remote control"
            desc="Let your phone — or another Genie in remote mode — drive this Genie over Tailscale"
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
                label="Enable mobile remote control"
                keywords="mobile remote control phone enable server pairing tailscale"
                desc="Off by default. Starts a small web server on your Tailscale interface so a paired phone can reach this desktop. Works only over your tailnet; pairing is confirmed here, then the device can drive terminals until you Disconnect or Lock."
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
