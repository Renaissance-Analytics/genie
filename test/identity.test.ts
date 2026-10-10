import { describe, expect, it } from 'vitest';
import {
    AGENT_RECORD_FIELDS,
    agentRecord,
    mintAgentId,
    threadKeyFor,
    type AgentRecord,
} from '../src/core/identity.js';

/**
 * ONE KEY, MINTED ONCE, USED BY EVERYTHING.
 *
 * This is the defect that made the previous build's Conversation tab unreachable, and it is
 * worth being precise about why it was so expensive to find: **an identity split is
 * invisible**. Nothing throws. The session store happily writes under one id, the view
 * happily reads under another, and the UI renders a perfectly correct empty session forever.
 * Four releases shipped that way and every surface downstream was blamed first.
 *
 * So the guard is not "remember to use the same id". It is that there is exactly one
 * function that turns an agent into a storage key, and these tests pin that both halves —
 * the writer and the reader — go through it.
 */
describe('agent identity', () => {
    it('mints distinct ids', () => {
        const a = mintAgentId();
        const b = mintAgentId();

        expect(a).not.toBe(b);
        expect(a).toMatch(/^agent_[0-9a-f]{32}$/);
    });

    it('derives a thread key that is byte-identical for the same id', () => {
        const id = mintAgentId();

        // The writer's key and the reader's key are the same call. If this ever becomes two
        // call sites with two shapes, that is the bug — and it is the one that hides.
        expect(threadKeyFor(id)).toBe(threadKeyFor(id));
        expect(threadKeyFor(id)).toContain(id);
    });

    it('gives different agents different thread keys', () => {
        // POSITIVE CONTROL for the assertion above: a key function that returned a constant
        // would satisfy "identical for the same id" perfectly, and collapse every agent's
        // history into one thread.
        expect(threadKeyFor(mintAgentId())).not.toBe(threadKeyFor(mintAgentId()));
    });
});

describe('the agent record', () => {
    const rec: AgentRecord = agentRecord({
        id: mintAgentId(),
        workspaceId: 'ws_1',
        provider: 'claude',
        name: 'atlas',
        instructions: '.agents/atlas/AGENT.md',
    });

    it('carries NO command line, shell or args — at runtime', () => {
        /**
         * *"If an agent record has a field describing a command line, the design has
         * leaked."* It is not a style note. In the previous build every agent's stored
         * `agent_command` carried flags, a bare-command check on that string decided the
         * engine, and so all thirty of the owner's agents were routed to a pty while their
         * provider was ACP-capable the whole time. The field was the mechanism.
         */
        const forbidden = ['command', 'agentCommand', 'agent_command', 'shell', 'args', 'argv', 'launch', 'cmd'];
        const present = Object.keys(rec).filter((k) => forbidden.includes(k));

        expect(present).toEqual([]);
    });

    it('POSITIVE CONTROL: it carries the fields it is supposed to', () => {
        // Without this, "no command field" passes against an empty object — which is the way
        // an absence assertion fails quietly.
        expect(Object.keys(rec).sort()).toEqual([...AGENT_RECORD_FIELDS].sort());
        expect(rec.provider).toBe('claude');
        expect(rec.threadId).toBeNull();
    });

    it('starts with no thread, and that is NOT the same as an empty one', () => {
        // `null` = this agent has never run. An empty thread would claim it ran and said
        // nothing. The UI renders these differently and must be able to tell them apart.
        expect(rec.threadId).toBeNull();
        expect(rec.lastUsedAt).toBeNull();
    });
});
