import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { agentPrompter, type AgentSessionsPort } from '../src/main/flow-runner.js';

/**
 * A TURN WHOSE PROVIDER ENDED IT ENDS IN GENIE TOO (Tynn #684, genie#721).
 *
 * The owner's ledger, beta.62.1, 2026-11-13: a flow ("every 15 min", one agent prompt) prompted an idle Claude agent at
 * 06:15:00. Turn 69 began, the agent answered and its `usage` row (the provider's `result`) landed at 06:15:57, and no
 * `finished` row ever came. The agent read Working for 11 hours, four inbox notices were folded into "turn 69", and the
 * flow's wait held every later run back. The day before, turn 67 (the same flow) did the same.
 *
 * NOT the flow's path: the prompt took the same `deliver` → `prompt` → `#send` as a person's or the inbox's. What both
 * stuck turns had in common is the turn BEFORE them: each had a second prompt delivered while it ran (an inbox notice at
 * 19:00:25 inside turn 66; one at 06:12:02 inside turn 68), which Claude Code folded into that turn. The same shape in
 * every other run of the owner's ledgers where `finished` stopped coming (a person's message folded into turn 9; a
 * notice into turn 2046): `usage` rows keep arriving, `finished` never again.
 *
 * Why: prism-acp's ClaudeDriver (0.41.x, `#settleTurn`/`#flushOutcomes`) releases turn ends IN SUBMISSION ORDER — "callback
 * consumers have no UUID field: preserve the order they submitted prompts". A prompt Claude absorbs into a running turn
 * gets no `result` of its own, so it never settles, and every later turn's end waits behind it for the rest of the run:
 * its `result` is mapped (the usage row) and its outcome is kept. Genie took a turn's end ONLY from `onTurnEnd`, so the
 * next prompt after any folded one, whoever sent it, never ended. Flows were simply the next prompt most often.
 *
 * The driver here models exactly that: a `result` frame sends its `usage_update` first (prism-acp's `#resultFrame`, with
 * the turn-scoped usage in `_meta`), then outcomes go out in submission order only.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const END: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: 'end_turn' };
const FLOW = 'flow "hourly round"';

/** prism-acp's ordered delivery: prompt N's end goes out only after every earlier prompt's has. */
function orderedClaudeDriver() {
    let events: DriverEvents = {};
    const pending: Array<{ id: number; outcome: TurnOutcomeLike | null }> = [];
    let written = 0;
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => { pending.push({ id: written, outcome: null }); written += 1; }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const flush = (): void => {
        while (pending.length > 0 && pending[0]!.outcome !== null) events.onTurnEnd?.(pending.shift()!.outcome!);
    };
    return {
        factory,
        say: (text: string) => events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
        /** Prompt `id`'s `result` frame: its usage first (mapped from the same frame), then whatever outcomes may go. */
        result: (id: number, outcome: TurnOutcomeLike = END) => {
            events.onUpdate?.({ sessionUpdate: 'usage_update', used: 1200, size: 1_000_000, _meta: { 'particle.academy/usage': { scope: 'turn', inputTokens: 10, outputTokens: 20 } } });
            const p = pending.find((x) => x.id === id);
            if (p) p.outcome = outcome;
            flush();
        },
        /** A prompt settled with NO result frame (prism-acp's own: dropped by a cancel, an accounting mismatch). */
        settleWithoutResult: (id: number, outcome: TurnOutcomeLike) => {
            const p = pending.find((x) => x.id === id);
            if (p) p.outcome = outcome;
            flush();
        },
    };
}

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-turn-held-'));
    dirs.push(dir);
    const d = orderedClaudeDriver();
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const rows: StreamEvent[] = [];
    const listeners = new Set<() => void>();
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: d.factory, processTree: noTree, turnsBefore: 0,
        onEvent: (e, meta) => { if (meta?.replacesLast) rows[rows.length - 1] = e; else rows.push(e); },
        onStateChange: () => { for (const l of listeners) l(); },
    });
    session.start();
    const ledger = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; n?: number; by?: string | null });
    };
    const markers = async () => (await ledger()).filter((e) => e.kind === 'turn').map((e) => `${e.n}:${e.by ?? '-'}`);
    const finished = async () => (await ledger()).filter((e) => e.kind === 'finished').map((e) => e.n);
    /** The path a flow's prompt takes in genie-host (`SessionHost.handOff` → `AgentSession.deliver`). */
    const port: AgentSessionsPort = {
        session: () => ({ running: session.running, turnState: session.turnState, pendingApproval: session.pendingApproval }),
        rows: () => rows.map((event) => ({ event })),
        prompt: (_agentId, text, by) => { session.deliver(text, by); return true; },
        subscribe: (listener) => { const l = () => listener(id); listeners.add(l); return () => { listeners.delete(l); }; },
    };
    const prompter = agentPrompter({ sessions: port, resolve: () => ({ kind: 'one', id }), agent: () => ({ name: 'scout', workspaceId: 'ws' }), asleep: () => false, by: FLOW });
    return { session, d, markers, finished, ledger, prompter };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The owner's turn 68: an inbox notice's turn, and a second notice delivered while it ran, which Claude folds in. */
function turnWithAFoldedNotice(s: ReturnType<typeof open>) {
    s.session.deliver('AgentInbox delivery: 1 message', 'genie'); // prompt 0
    s.d.say('reading it');
    s.session.deliver('AgentInbox delivery: 1 more message', 'genie'); // prompt 1: folded, never a result of its own
    s.d.say('answered both');
    s.d.result(0);
}

describe('CONTROL: the ordered driver ends a turn exactly as before when nothing was folded', () => {
    it('a flow prompt after a plain turn records `finished` and leaves the agent idle', async () => {
        const s = open();
        s.session.deliver('AgentInbox delivery: 1 message', 'genie');
        s.d.say('done');
        s.d.result(0);
        expect(s.session.turnState).toBe('idle');
        s.session.deliver('Hourly round', FLOW);
        s.d.say('round done');
        s.d.result(1);
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(await s.finished()).toEqual([1, 2]);
        // Not twice: the outcome came with its result, and nothing closed the turn a second time.
        expect(await s.markers()).toEqual(['1:genie', `2:${FLOW}`]);
    });
});

describe('the owner\'s turn 69: the turn after a folded prompt', () => {
    it('a flow prompt whose provider turn ended records `finished` and returns the agent to idle, like a person\'s prompt', async () => {
        const s = open();
        turnWithAFoldedNotice(s);
        expect(s.session.turnState).toBe('idle');
        expect(await s.finished()).toEqual([1]);

        s.session.deliver('Hourly round', FLOW); // prompt 2
        expect(s.session.turnState).toBe('working');
        s.d.say('Round done with two reads.');
        s.d.result(2); // its usage row lands; prism-acp keeps its outcome behind prompt 1
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(s.session.promptable).toBe(true);
        expect(await s.finished()).toEqual([1, 2]);
    });

    it('the flow\'s own wait answers with the reply once that turn ended (agentPrompter on the same path)', async () => {
        const s = open();
        turnWithAFoldedNotice(s);
        let reply: string | null = null;
        const asked = s.prompter('claude:scout', 'Hourly round').then((r) => { reply = r; });
        await tick();
        expect(s.session.turnState).toBe('working');
        s.d.say('Round done with two reads.');
        s.d.result(2);
        await tick();
        await tick();
        expect(reply).toBe('Round done with two reads.');
        await asked;
    });

    it('a person\'s prompt in the same place ends too: it was never about who sent it', async () => {
        const s = open();
        turnWithAFoldedNotice(s);
        s.session.deliver('what next?', 'you');
        s.d.say('this');
        s.d.result(2);
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(await s.finished()).toEqual([1, 2]);
    });
});

describe('never stuck Working: an ended turn is closed, and what comes after it is a new turn', () => {
    it('follow-ups after the ended turn each start a turn of their own and end — not folded into the old one', async () => {
        const s = open();
        turnWithAFoldedNotice(s);
        s.session.deliver('Hourly round', FLOW); // 2
        s.d.say('round done');
        s.d.result(2);
        await tick();
        // The owner's 07:21 inbox notice: a new turn, by genie, not a follow-up inside turn 2.
        s.session.deliver('AgentInbox delivery: 1 message (from an app)', 'genie'); // 3
        expect(s.session.turnState).toBe('working');
        s.d.say('replied');
        s.d.result(3);
        await tick();
        s.session.deliver('AgentInbox delivery: 1 message', 'genie'); // 4
        s.d.say('noted');
        s.d.result(4);
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(await s.markers()).toEqual(['1:genie', `2:${FLOW}`, '3:genie', '4:genie']);
        expect(await s.finished()).toEqual([1, 2, 3, 4]);
    });

    it('the held ends, released later all at once (a cancel settles the folded prompt), close nothing twice and open nothing', async () => {
        const s = open();
        turnWithAFoldedNotice(s);
        s.session.deliver('Hourly round', FLOW); // 2
        s.d.say('round done');
        s.d.result(2);
        await tick();
        s.session.deliver('AgentInbox delivery', 'genie'); // 3
        s.d.say('replied');
        s.d.result(3);
        await tick();
        const before = await s.ledger();
        // prism-acp releases prompt 1 (no result: it was folded) and with it the ends it held, 2 and 3.
        s.d.settleWithoutResult(1, { stopReason: 'cancelled', isError: false, raw: 'cancel accounting mismatch' });
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(s.session.turns).toBe(3);
        const after = await s.ledger();
        expect(after.slice(before.length).filter((e) => e.kind === 'finished' || e.kind === 'stopped' || e.kind === 'turn')).toEqual([]);
        // And the next prompt is turn 4, ended by its own outcome as usual.
        s.session.deliver('next', 'you'); // 4
        s.d.say('ok');
        s.d.result(4);
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(await s.finished()).toEqual([1, 2, 3, 4]);
    });

    it('a result while the turn is still running a folded prompt\'s work is not taken early: only the turn Genie has open ends, once', async () => {
        const s = open();
        s.session.deliver('a', 'you'); // 0
        s.d.say('working');
        s.d.result(0);
        await tick();
        expect(await s.finished()).toEqual([1]);
        expect(s.session.turnState).toBe('idle');
        // A usage_update with no turn open (nothing of Genie's running) closes nothing and writes nothing.
        s.d.result(99);
        await tick();
        expect(s.session.turnState).toBe('idle');
        expect(await s.finished()).toEqual([1]);
    });
});
