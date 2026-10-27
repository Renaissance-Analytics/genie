import { ContentRenderer, Modal } from '@particle-academy/react-fancy';
import { genieClipboardWriter } from '../clipboard.js';
import type { SignalAction } from '../../core/deck.js';
import type { UpdateChip } from '../../core/update-chip.js';

/**
 * WHAT IS IN THIS UPDATE (the owner, 2026-10-19: "make sure that in this update we are actually showing the release
 * notes in the update ux like it did for genie 1"). Genie 1's upgrade window: every version between yours and the one on
 * offer, grouped by version, newest first, and the step that takes the update — opened from the header's update button.
 * It says when the notes are still coming, when some could not be fetched, and when they could not be loaded at all
 * (offline: the update is still safe to install).
 */
export interface UpdateWindowProps {
    update: UpdateChip;
    onAction: (action: SignalAction) => void;
    onClose: () => void;
}

export function UpdateWindow({ update, onAction, onClose }: UpdateWindowProps) {
    const c = update.changelog ?? null;
    const groups = c && c !== 'unavailable' ? c.groups : [];
    const state = c === null ? 'loading' : c === 'unavailable' ? 'unavailable' : groups.length === 0 ? 'none' : c.partial ? 'partial' : 'complete';
    return (
        <Modal open onClose={onClose} size="lg">
            <Modal.Header>What’s in Genie {update.version}</Modal.Header>
            <Modal.Body>
                <div data-update-window={update.version} className="flex max-h-[60vh] flex-col gap-5 overflow-auto">
                    {groups.map((g) => (
                        <section key={g.version} data-update-notes-version={g.version} className="flex flex-col gap-2">
                            <h3 className="text-sm font-semibold text-[var(--fg-1)]">Genie {g.version}</h3>
                            <ContentRenderer clipboardWriter={genieClipboardWriter} value={g.notes} format="markdown" lineSpacing={1.4} className="text-[13px] text-[var(--fg-2)]" />
                        </section>
                    ))}
                    {state === 'complete' ? null : (
                        <p data-update-notes-state={state} className="text-[13px] text-[var(--fg-3)]">
                            {state === 'loading'
                                ? 'Fetching the release notes…'
                                : state === 'unavailable'
                                  ? 'Couldn’t load the release notes (offline?). The update is still safe to install.'
                                  : state === 'none'
                                    ? 'No release notes were published for this update.'
                                    : 'Some release notes could not be fetched. This list may be incomplete.'}
                        </p>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <div className="flex w-full items-center justify-end gap-2">
                    <button type="button" data-action="update-close" onClick={onClose} className="rounded-md border border-[var(--border-1)] px-3 py-1 text-[13px] text-[var(--fg-1)] hover:bg-[var(--bg-2)]">
                        Close
                    </button>
                    {update.action ? (
                        <button
                            type="button"
                            data-action={update.action}
                            onClick={() => onAction(update.action!)}
                            className="rounded-md bg-[var(--primary)] px-3 py-1 text-[13px] font-medium text-white hover:opacity-90"
                        >
                            {update.action === 'update-install' ? `Restart to install Genie ${update.version}` : `Download Genie ${update.version}`}
                        </button>
                    ) : (
                        <span className="text-[13px] text-[var(--fg-3)]">{update.label}</span>
                    )}
                </div>
            </Modal.Footer>
        </Modal>
    );
}
