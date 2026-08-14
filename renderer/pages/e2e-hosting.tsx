import { useState } from 'react';
import { DevServerSection, ToolchainSection } from './settings';
import WorkspaceSiteManager from '../components/Master/WorkspaceSiteManager';
import type { WorkspaceRow } from '../lib/genie';

/**
 * E2E harness page for the HOSTING MANAGER (genie #234).
 *
 * NOT product UI. It exists so a Playwright Electron test can drive both
 * Hosting surfaces without standing up the whole Settings shell (which mounts
 * every other section's IPC — GitHub, plugins, updater, Tailscale, devices —
 * none of which this spec is about, all of which could hang a CI runner) or the
 * master window's workspace grid.
 *
 * Nothing here is a stand-in. It mounts the REAL `DevServerSection` — the
 * Settings → Hosting Manager section, imported from the settings page itself —
 * and the REAL `WorkspaceSiteManager`, the per-workspace panel. What IS faked
 * is one layer lower and in MAIN: the six `dev:*` IPC channels answer from
 * `main/e2e/hosting.ts`, so the components see production-shaped payloads on a
 * runner with no container runtime.
 *
 * `panel-closed` is a positive sentinel rather than an absence check: "the
 * sentinel appeared" is a much stronger claim about a closed modal than "some
 * selector was no longer on the page".
 */

/** The workspace the panel is opened for. A plain fixture row — the panel only
 *  reads `id` (for its IPC calls) and `project_name` (for its heading). */
const WORKSPACE: WorkspaceRow = {
    id: 'ws-e2e-hosting',
    backend: 'tynn',
    project_id: 'proj-e2e-hosting',
    project_name: 'Hosting E2E',
    tynn_project_id: 'proj-e2e-hosting',
    tynn_project_name: 'Hosting E2E',
    shape: 'simple',
    path: 'C:/e2e/hosting-workspace',
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
};

export default function E2EHosting() {
    const [panelOpen, setPanelOpen] = useState(false);
    // The real Settings page persists this through `settings:set`; the harness
    // holds it locally, because the Genie Browser toggle is not under test and
    // writing it would mutate the E2E profile between runs.
    const [genieBrowser, setGenieBrowser] = useState(true);

    return (
        // A plain scrolling column, NOT the `.set-shell` frame: that is
        // `height:100vh` with an `overflow:hidden` main, so the sections below
        // the fold would be clipped out of reach instead of scrolled to. The
        // sections style themselves — `.set-section` / `.set-row` / `.ws-*` are
        // all standalone.
        <div
            data-testid="e2e-hosting-root"
            className="settings-tab"
            style={{
                height: '100vh',
                overflowY: 'auto',
                padding: '18px 20px 28px',
                background: 'var(--bg-0, #0a0a0c)',
                color: 'var(--fg-1, #e6e6e6)',
            }}
        >
            <button
                type="button"
                data-testid="open-hosting-panel"
                onClick={() => setPanelOpen(true)}
            >
                Open the workspace Hosting panel
            </button>
            {!panelOpen && <span data-testid="panel-closed">Hosting panel closed</span>}

            {/* Settings → Toolchain. Its own PAGE in the product (the toolchain
                is the machine's concern; hosting merely consumes it), mounted
                here beside the Hosting Manager because both drive the same
                faked `toolchain:*` / `dev:*` channels in main. */}
            <ToolchainSection />

            <DevServerSection
                genieBrowserEnabled={genieBrowser}
                onGenieBrowserChange={setGenieBrowser}
            />

            {panelOpen && (
                <WorkspaceSiteManager
                    workspace={WORKSPACE}
                    onClose={() => setPanelOpen(false)}
                />
            )}
        </div>
    );
}
