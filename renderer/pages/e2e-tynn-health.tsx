import { useState } from 'react';
import TynnHealthIndicator from '../components/Master/TynnHealthIndicator';
import {
    classifyTynnHealth,
    type HttpObservation,
} from '../../main/mcp/tynn-health';

/**
 * E2E harness page for the Tynn MCP health indicator. NOT product UI.
 *
 * It mounts the REAL `TynnHealthIndicator` — real Fancy `Popover`, real hover
 * behaviour, real stylesheet — against health objects produced by the REAL
 * classifier (`classifyTynnHealth`, which is pure and so bundles into the
 * renderer untouched). Nothing is mocked between the raw HTTP observation and
 * the pixels, which is exactly the seam the unit tests cannot reach: they prove
 * the message text, this proves the message text ARRIVES ON SCREEN.
 *
 * The scenario that matters is the middle one. `http://tynn.ai/mcp/tynn`
 * answers 301; a followed redirect turns the POST into a GET; laravel/mcp
 * answers 405; every agent in the workspace goes silently toolless. If the
 * popover ever stops naming that, this spec fails.
 */

const WS = { workspaceId: 'ws-e2e', workspaceName: 'tynn.ai' };

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpObservation {
    return { kind: 'response', status, headers, bodyText: JSON.stringify(body) };
}

const INIT_OK = response(200, { jsonrpc: '2.0', id: 1, result: {} });
const TOOLS_OK = response(200, {
    jsonrpc: '2.0',
    id: 2,
    result: { tools: [{ name: 'project' }, { name: 'find' }, { name: 'create' }] },
});

const SCENARIOS = {
    healthy: classifyTynnHealth({
        ...WS,
        url: 'https://tynn.ai/mcp/tynn',
        token: 'tok',
        initialize: INIT_OK,
        toolsList: TOOLS_OK,
    }),
    // The incident, exactly as it happened.
    redirect: classifyTynnHealth({
        ...WS,
        url: 'http://tynn.ai/mcp/tynn',
        token: 'tok',
        initialize: {
            kind: 'response',
            status: 301,
            headers: { location: 'https://tynn.ai/mcp/tynn' },
            bodyText: '',
        },
    }),
    unauthorized: classifyTynnHealth({
        ...WS,
        url: 'https://tynn.ai/mcp/tynn',
        token: 'tok',
        initialize: { kind: 'response', status: 401, headers: {}, bodyText: 'Unauthenticated.' },
    }),
} as const;

type ScenarioKey = keyof typeof SCENARIOS;

export default function E2ETynnHealth() {
    const [scenario, setScenario] = useState<ScenarioKey>('healthy');
    const [rechecks, setRechecks] = useState(0);

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', padding: 24, color: '#e4e4e7' }}
        >
            <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
                {(Object.keys(SCENARIOS) as ScenarioKey[]).map((key) => (
                    <button
                        key={key}
                        type="button"
                        data-testid={`scenario-${key}`}
                        onClick={() => setScenario(key)}
                    >
                        {key}
                    </button>
                ))}
            </div>
            {/* The same `.glogo` wrapper the sidebar uses, so the indicator is
                laid out and painted exactly as it ships. */}
            <span className="glogo">
                <TynnHealthIndicator
                    health={SCENARIOS[scenario]}
                    checking={false}
                    onRecheck={() => setRechecks((n) => n + 1)}
                >
                    <img className="lamp" src="./logo.png" alt="" width={22} height={22} />
                </TynnHealthIndicator>
                <span className="glogo-text">Genie</span>
            </span>
            <div data-testid="recheck-count" style={{ marginTop: 24 }}>
                {rechecks}
            </div>
        </div>
    );
}
