import { describe, expect, it } from 'vitest';
import { mergeDeclared } from '../merge-declared';
import { emptyAgentSession, sessionFidelity, type AgentSession } from '../model';

/**
 * Declared data over the floor projection — P3's reducer, finally written.
 *
 * The plan states the rule in one line: *"declared fields win, floor fields survive where a
 * report is silent."* It was never built, which is why the whole declared path was
 * disconnected: `applySessionUpdate` mapped ACP's twenty update kinds into an `AgentSession`
 * and nothing merged the result with what Genie already knew.
 *
 * ## The rule, and why "silent" is the hard part
 *
 * A declared field is authoritative when the agent SAID something — including when it said
 * "nothing". `plan: []` is a declaration that there is no plan; `plan: null` is the agent
 * not having mentioned plans. The first must win over the floor, the second must not erase
 * it. Every case below is that distinction.
 */

const NOW = 1_700_000_000_000;
const identity = {
    agentId: 'ag-1',
    specId: 'spec-1',
    name: 'kai',
    provider: 'claude',
    cwd: '/repo',
    workspaceId: 'ws-1',
};

/** What the floor projector produces: turn, transcript, approvals, error — nothing else. */
const floor = (over: Partial<AgentSession> = {}): AgentSession => ({
    ...emptyAgentSession(identity, NOW),
    turn: { state: 'thinking', since: NOW - 5_000 },
    transcript: [{ id: 'm1', role: 'agent', content: 'from the inbox' }],
    error: 'host lost',
    ...over,
});

/** What the ACP mapper produces. */
const declared = (over: Partial<AgentSession> = {}): AgentSession => ({
    ...emptyAgentSession(identity, NOW),
    ...over,
});

describe('mergeDeclared — a declared field wins', () => {
    it('takes the declared turn state over the inferred one', () => {
        // The whole point of the exercise: the agent says what it is doing instead of Genie
        // guessing from byte activity.
        const m = mergeDeclared(floor(), declared({ turn: { state: 'tool', since: NOW } }));
        expect(m.turn).toEqual({ state: 'tool', since: NOW });
    });

    it('takes declared usage, plan and commands, which the floor never has', () => {
        const m = mergeDeclared(
            floor(),
            declared({
                usage: { contextUsed: 38_000, contextMax: 200_000, costUsd: 0.91 },
                plan: [{ id: 'p1', title: 'read ipc.ts', status: 'done' }],
                commands: [{ name: 'compact', hint: null }],
            }),
        );
        expect(m.usage).toMatchObject({ costUsd: 0.91 });
        expect(m.plan).toHaveLength(1);
        expect(m.commands).toHaveLength(1);
    });

    it('makes the merged session DECLARED, so the right surface renders', () => {
        // The payoff. Floor-only is `observed` (Terminal-first tabs); once anything is
        // declared the Agent view shows the Conversation tab instead.
        expect(sessionFidelity(floor())).toBe('observed');
        expect(sessionFidelity(mergeDeclared(floor(), declared({ plan: [] })))).toBe('declared');
    });
});

/**
 * THE TRANSCRIPT IS ONE CONVERSATION, not two — P7's *"human↔agent DMs fold into the Agent
 * Conversation"*.
 *
 * ## The defect this replaces
 *
 * The rule used to be `declared.transcript.length > 0 ? declared.transcript : floor.transcript`
 * — the declared conversation REPLACES the projected one. Read as "a real conversation beats
 * projected mail", that sounds right. It is not, and **measuring a real claude ACP session is
 * what settled it** (`handshake.real.test.ts`, logged on every run):
 *
 * ```
 * [acp transcript] live=agent_message_chunk,notice,usage_update | replay=(0) none
 * ```
 *
 * The declared stream carries the **agent's voice only**. The owner's prompt is never echoed
 * as `user_message_chunk` while the session runs, and `session/load` on the CLI's own session
 * id replays **nothing at all**. So the old rule deleted the entire human half of the
 * conversation the moment the agent said one word — and it deleted it from the one surface P7
 * makes the place you talk to an agent.
 *
 * It also settles the fear that argued for replacement in the first place. A DM to an ACP agent
 * is delivered as a prompt (`acpMailSender`), so concatenating looked like it would show every
 * DM twice. It cannot: there is no second copy to collide with.
 *
 * ## Ordering, which is why `Message.at` exists
 *
 * Mail arriving DURING a session is the normal case for a working agent, so appending one
 * stream to the other would put the owner's interruption above the reply it provoked. Both
 * producers stamp `at`, and the merge is by time.
 */
describe('mergeDeclared — the human half of the conversation survives', () => {
    const at = (n: number) => NOW + n;

    it('INTERLEAVES the DM thread with the declared turn, by time', () => {
        const m = mergeDeclared(
            floor({
                transcript: [
                    { id: 'm1', role: 'user', content: 'start on the lists dock', at: at(0) },
                    { id: 'm2', role: 'user', content: 'actually do the icons first', at: at(20) },
                ],
            }),
            declared({
                transcript: [
                    { id: 'd1', role: 'agent', content: 'reading master.tsx', at: at(10) },
                    { id: 'd2', role: 'agent', content: 'switching to the icons', at: at(30) },
                ],
            }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'd1', 'm2', 'd2']);
    });

    it('keeps a sibling agent\'s DM and its author, which ACP cannot express at all', () => {
        // The sharpest case: ACP has no notion of an author, so a message from another agent
        // exists ONLY on the floor side. Replacing the floor transcript lost it outright.
        const m = mergeDeclared(
            floor({
                transcript: [{ id: 'm1', role: 'user', author: 'prism', content: '0.5.0 is up', at: at(0) }],
            }),
            declared({ transcript: [{ id: 'd1', role: 'agent', content: 'installing', at: at(5) }] }),
        );
        expect(m.transcript).toEqual([
            { id: 'm1', role: 'user', author: 'prism', content: '0.5.0 is up', at: at(0) },
            { id: 'd1', role: 'agent', content: 'installing', at: at(5) },
        ]);
    });

    it('keeps the handoff, which is the floor\'s and never the session\'s', () => {
        // `handoff:<agentId>` is written by `imDone` and projected by the floor. A resumed
        // session replays nothing, so this is the only record of what the last run did.
        const m = mergeDeclared(
            floor({
                transcript: [{ id: 'handoff:ag-1', role: 'agent', content: 'left the dock undone', at: at(0) }],
            }),
            declared({ transcript: [{ id: 'd1', role: 'agent', content: 'picking it up', at: at(1) }] }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['handoff:ag-1', 'd1']);
    });

    it('appends an UNSTAMPED declared stream rather than guessing where it goes', () => {
        // A `reportState` harness need not carry timestamps. "I do not know when" has one
        // honest position relative to times we do know, and that is last — which is also what
        // the surface did before, so no ordering information is lost.
        const m = mergeDeclared(
            floor({ transcript: [{ id: 'm1', role: 'user', content: 'hello', at: at(500) }] }),
            declared({ transcript: [{ id: 'd1', role: 'agent', content: 'hi' }] }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'd1']);
    });

    it('keeps BOTH streams in order when neither is stamped at all', () => {
        // The comparator's sharp edge: `Infinity - Infinity` is NaN, and a comparator returning NaN
        // makes `Array.prototype.sort` implementation-defined by spec. V8 happens to treat it as 0
        // and stay stable, which is exactly the kind of accident that holds until it does not.
        const m = mergeDeclared(
            floor({
                transcript: [
                    { id: 'm1', role: 'user', content: 'one' },
                    { id: 'm2', role: 'user', content: 'two' },
                ],
            }),
            declared({
                transcript: [
                    { id: 'd1', role: 'agent', content: 'three' },
                    { id: 'd2', role: 'agent', content: 'four' },
                ],
            }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'm2', 'd1', 'd2']);
    });

    /**
     * A CODEX ECHO MUST NOT DOUBLE A DM — the case C23's original reasoning worried about, which is
     * false for claude and TRUE for codex.
     *
     * Measured (`handshake-codex.real.test.ts`): codex reports the user's turn as
     * `user_message_chunk` — once per turn on prism-acp 0.5.3, and twice before it, which was prism's
     * own missing lifecycle guard rather than codex's doing. Either way one copy lands in the DECLARED
     * transcript, and a DM delivered through `acpMailSender` is ALSO in the AgentInbox thread, hence
     * in the floor one. Two streams, one message, both legitimate — which no fix on either side
     * changes.
     *
     * The FLOOR copy wins, and that is the whole reason this is resolvable: it carries `author`, so
     * it can say a sibling agent sent it. ACP has no notion of an author, so the echo is anonymous
     * and strictly the poorer record of the same text.
     *
     * One-to-one, so two genuinely identical messages still show as two.
     */
    it('drops a declared echo of a message the FLOOR already has', () => {
        const m = mergeDeclared(
            floor({
                transcript: [{ id: 'm1', role: 'user', author: 'kora', content: 'rebase onto main', at: at(0) }],
            }),
            declared({
                transcript: [
                    { id: 'u-0', role: 'user', author: null, content: 'rebase onto main', at: at(1) },
                    { id: 'd1', role: 'agent', author: null, content: 'rebasing', at: at(2) },
                ],
            }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'd1']);
        // And the one kept is the one that knows WHO.
        expect(m.transcript[0]!.author).toBe('kora');
    });

    it('keeps a declared user message the floor does NOT have', () => {
        // The positive control: suppression is about the floor already holding that text, not about a
        // declared message being `user`. The owner's Conversation prompt has no mail behind it.
        const m = mergeDeclared(
            floor({ transcript: [{ id: 'm1', role: 'user', content: 'one thing', at: at(0) }] }),
            declared({ transcript: [{ id: 'h1', role: 'user', content: 'another thing', at: at(1) }] }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'h1']);
    });

    it('collapses ONE echo per floor message, not every repeat', () => {
        // Two separate DMs of the same text are two messages, and two echoes of them are two echoes.
        // A set-membership test would keep one and drop the rest.
        const m = mergeDeclared(
            floor({
                transcript: [
                    { id: 'm1', role: 'user', content: 'again', at: at(0) },
                    { id: 'm2', role: 'user', content: 'again', at: at(2) },
                ],
            }),
            declared({
                transcript: [
                    { id: 'u1', role: 'user', content: 'again', at: at(1) },
                    { id: 'u2', role: 'user', content: 'again', at: at(3) },
                    { id: 'u3', role: 'user', content: 'again', at: at(4) },
                ],
            }),
        );
        // Two floor messages absorb two echoes; the third has nothing left to match.
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'm2', 'u3']);
    });

    it('never drops an AGENT message that happens to repeat a human one', () => {
        // Roles are not interchangeable: an agent quoting the owner back is the agent speaking.
        const m = mergeDeclared(
            floor({ transcript: [{ id: 'm1', role: 'user', content: 'ship it', at: at(0) }] }),
            declared({ transcript: [{ id: 'd1', role: 'agent', content: 'ship it', at: at(1) }] }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'd1']);
    });

    it('puts the floor first when two messages share a timestamp', () => {
        // Mail is stamped when it ARRIVES and the agent's reply when Genie sees it; at equal
        // resolution the prompt came first, and a stable answer beats a coin toss.
        const m = mergeDeclared(
            floor({ transcript: [{ id: 'm1', role: 'user', content: 'go', at: at(7) }] }),
            declared({ transcript: [{ id: 'd1', role: 'agent', content: 'ok', at: at(7) }] }),
        );
        expect(m.transcript.map((x) => x.id)).toEqual(['m1', 'd1']);
    });
});

describe('mergeDeclared — the floor survives silence', () => {
    it('keeps the projected transcript when the agent has said nothing yet', () => {
        // A session that has connected but not spoken must not go blank. Its mail and last
        // handoff are the most useful thing on screen at that moment.
        const m = mergeDeclared(floor(), declared({ transcript: [] }));
        expect(m.transcript).toEqual([{ id: 'm1', role: 'agent', content: 'from the inbox' }]);
    });

    it('keeps the floor turn state when the declared one is still the default idle', () => {
        // `emptyAgentSession` starts at `idle`. Letting that overwrite a floor state of
        // `thinking` would report every freshly-connected working agent as idle — and
        // `agentinbox/wake.ts` treats idle as "safe to deliver mail into".
        const m = mergeDeclared(floor(), declared());
        expect(m.turn.state).toBe('thinking');
    });

    it('keeps a floor-reported error when the agent reports none', () => {
        // The ailment comes from `diagnoseAgent`, which sees things the agent cannot — a
        // lost host, a dead transport. An agent that is fine from the inside must not clear
        // an error observed from the outside.
        expect(mergeDeclared(floor(), declared()).error).toBe('host lost');
    });

    it('lets the agent CLEAR an error it has reported itself', () => {
        const withErr = mergeDeclared(floor(), declared({ error: 'rate limited' }));
        expect(withErr.error).toBe('rate limited');
    });

    it('keeps floor approvals when the declared list is empty', () => {
        // Floor approvals are pending ForceTheQuestions — a human is genuinely blocked on
        // them. An ACP session with no mid-turn permission request must not hide them.
        const m = mergeDeclared(
            floor({ approvals: [{ id: 'q1', name: 'Answer', args: {} }] }),
            declared({ approvals: [] }),
        );
        expect(m.approvals).toHaveLength(1);
    });

    it('UNIONS approvals when both have some', () => {
        // They come from different places and both block: a pending question and a
        // mid-turn tool permission are not alternatives.
        const m = mergeDeclared(
            floor({ approvals: [{ id: 'q1', name: 'Answer', args: {} }] }),
            declared({ approvals: [{ id: 'a1', name: 'Write ipc.ts', args: {} }] }),
        );
        expect(m.approvals.map((a) => a.id).sort()).toEqual(['a1', 'q1']);
    });
});

describe('mergeDeclared — identity', () => {
    it('keeps the floor identity, which owns the agent record', () => {
        // The declared side knows a provider and a cwd; the floor side knows the agent's
        // Genie identity — its record id and name. Those are not the agent's to rename.
        const m = mergeDeclared(floor(), declared({ session: { ...emptyAgentSession(identity, NOW).session, name: 'impostor' } }));
        expect(m.session.name).toBe('kai');
    });

    it('fills a session id from the declared side, which is the only one that has it', () => {
        const m = mergeDeclared(
            floor(),
            declared({ session: { ...emptyAgentSession(identity, NOW).session, sessionId: 'sess-7' } }),
        );
        expect(m.session.sessionId).toBe('sess-7');
    });
});

describe('mergeDeclared — no declared session at all', () => {
    it('returns the floor projection untouched', () => {
        // Every pty agent takes this path, which is most of them.
        const f = floor();
        expect(mergeDeclared(f, null)).toEqual(f);
        expect(sessionFidelity(mergeDeclared(f, null))).toBe('observed');
    });
});
