import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';

/**
 * A PROMPT THE PROVIDER FOLDS INTO THE RUNNING TURN LEAVES NO PHANTOM TURN (the owner, 2026-10-20: "agents don't seem to be
 * getting inbox pings when they are idle … I sat here for 5 minutes").
 *
 * Measured in moic's own ledger (beta.32): the owner sent two messages while turn 172 ran; Claude Code folded both into
 * that turn (it answered both in it). When the turn ended Genie opened TURN 175 "by you" for a prompt the provider had
 * already consumed, and waited for its end — which never came. moic stayed `working` for 36 minutes while idle: not
 * promptable, so fancy's mail (01:16:42Z) was never pushed, and the owner's next message (01:32:35Z) was queued behind
 * the phantom turn instead of starting one.
 *
 * Genie no longer ASSUMES a queued prompt becomes its own turn. A turn ending leaves the agent idle; a turn opens when
 * the PROVIDER starts one (its first activity), credited to the oldest queued sender; a provider turn that ends with no
 * activity while Genie is idle is the queued prompt's (silent) turn. A prompt sent from idle drops what the queue still
 * held — those were folded into an earlier turn.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-folded-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: unknown[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: (t) => { prompts.push(t); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree });
    session.start();
    const end = () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
    const say = (text: string) => events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const markers = async () => (await openAgentThread(store, id).messages())
        .map((r) => r.message as { kind: string; n?: number; by?: string | null })
        .filter((e) => e.kind === 'turn')
        .map((e) => `${e.n}:${e.by ?? '-'}`);
    return { session, end, say, markers, prompts };
}

describe('a prompt folded into the running turn (Claude Code does this)', () => {
    it('after the turn ends the agent is IDLE and can take a prompt — no phantom turn, no marker for it', async () => {
        const { session, end, say, markers } = open();
        session.prompt('build it', 'you');
        say('working on it');
        session.prompt('and drop the dev notes', 'you'); // sent mid-turn; the provider folds it in
        say('done, notes dropped too');
        end();
        expect(session.turnState).toBe('idle');
        expect(session.promptable).toBe(true);
        await session.settled();
        expect(await markers()).toEqual(['1:you']);
    });

    it('the next prompt from idle starts turn 2, by its sender — the folded one is not counted ahead of it', async () => {
        const { session, end, say, markers } = open();
        session.prompt('a', 'you');
        session.prompt('folded', 'you');
        end();
        session.prompt('You have 1 unread AgentInbox message', 'genie');
        expect(session.turnState).toBe('working');
        say('reading it');
        end();
        expect(session.turnState).toBe('idle');
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:genie']);
    });
});

describe('a queued prompt the provider DOES run as its own turn (CONTROL: still marked and credited)', () => {
    it('the turn opens when the provider starts it, credited to whoever queued it, and ends idle', async () => {
        const { session, end, say, markers } = open();
        session.prompt('a', 'you');
        session.prompt('from a peer', 'kai');
        say('answer to a');
        end();
        expect(session.turnState).toBe('idle');
        say('answer to the peer'); // the provider starts the queued prompt's own turn
        expect(session.turnState).toBe('working');
        end();
        expect(session.turnState).toBe('idle');
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:kai']);
        expect(session.turns).toBe(2);
    });

    it('a provider turn that ends with no activity while idle is the queued prompt\'s silent turn', async () => {
        const { session, end, markers } = open();
        session.prompt('a', 'you');
        session.prompt('b', 'kai');
        end();
        end();
        expect(session.turnState).toBe('idle');
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:kai']);
    });
});
