import { useEffect, useState } from 'react';
import { AgentAccessPanel } from '../components/Master/WorkspaceSettingsModal';
import { api } from '../lib/genie';

/**
 * E2E harness page for the per-workspace AGENT ACCESS control (Tynn story #218).
 * NOT product UI — it exists so a Playwright Electron test can drive the REAL
 * AgentAccessPanel without standing up the whole master window.
 *
 * Unlike the GitHub/IssueWatch harnesses, NOTHING here is mocked: the panel talks
 * to the real `workspaces:*` IPC against the real sqlite in the throwaway E2E
 * profile. That is the entire point — the spec is validating the chain the unit
 * tests can't reach (v27 migration → accessors → IPC → preload → renderer).
 *
 * The workspace it targets is seeded by `seedAgentAccessE2E` (main/e2e/
 * agent-access.ts) before this window opens. We resolve it by LISTING rather than
 * hardcoding the id, so the harness fails loudly if seeding regressed instead of
 * silently rendering a panel bound to a workspace that doesn't exist — which
 * would make every persistence assertion vacuous.
 */
export default function E2EAgentAccess() {
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const list = await api().workspaces.list();
                if (!alive) return;
                const primary = list.find((w) => w.id === 'e2e-agent-access-primary');
                if (!primary) {
                    setError(
                        `seed missing: expected workspace "e2e-agent-access-primary", got [${list
                            .map((w) => w.id)
                            .join(', ')}]`,
                    );
                    return;
                }
                setWorkspaceId(primary.id);
            } catch (e) {
                if (alive) setError(`workspaces.list failed: ${String(e)}`);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', color: '#e6e6e6', padding: 16 }}
        >
            {error && <div data-testid="e2e-error">{error}</div>}
            {workspaceId && <AgentAccessPanel workspaceId={workspaceId} />}
        </div>
    );
}
