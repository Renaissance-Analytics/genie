import { Modal } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { nameProblem, type FileOpDialog } from '../../core/file-ops.js';

/**
 * THE TREE'S FILE-OPERATION DIALOG (Tynn #844; Genie 1's showPrompt for New file / New folder / Rename / Delete): a name
 * field where the operation needs one, checked as you type (one name, never a path), or the sentence saying what will
 * happen (Delete: where it goes). The host's refusal — a taken name, a failed trash — is shown here, and the dialog stays
 * open so it can be fixed.
 */

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';

export interface FileOpFormProps {
    readonly dialog: FileOpDialog;
    /** The host's refusal of the last try, in its words; `null` before one. */
    readonly error: string | null;
    readonly busy?: boolean;
    /** The typed name (`''` for a dialog without a field). */
    readonly onConfirm: (name: string) => void;
    readonly onCancel: () => void;
}

export function FileOpModal(props: FileOpFormProps) {
    return (
        <Modal open onClose={props.onCancel} size="sm">
            <Modal.Header>{props.dialog.title}</Modal.Header>
            <Modal.Body>
                <FileOpForm {...props} />
            </Modal.Body>
        </Modal>
    );
}

export function FileOpForm({ dialog, error, busy = false, onConfirm, onCancel }: FileOpFormProps) {
    const [name, setName] = useState(dialog.input ?? '');
    const problem = dialog.input === null ? null : nameProblem(name);
    const unchanged = dialog.action === 'rename' && name.trim() === dialog.input;
    return (
        <form
            data-file-op={dialog.action}
            className="flex flex-col gap-3 text-sm"
            onSubmit={(e) => { e.preventDefault(); if (!problem && !busy) { if (unchanged) onCancel(); else onConfirm(name.trim()); } }}
        >
            {dialog.body ? <p>{dialog.body}</p> : null}
            {dialog.input !== null ? (
                <label className="flex flex-col gap-1">
                    <span className="font-medium">Name</span>
                    <input
                        name="name"
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                        className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 font-mono"
                    />
                </label>
            ) : null}
            {problem && name !== '' ? <p data-problem="name" className="text-xs text-[var(--danger)]">{problem}</p> : null}
            {error ? <p data-problem="file-op" className="text-xs text-[var(--danger)]">{error}</p> : null}
            <div className="flex justify-end gap-2">
                <button type="button" className={button} onClick={onCancel}>Cancel</button>
                <button type="submit" data-action="confirm-file-op" className={button} disabled={busy || problem !== null}>{dialog.confirmLabel}</button>
            </div>
        </form>
    );
}
