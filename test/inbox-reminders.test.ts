import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN } from '../src/core/inbox.js';
import { REMINDER_GAP_MS, ReminderBook } from '../src/core/inbox-reminders.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * UNREAD REMINDERS THAT NEVER FIRE MID-TURN (§6.4). An agent with uncollected mail is reminded through
 * its own session — but only while it is IDLE (a reminder landing mid-turn derails the turn), only once
 * per gap, and the text says how many and how to collect (agentinbox receive). Collecting clears it.
 * The book is pure; the composed service pairs it with the inbox and reports what to send, never sends.
 */

describe('ReminderBook', () => {
    it('reminds an idle agent with unread mail once per gap; never a working agent; never with nothing unread', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 2, idle: true, now: 1_000 })).toBe('You have 2 unread AgentInbox messages; collect them with agentinbox receive.');
        expect(book.due({ agentId: 'a', unread: 2, idle: true, now: 1_000 + REMINDER_GAP_MS - 1 })).toBeNull();
        expect(book.due({ agentId: 'a', unread: 3, idle: true, now: 1_000 + REMINDER_GAP_MS })).toBe('You have 3 unread AgentInbox messages; collect them with agentinbox receive.');
        expect(book.due({ agentId: 'b', unread: 1, idle: false, now: 5_000 })).toBeNull();
        expect(book.due({ agentId: 'b', unread: 1, idle: true, now: 5_000 })).toBe('You have 1 unread AgentInbox message; collect it with agentinbox receive.');
        expect(book.due({ agentId: 'c', unread: 0, idle: true, now: 5_000 })).toBeNull();
        expect(REMINDER_GAP_MS).toBe(5 * 60_000);
    });

    it('a mid-turn moment does not consume the gap: the reminder fires as soon as the agent is idle again', () => {
        const book = new ReminderBook();
        expect(book.due({ agentId: 'a', unread: 1, idle: false, now: 1_000 })).toBeNull();
        expect(book.due({ agentId: 'a', unread: 1, idle: true, now: 1_001 })).not.toBeNull();
    });
});

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-reminders-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('services.inboxReminders', () => {
    it('reports what to send for every registered agent with unread mail that is idle; collecting clears it', async () => {
        services.registerAgentName('agent_a' as never, { name: 'atlas', workspaceId: 'tynn' });
        services.registerAgentName('agent_b' as never, { name: 'bolt', workspaceId: 'tynn' });
        await services.inbox.send({ from: HUMAN, to: 'agent_a' as never, text: 'ping' });
        await services.inbox.send({ from: HUMAN, to: 'agent_b' as never, text: 'pong' });
        const idle = new Set(['agent_a']);
        expect(services.inboxReminders({ now: 1_000, idle: (id) => idle.has(id) })).toEqual([{ agentId: 'agent_a', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' }]);
        // Within the gap: nothing again for atlas; bolt becomes idle and gets its own.
        idle.add('agent_b');
        expect(services.inboxReminders({ now: 2_000, idle: (id) => idle.has(id) })).toEqual([{ agentId: 'agent_b', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' }]);
        await services.inbox.receive({ participant: 'agent_a' as never });
        // Still inside bolt's gap (reminded at 2_000): nobody is told, atlas has collected.
        expect(services.inboxReminders({ now: 1_000 + REMINDER_GAP_MS, idle: () => true })).toEqual([]);
        // Bolt's gap has passed and the mail is still unread: reminded again; atlas, collected, stays quiet.
        expect(services.inboxReminders({ now: 2_000 + REMINDER_GAP_MS, idle: () => true })).toEqual([{ agentId: 'agent_b', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' }]);
    });
});
