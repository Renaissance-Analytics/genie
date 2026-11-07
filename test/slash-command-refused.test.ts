import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { unsupportedSlashCommand } from '../src/core/provider-commands.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A SLASH COMMAND TYPED TO AN AGENT THAT OFFERS NONE IS SAID, NOT SENT (Tynn #440; the owner, 2026-11-04: "do the chat
 * commands… actually get sent as commands… or just a chat message with a string"). prism-acp 0.38.0's Codex driver
 * reports no commands, so `/compact` typed to a Codex agent reached the model as a chat message. Now the composer is
 * told it was not sent. An agent whose CLI reports its commands (Claude, at its `system/init`) is unchanged: its CLI
 * runs them — before its first report too, since Claude reports only once a turn starts.
 */

describe('unsupportedSlashCommand — the rule', () => {
    const none = { commands: [], plugins: null, subagents: null };
    const compact = { commands: [{ name: 'compact', description: '', source: null }], plugins: null, subagents: null };

    it('an agent that never reports commands and has reported none: a command is refused, naming it', () => {
        const reason = unsupportedSlashCommand('/compact', null, false);
        expect(reason).not.toBeNull();
        expect(reason).toContain('/compact');
        expect(unsupportedSlashCommand('  /review now please', null, false)).toContain('/review');
    });

    it('an agent that REPORTED an empty list: refused, whatever its provider', () => {
        expect(unsupportedSlashCommand('/compact', none, true)).toContain('/compact');
        expect(unsupportedSlashCommand('/compact', none, false)).toContain('/compact');
    });

    it('an agent that reported commands, or reports them later (Claude before its first turn): sent, its CLI decides', () => {
        expect(unsupportedSlashCommand('/compact', compact, true)).toBeNull();
        expect(unsupportedSlashCommand('/other', compact, true)).toBeNull();
        expect(unsupportedSlashCommand('/compact', compact, false)).toBeNull();
        expect(unsupportedSlashCommand('/compact', null, true)).toBeNull();
    });

    it('text that is not a command is never refused: plain words, a path, a lone slash', () => {
        for (const text of ['hello', 'why does /compact not work?', '/path/to/file is broken', '/', '/ spaced', '']) {
            expect(unsupportedSlashCommand(text, null, false), text).toBeNull();
            expect(unsupportedSlashCommand(text, none, true), text).toBeNull();
        }
    });
});

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake { prompts: unknown[]; events: DriverEvents; ready: () => void }
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        const fake: Fake = { prompts: [], events: options.events, ready: resolve };
        fakes.set(record.id, fake);
        return {
            start: () => {},
            prompt: (content: unknown) => { fake.prompts.push(content); },
            kill: () => {},
            cliSessionId: null,
            ...(record.provider === 'codex' ? { ready } : {}),
        };
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-slash-'));
    fakes.clear();
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const started = async (provider: 'claude' | 'codex'): Promise<AgentRecord> => {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: `${provider}-a` });
    expect(host.start(record, dir)).toEqual({ ok: true });
    fakes.get(record.id)!.ready();
    await tick();
    return record;
};
const report = async (record: AgentRecord, names: string[]): Promise<void> => {
    fakes.get(record.id)!.events.onUpdate?.({ sessionUpdate: 'available_commands_update', availableCommands: names.map((name) => ({ name, description: '' })) });
    await tick();
};
const messageRows = (record: AgentRecord): string[] =>
    host.rowsFor(record.id).map((r) => r.event).flatMap((e) => (e.kind === 'message' && e.speaker === 'you' ? [e.text] : []));

describe('the composer (SessionHost.promptWith)', () => {
    it('CODEX: `/compact` is NOT sent to the model; the composer is told why; nothing lands in the chat as your message', async () => {
        const record = await started('codex');
        const sent = host.promptWith(record.id, '/compact', [], 'you');
        expect(sent.ok).toBe(false);
        expect(sent.ok ? null : sent.reason).toContain('/compact');
        expect(fakes.get(record.id)!.prompts).toEqual([]);
        expect(messageRows(record)).toEqual([]);
    });

    it('CODEX, control: ordinary text, and a path that starts with a slash, still go', async () => {
        const record = await started('codex');
        expect(host.promptWith(record.id, 'run the tests', [], 'you')).toEqual({ ok: true });
        expect(fakes.get(record.id)!.prompts).toHaveLength(1);
    });

    it('CODEX that reports commands (a later prism): a reported command is sent for its CLI to run', async () => {
        const record = await started('codex');
        await report(record, ['compact']);
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        expect(fakes.get(record.id)!.prompts).toHaveLength(1);
    });

    it('CLAUDE before any report: sent, as before (Claude reports its commands only once a turn starts)', async () => {
        const record = await started('claude');
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        expect(fakes.get(record.id)!.prompts).toHaveLength(1);
    });

    it('CLAUDE that reported NO commands: refused, as for any agent that offers none', async () => {
        const record = await started('claude');
        await report(record, []);
        const sent = host.promptWith(record.id, '/compact', [], 'you');
        expect(sent.ok).toBe(false);
        expect(fakes.get(record.id)!.prompts).toEqual([]);
    });
});
