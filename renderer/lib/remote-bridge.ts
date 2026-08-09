import type {
    GenieApi,
    Settings,
    WorkspaceRow,
    TerminalSpec,
    ProcessListItem,
    ProcessStatus,
    TreeNodeData,
    GitStatusMap,
    WatchTypeCounts,
    WatchRepoView,
    WatchFeedItem,
    WorkspaceWatchStatus,
    AgentType,
    AgentInboxAgentInfo,
    AgentInboxChannelInfo,
    AgentInboxDmThreadInfo,
    AgentInboxMessage,
    ScheduleInfo,
    PendingQuestionSpec,
    ManageSiteRequest,
    ManageSiteResult,
    ManageServiceResult,
    DevRuntimeInfo,
} from './genie';
import { isHostSourcedSettingKey } from './settings-nav';
// The PURE inbox grouping main uses (electron-free by construction — see the
// module header). Shared rather than re-implemented so a host-sourced group is
// keyed, counted and ordered EXACTLY like a local one.
import { groupPendingByWorkspace, pendingCount } from '../../main/ask/inbox';

/**
 * The remote-desktop bridge — a `GenieApi` backed by a HOST Genie over Tailscale.
 *
 * In remote mode `api()` returns this instead of `window.genie`. It SPREADS the
 * local bridge (so everything not overridden — the `api().on*` event subscriptions,
 * GitHub, settings, the account/Tynn surface, the LOCAL updater — stays local) and
 * re-points the data-driving namespaces at the host through the local-main proxy
 * (`local.remote.request` for REST, `local.remote.terminal*` for pty I/O). The host
 * serves its OWN rich shapes (`/api/desktop/*`, `/api/files/*`), so these are thin
 * pass-throughs. The session token lives in main; the renderer never sees it. Live
 * events arrive on the SAME local IPC channels (the main re-emits the host's
 * `/ws/events` + `/ws/term`), so the desktop's subscriptions need no change.
 *
 * KNOWN GAP (follow-on): spawning a BRAND-NEW terminal remotely needs a host
 * `/api/desktop/terminal-open` (spec-id-keyed pty spawn). Today `terminal.create`
 * attaches the viewer to an EXISTING host pty (the common case — driving the
 * agents already running on the host).
 */
export function makeRemoteBridge(local: GenieApi): GenieApi {
    const req = local.remote.request;
    const r = local.remote;

    // Live "view-only" flag: when the host TAKES CONTROL (its kill-switch), this
    // driver must stop writing to the host pty. Main already drops such keystrokes
    // authoritatively, but gating here too avoids a pointless round-trip and keeps
    // the client's behaviour consistent with the banner it shows. Seeded async then
    // kept live via the host's `control:changed` push (bridge lives for the window).
    let controlLocked = false;
    void local.remote
        .controlState()
        .then((s) => {
            controlLocked = s.locked;
        })
        .catch(() => {});
    local.remote.onControl((s) => {
        controlLocked = s.locked;
    });

    // The host's rail — full WorkspaceRow pass-through.
    const workspaces: GenieApi['workspaces'] = {
        ...local.workspaces,
        list: async () =>
            ((await req('/api/desktop/workspaces')) as { workspaces: WorkspaceRow[] }).workspaces,
    };

    // Host-sourced IssueWatch: the rail pill / flyout / badge reflect the HOST's
    // repos + counts (via the HOST's GitHub token) — the host serves these at
    // /api/desktop/issue-watch/*. The live `on.issueWatchUpdate` push arrives on
    // the SAME local channel (main re-emits the host's /ws/events issue-watch:update),
    // so the spread's `on.*` subscriptions need no change.
    const wsQ = (id: string) => `?workspaceId=${encodeURIComponent(id)}`;
    const issueWatch: GenieApi['issueWatch'] = {
        counts: async () =>
            ((await req('/api/desktop/issue-watch/counts')) as {
                counts: Record<string, WatchTypeCounts>;
            }).counts,
        repos: async (workspaceId) =>
            ((await req(`/api/desktop/issue-watch/repos${wsQ(workspaceId)}`)) as {
                repos: WatchRepoView[];
            }).repos,
        feed: async (workspaceId) =>
            ((await req(`/api/desktop/issue-watch/feed${wsQ(workspaceId)}`)) as {
                feed: WatchFeedItem[];
            }).feed,
        status: async (workspaceId) =>
            ((await req(`/api/desktop/issue-watch/status${wsQ(workspaceId)}`)) as {
                status: WorkspaceWatchStatus;
            }).status,
        markSeen: async (workspaceId) =>
            (await req('/api/desktop/issue-watch/mark-seen', {
                method: 'POST',
                json: { workspaceId },
            })) as { ok: boolean },
        set: async (workspaceId, owner, repo, enabled) =>
            (await req('/api/desktop/issue-watch/set', {
                method: 'POST',
                json: { workspaceId, owner, repo, enabled },
            })) as { ok: boolean },
    };

    // A `.gen` site belongs to the machine this window DRIVES — it is a
    // container the HOST's Dev Server is serving — so the listing is
    // HOST-SOURCED, exactly like the IssueWatch rail. The bearer token stays in
    // main. There is no write here: creating a site is `devServer.site`, which
    // is local-only until the host grows `/api/dev-server/*` (P5).
    const sites: GenieApi['sites'] = {
        // The header `.gen` popover is HOST-SOURCED when remote — the enabled sites
        // belong to the machine THIS window drives, exactly like files / processes /
        // IssueWatch. Fetch the host's aggregated enabled-`.gen` snapshot over the
        // bridge (`/api/sites/enabled`) and shape it into the popover payload.
        // (`GenSitesAll.local` means "the sites of the machine this window
        // represents", so host sites go there — the popover renders `data.local`.)
        // [] on a host that predates the endpoint or is locked.
        all: async () => {
            try {
                const hostSites =
                    ((await req('/api/sites/enabled')) as {
                        sites?: Array<{ genName: string; hostname: string }>;
                    }).sites ?? [];
                return {
                    local: hostSites.map((s) => ({ genName: s.genName, hostname: s.hostname })),
                    hosts: [],
                };
            } catch {
                return { local: [], hosts: [] };
            }
        },
        // `open` MUST stay on the LOCAL preload: it spins up a Testing Browser
        // WINDOW on THIS machine (main can't open a window on the host) and resolves
        // this host window's connKey → the host's carrier, so the `.gen` site loads
        // over the tunnel. Lazy wrapper so bridge construction never touches
        // `local.sites`.
        open: (genName) => local.sites.open(genName),
    };

    /**
     * The container DEV SERVER (#234) — HOST-SOURCED in a remote window.
     *
     * The sites + services a host window manages are hosted on the HOST (a site's
     * container mounts the host's workspace; a service is state that lives there),
     * so `site` / `service` / `runtimeStatus` / `repos` route through the bridge to
     * the host's `/api/desktop/dev-server/*`, running the SAME `runManageSite` /
     * `runManageService` an agent reaches — the Site Manager drives the HOST, not
     * the client. `sites` above only READS + OPENS what this created.
     *
     * The one action that STAYS local is `open`: opening a `.gen` site is a Testing
     * Browser WINDOW on THIS client pointed at the host's carrier (main can't open a
     * window on the host), so the bridge resolves the site's genName from the host
     * and then hands off to the local carrier — exactly the `.gen` popover path.
     */
    const hostSite = (workspaceId: string, siteReq: ManageSiteRequest) =>
        req('/api/desktop/dev-server/site', {
            method: 'POST',
            json: { workspaceId, req: siteReq },
        }) as Promise<ManageSiteResult>;
    const devServer: GenieApi['devServer'] = {
        site: async (workspaceId, siteReq) => {
            if (siteReq.action === 'open') {
                // Resolve genName from the host, then open on THIS client (the same
                // local carrier the `.gen` popover uses) — never a browser on the host.
                const listed = await hostSite(workspaceId, { action: 'list' });
                const target = listed.sites?.find((s) => s.id === siteReq.id);
                if (!target?.genName) {
                    return { ...listed, ok: false, error: 'That site no longer exists.' };
                }
                const opened = await local.sites.open(target.genName);
                return {
                    ...listed,
                    ok: opened.ok,
                    ...(opened.error ? { error: opened.error } : {}),
                    ...(siteReq.id ? { affectedId: siteReq.id } : {}),
                };
            }
            return hostSite(workspaceId, siteReq);
        },
        service: async (workspaceId, serviceReq) =>
            (await req('/api/desktop/dev-server/service', {
                method: 'POST',
                json: { workspaceId, req: serviceReq },
            })) as ManageServiceResult,
        runtimeStatus: async () =>
            ((await req('/api/desktop/dev-server/runtime')) as { runtime: DevRuntimeInfo }).runtime,
        repos: async (workspaceId) =>
            ((await req('/api/desktop/dev-server/repos', {
                method: 'POST',
                json: { workspaceId },
            })) as { repos: string[] }).repos,
        // The MACHINE-level Workstation Dev Server (the SETTINGS surface, not the
        // per-workspace Site Manager) stays inert in a remote window: it would
        // describe the CLIENT's Docker, images and engines under a window driving
        // another machine. The panel this bridge makes host-capable uses site /
        // service / runtimeStatus / repos above; the machine-level `inventory`
        // action of `service` already carries the host's engines when needed.
        workstation: async () => ({
            runtime: { kind: 'none', probes: [] },
            devBase: { image: '', installed: false, toolchain: [] },
            engines: [],
        }),
        engine: async () => ({
            ok: false,
            error: 'Service engines are managed on the machine itself.',
        }),
    };

    // The host's terminal-spec model (the grid's backbone) — pass-through.
    const terminalSpec: GenieApi['terminalSpec'] = {
        list: async () =>
            ((await req('/api/desktop/terminal-specs')) as { specs: TerminalSpec[] }).specs,
        get: async (id) =>
            (
                (await req('/api/desktop/terminal-spec/get', { method: 'POST', json: { id } })) as {
                    spec: TerminalSpec | null;
                }
            ).spec,
        create: async (input) =>
            (
                (await req('/api/desktop/terminal-spec/create', {
                    method: 'POST',
                    json: { input },
                })) as { spec: TerminalSpec }
            ).spec,
        update: async (id, patch) =>
            (
                (await req('/api/desktop/terminal-spec/update', {
                    method: 'POST',
                    json: { id, patch },
                })) as { spec: TerminalSpec | null }
            ).spec,
        remove: async (id) =>
            (
                (await req('/api/desktop/terminal-spec/remove', { method: 'POST', json: { id } })) as {
                    ok: boolean;
                }
            ).ok,
        touch: async (id) =>
            (await req('/api/desktop/terminal-spec/touch', {
                method: 'POST',
                json: { id },
            })) as { ok: boolean },
        // Panel order lives on the HOST's terminal_specs rows (WORK/CONTENT
        // state), so a remote window's drag-reorder writes through the bridge —
        // same as create/update/remove above.
        reorder: async (ids) =>
            (await req('/api/desktop/terminal-spec/reorder', {
                method: 'POST',
                json: { ids },
            })) as { ok: boolean },
        // A specialized (AI-TUI) terminal is spawned on the machine that owns the
        // pty + the AgentInbox broker — the HOST — so this routes through the bridge
        // like `create`. (AgentInbox itself is local-only in v1, but creating an
        // agent terminal in a host window must target the host, not the client.)
        createAgent: async (input) =>
            (await req('/api/desktop/terminal-spec/create-agent', {
                method: 'POST',
                json: { input },
            })) as { ok: boolean; spec?: TerminalSpec; error?: string },
        // Restart targets the HOST's agent (the terminal lives there), like create.
        restartAgent: async (id) =>
            (await req('/api/desktop/terminal-spec/restart-agent', {
                method: 'POST',
                json: { id },
            })) as
                | { ok: true; oldId: string; newId: string; agent: AgentType; command: string }
                | { ok: false; error: string },
    };

    // The host's workspace files (keyed by the WorkspaceRow.path the desktop holds).
    const files: GenieApi['files'] = {
        ...local.files,
        listTree: async (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string; system?: boolean },
        ) => {
            // System-mode = the FileBrowser host-path picker: browse the HOST's whole
            // filesystem (drive roots / absolute paths), NOT a workspace — so it goes
            // to the dedicated, non-workspace-scoped host route (owner-approved).
            if (opts?.system) {
                return (
                    (await req('/api/files/system-tree', {
                        method: 'POST',
                        json: { root: opts.root, maxDepth: opts.maxDepth },
                    })) as { tree: TreeNodeData[] }
                ).tree;
            }
            return (
                (await req('/api/files/tree', {
                    method: 'POST',
                    json: { workspacePath, root: opts?.root },
                })) as { tree: TreeNodeData[] }
            ).tree;
        },
        read: async (workspacePath: string, relPath: string) =>
            (await req('/api/files/read', {
                method: 'POST',
                json: { workspacePath, relPath },
            })) as { content: string; truncated: boolean },
        write: async (workspacePath: string, relPath: string, content: string) =>
            (await req('/api/files/write', {
                method: 'POST',
                json: { workspacePath, relPath, content },
            })) as { ok: boolean },
        createFile: async (workspacePath: string, relPath: string) =>
            (await req('/api/files/create-file', {
                method: 'POST',
                json: { workspacePath, relPath },
            })) as { ok: boolean },
        createFolder: async (workspacePath: string, relPath: string) =>
            (await req('/api/files/create-folder', {
                method: 'POST',
                json: { workspacePath, relPath },
            })) as { ok: boolean },
        rename: async (workspacePath: string, fromRel: string, toRel: string) =>
            (await req('/api/files/rename', {
                method: 'POST',
                json: { workspacePath, fromRel, toRel },
            })) as { ok: boolean },
        duplicate: async (workspacePath: string, relPath: string) =>
            (await req('/api/files/duplicate', {
                method: 'POST',
                json: { workspacePath, relPath },
            })) as { ok: boolean; relPath: string },
        // External OS-file drop in a HOST window. The FILE lives on the CLIENT's
        // disk (`srcAbs` is a client-local path, resolved by the LOCAL pathForFile,
        // which stays spread-from-local), but the dest workspace is on the HOST.
        // So read the bytes LOCALLY here, then POST them to the host to write into
        // the dest folder there. (`system` is meaningless remotely — the host never
        // serves the System workspace.) `pathForFile` is intentionally NOT
        // overridden: it must resolve the CLIENT's local path so this read works.
        importExternal: async (
            workspacePath: string,
            srcAbs: string,
            destFolderRel: string,
        ) => {
            const { name, base64 } = await local.files.readExternalBytes(srcAbs);
            return (await req('/api/files/import-external', {
                method: 'POST',
                json: {
                    workspacePath,
                    destFolder: destFolderRel,
                    filename: name,
                    dataBase64: base64,
                },
            })) as { ok: boolean; relPath: string };
        },
        delete: async (workspacePath: string, relPath: string) =>
            (await req('/api/files/delete', {
                method: 'POST',
                json: { workspacePath, relPath },
            })) as { ok: boolean },
        gitStatus: async (workspacePath: string, opts?: { ignored?: boolean }) =>
            (
                (await req('/api/files/git-status', {
                    method: 'POST',
                    json: { workspacePath, ignored: opts?.ignored },
                })) as { map: GitStatusMap }
            ).map,
    };

    // Clipboard: `read`/`readImage` stay LOCAL (spread from local) — the copied
    // image lives on the machine the user is on, so a host window still reads the
    // LOCAL clipboard, exactly like text paste already does. Only `writeImage` is
    // re-pointed to the HOST over the authed bridge, so a synced image lands where
    // the CLI (running on the host) will read it — the HOST OS clipboard on
    // Windows/macOS, or a HOST temp file whose `path` comes back on Linux (the
    // client then pastes the path, since the CLI can't read a Linux clipboard image).
    const clipboard: GenieApi['clipboard'] = {
        ...local.clipboard,
        writeImage: async (dataBase64: string) =>
            (await req('/api/clipboard/image', {
                method: 'POST',
                json: { dataBase64 },
            })) as { ok: boolean; supported: boolean; path?: string },
    };

    // The host's background processes.
    const process: GenieApi['process'] = {
        list: async () =>
            ((await req('/api/processes')) as { processes: ProcessListItem[] }).processes,
        start: async (id) => {
            await req(`/api/process/${encodeURIComponent(id)}/start`, { method: 'POST' });
            return { ok: true };
        },
        stop: async (id) => {
            await req(`/api/process/${encodeURIComponent(id)}/stop`, { method: 'POST' });
            return { ok: true };
        },
        restart: async (id) => {
            await req(`/api/process/${encodeURIComponent(id)}/restart`, { method: 'POST' });
            return { ok: true };
        },
        statuses: async () => {
            const list = ((await req('/api/processes')) as { processes: ProcessListItem[] })
                .processes;
            const out: Record<string, ProcessStatus> = {};
            for (const p of list) out[p.id] = p.status as ProcessStatus;
            return out;
        },
        // No host log endpoint yet — the hover log is empty in remote mode, so
        // clearing it is a no-op (nothing is buffered on the client side).
        log: async () => '',
        clearLog: async () => ({ ok: true }),
    };

    // Scheduled tasks are HOST-owned work (the timers live on the host), so the
    // remote window reads them from the host rather than keeping any local state.
    const schedule: GenieApi['schedule'] = {
        info: async () =>
            ((await req('/api/schedules')) as { schedules: Record<string, ScheduleInfo> })
                .schedules,
        runNow: async (id) => {
            await req(`/api/process/${encodeURIComponent(id)}/run-now`, { method: 'POST' });
            return { ok: true };
        },
    };

    // xterm forwards the host app's mouse-tracking (CSI M / CSI < … M|m) as input
    // whenever the host program (tmux, vim, htop, `less -M`, …) turns mouse-
    // tracking mode on — which also makes xterm stop doing its OWN client-side
    // scrollback for wheel/trackpad ticks, since it assumes the program is
    // handling them. A remote session must never push CLICKS/DRAGS into the
    // host terminal (a remote viewer clicking something in the host's TUI would
    // be surprising and wrong) — but a wheel/trackpad SCROLL is exactly what the
    // remote user is asking for, and blocking it too (the original behaviour)
    // left remote scrolling completely dead any time mouse-tracking was on.
    //
    // SGR mouse reports (`CSI < Cb ; Cx ; Cy M|m` — what tmux/vim/htop send by
    // default; legacy X10 `CSI M...` 3-byte reports are rare in modern configs
    // and stay blocked below, unparsed) encode the button + modifiers in `Cb`:
    // base buttons are 0–3 (press/release), modifiers (shift/meta/ctrl) OR 4/8/16
    // on top, so the highest possible NON-wheel value is 3+4+8+16=31. The wheel/
    // tilt range starts at 64, so `Cb >= 64` is unambiguous — never a click or
    // drag, always a scroll tick — and safe to forward.
    const isBlockedMouseReport = (data: string): boolean => {
        if (/^\x1b\[M/.test(data)) return true; // legacy X10 — can't safely tell wheel from click here
        const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(data);
        if (!sgr) return false;
        return parseInt(sgr[1], 10) < 64; // < 64 ⇒ click/drag/release — block; ≥ 64 ⇒ wheel — forward
    };

    // Drive the host's pty-host terminals (data/exit arrive on the local channels).
    const terminal: GenieApi['terminal'] = {
        ...local.terminal,
        create: async (opts: {
            id: string;
            cwd: string;
            shell?: string;
            args?: string[];
            cols?: number;
            rows?: number;
            env?: Record<string, string>;
            workspaceId?: string;
        }) => {
            // SPAWN, then attach. A remote window owns its terminal id, but the host
            // had no way to spawn a pty for it — create only ATTACHED — so a fresh or
            // post-restart-dead panel fail-closed at the /ws/term gate and never
            // started. First spawn a plain, cwd-confined, served-gated pty for this id
            // (idempotent: a still-live id is a no-op reattach on the host)…
            // A host that PREDATES this endpoint (mid-rollout, or simply not upgraded
            // yet) 404s here — fall back to attach-only (the prior behavior) so a
            // version-skewed client is never WORSE than before, just un-fixed.
            let existing = true;
            try {
                const spawned = (await req('/api/desktop/terminal-open', {
                    method: 'POST',
                    json: {
                        id: opts.id,
                        workspaceId: opts.workspaceId,
                        cwd: opts.cwd,
                        shell: opts.shell,
                        args: opts.args,
                        // Spawn at OUR fitted grid. Terminal.tsx has already fitted by
                        // the time it calls create, so the pty starts the right width
                        // instead of at the engine's 80×24 default.
                        cols: opts.cols,
                        rows: opts.rows,
                    },
                })) as { existing?: boolean };
                if (typeof spawned?.existing === 'boolean') existing = spawned.existing;
            } catch {
                /* old host without /api/desktop/terminal-open — attach-only */
            }
            // …then open the relay term channel (workspace-tagged so a scoped grant
            // only reaches its own terminals; missing → host:all on the host side).
            // The attach itself replays scrollback (server-side catch-up), so return
            // '' here to avoid double-drawing — but surface the host's REAL `existing`
            // so Terminal.tsx frames a genuine cold spawn vs a warm reattach correctly.
            // Hand main our grid alongside the attach: the term socket is still
            // CONNECTING when this returns, so a resize sent immediately after would
            // be dropped on the floor. Main holds it and flushes on `open` (and
            // re-sends it after a reconnect), which is what makes the size stick.
            await r.terminalAttach(opts.id, opts.workspaceId, opts.cols, opts.rows);
            return { id: opts.id, pid: 0, shell: opts.shell ?? '', existing, scrollback: '' };
        },
        write: (id: string, data: string) => {
            // View-only (host has control): swallow the keystroke locally.
            if (controlLocked) return Promise.resolve(false);
            return r.terminalInput(id, isBlockedMouseReport(data) ? '' : data);
        },

        resize: (id: string, cols: number, rows: number) => r.terminalResize(id, cols, rows),
        detach: async (id: string) => (await r.terminalDetach(id)).ok,
        kill: async (id: string) =>
            ((await req(`/api/terminal/${encodeURIComponent(id)}/kill`, { method: 'POST' })) as {
                ok: boolean;
            }).ok,
        list: async () =>
            ((await req('/api/terminals')) as { terminals: Array<{ id: string }> }).terminals.map(
                (t) => ({ id: t.id, pid: 0, shell: '' }),
            ),
    };

    // Host-sourced WORKSPACE / AGENT-ENVIRONMENT settings. The agent runs on the
    // HOST, so the settings that govern how it runs there — the Ai.System
    // workspace-instructions injected into the host's AGENTS.md, the Agent-MCP config
    // the host binds + syncs into its workspaces, and the host terminal toolkit env —
    // are read from and written to the HOST (allow-listed by HOST_SOURCED_SETTINGS_KEYS,
    // enforced again server-side at /api/desktop/settings). Every OTHER key is a
    // per-device UI pref (theme, notifications, copy-paste, panel layout) and stays
    // CLIENT-LOCAL — the picker/file/sound/shell helpers spread from `local`.
    const settings: GenieApi['settings'] = {
        ...local.settings,
        get: async () => {
            const localS = await local.settings.get();
            try {
                const host = (
                    (await req('/api/desktop/settings')) as { settings: Partial<Settings> }
                ).settings;
                // Overlay the host's bucket-2 values on the client's own settings.
                return { ...localS, ...host };
            } catch {
                // Link blip — fall back to the local view so Settings still opens.
                return localS;
            }
        },
        set: async (patch: Partial<Settings>) => {
            // Split the patch: host-sourced keys → the HOST, everything else stays
            // client-local. settings.tsx saves the WHOLE object, so both halves are
            // usually present; each is routed to the right store (idempotent).
            const hostPatch: Record<string, unknown> = {};
            const localPatch: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(patch)) {
                (isHostSourcedSettingKey(k) ? hostPatch : localPatch)[k] = v;
            }
            const [hostSettings, localResult] = await Promise.all([
                // Resolve the host's current bucket-2 values: POST the change when
                // there is one, else a plain GET — so the returned Settings always
                // reflects the HOST for host keys, never the client's stale copy.
                (async (): Promise<Partial<Settings>> => {
                    try {
                        const r =
                            Object.keys(hostPatch).length > 0
                                ? await req('/api/desktop/settings', {
                                      method: 'POST',
                                      json: { patch: hostPatch },
                                  })
                                : await req('/api/desktop/settings');
                        return (r as { settings: Partial<Settings> }).settings;
                    } catch {
                        return {};
                    }
                })(),
                Object.keys(localPatch).length > 0
                    ? local.settings.set(localPatch as Partial<Settings>)
                    : local.settings.get(),
            ]);
            return { ...localResult, ...hostSettings };
        },
    };

    // Host-sourced AgentInbox. The agents + the broker live on the HOST, so a
    // remote window's AgentInboxFlyout must read the HOST broker's directory /
    // channels / DM threads / history and post to IT — not the client's own empty
    // local broker (which is why remote showed "no agents"). Live presence/message
    // updates arrive on the SAME local channels (main re-emits the host's
    // /ws/events `agentInbox:presence` / `agentInbox:message` — see PASSTHROUGH_EVENTS),
    // so the spread's `on.agentInbox*` subscriptions need no change. `updateChannel`
    // (the "Agent settings…" edit) ALSO targets the host — the agent + its spec live
    // there — so a remote window edits the host agent's purpose/scope/wake-on-DM
    // through the host route, not the client's own empty broker.
    const agentInbox: GenieApi['agentInbox'] = {
        ...local.agentInbox,
        directory: async () =>
            (await req('/api/desktop/agentinbox/directory')) as { agents: AgentInboxAgentInfo[] },
        channels: async () =>
            (await req('/api/desktop/agentinbox/channels')) as { channels: AgentInboxChannelInfo[] },
        dmThreads: async () =>
            (await req('/api/desktop/agentinbox/dm-threads')) as { threads: AgentInboxDmThreadInfo[] },
        history: async (opts) =>
            (await req('/api/desktop/agentinbox/history', { method: 'POST', json: opts })) as {
                messages: AgentInboxMessage[];
            },
        post: async (input) =>
            (await req('/api/desktop/agentinbox/post', { method: 'POST', json: input })) as {
                ok: boolean;
                error?: string;
            },
        // Attachment BYTES come from the HOST's store (that is where messages and
        // their blobs live) and land on the CLIENT, which then saves the file —
        // the mirror of the client-side read behind an external file drop, and the
        // reason a remote human gets the download on their own machine.
        attachmentBytes: async (attachmentId) =>
            (await req('/api/desktop/agentinbox/attachment', {
                method: 'POST',
                json: { attachmentId },
            })) as {
                ok: boolean;
                error?: string;
                filename?: string;
                mime?: string;
                bytes?: number;
                base64?: string;
            },
        updateChannel: async (specId, patch) =>
            (await req('/api/desktop/agentinbox/update-channel', {
                method: 'POST',
                json: { specId, patch },
            })) as { ok: boolean; error?: string },
        // The badge must reflect the HOST's agents (they are the ones lagging), so
        // the seed reads the host too; the live level rides `agentinbox:lag`.
        lag: async () => (await req('/api/desktop/agentinbox/lag')) as { count: number },
        // Wiping a conversation targets the HOST too — the durable log lives in the
        // host's genie.db, so clearing the client's own empty broker would silently
        // do nothing while the host kept the history. The `agentinbox:cleared` push
        // rides /ws/events → PASSTHROUGH_EVENTS back to this window.
        clearChannel: async (channelKey) =>
            (await req('/api/desktop/agentinbox/clear', {
                method: 'POST',
                json: { channelKey },
            })) as { ok: boolean; cleared: number },
        deleteThread: async (pairKey) =>
            (await req('/api/desktop/agentinbox/delete-thread', {
                method: 'POST',
                json: { pairKey },
            })) as { ok: boolean; cleared: number },
        wipeMany: async (input) =>
            (await req('/api/desktop/agentinbox/wipe-many', {
                method: 'POST',
                json: input,
            })) as { ok: boolean; cleared: number; channels: number; threads: number },
    };

    // Host-sourced PendingQuestions. The agents that ASK live on the HOST, so its
    // pending questions are the ones a host window must show — the client's own
    // queue is empty (which is why the top-bar QUESTIONS badge sat at 0 on a
    // host-bound window: it seeded from `groups.length` of the LOCAL list). Same
    // treatment as the AgentInbox lag badge above: read the host, render the host.
    //
    // The read hits the LONG-STANDING `/api/questions` (not a new /api/desktop/*
    // route) so this works against hosts already deployed on older builds, and the
    // flat list is grouped HERE with the very same pure grouping main uses — one
    // implementation, so a host group and a local group key/sort identically.
    //
    // Answering targets the host too: the ids in that list are the HOST's, and
    // `answerPendingQuestion` on the client would find no such question and
    // silently do nothing. The host applies its own kill-switch to the POST.
    // Live refresh needs no work here — main re-emits the host's questions:changed
    // onto this window's local channel (PASSTHROUGH_EVENTS), including for hosts
    // old enough to only push the singular question:changed.
    const questions: GenieApi['questions'] = {
        ...local.questions,
        list: async () => {
            const pending =
                ((await req('/api/questions')) as { questions?: PendingQuestionSpec[] })
                    ?.questions ?? [];
            return { groups: groupPendingByWorkspace(pending), count: pendingCount(pending) };
        },
        answer: async (id, answers) =>
            (
                (await req(`/api/questions/${encodeURIComponent(id)}/answer`, {
                    method: 'POST',
                    json: { answers },
                })) as { ok: boolean; answered?: boolean }
            ).answered === true,
    };

    // Host-sourced Tynn provisioning. The workspace-settings "Tynn agent" panel writes
    // the MCP agent token into a workspace's .mcp.json — but the workspace files, the
    // running agent, and the user's Tynn session all live on the HOST. So a remote
    // window reads its projects / link-status / tynn-host and performs link / provision
    // / unlink AGAINST THE HOST over the bridge; running them locally would mint against
    // the wrong session and write to a client path that doesn't exist (which is why
    // remote "Link & provision" did nothing). Every OTHER tynn.* method (inbox,
    // capture-wish, create-project, ops-*) stays spread-from-local. Token stays in main.
    const tynn: GenieApi['tynn'] = {
        ...local.tynn,
        projects: async () =>
            (
                (await req('/api/desktop/tynn/projects')) as {
                    projects: Awaited<ReturnType<GenieApi['tynn']['projects']>>;
                }
            ).projects,
        provisionStatus: async (workspacePath) =>
            (await req('/api/desktop/tynn/status', {
                method: 'POST',
                json: { workspacePath },
            })) as Awaited<ReturnType<GenieApi['tynn']['provisionStatus']>>,
        link: async (workspacePath, link) =>
            (await req('/api/desktop/tynn/link', {
                method: 'POST',
                json: { workspacePath, link },
            })) as { ok: boolean },
        unlink: async (workspacePath) =>
            (await req('/api/desktop/tynn/unlink', {
                method: 'POST',
                json: { workspacePath },
            })) as { ok: boolean },
        provision: async (workspacePath, force) =>
            (await req('/api/desktop/tynn/provision', {
                method: 'POST',
                json: { workspacePath, force },
            })) as Awaited<ReturnType<GenieApi['tynn']['provision']>>,
    };

    // The Tynn instance base the HOST is signed into — the link block the host writes
    // must reference the host's Tynn host, so a remote window reads it from the host.
    const tynnHost: GenieApi['tynnHost'] = {
        ...local.tynnHost,
        get: async () => ((await req('/api/desktop/tynn/host')) as { host: string }).host,
    };

    // genie#54 — the "Workspace docs" panel resolves AGENTS.md / CLAUDE.md, which live
    // on the HOST. Left on the client, its win32 `path.*` mangled the host's POSIX root
    // (`/data/workspaces/…` → `C:\data\…`) so stat/read ENOENT'd. Route doc-health +
    // repair to the host so it resolves with its OWN path. status/restart/pushStatus
    // stay client-local — they concern the client's MCP server, not host workspace files.
    const mcp: GenieApi['mcp'] = {
        ...local.mcp,
        docHealth: async (workspaceId) =>
            (
                (await req('/api/desktop/docs/health', {
                    method: 'POST',
                    json: { workspaceId },
                })) as { health: Awaited<ReturnType<GenieApi['mcp']['docHealth']>> }
            ).health,
        repairDocs: async (workspaceId) =>
            (
                (await req('/api/desktop/docs/repair', {
                    method: 'POST',
                    json: { workspaceId },
                })) as { result: Awaited<ReturnType<GenieApi['mcp']['repairDocs']>> }
            ).result,
    };

    // The CLIENT/HOST seam for plugins (main/plugins/side.ts). Plugin ABILITIES —
    // MCP tools + recipes — run on the HOST, so a remote window's Settings → Plugins
    // panel must view and manage the HOST's plugin registry, not the empty
    // client-side one it renders from (genie#101). Every host-targeting MANAGEMENT
    // verb therefore dials the host's `/api/desktop/plugins/*` route, which runs the
    // SAME `main/plugins/manage.ts` operations the local `plugins:*` IPC does — one
    // implementation, so the two paths can't diverge. Reads are auth-only; writes are
    // kill-switch-gated + audited host-side.
    //
    // What STAYS client-local (spread from `local.plugins`):
    //   - `editorFor` (which client editor claims a file type), the editor component
    //     itself, and `convertDocument` (the .docx↔markdown conversion) — a document
    //     editor is a CLIENT surface;
    //   - `installFolder` — its native folder picker + chosen path live on the
    //     machine the user is sitting at, with no headless-host equivalent.
    //
    // genie#54 — the binary editor I/O (`editorRead`/`editorWrite`) is bridged too,
    // but for a NARROWER reason: only the document's BYTES live on the host, which
    // authorises that read/write from the plugin's own manifest sandbox rather than
    // from ITS enabled-plugin list. Left on the client, win32 `path.resolve` mangled
    // the host's POSIX root (`/data/…` → `C:\data\…`) and `fsp.stat` ENOENT'd.
    const plugins: GenieApi['plugins'] = {
        ...local.plugins,
        list: async () =>
            ((await req('/api/desktop/plugins')) as {
                plugins: Awaited<ReturnType<GenieApi['plugins']['list']>>;
            }).plugins,
        installRepo: async (url, ref) =>
            (await req('/api/desktop/plugins/install-repo', {
                method: 'POST',
                json: { url, ref },
            })) as Awaited<ReturnType<GenieApi['plugins']['installRepo']>>,
        enable: async (id, enabled) =>
            (await req('/api/desktop/plugins/enable', {
                method: 'POST',
                json: { id, enabled },
            })) as Awaited<ReturnType<GenieApi['plugins']['enable']>>,
        setGrant: async (id, category, key, granted) =>
            (await req('/api/desktop/plugins/set-grant', {
                method: 'POST',
                json: { id, category, key, granted },
            })) as Awaited<ReturnType<GenieApi['plugins']['setGrant']>>,
        uninstall: async (id) =>
            (await req('/api/desktop/plugins/uninstall', {
                method: 'POST',
                json: { id },
            })) as Awaited<ReturnType<GenieApi['plugins']['uninstall']>>,
        marketplaces: async () =>
            ((await req('/api/desktop/plugins/marketplaces')) as {
                marketplaces: Awaited<ReturnType<GenieApi['plugins']['marketplaces']>>;
            }).marketplaces,
        addMarketplace: async (url, ref) =>
            (await req('/api/desktop/plugins/add-marketplace', {
                method: 'POST',
                json: { url, ref },
            })) as Awaited<ReturnType<GenieApi['plugins']['addMarketplace']>>,
        refreshMarketplace: async (id) =>
            (await req('/api/desktop/plugins/refresh-marketplace', {
                method: 'POST',
                json: { id },
            })) as Awaited<ReturnType<GenieApi['plugins']['refreshMarketplace']>>,
        refreshMarketplaces: async (maxAgeMs) =>
            (await req('/api/desktop/plugins/refresh-marketplaces', {
                method: 'POST',
                json: { maxAgeMs },
            })) as Awaited<ReturnType<GenieApi['plugins']['refreshMarketplaces']>>,
        removeMarketplace: async (id) =>
            (await req('/api/desktop/plugins/remove-marketplace', {
                method: 'POST',
                json: { id },
            })) as Awaited<ReturnType<GenieApi['plugins']['removeMarketplace']>>,
        installMarketplacePlugin: async (marketplaceId, pluginId) =>
            (await req('/api/desktop/plugins/install-marketplace-plugin', {
                method: 'POST',
                json: { marketplaceId, pluginId },
            })) as Awaited<ReturnType<GenieApi['plugins']['installMarketplacePlugin']>>,
        official: async () =>
            ((await req('/api/desktop/plugins/official')) as {
                official: Awaited<ReturnType<GenieApi['plugins']['official']>>;
            }).official,
        installBundled: async (id) =>
            (await req('/api/desktop/plugins/install-bundled', {
                method: 'POST',
                json: { id },
            })) as Awaited<ReturnType<GenieApi['plugins']['installBundled']>>,
        developerMode: async () =>
            (await req('/api/desktop/plugins/developer-mode')) as Awaited<
                ReturnType<GenieApi['plugins']['developerMode']>
            >,
        setDeveloperMode: async (enabled) =>
            (await req('/api/desktop/plugins/set-developer-mode', {
                method: 'POST',
                json: { enabled },
            })) as Awaited<ReturnType<GenieApi['plugins']['setDeveloperMode']>>,
        addTrustedKey: async (publicKeyPem, label) =>
            (await req('/api/desktop/plugins/add-trusted-key', {
                method: 'POST',
                json: { publicKeyPem, label },
            })) as Awaited<ReturnType<GenieApi['plugins']['addTrustedKey']>>,
        removeTrustedKey: async (keyId) =>
            (await req('/api/desktop/plugins/remove-trusted-key', {
                method: 'POST',
                json: { keyId },
            })) as Awaited<ReturnType<GenieApi['plugins']['removeTrustedKey']>>,
        editorRead: async (pluginId, root, relPath) =>
            (await req('/api/plugins/editor-read', {
                method: 'POST',
                json: { pluginId, root, relPath },
            })) as Awaited<ReturnType<GenieApi['plugins']['editorRead']>>,
        editorWrite: async (pluginId, root, relPath, base64) =>
            (await req('/api/plugins/editor-write', {
                method: 'POST',
                json: { pluginId, root, relPath, base64 },
            })) as Awaited<ReturnType<GenieApi['plugins']['editorWrite']>>,
    };

    return {
        ...local,
        workspaces,
        terminalSpec,
        files,
        process,
        schedule,
        terminal,
        clipboard,
        issueWatch,
        sites,
        devServer,
        settings,
        agentInbox,
        questions,
        tynn,
        tynnHost,
        mcp,
        plugins,
    };
}
