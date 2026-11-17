import type { FileStatus, SaveChoices, SavePreview } from './workspace-save.js';

/**
 * THE SAVE TO REPO DIALOG, AS DATA (Tynn #756 UI; the owner, 2026-11-16: a "Save to repo" button with a diff that is
 * upstream-aware). A preview from the host and the person's choices in; what the dialog says and whether Save is enabled
 * out. Pure: the component only draws it.
 *
 * - Save stays disabled until EVERY conflict has a choice (yours or theirs). Nothing here picks a side.
 * - A guard refusal lists each offending field, in the guard's words.
 * - A failed fetch is a warning that does not block: the preview still shows what was last fetched.
 */

export interface SaveDialogInput {
    readonly preview: SavePreview | null;
    readonly choices: SaveChoices;
    readonly busy: boolean;
    readonly error: string | null;
    /** The files a save wrote, once it has. */
    readonly saved: readonly string[] | null;
}

export interface SaveDialogView {
    readonly loading: boolean;
    readonly refusal: { reason: string; fields: readonly { path: string; reason: string }[] } | null;
    readonly warning: string | null;
    readonly info: string | null;
    readonly files: readonly { path: string; label: string; status: FileStatus; words: string }[];
    /** What was rewritten for the repo on the way (a path made relative, a port made the placeholder). */
    readonly notes: readonly string[];
    readonly incoming: readonly { id: string; label: string }[];
    readonly conflicts: readonly { id: string; label: string; local: string; incoming: string; choice: 'local' | 'incoming' | null }[];
    readonly canSave: boolean;
    readonly saveLabel: string;
    readonly note: string | null;
    readonly error: string | null;
    readonly done: string | null;
}

const WORDS: Readonly<Record<FileStatus, string>> = { added: 'New', changed: 'Changed', unchanged: 'No change' };

/** A file as a person names it. */
export function fileLabel(path: string): string {
    if (path === 'project.json') return 'Workspace settings (project.json)';
    if (path === '.genie/tabs.json') return 'Workspace tabs';
    const flow = /^\.flows\/(.+)\.json$/.exec(path);
    if (flow) return `Flow: ${flow[1]}`;
    const process = /^\.processes\/(.+)\.json$/.exec(path);
    if (process) return `Process: ${process[1]}`;
    return path;
}

const KINDS: Readonly<Record<string, string>> = { sites: 'Site', agents: 'Agent', services: 'Service' };

/** A merge element (`project.json#sites/a1`, or a whole file) as a person names it. */
export function elementLabel(id: string): string {
    const at = id.indexOf('#');
    if (at < 0) return fileLabel(id);
    const [key = '', ...rest] = id.slice(at + 1).split('/');
    const kind = KINDS[key];
    if (kind !== undefined && rest.length > 0) return `${kind} ${rest.join('/')}`;
    if (key === 'workspace') return 'Workspace settings';
    return key === '' ? id : `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

const SHOWN = 80;

/** One side of a conflict as a single line. */
function summary(value: unknown): string {
    if (value === undefined) return '(removed)';
    const text = JSON.stringify(value) ?? String(value);
    return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function saveDialogView(input: SaveDialogInput): SaveDialogView {
    const { preview, choices, busy, error, saved } = input;
    const done = saved === null ? null
        : saved.length === 1 ? 'Saved 1 file. It is an ordinary change in git: review and commit it.'
        : `Saved ${saved.length} files. They are ordinary changes in git: review and commit them.`;
    const empty = { loading: false, refusal: null, warning: null, info: null, files: [], notes: [], incoming: [], conflicts: [], canSave: false, saveLabel: busy ? 'Saving…' : 'Save', note: null, error, done } satisfies SaveDialogView;
    if (preview === null) return { ...empty, loading: error === null };

    const upstream = preview.upstream;
    const warning = upstream.fetched ? null : `Could not check for your teammates' changes${upstream.reason ? ` (${upstream.reason})` : ''}. You can still save; what is shown is what was last fetched.`;
    const info = upstream.fetched && upstream.ref === null ? "This branch has no upstream, so teammates' changes are not shown." : null;

    if (!preview.plan.ok) {
        const plan = preview.plan;
        return { ...empty, refusal: { reason: plan.reason, fields: plan.violations.map((v) => ({ path: v.path, reason: v.reason })) }, warning, info, note: 'Nothing can be saved until this is fixed.' };
    }

    const files = preview.files.map((f) => ({ path: f.path, label: fileLabel(f.path), status: f.status, words: WORDS[f.status] }));
    const incoming = preview.decisions.filter((x) => x.kind === 'incoming').map((x) => ({ id: x.id, label: elementLabel(x.id) }));
    const conflicts = preview.decisions.filter((x) => x.kind === 'conflict').map((x) => ({ id: x.id, label: elementLabel(x.id), local: summary(x.local), incoming: summary(x.incoming), choice: choices[x.id] ?? null }));
    const open = conflicts.filter((c) => c.choice === null).length;
    const nothing = files.every((f) => f.status === 'unchanged') && incoming.length === 0 && conflicts.length === 0;
    const note = open > 0 ? `Choose yours or theirs for ${open} ${plural(open, 'conflict', 'conflicts')} before saving.` : nothing ? 'Nothing to save: the repo already matches.' : null;
    return { ...empty, refusal: null, warning, info, files, notes: preview.plan.notes ?? [], incoming, conflicts, canSave: !busy && saved === null && open === 0 && !nothing, note };
}
