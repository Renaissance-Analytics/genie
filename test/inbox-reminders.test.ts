import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { ReminderBook } from '../src/core/inbox-reminders.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE INBOX PUSH'S BOOK (§6.4, B26). An agent with mail is told through its own session — only while that session can
 * take a turn (`run` is not `null`: not mid-turn, not starting, running), and EXACTLY ONCE PER ARRIVAL BATCH: told once,
 * not repeated; a newer message is a new batch, told at once; a new run has been told nothing. TOLD MEANS DELIVERED: a
 * notice handed out is sending until it settles — delivered, it is told; not (refused, crashed, stopped), it is untold
 * and told again. The text says how many and how to collect (agentinbox receive). The book is pure; the composed service pairs it with the inbox and reports
 * what to send, never sends.
 */

describe('ReminderBook', () => {
    it('tells an agent that can take a turn about its unread mail once per batch; never one that cannot; never with nothing unread', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 2, newestSeq: 2, run: 1 })).toBe('You have 2 unread AgentInbox messages; collect them with agentinbox receive.');
        book.settled('a', true);
        // The same batch, however long it waits: not told again.
        expect(book.due({ agentId: 'a', unread: 2, newestSeq: 2, run: 1 })).toBeNull();
        // A message on top of it: a new batch, told at once — no gap.
        expect(book.due({ agentId: 'a', unread: 3, newestSeq: 3, run: 1 })).toBe('You have 3 unread AgentInbox messages; collect them with agentinbox receive.');
        expect(book.due({ agentId: 'b', unread: 1, newestSeq: 4, run: null })).toBeNull();
        expect(book.due({ agentId: 'b', unread: 1, newestSeq: 4, run: 2 })).toBe('You have 1 unread AgentInbox message; collect it with agentinbox receive.');
        expect(book.due({ agentId: 'c', unread: 0, newestSeq: 0, run: 3 })).toBeNull();
    });

    it('a moment it cannot take a turn does not consume the batch: told the first time it can', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: null })).toBeNull();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: 1 })).not.toBeNull();
    });

    it('collected and then mailed again: the next message is told at once', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: 1 })).not.toBeNull();
        book.settled('a', true);
        // Collected (nothing unread), then message 2 lands a moment later.
        expect(book.due({ agentId: 'a', unread: 0, newestSeq: 0, run: 1 })).toBeNull();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 2, run: 1 })).toBe('You have 1 unread AgentInbox message; collect it with agentinbox receive.');
    });

    it('a NEW RUN has been told nothing: a batch told to the run before it is told again', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: 1 })).not.toBeNull();
        book.settled('a', true);
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: 1 })).toBeNull();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: 2 })).toBe('You have 1 unread AgentInbox message; collect it with agentinbox receive.');
    });

    it('SENDING: handed out once, never twice before it settles; NOT delivered, the same batch is told again', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 1, newestSeq: 1, run: 1 })).not.toBeNull();
        // A second event in the same tick, even with more mail: nothing while one is out.
        expect(book.due({ agentId: 'a', unread: 2, newestSeq: 2, run: 1 })).toBeNull();
        book.settled('a', false);
        expect(book.due({ agentId: 'a', unread: 2, newestSeq: 2, run: 1 })).toBe('You have 2 unread AgentInbox messages; collect them with agentinbox receive.');
        book.settled('a', true);
        expect(book.due({ agentId: 'a', unread: 2, newestSeq: 2, run: 1 })).toBeNull();
        // One handed to a run that is gone and never settled was not delivered: the next run is told.
        expect(book.due({ agentId: 'a', unread: 3, newestSeq: 3, run: 1 })).not.toBeNull();
        expect(book.due({ agentId: 'a', unread: 3, newestSeq: 3, run: 2 })).not.toBeNull();
    });
});

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let roster: AgentRecord[] = [];
/** An agent on the roster — what the registry hands the composed services. */
const onRoster = (id: string, name: string, workspaceId: string): void => {
    roster.push({ id, workspaceId, provider: 'claude', name, instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null } as never);
};
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-reminders-'));
    roster = [];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services.inboxReminders', () => {
    it('reports what to send for every registered agent with mail it has not been told about whose session can take a turn', async () => {
        onRoster('agent_a', 'atlas', 'tynn');
        onRoster('agent_b', 'bolt', 'tynn');
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'ping' });
        await services.inbox.send({ from: HUMAN, to: 'agent_b' as never, text: 'pong' });
        const runs = new Map<string, number>([['agent_a', 1]]);
        const run = (id: string): number | null => runs.get(id) ?? null;
        expect(services.inboxReminders({ run })).toEqual([{ agentId: 'agent_a', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' }]);
        services.inboxNoticeSettled('agent_a', true);
        // Atlas's batch was told; bolt can now take a turn and gets its own.
        runs.set('agent_b', 2);
        expect(services.inboxReminders({ run })).toEqual([{ agentId: 'agent_b', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' }]);
        services.inboxNoticeSettled('agent_b', true);
        expect(services.inboxReminders({ run })).toEqual([]);
        // Atlas collects; a new message for it is a new batch, told at once.
        await services.inbox.receive({ participant: 'agent_a' as never });
        expect(services.inboxReminders({ run })).toEqual([]);
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'again' });
        expect(services.inboxReminders({ run })).toEqual([{ agentId: 'agent_a', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' }]);
    });
});
