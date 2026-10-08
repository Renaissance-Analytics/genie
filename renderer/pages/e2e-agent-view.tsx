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
 *
 * ## The WRITE handlers are here because they had no caller at all
 *
 * `onApprove` and `onTakeOver` were declared by the component and passed by nothing in the
 * product; there was no composer; and `terminal:write` reaches a pty, which for an ACP agent is
 * an empty shell. So the default surface of Genie 2 could display an agent and not speak to it.
 * `onSend` and `onCancel` exist now and `master.tsx` wires all four to
 * `agentSession.prompt|cancel|decide` — these specs are the half that proves a human can act.
 */

const NOW = 1_700_000_000_000;

const base: AgentSessionSpec = {
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: 'repos/genie', workspaceId: 'w1', sessionId: 'sess' },
    turn: { state: 'awaiting-approval', since: NOW - 8_000 },
    /**
     * A REAL rate-limit reading, in the shape prism actually sends.
     *
     * The gauge is the one number the owner judges this migration by, and it had never rendered
     * in a window — `rateLimit` reached the session model, the types and this fixture's `null`,
     * and no surface read it. 13% used is one of the three values measured off live traffic.
     */
    rateLimit: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        windows: { five_hour: { utilization: 0.13, resetsAtMs: NOW + 3_600_000 } },
        notice: null,
    } as never,
    rateLimitUnavailable: null,
    composer: { text: '', cursor: 0, busy: false },
    transcript: [{ id: 'm1', role: 'user', content: 'the pty host dies on upgrade' }],
    // A SETTLED thought and nothing live: the fixture shows the readable state, because a
    // live thought renders as "Thinking…" with its text withheld and would assert nothing.
    thoughts: [
        {
            id: 'th1',
            text: 'feedTerminalData is called from two places; the second one bypasses the guard…',
            at: NOW - 4_000,
        },
    ],
    liveThought: null,
    live: null,
    // A PENDING call genuinely has no arguments and no result yet: measured, `rawInput`
    // arrives on the `in_progress` frame and the result on the closing one. So the nulls here
    // are the realistic state of a call that has only just been announced, not placeholders —
    // and `kind` is null because this frame did not declare one.
    tools: [{ id: 't1', name: 'Bash', status: 'pending', kind: null, rawInput: null, result: null, at: NOW }],
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
    /**
     * `rateLimit` HAS to be cleared here, and it is not cosmetic: it is one of
     * `DECLARED_ONLY_FIELDS`, so inheriting the base fixture's reading makes this session
     * DECLARED and the "different shape" assertion reads `data-fidelity="declared"`.
     *
     * Caught on CI on all three platforms the moment the base fixture gained a reading. It is
     * also true to life — a pty agent reports no rate limit, which is the whole reason the
     * field counts as a declaration.
     */
    rateLimit: null,
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
                // The TEXT, not merely that Send was pressed: a composer that sent an empty
                // string, or the placeholder, would pass an assertion about the click alone.
                onSend={(text) => record(`send:${text}`)}
                onCancel={() => record('cancel')}
            />
        </div>
    );
}
