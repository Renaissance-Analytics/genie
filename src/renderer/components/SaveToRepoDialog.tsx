import { Button, Modal } from '@particle-academy/react-fancy';
import { useEffect, useMemo, useState } from 'react';
import { saveDialogView, type SaveDialogView } from '../../core/save-dialog-view.js';
import type { SaveChoices, SavePreview, SaveResult } from '../../core/workspace-save.js';

/**
 * SAVE TO REPO (Tynn #756 UI; the owner, 2026-11-16: a "Save to repo" button with a diff that is upstream-aware). Each file's
 * status, what teammates changed, and a conflict's yours-or-theirs choice; Save stays disabled until every conflict is
 * settled. A guard refusal names each field. A failed fetch is a warning, not a stop. The save is an ordinary git change the
 * person commits: this dialog never commits.
 *
 * The view is hook-free (a test renders it); `SaveToRepoDialog` loads the preview, holds the choices and calls the host.
 */

const muted = 'text-xs text-[var(--fg-3)]';
const chip = (on: boolean) => `rounded-md border px-2 py-0.5 text-xs ${on ? 'border-[var(--violet-500)] bg-[var(--violet-500)]/15 text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`;
const STATUS_TONE = { added: 'text-[var(--success)]', changed: 'text-[var(--warning)]', unchanged: 'text-[var(--fg-3)]' } as const;

export interface SaveToRepoViewProps {
    readonly workspaceName: string;
    readonly view: SaveDialogView;
    readonly onChoose: (id: string, side: 'local' | 'incoming') => void;
    readonly onSave: () => void;
    readonly onClose: () => void;
}

export function SaveToRepoView({ workspaceName, view, onChoose, onSave, onClose }: SaveToRepoViewProps) {
    return (
        <div data-save-dialog="" className="flex min-w-[460px] max-w-[640px] flex-col gap-3 text-sm">
            <h2 className="text-base font-semibold">Save {workspaceName} to its repo</h2>
            {view.loading ? <p data-save-loading="" className={muted}>Checking the repo and your teammates' changes…</p> : null}
            {view.warning ? <p data-save-warning="" role="status" className="rounded-md border border-[var(--warning)]/50 bg-[var(--warning)]/10 px-2.5 py-1.5 text-xs">{view.warning}</p> : null}
            {view.info ? <p data-save-info="" className={muted}>{view.info}</p> : null}
            {view.refusal ? (
                <div data-save-refusal="" role="alert" className="flex flex-col gap-1.5 rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-2 text-xs">
                    <p className="font-medium">{view.refusal.reason}</p>
                    <ul className="flex flex-col gap-1">
                        {view.refusal.fields.map((f) => (
                            <li key={f.path} data-save-field={f.path} className="flex flex-col"><code className="font-mono">{f.path}</code><span>{f.reason}</span></li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {view.files.length > 0 ? (
                <ul data-save-files="" className="flex flex-col gap-1">
                    {view.files.map((f) => (
                        <li key={f.path} data-save-file={f.path} className="flex items-center justify-between gap-3">
                            <span className="min-w-0 truncate">{f.label}</span>
                            <span className={`shrink-0 text-xs font-medium ${STATUS_TONE[f.status]}`}>{f.words}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            {view.incoming.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <h3 className="text-xs font-medium">From your teammates, coming in</h3>
                    <ul className="flex flex-col gap-0.5">
                        {view.incoming.map((i) => <li key={i.id} data-save-incoming={i.id} className="text-xs">{i.label}</li>)}
                    </ul>
                </div>
            ) : null}
            {view.conflicts.length > 0 ? (
                <div className="flex flex-col gap-2">
                    <h3 className="text-xs font-medium">You and a teammate both changed these. Pick which to keep.</h3>
                    {view.conflicts.map((c) => (
                        <div key={c.id} data-save-conflict={c.id} className="flex flex-col gap-1 rounded-md border border-[var(--border-1)] px-2.5 py-2">
                            <span className="text-xs font-medium">{c.label}</span>
                            <div className="flex items-start gap-2">
                                <Button size="xs" type="button" data-save-choice="local" aria-pressed={c.choice === 'local'} className={chip(c.choice === 'local')} onClick={() => onChoose(c.id, 'local')}>Mine</Button>
                                <code className="min-w-0 break-all font-mono text-[11px] text-[var(--fg-2)]">{c.local}</code>
                            </div>
                            <div className="flex items-start gap-2">
                                <Button size="xs" type="button" data-save-choice="incoming" aria-pressed={c.choice === 'incoming'} className={chip(c.choice === 'incoming')} onClick={() => onChoose(c.id, 'incoming')}>Theirs</Button>
                                <code className="min-w-0 break-all font-mono text-[11px] text-[var(--fg-2)]">{c.incoming}</code>
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
            {view.note ? <p data-save-note="" className={muted}>{view.note}</p> : null}
            {view.error ? <p data-save-error="" role="alert" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{view.error}</p> : null}
            {view.done ? <p data-save-done="" role="status" className="rounded-md border border-[var(--success)]/50 bg-[var(--success)]/10 px-2.5 py-1.5 text-xs">{view.done}</p> : null}
            <div className="flex justify-end gap-2">
                <Button size="xs" type="button" data-action="save-to-repo-close" onClick={onClose}>{view.done ? 'Close' : 'Cancel'}</Button>
                <Button size="xs" type="button" data-action="save-to-repo-confirm" disabled={!view.canSave} onClick={onSave}>{view.saveLabel}</Button>
            </div>
        </div>
    );
}

export function SaveToRepoDialog({ workspaceName, load, save, onClose }: {
    readonly workspaceName: string;
    /** The host's preview: it fetches first, then reads. */
    readonly load: () => Promise<SavePreview>;
    /** The host's save, with the conflicts settled. */
    readonly save: (choices: SaveChoices) => Promise<SaveResult>;
    readonly onClose: () => void;
}) {
    const [preview, setPreview] = useState<SavePreview | null>(null);
    const [choices, setChoices] = useState<SaveChoices>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState<readonly string[] | null>(null);
    useEffect(() => {
        let live = true;
        load().then((p) => { if (live) setPreview(p); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
        return () => { live = false; };
    }, [load]);
    const view = useMemo(() => saveDialogView({ preview, choices, busy, error, saved }), [preview, choices, busy, error, saved]);
    const doSave = (): void => {
        setBusy(true);
        setError(null);
        void save(choices)
            .then((r) => { if (r.ok) setSaved(r.written); else setError(r.reason); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    };
    return (
        <Modal open onClose={onClose}>
            <Modal.Body>
                <SaveToRepoView workspaceName={workspaceName} view={view} onChoose={(id, side) => setChoices((c) => ({ ...c, [id]: side }))} onSave={doSave} onClose={onClose} />
            </Modal.Body>
        </Modal>
    );
}
