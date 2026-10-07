import { useState } from 'react';
import { AgentView } from '../components/Master/AgentView';
import type { AgentSessionSpec } from '../lib/genie';
import type { AgentViewTab } from '../lib/agent-view';

/**
 * E2E harness for the AGENT VIEW. NOT product UI.
 *
 * Mounts the REAL component, inside `.gwrap` so the colour tokens resolve (they are declared
 * there, not on `:root` — the genie#114 failure mode).
 *
 * `?fidelity=observed` switches the session so one spec can prove the shape CHANGES. The
 * rule under test is "absence of a tab, not a disabled tab": an Observed agent must have no
 * Conversation tab at all, because Genie only sees bytes and a greyed-out tab would tell the
 * user they did something wrong.
 *
 * Decisions are recorded on `window` so a spec can assert WHICH outcome a click produced —
 * "a button was clickable" would pass even if Allow sent Deny.
 */

const NOW = 1_700_000_000_000;

const base: AgentSessionSpec = {
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: 'repos/genie', workspaceId: 'w1', sessionId: 'sess' },
    turn: { state: 'awaiting-approval', since: NOW - 8_000 },
    rateLimit: null,
    rateLimitUnavailable: null,
    composer: { text: '', cursor: 0, busy: false },
    transcript: [{ id: 'm1', role: 'user', content: 'the pty host dies on upgrade' }],
    live: null,
    tools: [{ id: 't1', name: 'Bash', status: 'pending' }],
    approvals: [{ id: 'ap1', name: 'Write main/terminal/ipc.ts', args: {} }],
    plan: [
        { id: 'p1', title: 'read ipc.ts', status: 'done' },
        { id: 'p2', title: 'patch feedTerminalData', status: 'in-progress' },
    ],
    usage: { contextUsed: 178_000, contextMax: 200_000, costUsd: 1.84 },
    commands: [{ name: 'compact', hint: null }],
    error: null,
};

/** The same agent with NOTHING declared — every pty provider. */
const observed: AgentSessionSpec = {
    ...base,
    composer: null,
    plan: null,
    usage: null,
    commands: null,
    turn: { state: 'tool', since: NOW - 4_000 },
    approvals: [],
};

export default function E2EAgentViewPage() {
    const [tab, setTab] = useState<AgentViewTab | undefined>(undefined);

    const search = typeof window !== 'undefined' ? window.location.search : '';
    const session = search.includes('fidelity=observed') ? observed : base;

    const record = (entry: string) => {
        const w = window as unknown as { __AGENT_CLICKS__?: string[] };
        w.__AGENT_CLICKS__ = [...(w.__AGENT_CLICKS__ ?? []), entry];
    };

    return (
        <div className="gwrap" style={{ height: '100vh', overflow: 'auto' }}>
            <AgentView
                session={session}
                now={NOW}
                {...(tab ? { tab } : {})}
                onTab={(t) => {
                    setTab(t);
                    record(`tab:${t}`);
                }}
                onApprove={(id, decision) => record(`approve:${id}:${decision}`)}
                onTakeOver={() => record('takeover')}
            />
        </div>
    );
}
