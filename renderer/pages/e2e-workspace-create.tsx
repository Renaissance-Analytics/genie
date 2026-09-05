import { useState } from 'react';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import type { WorkspaceRow } from '../lib/genie';

/**
 * E2E harness page for MAKING a workspace (genie#431).
 *
 * NOT product UI — it mounts the REAL `AddWorkspaceModal` so a Playwright
 * Electron test can walk "Add workspace → New workspace" without standing up the
 * master window. Nothing about the flow is re-implemented here: the route, the
 * form, `agi:create` and `workspaces:add` are all the shipped ones, which is the
 * only way this can catch the bug it exists for — "New workspace" going
 * somewhere else.
 *
 * `workspace-added` is a positive sentinel carrying the registered row's path,
 * so the spec can assert WHICH workspace landed rather than that something did.
 */
export default function E2EWorkspaceCreate() {
    const [added, setAdded] = useState<WorkspaceRow | null>(null);

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', color: '#e6e6e6' }}
        >
            {added ? (
                <div data-testid="workspace-added" data-path={added.path} data-name={added.project_name}>
                    Workspace added
                </div>
            ) : (
                <AddWorkspaceModal onClose={() => {}} onAdded={setAdded} />
            )}
        </div>
    );
}
