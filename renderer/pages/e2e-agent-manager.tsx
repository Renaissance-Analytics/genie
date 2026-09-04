import { useEffect, useState } from 'react';
import AgentManager from '../components/Master/AgentManager';
import { api } from '../lib/genie';

/**
 * E2E harness page for the AGENT MANAGER (Tynn #709 / story #263).
 *
 * NOT product UI — it exists so a Playwright Electron test can drive the REAL
 * `AgentManager` without standing up the whole master window.
 *
 * Nothing is mocked. The component talks to the real `agents:*` IPC, which reads
 * and writes the real `AGENT.md` and `.mcp.json` seeded by `seedAgentManagerE2E`
 * (main/e2e/agent-manager.ts) in the throwaway E2E profile. That is the entire
 * point: the unit suite pins the pure decisions, and only this run proves the
 * chain — file → parse → IPC → preload → renderer → edit → IPC → render → file —
 * actually delivers them. A save that never reached disk would look identical on
 * screen to one that did.
 *
 * The agent is resolved by LISTING rather than hardcoding the id, so a regressed
 * seed fails loudly here instead of rendering a manager bound to an agent that
 * does not exist — which would make every assertion below it vacuous.
 */
export default function E2EAgentManager() {
    const [agentId, setAgentId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const { agents } = await api().agents.list('e2e-agent-manager-ws');
                if (!alive) return;
                const target = agents.find((a) => a.name === 'moic');
                if (!target) {
                    setError(
                        `seed missing: expected agent "moic", got [${agents
                            .map((a) => a.name)
                            .join(', ')}]`,
                    );
                    return;
                }
                setAgentId(target.id);
            } catch (e) {
                if (alive) setError(`agents.list failed: ${String(e)}`);
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
            {agentId && (
                <AgentManager
                    agentId={agentId}
                    identity={
                        <div data-testid="agent-manager-identity">
                            The identity controls live here in the product.
                        </div>
                    }
                />
            )}
        </div>
    );
}
