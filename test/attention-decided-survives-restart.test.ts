import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { openAgentStores } from '../src/main/agent-stores-open.js';
import { assembleDeckItems } from '../src/main/deck-assembly.js';

/**
 * A DISMISSED OR ANSWERED QUESTION STAYS GONE (Tynn #600, acceptance 1 and 3): decided, genie-host restarted on the same
 * files, and the Deck it says to every window (deck.watch, built by assembleDeckItems as genie-host's featureDeckItems
 * is) read afresh. Written after the code: break-probed (the decided write broken, seen red on CI, and
 * restored by reversing that edit) before it was trusted.
 */
let dir: string;
let clock = 1_000;
const now = () => new Date(clock++).toISOString();
const q = (header: string) => [{ header, question: `${header}?`, options: [{ label: 'a' }, { label: 'b' }] }];
const agent = mintAgentId();

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-decided-restart-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

describe('decided, then a restart and a fresh window', () => {
    it('neither the dismissed nor the answered question returns; the one left open does', async () => {
        const first = await openAgentStores(dir, now, undefined, undefined);
        const dismissed = await first.attention.ask({ agentId: agent, agentName: 'prism', workspaceId: 'ws', questions: q('Harness rel') }, { userActive: true });
        const answered = await first.attention.ask({ agentId: agent, agentName: 'prism', workspaceId: 'ws', questions: q('Harness work') }, { userActive: true });
        const open = await first.attention.ask({ agentId: agent, agentName: 'prism', workspaceId: 'ws', questions: q('Still open') }, { userActive: true });
        await first.attention.dismiss(dismissed.questionId);
        await first.attention.answer(answered.questionId, { selections: [['a']], notes: [''], note: '' });
        first.knowledge.close();

        // genie-host again, on the same files; a window asks it for the Deck.
        const again = await openAgentStores(dir, now, undefined, undefined);
        try {
            expect(again.attention.pending().map((p) => p.id)).toEqual([open.questionId]);
            expect(again.attention.asked(dismissed.questionId)?.outcome).toBe('dismissed');
            expect(again.attention.asked(answered.questionId)?.outcome).toBe('answered');
            const deck = assembleDeckItems({ workspaces: [{ id: 'ws', path: dir }], approvals: [], trust: [], attention: again.attention, inbox: again.inbox,
                agents: { [agent]: { name: 'prism', workspaceId: 'ws' } } });
            const questions = deck.filter((item) => item.source === 'agent-question');
            expect(questions.map((item) => item.id)).toEqual([open.questionId]);
            // CONTROL: the Deck the gauge reads does carry an open question (the one left open), so an empty list would show.
        } finally {
            again.knowledge.close();
        }
    });
});
