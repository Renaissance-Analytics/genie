import type {
    GenieApi,
    WorkspaceRow,
    TerminalSpec,
    ProcessListItem,
    ProcessStatus,
    TreeNodeData,
    GitStatusMap,
} from './genie';

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

    // The host's rail — full WorkspaceRow pass-through.
    const workspaces: GenieApi['workspaces'] = {
        ...local.workspaces,
        list: async () =>
            ((await req('/api/desktop/workspaces')) as { workspaces: WorkspaceRow[] }).workspaces,
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
        // No host log endpoint yet — the hover log is empty in remote mode.
        log: async () => '',
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
        }) => {
            await r.terminalAttach(opts.id);
            return { id: opts.id, pid: 0, shell: opts.shell ?? '', existing: true, scrollback: '' };
        },
        write: (id: string, data: string) =>
            r.terminalInput(id, isMouseReport(data) ? '' : data),
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

    return { ...local, workspaces, terminalSpec, files, process, terminal };
}
