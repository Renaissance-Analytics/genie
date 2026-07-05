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
    SiteView,
} from './genie';
import { isHostSourcedSettingKey } from './settings-nav';

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

    // Serve-local-sites (Phase B). Discovery reads the HOST's hosts file + probes
    // the HOST's loopback, and the per-site enable set is the allowlist the HOST
    // serves from — so this is HOST-SOURCED: a remote window resolves `.gen`
    // config against the host over /api/sites (read) + /api/sites/set (write),
    // exactly like the IssueWatch rail. The bearer token stays in main.
    const sites: GenieApi['sites'] = {
        list: async (workspaceId, opts) =>
            (
                (await req(
                    `/api/sites?workspaceId=${encodeURIComponent(workspaceId)}${
                        opts?.refresh ? '&refresh=1' : ''
                    }`,
                )) as { sites: SiteView[] }
            ).sites,
        set: async (workspaceId, siteId, patch) =>
            (await req('/api/sites/set', {
                method: 'POST',
                json: { workspaceId, siteId, patch },
            })) as { ok: boolean },
        // The header `.gen` popover is a LOCAL-window affordance (hidden inside a
        // host window), so these never fire here — a remote window owns no local
        // sites and can't spawn local browser windows. Honest no-ops for the type.
        all: async () => ({ local: [], hosts: [] }),
        openLocal: async () => ({ ok: false, error: 'not available in a host window' }),
        // (openLocal takes a genName now; the host-window stub ignores it.)
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
    };

    // The host's workspace files (keyed by the WorkspaceRow.path the desktop holds).
    const files: GenieApi['files'] = {
        ...local.files,
        listTree: async (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string },
        ) =>
            (
                (await req('/api/files/tree', {
                    method: 'POST',
                    json: { workspacePath, root: opts?.root },
                })) as { tree: TreeNodeData[] }
            ).tree,
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

    // xterm forwards the host app's mouse-tracking (CSI M / CSI < … M|m) as input.
    // A remote session must only drive the UI — never push our mouse into the host
    // terminal — so strip mouse reports before they reach the host pty.
    const isMouseReport = (data: string): boolean => /^\x1b\[(M|<[0-9;]+[Mm])/.test(data);

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
            // Tag the terminal's workspace onto the relay term `open` frame so the
            // host scopes it to the grant's workspaces (a workspace-scoped grant
            // only reaches its own terminals; `host:all` reaches any). Missing →
            // fails closed to host:all on the host side.
            await r.terminalAttach(opts.id, opts.workspaceId);
            return { id: opts.id, pid: 0, shell: opts.shell ?? '', existing: true, scrollback: '' };
        },
        write: (id: string, data: string) => {
            // View-only (host has control): swallow the keystroke locally.
            if (controlLocked) return Promise.resolve(false);
            return r.terminalInput(id, isMouseReport(data) ? '' : data);
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

    return {
        ...local,
        workspaces,
        terminalSpec,
        files,
        process,
        terminal,
        clipboard,
        issueWatch,
        sites,
        settings,
    };
}
