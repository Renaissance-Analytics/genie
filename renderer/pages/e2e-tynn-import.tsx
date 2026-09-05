import { useState } from 'react';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import type { WorkspaceRow } from '../lib/genie';

/**
 * E2E harness page for the Tynn IMPORT route.
 *
 * NOT product UI — it mounts the REAL `AddWorkspaceModal` so a Playwright
 * Electron test can walk the owner's reported path (Add workspace → Import from
 * Tynn → pick a project) without standing up the whole master window.
 *
 * `workspace-added` is a POSITIVE sentinel, and that is the point: the bug was a
 * flow that reached the wrong screen, and "the conversion wizard did not appear"
 * would be satisfied just as well by an import that did nothing at all. The
 * sentinel carries the registered row's path and project id, so the spec can
 * assert a workspace really landed — through the REAL `workspaces:create`.
 *
 * `add-another` reopens the modal, because the spec imports three projects in
 * one window: the one with no repositories, and the two positive controls that
 * keep its result meaningful.
 */
export default function E2ETynnImport() {
    const [added, setAdded] = useState<WorkspaceRow | null>(null);
    const [open, setOpen] = useState(true);

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', color: '#e6e6e6' }}
        >
            {added ? (
                <div>
                    <div
                        data-testid="workspace-added"
                        data-path={added.path}
                        data-project={added.tynn_project_id}
                    >
                        Registered {added.project_name} at {added.path}
                    </div>
                    <button
                        data-testid="add-another"
                        onClick={() => {
                            setAdded(null);
                            setOpen(true);
                        }}
                    >
                        Add another
                    </button>
                </div>
            ) : open ? (
                <AddWorkspaceModal onClose={() => setOpen(false)} onAdded={setAdded} />
            ) : (
                <div data-testid="modal-closed">Add-workspace modal closed</div>
            )}
        </div>
    );
}
