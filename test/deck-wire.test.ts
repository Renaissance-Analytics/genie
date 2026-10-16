import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { mintAgentId } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE DECK SHOWS WHAT AGENTS ASK (the owner, 2026-10-14: "I have not seen in FTQ modals pop up at all. I do not see any
 * Pending Questions list"). Five questions sat unanswered in attention.json. The snapshot's Deck carried only live
 * sessions' permission requests, and the composition root's full Deck (questions, the person's list, mail to the person,
 * finished agents, tool approvals) was built and never read. Nothing announced a new question either.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-deckwire-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const question = (id: string): DeckItem => ({ id, source: 'agent-question', agentId: 'agent_x', agentName: 'kai', workspaceId: 'ws', title: 'Which?', blocking: false, priority: 'high', at: 1, answer: { kind: 'form', fields: 1 }, forwardedFrom: null } as unknown as DeckItem);

describe('the snapshot’s Deck', () => {
    it('carries the composition root’s items — a question is on the Deck — and re-emits when the source is set', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        const seen: number[] = [];
        registry.subscribe((s) => seen.push(s.deckItems?.length ?? -1));
        registry.setDeckSource(() => [question('q1'), question('q2')]);
        // COUNTED: both questions, and the subscriber heard the change.
        expect(registry.snapshot().deckItems?.map((d) => d.id)).toEqual(['q1', 'q2']);
        expect(seen.at(-1)).toBe(2);
    });
});

describe('the attention store announces its changes', () => {
    it('a question asked, then answered: each one fires onChange (and nothing fires after unsubscribe)', async () => {
        const inbox = await InboxStore.open(dir);
        const attention = await AttentionStore.open(dir, inbox);
        let changes = 0;
        const off = attention.onChange(() => { changes += 1; });
        const asked = await attention.ask({ agentId: mintAgentId(), agentName: 'kai', workspaceId: 'ws', questions: [{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], priority: 'high' } as never, { userActive: true });
        expect(asked.ok).toBe(true);
        expect(changes).toBe(1);
        await attention.answer((asked as { questionId: string }).questionId, { selections: [['A']], note: '' } as never);
        expect(changes).toBe(2);
        off();
        await attention.lists.add({ list: 'user', workspaceId: 'ws', agentId: mintAgentId(), text: 'press Trust' } as never);
        expect(changes).toBe(2);
    });
});

describe('main wires it', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the registry’s Deck source is the composition root’s deckItems, after the main process’s recorded errors (core/main-errors.ts)', () => {
        expect(main.match(/registry\.setDeckSource\(\(\)\s*=>\s*\[\.\.\.mainErrors\.deckItems\(\),\s*\.\.\.composed\.deckItems\(\)\]\)/g) ?? []).toHaveLength(1);
        expect(main.match(/registry\.setDeckSource\(/g) ?? []).toHaveLength(1);
    });
    it('an attention change refreshes the snapshot', () => {
        expect(main.match(/composed\.attention\.onChange\(\(\)\s*=>\s*registry\?\.touch\(\)\)/g) ?? []).toHaveLength(1);
    });
});
