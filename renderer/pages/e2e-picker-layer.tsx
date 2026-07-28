import { useState } from 'react';
import AddWorkspaceModal from '../components/AddWorkspaceModal';

/**
 * E2E harness page for the file-picker STACKING fix (genie #86).
 *
 * NOT product UI — it exists so a Playwright Electron test can drive the exact
 * reported repro (Add workspace → Local folder → Browse) without standing up the
 * whole master window and its workspace grid.
 *
 * Nothing is mocked and nothing is re-implemented: this mounts the REAL
 * `AddWorkspaceModal` (a react-fancy `Modal`, portaled to `document.body`) and
 * relies on the REAL `FilePickerHost` that `_app.tsx` already mounts at the app
 * root. That pairing IS the bug — a `.ctx-scrim` picker living inside `#__next`
 * versus a portaled Fancy overlay — so anything less faithful (a stand-in modal,
 * a stand-in picker) could pass while the shipped screen stays broken.
 *
 * `modal-closed` is a positive sentinel rather than an absence check: the spec
 * asserts that dismissing the PICKER leaves the Add-workspace modal standing,
 * and "the sentinel never appeared" is a much stronger claim than "some selector
 * was still on the page".
 */
export default function E2EPickerLayer() {
    const [open, setOpen] = useState(true);

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', color: '#e6e6e6' }}
        >
            {open ? (
                <AddWorkspaceModal onClose={() => setOpen(false)} onAdded={() => {}} />
            ) : (
                <div data-testid="modal-closed">Add-workspace modal closed</div>
            )}
        </div>
    );
}
