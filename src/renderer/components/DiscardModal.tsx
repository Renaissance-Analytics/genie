import { Button, Modal } from '@particle-academy/react-fancy';

/**
 * CLOSING WHAT YOU HAVE NOT SAVED ASKS FIRST (beta.33 item 15; Genie 1 CodePanel's showPrompt "Unsaved changes — Discard?").
 * Genie 2 closed a dirty tab — and "Close all" — without a word, and the edits were gone.
 */

const base = (p: string) => p.split('/').pop() ?? p;

export function discardWords(paths: readonly string[]): string {
    return paths.length === 1 ? `${base(paths[0]!)} has unsaved edits. Discard them?` : `${paths.length} open files have unsaved edits. Discard them all?`;
}

export function DiscardForm({ paths, onDiscard, onCancel }: { paths: readonly string[]; onDiscard: () => void; onCancel: () => void }) {
    return (
        <div data-discard-prompt="" className="flex flex-col gap-3 text-sm">
            <p>{discardWords(paths)}</p>
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" data-action="keep-editing" onClick={onCancel}>Keep editing</Button>
                <Button size="sm" color="red" data-action="discard" onClick={onDiscard}>Discard</Button>
            </div>
        </div>
    );
}

export function DiscardModal(props: { paths: readonly string[]; onDiscard: () => void; onCancel: () => void }) {
    return (
        <Modal open onClose={props.onCancel} size="sm">
            <Modal.Header>Unsaved changes</Modal.Header>
            <Modal.Body>
                <DiscardForm {...props} />
            </Modal.Body>
        </Modal>
    );
}
