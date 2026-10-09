import { describe, expect, it } from 'vitest';
import {
    emptyAgentSession,
    type AgentSession,
    type AgentSessionIdentity,
    type Message,
    type ToolCall,
} from '../../../main/agentsession/model';
import { agentActivity, type ActivityKind, type ActivitySourceId } from '../agent-activity';

/**
 * ACTIVITY — what Genie can say about an agent it can only WATCH.
 *
 * The board: *"Activity lists terminal input and output, file writes and commits."* Two of
 * those three Genie does not hold per agent, and the whole value of this surface is that it
 * SAYS SO instead of drawing an empty list that reads as "the agent did nothing". So the
 * tests below are mostly about the difference between a zero and a blank.
 *
 * The discipline is the session model's own: `null` is "cannot see", `[]` is "none". Applied
 * to a count, that means a number on screen is a measurement and an absent number is an
 * admission — and the two must never be swapped, because a confident `0` beside "File writes"
 * is a claim that the agent wrote nothing.
 */

const NOW = 1_000_000;

const IDENTITY: AgentSessionIdentity = {
    agentId: 'atlas',
    specId: 'spec-1',
    provider: 'claude',
    name: 'atlas',
    cwd: '/w',
    workspaceId: 'tynn',
};

function session(over: Partial<AgentSession> = {}): AgentSession {
    const base = emptyAgentSession(IDENTITY, NOW);
    return { ...base, ...over, session: { ...base.session, ...(over.session ?? {}) } };
}

const msg = (over: Partial<Message> & { id: string }): Message => ({
    role: 'user',
    content: 'ship it',
    author: null,
    at: NOW,
    ...over,
});

const tool = (over: Partial<ToolCall> & { id: string }): ToolCall => ({
    name: 'Read',
    status: 'success',
    kind: 'read',
    rawInput: { file_path: '/w/src/Auth/ChallengeStore.php' },
    result: null,
    at: NOW,
    ...over,
});

/** A session with one of everything Genie can observe. The POSITIVE CONTROL for every
 *  absence assertion below — an empty component passes "X is not rendered" trivially. */
const busy = (): AgentSession =>
    session({
        transcript: [
            msg({ id: 'm1', role: 'user', author: 'wren', content: 'can you take the migration', at: 10 }),
            msg({ id: 'm2', role: 'agent', content: 'done, see the handoff', at: 40 }),
        ],
        thoughts: [{ id: 'th1', text: 'no sign-count column', at: 20 }],
        tools: [
            tool({ id: 't1', name: 'Write', kind: 'write', rawInput: { file_path: '/w/main/ipc.ts' }, at: 30 }),
            tool({ id: 't2', at: 25 }),
        ],
    });

const kinds = (s: AgentSession): ActivityKind[] => agentActivity(s).rows.map((r) => r.kind);

const sourceById = (s: AgentSession, id: ActivitySourceId) => {
    const found = agentActivity(s).sources.find((x) => x.id === id);
    if (!found) throw new Error(`no source ${id}`);
    return found;
};

describe('the rows Genie can honestly produce', () => {
    it('POSITIVE CONTROL: one row per observed event, each with the kind its source implies', () => {
        // Everything else in this file asserts something is ABSENT or NULL. Those pass
        // against a projection that returns nothing at all, so this is what proves the
        // projection is alive before the refusals mean anything.
        expect(kinds(busy())).toEqual(['heard', 'thought', 'ran', 'wrote', 'said']);
    });

    it('flattens every row to ONE LINE, speech included', () => {
        /**
         * Where this DIFFERS from the Stream, deliberately. `agent-stream.ts` leaves speech
         * unflattened because *"speech is the one place a human reads prose"*. Activity is not
         * that place — it is a log of what was observed, scanned down the left edge — and a
         * three-line mail row in the middle of it destroys the scan.
         */
        const s = session({ transcript: [msg({ id: 'm1', content: 'first\n\n\n   \tsecond' })] });
        const row = agentActivity(s).rows[0]!;
        expect(row.main).toBe('first second');
        expect(row.main).not.toContain('\n');
    });

    it('names the speaker: a peer by name, the owner as "you", and a role when there is nobody', () => {
        // The same rule as the Stream's, and for the reason recorded there: before authors
        // existed a sibling agent's request read `user` exactly like the owner's, on the one
        // screen whose job is deciding what to do next.
        const s = session({
            transcript: [
                msg({ id: 'm1', author: 'wren' }),
                msg({ id: 'm2', author: null, role: 'user' }),
                msg({ id: 'm3', author: null, role: 'error', content: 'pty closed' }),
            ],
        });
        expect(agentActivity(s).rows.map((r) => r.meta)).toEqual(['wren', 'you', 'error']);
        // And an `error` message reads as bad, because it IS bad — the pty closing or the
        // harness refusing. Its role is the only thing that says so, so dropping the role
        // would also drop the tint.
        expect(agentActivity(s).rows.map((r) => r.level)).toEqual([null, null, 'bad']);
    });

    it('calls an edit-kind call a WRITE and shows the file, not the tool', () => {
        const s = session({
            tools: [tool({ id: 't1', name: 'Write', kind: 'write', rawInput: { file_path: '/w/main/ipc.ts' } })],
        });
        const row = agentActivity(s).rows[0]!;
        expect(row.kind).toBe('wrote');
        expect(row.main).toBe('ipc.ts');
    });

    it('falls back to the tool NAME when the arguments say nothing', () => {
        // A blank row reads as a rendering fault rather than as a tool whose arguments are
        // opaque, and `toolSubject` refuses far more than it accepts by design.
        const s = session({ tools: [tool({ id: 't1', name: 'PowerShell', rawInput: null })] });
        expect(agentActivity(s).rows[0]!.main).toBe('PowerShell');
    });

    it('carries the status of a call that failed or is still running, and nothing for one that worked', () => {
        const s = session({
            tools: [
                tool({ id: 't1', status: 'failure', at: 10 }),
                tool({ id: 't2', status: 'pending', at: 20 }),
                tool({ id: 't3', status: 'success', at: 30 }),
            ],
        });
        const rows = agentActivity(s).rows;
        expect(rows.map((r) => r.meta)).toEqual(['failed', 'running', null]);
        expect(rows.map((r) => r.level)).toEqual(['bad', 'pending', null]);
    });

    it('offers a tool call for inspection and offers NOTHING for a row with nothing behind it', () => {
        // COUNTED rather than checked one row at a time: the bug this guards is `inspect`
        // being set for every row, which any single-row assertion would still pass.
        const view = agentActivity(busy());
        const inspectable = view.rows.filter((r) => r.inspect !== null);
        expect(inspectable.map((r) => r.inspect)).toEqual(['t2', 't1']);
        expect(view.rows.length - inspectable.length).toBe(3);
    });
});

describe('when it happened, and what to do when that is unknown', () => {
    it('orders by the moment Genie saw it', () => {
        expect(agentActivity(busy()).rows.map((r) => r.at)).toEqual([10, 20, 25, 30, 40]);
    });

    it('puts an unstamped row LAST rather than at the dawn of the epoch', () => {
        // `at: null` means nobody stamped it, not 1970. Sorting a null to the front puts the
        // oldest possible position on a fact whose age is unknown — which in practice is the
        // newest thing that arrived.
        const s = session({
            transcript: [msg({ id: 'm1', at: null }), msg({ id: 'm2', at: 500 })],
        });
        expect(agentActivity(s).rows.map((r) => r.id)).toEqual(['msg:m2', 'msg:m1']);
    });

    it('REFUSES a timestamp that is not a real number, instead of throwing inside a render', () => {
        /**
         * `at` is typed `number | null`, and the wire is untrusted all the same —
         * `tool-subject.ts` was written for the same hazard: *"a `file_path` that arrives as a
         * NUMBER would reach the basename split and throw inside a render, taking the
         * transcript with it."* `new Date(NaN).toISOString()` throws a RangeError, so a single
         * bad sample would take out the whole tab.
         */
        const s = session({ transcript: [msg({ id: 'm1', at: Number.NaN })] });
        const row = agentActivity(s).rows[0]!;
        expect(row.at).toBeNull();
        expect(row.iso).toBeNull();
    });

    it('POSITIVE CONTROL: a real timestamp does produce a machine-readable stamp', () => {
        // Without this, the refusal above passes against a projection that never stamps
        // anything.
        const s = session({ transcript: [msg({ id: 'm1', at: 0 })] });
        expect(agentActivity(s).rows[0]!.iso).toBe('1970-01-01T00:00:00.000Z');
    });
});

describe('what is still in flight', () => {
    it('puts the live message and the live thought last, after everything settled', () => {
        const s = session({
            transcript: [msg({ id: 'm1', at: 900_000 })],
            live: msg({ id: 'm2', role: 'agent', content: 'on it', at: 10 }),
            liveThought: { id: 'th2', text: 'the column is missing', at: 20 },
        });
        const rows = agentActivity(s).rows;
        // Their own timestamps are OLDER than the settled row and they still sort last:
        // they are still happening, so no comparison can place them anywhere else honestly.
        expect(rows.map((r) => r.id)).toEqual(['msg:m1', 'msg:m2', 'thought:th2']);
        expect(rows.slice(1).every((r) => r.live)).toBe(true);
    });

    it('WITHHOLDS the text of a thought that is still streaming', () => {
        // The Stream's rule, kept rather than re-decided: a settled thought reads, a streaming
        // one would rewrite its own row on every chunk. The text waits until it stops moving.
        const s = session({ liveThought: { id: 'th1', text: 'half a sentence so f', at: 10 } });
        const row = agentActivity(s).rows[0]!;
        expect(row.main).toBe('Thinking…');
        expect(row.main).not.toContain('half a sentence');
    });
});

describe('the sources panel — a count is a measurement, a blank is an admission', () => {
    it('counts messages even when there are none, because Genie OWNS that channel', () => {
        /**
         * `0` is honest here and nowhere else on this panel. The floor projector fills
         * `transcript` from AgentInbox mail and the last `imDone` handoff for all twenty-one
         * providers, so an empty one really does mean nothing was exchanged.
         */
        const mail = sourceById(session(), 'mail');
        expect(mail.count).toBe(0);
        expect(mail.unavailable).toBeNull();
    });

    it('says it CANNOT SEE file writes rather than reporting zero of them', () => {
        const empty = session();
        expect(sourceById(empty, 'files').count).toBeNull();
        expect(sourceById(empty, 'files').unavailable).toBeTruthy();
        // POSITIVE CONTROL in the same session: `mail` does carry a number, so this is the
        // null/zero distinction being drawn and not a panel that reports nothing at all.
        expect(sourceById(empty, 'mail').count).toBe(0);
    });

    it('counts ZERO writes once the agent is reporting its tool calls at all', () => {
        /**
         * The discriminator is whether ANY tool call arrived — not whether a write did. An
         * agent whose calls Genie can see and which has only read files has genuinely written
         * nothing, and that is worth saying. This is `read-buffer.ts`'s distinction applied to
         * a different subject: *"0 bytes because we hold no buffer"* is not *"0 bytes because
         * the terminal is quiet"*.
         */
        const reading = session({ tools: [tool({ id: 't1', kind: 'read' })] });
        expect(sourceById(reading, 'files').count).toBe(0);
        expect(sourceById(reading, 'files').unavailable).toBeNull();
        expect(sourceById(reading, 'tools').count).toBe(1);
    });

    it('never reports terminal I/O or commits, in the busiest session there is', () => {
        /**
         * Both are on the board and NEITHER reaches this model, so they are listed as blind
         * rather than quietly dropped — an omitted source is indistinguishable from a source
         * with nothing in it.
         *
         * Terminal bytes: `project-floor.ts` measured and recorded why there is no per-agent
         * signal — *"Genie counts pty bytes per WORKSPACE … so a byte-derived signal here
         * would report a SIBLING agent's output as this agent thinking."*
         *
         * Commits: nothing in `AgentSession` carries one. `workspace-changes.ts` builds the
         * Changes surface from tool calls alone for the same reason.
         *
         * Asserted against `busy()` on purpose: a blindness that only holds for an empty
         * session is a blindness nobody has tested.
         */
        for (const id of ['terminal', 'commits'] as const) {
            expect(sourceById(busy(), id).count).toBeNull();
            expect(sourceById(busy(), id).unavailable).toBeTruthy();
        }
        // POSITIVE CONTROL: the same call does produce counts for what it can see.
        expect(sourceById(busy(), 'mail').count).toBe(2);
        expect(sourceById(busy(), 'files').count).toBe(1);
    });

    it('gives every blind source a reason and every counted source none', () => {
        // The invariant rather than a sample: a null count with no explanation leaves no gauge
        // AND no reason, which `rateLimitUnavailable` exists in the model to prevent.
        for (const s of [session(), busy()]) {
            for (const source of agentActivity(s).sources) {
                expect(source.unavailable === null).toBe(source.count !== null);
                expect(source.label.length).toBeGreaterThan(0);
            }
        }
    });

    it('counts exactly the rows it produced, so the panel and the list cannot disagree', () => {
        const view = agentActivity(busy());
        const counted = view.sources.reduce((sum, s) => sum + (s.count ?? 0), 0);
        expect(counted).toBe(view.rows.length);
    });
});
