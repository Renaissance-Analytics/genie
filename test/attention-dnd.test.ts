import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';

/**
 * DO NOT DISTURB (§6.3) — when the person has said they are away, an agent that asks is told so at
 * once, in the person's own configured words, so it can carry on or park on its own terms. The
 * question is STILL recorded: DND changes what the agent hears now, not whether the person sees the
 * question later. With DND off the result carries no reply.
 */

let dir: string;
let attention: AttentionStore;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-dnd-'));
    const inbox = await InboxStore.open(dir, () => 't');
    attention = await AttentionStore.open(dir, inbox, () => 't');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const q = { agentId: 'agent_a' as never, agentName: 'atlas', workspaceId: 'tynn', questions: [{ header: 'Deploy', question: 'Ship now?', options: [{ label: 'Agent: ship' }, { label: 'Agent: wait' }] }] };

describe('ask under DND', () => {
    it('with DND on the asker gets the configured reply immediately AND the question is recorded for later', async () => {
        const r = await attention.ask(q, { userActive: false, dnd: { on: true, reply: 'Away from the desk — I will answer when I am back.' } });
        expect(r).toMatchObject({ ok: true, rejoined: false, userActive: false, dndReply: 'Away from the desk — I will answer when I am back.' });
        expect(attention.pending()).toHaveLength(1);
    });

    it('with DND off there is no reply; a rejoined question under DND still carries the reply', async () => {
        const first = await attention.ask(q, { userActive: true, dnd: { on: false, reply: 'x' } });
        expect(first).toMatchObject({ dndReply: null });
        const again = await attention.ask(q, { userActive: false, dnd: { on: true, reply: 'Back at 3.' } });
        expect(again).toMatchObject({ rejoined: true, dndReply: 'Back at 3.' });
        expect(attention.pending()).toHaveLength(1);
    });
});
