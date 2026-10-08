import { AgentStream } from '../components/Master/AgentStream';
import type { AgentSession } from '../../main/agentsession/model';

/**
 * E2E harness for the AGENT STREAM and its Inspector. NOT product UI.
 *
 * Inside `.gwrap` so the colour tokens resolve — they are declared there, not on `:root`
 * (genie#114), which is the same reason the other harnesses say so.
 *
 * ## Why this surface in particular needs a real window
 *
 * The Stream's central claim is STRUCTURAL and therefore invisible to a unit test:
 *
 *  - an EVENT row is exactly one line, **whatever arrives** — so a thought containing newlines
 *    must still occupy one row's height, not three;
 *  - opening a row fills the Inspector and **the rows above it do not move**.
 *
 * The second is a layout fact. `agent-stream.ts` flattens the text, which a unit test asserts,
 * but nothing in a projection can prove that the rendered rows hold still — and "the rows hold
 * still" is the entire reason the design makes an event row unable to grow. A stylesheet one
 * careless override away from losing `nowrap` would pass every unit test in the file.
 *
 * The fixture therefore includes a deliberately multi-line thought and a live one, because
 * those are the two cases that would move things.
 */

const NOW = 1_700_000_000_000;

const SESSION: AgentSession = {
    agentId: 'atlas',
    specId: 'spec-atlas',
    session: {
        provider: 'claude',
        name: 'atlas',
        cwd: '/w/tynn',
        workspaceId: 'tynn',
        sessionId: null,
    },
    turn: { state: 'tool', since: NOW - 40_000 },
    composer: null,
    transcript: [
        { id: 'm1', role: 'user', author: null, content: 'Keep the controller thin.', at: NOW - 300_000 },
        {
            id: 'm2',
            role: 'agent',
            author: null,
            content: 'ChallengeStore is committed.\n\nStarting the enrolment endpoint next.',
            at: NOW - 120_000,
        },
        // Another agent's message — the author must be NAMED, not labelled "user" like the
        // owner's. That distinction is what `speakerOf` existed for and the Stream inherited.
        { id: 'm3', role: 'user', author: 'wren', content: 'sessions migration needs passkey_id', at: NOW - 100_000 },
    ],
    live: null,
    thoughts: [
        // MULTI-LINE ON PURPOSE. Flattened to one line by the projection; this fixture is what
        // proves the rendered row is one line high rather than three.
        {
            id: 'th1',
            text: 'No sign-count column.\nEither add a migration\n\nor ask wren — wren owns the sessions migration…',
            at: NOW - 280_000,
        },
        { id: 'th2', text: 'webauthn-lib is not in composer.json yet; check before writing.', at: NOW - 200_000 },
    ],
    // A LIVE thought: the row must read "Thinking…" and must NOT contain this text.
    liveThought: { id: 'th-live', text: 'SECRETREASONING that must never reach the screen', at: NOW - 5_000 },
    tools: [
        {
            id: 't-edit',
            name: 'Write',
            status: 'success',
            kind: 'edit',
            rawInput: { file_path: '/w/tynn/src/Auth/ChallengeStore.php', content: 'final class ChallengeStore {}' },
            result: [
                {
                    type: 'content',
                    content: { type: 'text', text: 'File created successfully at: src/Auth/ChallengeStore.php' },
                },
            ],
            at: NOW - 240_000,
        },
        {
            id: 't-read',
            name: 'Read',
            status: 'success',
            kind: 'read',
            rawInput: { file_path: '/w/tynn/composer.json' },
            result: null,
            at: NOW - 220_000,
        },
        {
            id: 't-failed',
            name: 'Bash',
            status: 'failure',
            kind: 'execute',
            rawInput: { command: 'php artisan test --filter=Passkey' },
            result: [{ type: 'content', content: { type: 'text', text: 'class Webauthn\\… not found' } }],
            at: NOW - 160_000,
        },
        {
            id: 't-pending',
            name: 'Bash',
            status: 'pending',
            kind: 'execute',
            rawInput: null,
            result: null,
            at: NOW - 20_000,
        },
    ],
    approvals: [],
    rateLimit: null,
    rateLimitUnavailable: null,
    plan: [
        { id: 'p1', title: 'ChallengeStore on cache', status: 'done' },
        { id: 'p2', title: 'Passkey enrolment endpoint', status: 'in-progress' },
    ],
    usage: { contextUsed: 173_000, contextMax: 200_000, costUsd: 1.84 },
    commands: null,
    error: null,
};

export default function E2EStream(): React.JSX.Element {
    return (
        <div className="gwrap" style={{ height: '100vh', overflow: 'hidden' }}>
            {/* A BOUNDED height, deliberately: the "rows do not move" assertion is meaningless
                in a page that grows to fit its content, because nothing would ever scroll or
                be displaced. This is the shape the Agent view actually gives it. */}
            <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <AgentStream session={SESSION} now={NOW} />
            </div>
        </div>
    );
}
