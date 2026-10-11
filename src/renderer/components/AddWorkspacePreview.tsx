import type { FolderKind, PlanStep } from '../../core/workspace-model.js';

/**
 * ADDING A FOLDER, PREVIEWED (§6.1) — what Genie found the folder to be and every step it would take,
 * the ones that WRITE marked, before anything is written. Confirm does the plan; Cancel does nothing.
 * A refusal shows its reason and offers only to pick again.
 */

export type AddPreviewView = { ok: true; path: string; kind: FolderKind; steps: readonly PlanStep[] } | { ok: false; reason: string };

const KIND_LABEL: Record<FolderKind, string> = {
    empty: 'an empty folder — Genie will set up a new envelope here',
    'simple-repo': 'a plain git repo — Genie will wrap it as an envelope with this folder as the host repo',
    'pre-init': 'a folder already laid out for an envelope, missing its manifest',
    'full-envelope': 'a full envelope — Genie will register it, stamping the schema only if it is older',
    missing: 'a folder that does not exist',
    other: 'a folder Genie cannot classify',
};

export function AddWorkspacePreview({ preview, onConfirm, onCancel }: { preview: AddPreviewView; onConfirm: (path: string) => void; onCancel: () => void }) {
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
        <section data-add-preview={preview.kind} className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-sm">
            <p className="font-semibold">Add <span className="font-mono">{preview.path}</span>?</p>
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
                <button type="button" data-action="confirm-add" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white" onClick={() => onConfirm(preview.path)}>Add this workspace</button>
                <button type="button" className={button} onClick={onCancel}>Cancel</button>
            </div>
        </section>
    );
}
