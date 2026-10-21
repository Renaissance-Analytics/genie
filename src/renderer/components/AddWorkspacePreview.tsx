import type { FolderKind, PlanStep } from '../../core/workspace-model.js';
import type { TynnContent, TynnProject } from '../../core/tynn.js';

/**
 * ADDING A FOLDER, PREVIEWED (§6.1) — what Genie found the folder to be and every step it would take,
 * the ones that WRITE marked, before anything is written. Confirm does the plan; Cancel does nothing.
 * A refusal shows its reason and offers only to pick again.
 */

export type AddPreviewView =
    | { ok: true; path: string; kind: FolderKind; steps: readonly PlanStep[]; source?: 'git'; url?: string; parent?: string }
    /** From Tynn (§6.1): the project's envelope, or a new one with its repos, or an empty one; the link is recorded in project.json. */
    | { ok: true; path: string; kind: FolderKind; steps: readonly PlanStep[]; source: 'tynn'; project: TynnProject; host: string; parent: string; content?: TynnContent }
    | { ok: false; reason: string };

const KIND_LABEL: Record<FolderKind, string> = {
    empty: 'an empty folder — Genie will set up a new envelope here',
    'simple-repo': 'a plain git repo — Genie will wrap it as an envelope with this folder as the host repo',
    'pre-init': 'a folder already laid out for an envelope, missing its manifest',
    'full-envelope': 'a full envelope — Genie will register it, stamping the schema only if it is older',
    missing: 'a folder that does not exist',
    other: 'a folder Genie cannot classify',
};

/** What a Tynn project brings (core/tynn.ts tynnContent), in words, before Confirm. */
function tynnContentWords(content: TynnContent | undefined): string {
    if (content?.kind === 'envelope') return `Tynn names its envelope, ${content.url}${content.branch ? ` (branch ${content.branch})` : ''}: Genie clones it with its submodules and links it back to the project.`;
    if (content?.kind === 'repos') {
        const n = content.repos.length;
        return `Tynn lists ${n} ${n === 1 ? 'repository' : 'repositories'} for it: Genie makes a new envelope, adds each as a submodule under repos/, and links it back to the project.`;
    }
    return 'Tynn lists no repositories for it: Genie makes a new envelope with its first commit, linked back to the project.';
}

/**
 * IMPORT FROM GIT (§6.1; Add workspace parity item 7): the URL, then Genie clones it to a STAGING folder and reads it, and
 * the same wizard as Open existing folder builds a new workspace from it (Genie 1 cloned, then analysed). The person's
 * folders are not written until they confirm the wizard's last step; the staging clone is removed afterwards.
 */
export function AddFromGitForm({ onPreview, onCancel, busy = false }: { onPreview: (url: string) => void; onCancel: () => void; busy?: boolean | undefined }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm';
    return (
        <form data-form="add-from-git" className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-sm" onSubmit={(e) => { e.preventDefault(); const url = String(new FormData(e.currentTarget).get('url') ?? '').trim(); if (url && !busy) onPreview(url); }}>
            <p className="font-semibold">Add a workspace from a git URL</p>
            <input name="url" type="url" placeholder="https://github.com/owner/name.git or git@host:owner/name.git" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 font-mono text-xs" />
            <p className="text-xs text-[var(--fg-3)]">Genie clones it to a staging folder and reads it; then you choose what goes into the new workspace and where it lives. Nothing of yours is written until you confirm.</p>
            <div className="flex gap-2">
                <button type="submit" data-action="clone-and-read" disabled={busy} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white disabled:opacity-60">{busy ? 'Cloning…' : 'Clone and read it'}</button>
                <button type="button" className={button} onClick={onCancel}>Cancel</button>
            </div>
        </form>
    );
}

/**
 * `busy` (parity row 25): the confirmed add is running — the button is disabled and says what is happening, so a double
 * click cannot start a second clone into the same folder (src/renderer/add-confirm.ts refuses it as well).
 */
export function AddWorkspacePreview({ preview, busy = false, onConfirm, onCancel, onConfirmGit, onConfirmTynn }: { preview: AddPreviewView; busy?: boolean | undefined; onConfirm: (path: string) => void; onCancel: () => void; onConfirmGit?: ((url: string, parent: string) => void) | undefined; onConfirmTynn?: ((parent: string, projectId: string) => void) | undefined }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm';
    if (!preview.ok) {
        return (
            <section data-add-preview="refused" className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--danger)] p-4 text-sm">
                <p className="font-semibold">Genie will not add that folder</p>
                <p className="text-[var(--fg-2)]">{preview.reason}</p>
                <div><button type="button" className={button} onClick={onCancel}>Pick another folder</button></div>
            </section>
        );
    }
    return (
        <section data-add-preview={preview.kind} {...(preview.source ? { 'data-add-source': preview.source } : {})} className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-sm">
            <p className="font-semibold">Add <span className="font-mono">{preview.path}</span>?</p>
            {preview.source === 'git' ? <p className="text-[var(--fg-2)]">From <span className="font-mono">{preview.url}</span> — cloned into this folder first. Nothing is cloned until you confirm.</p> : null}
            {preview.source === 'tynn' ? (
                <p data-tynn-content={preview.content?.kind ?? 'empty'} className="text-[var(--fg-2)]">
                    From Tynn project <span className="font-medium text-[var(--fg-1)]">{preview.project.name}</span> at <span className="font-mono">{preview.host}</span> — {tynnContentWords(preview.content)} Nothing is written until you confirm.
                </p>
            ) : null}
            <p className="text-[var(--fg-2)]">This is {KIND_LABEL[preview.kind]}. Nothing has been written yet. Genie would:</p>
            <ol className="flex flex-col gap-1 pl-5">
                {preview.steps.map((s, i) => (
                    <li key={`${s.action}-${i}`} data-step-writes={s.writes ? 'true' : 'false'} className="list-decimal">
                        <span>{s.action}</span>
                        {s.writes ? <span className="ml-2 font-mono text-[11px] text-[var(--warning)]">writes</span> : <span className="ml-2 font-mono text-[11px] text-[var(--fg-4)]">no write</span>}
                    </li>
                ))}
            </ol>
            <div className="flex gap-2">
                <button type="button" data-action="confirm-add" disabled={busy} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white disabled:opacity-60" onClick={() => (busy ? undefined : preview.source === 'tynn' && onConfirmTynn ? onConfirmTynn(preview.parent, preview.project.id) : preview.source === 'git' && preview.url && preview.parent !== undefined && onConfirmGit ? onConfirmGit(preview.url, preview.parent) : onConfirm(preview.path))}>{preview.source === 'tynn' ? (preview.content?.kind === 'envelope' ? (busy ? 'Cloning…' : 'Clone and add') : busy ? 'Creating…' : 'Create and add') : preview.source === 'git' ? (busy ? 'Cloning…' : 'Clone and add') : busy ? 'Adding…' : 'Add this workspace'}</button>
                <button type="button" className={button} onClick={onCancel}>Cancel</button>
            </div>
        </section>
    );
}
