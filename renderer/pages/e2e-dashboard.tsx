import { Dashboard } from '../components/Master/Dashboard';
import type { AgentSession } from '../../main/agentsession/model';

/**
 * E2E harness for the WORKFLOW DASHBOARD. NOT product UI.
 *
 * Mounts the REAL component inside `.gwrap`, because the colour tokens are declared there
 * rather than on `:root` — the genie#114 failure mode, and the reason the agent-view harness
 * says the same thing.
 *
 * ## Why this surface needs a real window at all
 *
 * `dashboard-view.ts` has 25 unit tests and they cover the decisions. What they cannot cover
 * is whether the decisions SURVIVE being rendered: that an Observed agent's context cell is
 * genuinely absent from the DOM rather than merely `null` in a projection, that a row below
 * the context threshold draws nothing rather than a `0`, and that the sort order a human sees
 * is the one the comparator produced. This repository's own history is five defects past two
 * thousand green unit tests, so "the projection is right" and "the screen is right" are
 * separate claims.
 *
 * ## The fixture is built to exercise the RULES, not to look plausible
 *
 * One agent per decided behaviour, and the sort order is deliberately the reverse of the
 * expected output so a spec asserting the order cannot pass by accident — the same reason the
 * `workspace-changes` fixtures put array order and time order in disagreement.
 */

const NOW = 1_700_000_000_000;

function session(over: Partial<AgentSession> & { agentId: string; name: string }): AgentSession {
    const { name, session: sessionOver, ...rest } = over;
    const base: AgentSession = {
        agentId: over.agentId,
        specId: `spec-${over.agentId}`,
        session: {
            provider: 'claude',
            name,
            cwd: '/w/tynn',
            workspaceId: 'tynn',
            sessionId: null,
        },
        turn: { state: 'idle', since: NOW - 60_000 },
        // Declared by default: a `plan` of `[]` is a DECLARATION (the agent says it has none),
        // which is what makes most of these rows "declared" without saying so at each one.
        // The observed agent below strips every declared-only field to become observed.
        composer: null,
        transcript: [],
        live: null,
        thoughts: [],
        liveThought: null,
        tools: [],
        approvals: [],
        rateLimit: null,
        rateLimitUnavailable: null,
        plan: [],
        usage: null,
        commands: null,
        error: null,
    };
    return {
        ...base,
        ...rest,
        session: { ...base.session, ...(sessionOver ?? {}) },
    };
}

/**
 * IDLE FIRST in the array, waiting LAST — the opposite of the order the board specifies.
 *
 * So a spec asserting `waiting → broken → working → idle` is asserting the comparator, not
 * the fixture's own layout. A fixture already in the expected order makes an ordering test
 * untestable, which is a hole a break-probe found in this session's `workspace-changes` tests.
 */
const SESSIONS: AgentSession[] = [
    // IDLE, and declared (it has a plan, which is a declaration even when empty).
    session({ agentId: 'a-idle', name: 'sable', turn: { state: 'idle', since: NOW - 2_520_000 } }),

    // OBSERVED: no declared-only field at all. Must read "Quiet", not "Idle", and must have
    // NO context cell — absence of a control, not an empty one.
    (() => {
        const s = session({ agentId: 'a-obs', name: 'moth' });
        return {
            ...s,
            session: { ...s.session, provider: 'aider' },
            plan: null,
            composer: null,
            usage: null,
            commands: null,
            rateLimit: null,
        };
    })(),

    // WORKING, declared, with a plan and a context reading BELOW the 160k threshold — the
    // cell is drawn and holds nothing. And an edit tool call, so "latest delivery" names a file.
    session({
        agentId: 'a-work',
        name: 'atlas',
        turn: { state: 'tool', since: NOW - 720_000 },
        plan: [
            { id: 'p1', title: 'read the auth flow', status: 'done' },
            { id: 'p2', title: 'Passkey enrolment endpoint', status: 'in-progress' },
            { id: 'p3', title: 'feature tests', status: 'pending' },
        ],
        usage: { contextUsed: 40_000, contextMax: 200_000, costUsd: 1.2 },
        tools: [
            {
                id: 't1',
                name: 'Write',
                status: 'success',
                kind: 'edit',
                rawInput: { file_path: '/w/tynn/src/Auth/ChallengeStore.php' },
                result: null,
                at: NOW - 180_000,
            },
        ],
    }),

    // WORKING with context ABOVE the critical threshold, so the bar and label appear in red.
    session({
        agentId: 'a-hot',
        name: 'quill',
        turn: { state: 'tool', since: NOW - 60_000 },
        plan: [{ id: 'p1', title: 'OpenTelemetry spans', status: 'in-progress' }],
        usage: { contextUsed: 182_000, contextMax: 200_000, costUsd: 3.4 },
    }),

    // BROKEN: must lose its step AND target, and show the reason.
    session({
        agentId: 'a-broken',
        name: 'tern',
        error: 'Provider sign-in expired',
        turn: { state: 'tool', since: NOW - 300_000 },
        plan: [{ id: 'p1', title: 'this target must not render', status: 'in-progress' }],
    }),

    // WAITING: the question ITSELF is the status detail, and the last delivery is KEPT.
    session({
        agentId: 'a-wait',
        name: 'wren',
        turn: { state: 'awaiting-approval', since: NOW - 120_000 },
        approvals: [{ id: 'ap1', name: 'Allow php artisan migrate --force?', args: {} }],
        plan: [],
        tools: [
            {
                id: 't2',
                name: 'Write',
                status: 'success',
                kind: 'edit',
                rawInput: { file_path: '/w/tynn/database/migrations/sessions.php' },
                result: null,
                at: NOW - 660_000,
            },
        ],
    }),
];

export default function E2EDashboard(): React.JSX.Element {
    return (
        <div className="gwrap" style={{ height: '100vh', overflow: 'auto' }}>
            <Dashboard
                sessions={SESSIONS}
                workspaces={[{ id: 'tynn', name: 'tynn', path: '~/work/tynn.agi' }]}
                now={NOW}
            />
        </div>
    );
}
