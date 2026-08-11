import { useEffect, useState } from 'react';
import PluginPanelBody from '../components/Plugins/PluginPanelBody';
import { api, type TerminalSpec, type WorkspaceRow } from '../lib/genie';

/**
 * E2E harness page for the REPOSITORY PANEL — the first plugin-panel consumer.
 * NOT product UI: it mounts the REAL PluginPanelBody (which resolves the declared
 * `RepoChangesPanel` export through the compile-time adapter registry) against the
 * REAL `repo:*` host git binding, so a Playwright Electron test can drive the full
 * chain without the master window.
 *
 * Nothing is mocked. The git repo + workspace are seeded by `seedRepoE2E`
 * (main/e2e/repo.ts) before this window opens; we resolve the workspace by LISTING
 * so the harness fails loudly if seeding regressed rather than rendering a panel
 * bound to a repo that doesn't exist.
 */
export default function E2ERepoPanel() {
    const [workspace, setWorkspace] = useState<WorkspaceRow | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const list = await api().workspaces.list();
                if (!alive) return;
                const ws = list.find((w) => w.id === 'e2e-repo-panel');
                if (!ws) {
                    setError(
                        `seed missing: expected workspace "e2e-repo-panel", got [${list
                            .map((w) => w.id)
                            .join(', ')}]`,
                    );
                    return;
                }
                setWorkspace(ws);
            } catch (e) {
                if (alive) setError(`workspaces.list failed: ${String(e)}`);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    // A minimal plugin-panel spec that declares the vetted RepoChangesPanel export
    // — the same meta addPluginPanel() would persist when opened from the launcher.
    const spec: TerminalSpec | null = workspace
        ? {
              id: 'e2e-repo-panel-spec',
              workspace_id: workspace.id,
              label: 'Repository',
              cwd: workspace.path,
              shell: null,
              args: [],
              env: {},
              type: 'plugin-panel',
              meta: {
                  plugin_id: 'ai.genie.repository',
                  panel_id: 'changes',
                  panel_title: 'Repository',
                  fancy_export: 'RepoChangesPanel',
                  fancy_package: '@particle-academy/fancy-git-ui',
                  fancy_version: '>=0.5.0',
              },
              sort_order: 0,
              created_at: '',
              last_opened_at: null,
              snapshot_at: null,
              snapshot_bytes: null,
              live_cwd: null,
              enabled: true,
          }
        : null;

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', color: '#e6e6e6' }}
        >
            {error && <div data-testid="e2e-error">{error}</div>}
            {spec && workspace && <PluginPanelBody spec={spec} workspace={workspace} />}
        </div>
    );
}
