import { Icon } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { tynnProjectSlug, type TynnOwner, type TynnProject } from '../../core/tynn.js';

/**
 * THE OPTIONAL TYNN PROJECT (Add workspace parity item 5) — Genie 1's ProjectPicker and its CreateProjectForm
 * (AddWorkspaceModal.tsx :905-1114), on New workspace and on the Open existing / Import from Git wizard's Workspace step.
 *
 * Linking is OPTIONAL and so is creating: "— No project (just a folder) —" is the default, and making a Tynn project is one
 * thing you can do from the picker, never a step on the way to a workspace. Genie 1's GApp variant is gone with GApps.
 * The id chosen goes to the host, which looks it up in Tynn's own list before writing anything.
 *
 * The two views are hook-free (a test renders and presses them); `TynnProjectLink` holds the list, the mode and the form.
 */

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';
const primary = 'flex items-center gap-1.5 rounded-md bg-[var(--violet-500)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--violet-400)] disabled:opacity-50';
const field = 'rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2.5 py-1.5';
const muted = 'text-xs text-[var(--fg-3)]';

export type TynnProjectsState = { readonly ok: true; readonly projects: readonly TynnProject[] } | { readonly ok: false; readonly reason: string } | null;

export interface TynnProjectPickerViewProps {
    /** `null` while loading; a refusal in Tynn's words when the projects cannot be listed. */
    readonly tynn: TynnProjectsState;
    readonly projectId: string | null;
    readonly onProject: (projectId: string | null) => void;
    /** Present when this host can create a Tynn project: Genie 1's "New project". */
    readonly onNew?: (() => void) | undefined;
}

export function TynnProjectPickerView({ tynn, projectId, onProject, onNew }: TynnProjectPickerViewProps) {
    return (
        <div data-tynn-project-picker="" className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold">Project (optional)</span>
                {onNew && tynn?.ok ? (
                    <button type="button" data-action="new-tynn-project" onClick={onNew} className={`${button} flex items-center gap-1`}><Icon name="plus" size="xs" />New project</button>
                ) : null}
            </div>
            {tynn === null ? (
                <span className={muted}>Loading Tynn projects…</span>
            ) : tynn.ok ? (
                <select data-field="tynn-project" value={projectId ?? ''} onChange={(e) => onProject(e.target.value === '' ? null : e.target.value)} className={field}>
                    <option value="">— No project (just a folder) —</option>
                    {tynn.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
            ) : (
                <span className={muted}>No Tynn projects available — {tynn.reason}</span>
            )}
            <span className={muted}>Optionally link this workspace to a Tynn project. Not required, and not required later either — the workspace works the same without one.</span>
        </div>
    );
}

export interface CreateTynnProjectViewProps {
    readonly name: string;
    readonly slug: string;
    /** `${kind}:${id}` of the chosen owner. */
    readonly ownerKey: string;
    /** `null` while loading. With one owner (the person's own account) there is nothing to choose and no Owner field. */
    readonly owners: readonly TynnOwner[] | null;
    readonly busy: boolean;
    readonly error: string | null;
    readonly onName: (name: string) => void;
    readonly onSlug: (slug: string) => void;
    readonly onOwner: (ownerKey: string) => void;
    readonly onCreate: () => void;
    readonly onCancel: () => void;
}

export const ownerKeyOf = (o: Pick<TynnOwner, 'kind' | 'id'>): string => `${o.kind}:${o.id}`;

/** Genie 1's "Create new project": Name, Owner (when there is a choice), Slug (derived, editable). */
export function CreateTynnProjectView({ name, slug, ownerKey, owners, busy, error, onName, onSlug, onOwner, onCreate, onCancel }: CreateTynnProjectViewProps) {
    return (
        <div data-create-tynn-project="" className="flex flex-col gap-2.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
            <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">Create new project</span>
                <button type="button" data-action="select-existing-tynn-project" disabled={busy} onClick={onCancel} className={`${button} flex items-center gap-1`}><Icon name="arrow-left" size="xs" />Select existing</button>
            </div>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Name</span>
                <input data-field="tynn-project-name" value={name} placeholder="My New Project" onChange={(e) => onName(e.target.value)} className={field} />
            </label>
            {owners !== null && owners.length > 1 ? (
                <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">Owner</span>
                    <select data-field="tynn-project-owner" value={ownerKey} onChange={(e) => onOwner(e.target.value)} className={field}>
                        {owners.map((o) => <option key={ownerKeyOf(o)} value={ownerKeyOf(o)}>{o.label}</option>)}
                    </select>
                    <span className={muted}>Who owns the project. Defaults to your personal account.</span>
                </label>
            ) : null}
            <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Slug</span>
                <input data-field="tynn-project-slug" value={slug} placeholder="my-new-project" onChange={(e) => onSlug(e.target.value)} className={`${field} font-mono text-xs`} />
                <span className={muted}>URL slug, auto-derived from the name. Editable.</span>
            </label>
            {error ? <p data-tynn-project-error="" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
                <button type="button" data-action="create-tynn-project" disabled={busy || name.trim() === ''} onClick={onCreate} className={primary}><Icon name="check" size="xs" />{busy ? 'Creating…' : 'Create project'}</button>
            </div>
        </div>
    );
}

/** What the picker asks of the host (bridge.workspaces): the list, and — on a host that can — owners and create. */
export interface TynnLinkApi {
    projects(): Promise<{ ok: true; projects: TynnProject[] } | { ok: false; reason: string }>;
    ownerOptions?: (() => Promise<{ ok: true; owners: TynnOwner[] } | { ok: false; reason: string }>) | undefined;
    createProject?: ((input: { name: string; slug: string; owner: { kind: TynnOwner['kind']; id: string } | null }) => Promise<{ ok: true; project: TynnProject } | { ok: false; reason: string }>) | undefined;
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The picker, live: the person's projects read once it is shown; New project → the form; a created project is selected. */
export function TynnProjectLink({ api, projectId, onProject }: { api: TynnLinkApi; projectId: string | null; onProject: (projectId: string | null) => void }) {
    const [tynn, setTynn] = useState<TynnProjectsState>(null);
    const [creating, setCreating] = useState(false);
    const [form, setForm] = useState({ name: '', slug: '', slugTouched: false, ownerKey: '' });
    const [owners, setOwners] = useState<readonly TynnOwner[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void api.projects().then(
            (r) => { if (live) setTynn(r.ok ? { ok: true, projects: r.projects } : { ok: false, reason: r.reason }); },
            (e: unknown) => { if (live) setTynn({ ok: false, reason: why(e) }); },
        );
        return () => { live = false; };
    }, [api]);

    // Owners are read when the form opens; a list Tynn cannot give leaves the person's own account (Tynn's default).
    useEffect(() => {
        if (!creating || !api.ownerOptions) return;
        let live = true;
        void api.ownerOptions().then(
            (r) => {
                if (!live) return;
                const list = r.ok ? r.owners : [];
                setOwners(list);
                const personal = list.find((o) => o.kind === 'user') ?? list[0];
                setForm((f) => (f.ownerKey === '' && personal ? { ...f, ownerKey: ownerKeyOf(personal) } : f));
            },
            () => { if (live) setOwners([]); },
        );
        return () => { live = false; };
    }, [creating, api]);

    if (creating && api.createProject) {
        const create = api.createProject;
        return (
            <CreateTynnProjectView
                name={form.name}
                slug={form.slug}
                ownerKey={form.ownerKey}
                owners={owners}
                busy={busy}
                error={error}
                onName={(name) => { setError(null); setForm((f) => ({ ...f, name, slug: f.slugTouched ? f.slug : tynnProjectSlug(name) })); }}
                onSlug={(slug) => setForm((f) => ({ ...f, slug, slugTouched: true }))}
                onOwner={(ownerKey) => setForm((f) => ({ ...f, ownerKey }))}
                onCancel={() => { setCreating(false); setError(null); }}
                onCreate={() => {
                    const owner = owners?.find((o) => ownerKeyOf(o) === form.ownerKey) ?? null;
                    setBusy(true);
                    setError(null);
                    void create({ name: form.name, slug: form.slug, owner: owner ? { kind: owner.kind, id: owner.id } : null })
                        .then((r) => {
                            if (!r.ok) { setError(r.reason); return; }
                            // Selected at once, and in the list, as Genie 1's picker did.
                            setTynn((t) => (t?.ok ? { ok: true, projects: [...t.projects.filter((p) => p.id !== r.project.id), r.project] } : { ok: true, projects: [r.project] }));
                            onProject(r.project.id);
                            setCreating(false);
                            setForm({ name: '', slug: '', slugTouched: false, ownerKey: '' });
                        }, (e: unknown) => setError(why(e)))
                        .finally(() => setBusy(false));
                }}
            />
        );
    }
    return <TynnProjectPickerView tynn={tynn} projectId={projectId} onProject={onProject} onNew={api.createProject ? () => setCreating(true) : undefined} />;
}
