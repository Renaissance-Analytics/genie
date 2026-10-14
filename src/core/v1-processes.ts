/**
 * GENIE 1's BACKGROUND PROCESSES → GENIE 2's PROCESS BOOK — the pure plan (no I/O).
 *
 * v1 kept the person's background processes as `terminal_specs` rows of type 'process'; the run
 * settings live in `meta_json` (`command`, `autostart`, `user_stopped`, `was_running`,
 * `restart_on_exit`, `schedule`, …), the folder in `cwd`, an on/off in `enabled`, an optional
 * `shell`. `main/v1-processes.ts` reads them; this decides what each one becomes.
 *
 * The rules:
 * - `wanted` = enabled && autostart && !user_stopped. Nothing is wanted that v1 was not told to
 *   start at launch; a `was_running`-only spec comes across stopped, listed, one Start away.
 * - restart: v1 restarted on ANY exit unless `restart_on_exit === false` (process-lifecycle's
 *   decideOnExit, capped) — that is Genie 2's `always` (also capped); false is `never`.
 * - Scheduled specs (`meta.schedule`) are Flows' business, not processes: never imported, noted.
 * - Not imported, and noted with why: no workspace, a workspace Genie 2 does not have, no
 *   command, a folder that is not inside its workspace (process-book refuses those too).
 * - Imported, and noted: disabled in v1 (comes across stopped); a custom shell (Genie 2 runs
 *   every process in its default shell).
 * - Ids: `proc_v1_<v1 id>` — stable, so an id already in the book is recognised and left alone.
 */

export interface V1ProcessSpec {
    readonly id: string;
    readonly workspaceId: string | null;
    readonly label: string;
    readonly cwd: string;
    readonly shell: string | null;
    readonly enabled: boolean;
    /** `meta_json` as v1 stores it: JSON text. */
    readonly meta: string;
}

export interface V1ProcessPlanned {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly command: string;
    readonly cwd: string;
    readonly restart: 'never' | 'always';
    readonly wanted: boolean;
}

export interface V1ProcessPlan {
    readonly processes: readonly V1ProcessPlanned[];
    /** One line per spec not imported, or imported with something it could not carry. */
    readonly notes: readonly string[];
}

export const V1_PROCESS_ID_PREFIX = 'proc_v1_';

/** `null` = cannot see v1, so nothing is planned and nothing is claimed. */
export function planV1ProcessImport(
    specs: readonly V1ProcessSpec[] | null,
    workspaces: readonly { readonly id: string; readonly path: string }[],
): V1ProcessPlan | null {
    if (specs === null) return null;
    const pathOf = new Map(workspaces.map((w) => [w.id, w.path]));
    const processes: V1ProcessPlanned[] = [];
    const notes: string[] = [];
    for (const spec of specs) {
        const meta = parseMeta(spec.meta);
        const name = spec.label.trim() || (typeof meta.command === 'string' ? meta.command.trim() : '') || spec.id;
        const say = (why: string) => notes.push(`process ${spec.id} ("${name}"): ${why}`);
        if (typeof meta.schedule === 'string' && meta.schedule.trim() !== '') {
            say('scheduled in Genie 1 — that belongs to Flows, not background processes; not imported');
            continue;
        }
        if (spec.workspaceId === null) {
            say('has no workspace in Genie 1; not imported');
            continue;
        }
        const workspacePath = pathOf.get(spec.workspaceId);
        if (workspacePath === undefined) {
            say(`its workspace ${spec.workspaceId} is not in Genie 2; not imported`);
            continue;
        }
        const command = typeof meta.command === 'string' ? meta.command.trim() : '';
        if (!command) {
            say('has no command; not imported');
            continue;
        }
        if (!folderInside(workspacePath, spec.cwd)) {
            say(`its folder ${spec.cwd || '(none)'} is outside its workspace ${workspacePath}; not imported`);
            continue;
        }
        if (!spec.enabled) say('was disabled in Genie 1; imported stopped');
        if (spec.shell !== null && spec.shell.trim() !== '') say(`ran under the shell ${spec.shell} in Genie 1; Genie 2 runs it in its default shell`);
        processes.push({
            id: `${V1_PROCESS_ID_PREFIX}${spec.id}`,
            workspaceId: spec.workspaceId,
            name,
            command,
            cwd: spec.cwd,
            restart: meta.restart_on_exit === false ? 'never' : 'always',
            wanted: spec.enabled && meta.autostart === true && meta.user_stopped !== true,
        });
    }
    return { processes, notes };
}

function parseMeta(text: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/**
 * Is `folder` the workspace or inside it? Platform-free on purpose: v1's paths are the machine's
 * own (Windows on the owner's), and this module must decide the same way wherever it runs. A
 * Windows-shaped path (drive letter or backslash) compares case-insensitively; `.` and `..` are
 * resolved first, so `<ws>/a/../..` is outside and `<ws>-2` is not `<ws>`.
 */
export function folderInside(workspacePath: string, folder: string): boolean {
    const ws = segments(workspacePath);
    const f = segments(folder);
    if (ws === null || f === null) return false;
    const windows = ws.windows || f.windows;
    const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (f.parts.length < ws.parts.length) return false;
    return ws.parts.every((part, i) => same(part, f.parts[i]!));
}

/** Absolute path → its resolved segments (root first); a relative or empty path is `null`. */
function segments(path: string): { windows: boolean; parts: string[] } | null {
    const p = path.trim();
    const windows = /^[a-zA-Z]:/.test(p) || p.includes('\\');
    const slashed = p.replace(/\\/g, '/');
    let root: string;
    if (/^[a-zA-Z]:\//.test(slashed)) root = slashed.slice(0, 2);
    else if (slashed.startsWith('//')) root = '//';
    else if (slashed.startsWith('/')) root = '/';
    else return null;
    const parts: string[] = [root];
    for (const part of slashed.slice(root.length).split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (parts.length > 1) parts.pop();
            continue;
        }
        parts.push(part);
    }
    return { windows, parts };
}
