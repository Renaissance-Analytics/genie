import { describe, expect, it, vi } from 'vitest';
import { AgentDrain, DRAIN_STUCK_AFTER_MS, drainNudgeText, type DrainTarget } from '../drain';
import { drainNudgeMode } from '../agent-mode';

/**
 * DRAIN THE AGENTS BEFORE THE UPGRADE (genie#389).
 *
 * The upgrade-kill guard already answers *"is anyone busy right now?"* and
 * holds. What it never does is ASK the agents to finish, so the user either
 * waits blind or forces — and forcing is what produced the disconnected agents
 * of genie#346.
 *
 * The drain asks. Every live agent is nudged to stop, write its handoff and
 * call `thumbsUp`; the roster shows who has answered; the upgrade waits.
 *
 * **The stuck path is tested as hard as the happy one.** A drain that only
 * works when every agent cooperates hangs forever on one wedged TUI, which is
 * worse than the kill it replaces — so an agent that never answers, one that
 * answers twice, one whose terminal dies mid-drain, and the manual satisfy all
 * have their own cases below.
 */

const AGENTS: DrainTarget[] = [
    {
        agentId: 'ws1:moic',
        inboxAgentId: 'inbox-moic',
        terminalId: 'term-moic',
        name: 'moic',
        workspaceId: 'ws1',
    },
    {
        agentId: 'ws1:hand',
        inboxAgentId: 'inbox-hand',
        terminalId: 'term-hand',
        name: 'hand',
        workspaceId: 'ws1',
    },
];

/** A drain whose clock and scheduler the test drives itself. */
function drain(over: Partial<ConstructorParameters<typeof AgentDrain>[0]> = {}) {
    const sent: Array<{ to: string; text: string }> = [];
    const fired: Array<{ run: () => void; delayMs: number }> = [];
    const changes: number[] = [];
    const d = new AgentDrain({
        send: (to, text) => {
            sent.push({ to, text });
            return true;
        },
        schedule: (run, delayMs) => {
            fired.push({ run, delayMs });
            return () => {
                const i = fired.findIndex((f) => f.run === run);
                if (i >= 0) fired.splice(i, 1);
            };
        },
        onChange: () => changes.push(1),
        ...over,
    });
    return { d, sent, fired, changes };
}

const stateOf = (d: AgentDrain, agentId: string) =>
    d.snapshot().rows.find((row) => row.agentId === agentId)?.state;

describe('the drain nudges every agent it is waiting on', () => {
    it('sends one nudge per agent, addressed to its INBOX id', () => {
        const { d, sent } = drain();
        void d.begin(AGENTS);

        // The AgentInbox id is what `send` addresses; `workspace_agents.id` is
        // what a `thumbsUp` acknowledges. They are different ids and using
        // either for both is how a drain waits on an agent it never nudged.
        expect(sent.map((s) => s.to)).toEqual(['inbox-moic', 'inbox-hand']);
        expect(sent[0]!.text).toContain('thumbsUp');
        expect(sent[0]!.text).toContain('handoff');
    });

    it('words the nudge for THAT agent’s mode (genie#410)', () => {
        const { d, sent } = drain({
            modeOf: (agentId) => (agentId === 'ws1:moic' ? 'automated' : 'manual'),
        });
        void d.begin(AGENTS);

        expect(sent[0]!.text).toContain(drainNudgeMode('automated'));
        expect(sent[1]!.text).toContain(drainNudgeMode('manual'));
        expect(sent[0]!.text).not.toContain(drainNudgeMode('manual'));
    });

    it('starts every row EMPTY — nothing is green before an agent answers', () => {
        const { d } = drain();
        void d.begin(AGENTS);

        const rows = d.snapshot().rows;
        // POSITIVE CONTROL: "no row is green" also passes against an empty
        // roster, which is the failure this whole feature is about.
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.state === 'waiting')).toBe(true);
        expect(d.snapshot().complete).toBe(false);
    });

    it('a row whose nudge could not be delivered says so instead of waiting on it', () => {
        // An agent Genie could not reach was never asked, so waiting on it is
        // waiting on nothing. The roster says that, and the user can satisfy it.
        const { d } = drain({ send: (to) => to !== 'inbox-hand' });
        void d.begin(AGENTS);

        expect(stateOf(d, 'ws1:moic')).toBe('waiting');
        expect(stateOf(d, 'ws1:hand')).toBe('stuck');
        expect(d.snapshot().rows[1]!.note).toMatch(/could not reach/i);
    });
});

describe('a thumbsUp fills exactly one row', () => {
    it('turns the sender green and leaves its sibling empty', () => {
        const { d } = drain();
        void d.begin(AGENTS);

        d.acknowledge('ws1:moic', 'shutdown');

        expect(stateOf(d, 'ws1:moic')).toBe('ready');
        expect(d.snapshot().rows[0]!.satisfiedBy).toBe('agent');
        // The control: one thumbsUp must not fill the roster.
        expect(stateOf(d, 'ws1:hand')).toBe('waiting');
        expect(d.snapshot().complete).toBe(false);
    });

    it('resolves only when EVERY row is green', async () => {
        const { d } = drain();
        const done = d.begin(AGENTS);
        let settled = false;
        void done.then(() => {
            settled = true;
        });

        d.acknowledge('ws1:moic', 'shutdown');
        await Promise.resolve();
        expect(settled).toBe(false);

        d.acknowledge('ws1:hand', 'shutdown');
        const snapshot = await done;
        expect(snapshot.complete).toBe(true);
        expect(snapshot.rows.every((row) => row.state === 'ready')).toBe(true);
    });

    it('ignores a thumbsUp from an agent it is not waiting on', () => {
        const { d } = drain();
        void d.begin(AGENTS);

        d.acknowledge('ws9:stranger', 'shutdown');

        expect(d.snapshot().rows.every((row) => row.state === 'waiting')).toBe(true);
    });

    it('a SECOND thumbsUp from the same agent changes nothing', async () => {
        // The completion promise resolves once. A duplicate ack that re-ran the
        // completion check would resolve a drain whose other row is still empty.
        const { d, changes } = drain();
        const done = d.begin(AGENTS);

        d.acknowledge('ws1:moic', 'shutdown');
        const after = changes.length;
        d.acknowledge('ws1:moic', 'shutdown');
        d.acknowledge('ws1:moic', 'ack');

        expect(changes.length).toBe(after);
        expect(stateOf(d, 'ws1:moic')).toBe('ready');
        expect(d.snapshot().complete).toBe(false);

        d.acknowledge('ws1:hand', 'shutdown');
        await expect(done).resolves.toMatchObject({ complete: true });
    });

    it('a thumbsUp already green by a HUMAN press stays attributed to the human', () => {
        const { d } = drain();
        void d.begin(AGENTS);

        d.satisfy('ws1:moic');
        d.acknowledge('ws1:moic', 'shutdown');

        expect(stateOf(d, 'ws1:moic')).toBe('satisfied');
        expect(d.snapshot().rows[0]!.satisfiedBy).toBe('user');
    });
});

describe('the stuck path — nothing hangs forever', () => {
    it('marks an agent that never answers STUCK, and says which one', () => {
        const { d, fired } = drain();
        void d.begin(AGENTS);

        d.acknowledge('ws1:moic', 'shutdown');
        // The armed deadline, fired by hand.
        expect(fired[0]!.delayMs).toBe(DRAIN_STUCK_AFTER_MS);
        fired[0]!.run();

        expect(stateOf(d, 'ws1:hand')).toBe('stuck');
        expect(d.snapshot().rows[1]!.note).toMatch(/has not answered/i);
        // POSITIVE CONTROL: the deadline must not sweep the agent that DID
        // answer back into the roster.
        expect(stateOf(d, 'ws1:moic')).toBe('ready');
        expect(d.snapshot().complete).toBe(false);
    });

    it('a stuck row can be satisfied BY HAND, and the drain then completes', async () => {
        const { d, fired } = drain();
        const done = d.begin(AGENTS);

        d.acknowledge('ws1:moic', 'shutdown');
        fired[0]!.run();
        expect(d.snapshot().complete).toBe(false);

        // The user shut the wedged TUI down and pressed its thumb.
        d.satisfy('ws1:hand');

        const snapshot = await done;
        expect(snapshot.complete).toBe(true);
        expect(snapshot.rows[1]!.state).toBe('satisfied');
        expect(snapshot.rows[1]!.satisfiedBy).toBe('user');
    });

    it('an agent whose TERMINAL dies mid-drain stops being waited on', async () => {
        // Nothing is left to answer. Waiting for a thumbsUp from a process that
        // no longer exists is the hang this feature exists to remove — and the
        // agent is still on the RESTORE list, because it was running.
        const { d } = drain();
        const done = d.begin(AGENTS);

        d.acknowledge('ws1:moic', 'shutdown');
        d.noteGone('ws1:hand');

        const snapshot = await done;
        expect(snapshot.complete).toBe(true);
        expect(snapshot.rows[1]!.state).toBe('gone');
        expect(snapshot.rows[1]!.satisfiedBy).toBe(null);
    });

    it('a drain with NOBODY to wait on completes immediately', async () => {
        const { d, sent } = drain();
        const snapshot = await d.begin([]);
        expect(snapshot.complete).toBe(true);
        expect(sent).toEqual([]);
    });

    it('cancel abandons the drain WITHOUT reporting it complete', async () => {
        const { d, fired } = drain();
        const done = d.begin(AGENTS);

        d.cancel();

        const snapshot = await done;
        expect(snapshot.complete).toBe(false);
        expect(d.active()).toBe(false);
        // The deadline is disarmed too — a timer that fired into a cancelled
        // drain would rewrite a roster nobody is looking at.
        expect(fired).toHaveLength(0);
    });

    it('cancel is a NO-OP once the drain has completed', async () => {
        // The completed snapshot is what the caller acted on: the upgrade is
        // already applying, and the restore list has already been written.
        // A late cancel that re-settled — or that let its caller clear that
        // list — would delete the record of everything about to come back.
        const { d } = drain();
        const done = d.begin(AGENTS);
        d.acknowledge('ws1:moic', 'shutdown');
        d.acknowledge('ws1:hand', 'shutdown');
        await expect(done).resolves.toMatchObject({ complete: true });

        expect(d.active()).toBe(false);
        d.cancel();
        // Still complete — the roster was not rewritten by the late call.
        expect(d.snapshot().rows.every((row) => row.state === 'ready')).toBe(true);
    });

    it('refuses a second drain while one is running', () => {
        const { d } = drain();
        void d.begin(AGENTS);
        expect(() => d.begin(AGENTS)).toThrow(/already/i);
    });
});

describe('the nudge text', () => {
    it('asks for the three things the drain needs, in order', () => {
        const text = drainNudgeText('manual');
        const stop = text.search(/stop/i);
        const handoff = text.search(/handoff/i);
        const thumbs = text.search(/thumbsUp/);
        expect(stop).toBeGreaterThanOrEqual(0);
        expect(stop).toBeLessThan(handoff);
        expect(handoff).toBeLessThan(thumbs);
    });

    it('tells a MANUAL agent to answer — this is the one nudge it must act on', () => {
        // Every other Genie nudge tells a Manual agent not to act unasked. This
        // one cannot: the upgrade waits on its answer, so silence is the failure.
        // The scope is still narrow, and it says so.
        const manual = drainNudgeMode('manual');
        expect(manual).toMatch(/waiting on your answer|answer/i);
        expect(manual).not.toMatch(/do not act on it unless a person asks/i);
        // …and it rules out the genie#407 mis-inference by name, exactly as the
        // upgrade notice does.
        expect(manual).toMatch(/sites/i);
        // POSITIVE CONTROL: the Automated clause is different and still present.
        expect(drainNudgeMode('automated')).not.toBe(manual);
        expect(drainNudgeMode('automated').length).toBeGreaterThan(20);
    });
});

describe('the roster is broadcast as it changes', () => {
    it('pushes a snapshot on begin and on every state change', () => {
        const onChange = vi.fn();
        const { d } = drain({ onChange });
        void d.begin(AGENTS);
        expect(onChange).toHaveBeenCalledTimes(1);

        d.acknowledge('ws1:moic', 'shutdown');
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(onChange.mock.calls[1]![0].rows[0].state).toBe('ready');
    });
});
