import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeedbackStore } from '../src/main/feedback-store.js';

/**
 * FEEDBACK (§6.3 `submitFeedback`) — what an agent (or the person) says about Genie itself, kept
 * durably on this machine. Tynn is the eventual destination and is not wired yet, so an item is
 * `sent: false` until something marks it — the store says what it has, never that it was delivered.
 */

let dir: string;
let store: FeedbackStore;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feedback-'));
    store = await FeedbackStore.open(dir, () => 1_700_000_000_000);
});

afterEach(async () => {
    await store.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('FeedbackStore', () => {
    it('adds an item with who said it, keeps it unsent, lists newest first, and survives a reopen', async () => {
        const a = store.add({ workspaceId: 'tynn', agentName: 'atlas', kind: 'bug', text: 'the Deck forgets my answer' });
        const b = store.add({ workspaceId: 'tynn', agentName: null, kind: 'idea', text: 'a dark-first palette picker' });
        expect(a).toMatchObject({ id: expect.stringMatching(/^fb_/), sent: false, at: '2023-11-14T22:13:20.000Z' });
        expect(store.list().map((f) => f.id)).toEqual([b.id, a.id]);
        expect(store.unsent()).toHaveLength(2);
        expect(store.markSent(a.id)).toBe(true);
        expect(store.markSent('fb_nope')).toBe(false);
        expect(store.unsent().map((f) => f.id)).toEqual([b.id]);
        await store.flushed();
        const reopened = await FeedbackStore.open(dir, () => 2);
        expect(reopened.list()).toHaveLength(2);
        expect(reopened.unsent().map((f) => f.id)).toEqual([b.id]);
    });

    it('refuses an empty text and an unknown kind by name', () => {
        expect(() => store.add({ workspaceId: 'tynn', agentName: 'atlas', kind: 'bug', text: '   ' })).toThrow('feedback needs some text');
        expect(() => store.add({ workspaceId: 'tynn', agentName: 'atlas', kind: 'rant' as never, text: 'x' })).toThrow('feedback kind must be one of bug, idea, praise');
    });
});
