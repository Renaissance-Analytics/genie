import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { documentedCommands } from '../src/core/provider-commands.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A PROVIDER'S SLASH COMMAND TYPED IN THE CHAT RUNS AS A COMMAND (Tynn #702, a gap in #440).
 *
 * Root cause: Claude's CLI runs `/compact` only when it is the START of the prompt. Genie put its own words ahead of a
 * turn's first prompt (the instructions it holds for the first turn, a carry-over, a re-dock note, a rate warning), so
 * `/compact` typed to a freshly started agent reached the CLI as `<instructions>\n\n/compact`: a plain message. A command
 * now goes alone, and what Genie held waits for the next ordinary prompt. The chat shows the command as a small row,
 * for Claude and Codex alike, not as your message.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake { prompts: unknown[]; commands: string[]; events: DriverEvents; ready: () => void }
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        const fake: Fake = { prompts: [], commands: [], events: options.events, ready: resolve };
        fakes.set(record.id, fake);
        const driver: Record<string, unknown> = {
            start: () => {},
            prompt: (content: unknown) => { fake.prompts.push(content); },
            kill: () => {},
            cliSessionId: null,
        };
        if (record.provider === 'codex') {
            driver['ready'] = ready;
            driver['runCommand'] = async (name: string) => { fake.commands.push(name); };
        }
        return driver as unknown as ReturnType<SessionDriverFactory>;
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-slash702-'));
    fakes.clear();
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const started = async (provider: 'claude' | 'codex', commands: string[] | null): Promise<{ record: AgentRecord; fake: Fake }> => {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: `${provider}-a` });
    expect(host.start(record, dir)).toEqual({ ok: true });
    const fake = fakes.get(record.id)!;
    fake.ready();
    await tick();
    if (commands !== null) {
        fake.events.onUpdate?.({ sessionUpdate: 'available_commands_update', availableCommands: commands.map((name) => ({ name, description: '' })) });
        await tick();
    }
    return { record, fake };
};
const rows = (record: AgentRecord) => host.rowsFor(record.id).map((r) => r.event);
const yourMessages = (record: AgentRecord): string[] => rows(record).flatMap((e) => (e.kind === 'message' && e.speaker === 'you' ? [e.text] : []));
const notices = (record: AgentRecord): string[] => rows(record).flatMap((e) => (e.kind === 'notice' ? [e.message] : []));
const endTurn = (fake: Fake): void => fake.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
const INSTRUCTIONS = 'GENIE INSTRUCTIONS';

describe('CLAUDE: an advertised command goes ALONE, so the CLI runs it', () => {
    it('with Genie instructions held for the first turn, `/compact` is the whole prompt; the instructions wait for the next one', async () => {
        const { record, fake } = await started('claude', ['compact']);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        expect(fake.prompts).toEqual(['/compact']);
        endTurn(fake);
        expect(host.promptWith(record.id, 'now run the tests', [], 'you')).toEqual({ ok: true });
        expect(fake.prompts).toHaveLength(2);
        expect(String(fake.prompts[1])).toContain(INSTRUCTIONS);
        expect(String(fake.prompts[1])).toContain('now run the tests');
    });

    it('before the CLI has reported anything (it reports at its first turn), a documented command still goes alone', async () => {
        const { record, fake } = await started('claude', null);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        expect(fake.prompts).toEqual(['/compact']);
    });

    it('with arguments, it still goes alone and whole', async () => {
        const { record, fake } = await started('claude', ['compact']);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        expect(host.promptWith(record.id, '/compact keep the test results', [], 'you')).toEqual({ ok: true });
        expect(fake.prompts).toEqual(['/compact keep the test results']);
    });

    it('the chat shows a small row that the command ran, not your message', async () => {
        const { record } = await started('claude', ['compact']);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        host.promptWith(record.id, '/compact', [], 'you');
        await tick();
        expect(yourMessages(record)).toEqual([]);
        expect(notices(record).filter((m) => m.includes('/compact'))).toHaveLength(1);
    });

    it('the phone text-only message is the same', async () => {
        const { record, fake } = await started('claude', ['compact']);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        expect(host.prompt(record.id, '/compact', 'you')).toBe(true);
        expect(fake.prompts).toEqual(['/compact']);
    });

    it('control: an unknown `/word` is sent as text, with what Genie holds, and is your message', async () => {
        const { record, fake } = await started('claude', null);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        expect(host.promptWith(record.id, '/frobnicate', [], 'you')).toEqual({ ok: true });
        expect(String(fake.prompts[0])).toContain(INSTRUCTIONS);
        expect(String(fake.prompts[0])).toContain('/frobnicate');
        expect(yourMessages(record)).toEqual(['/frobnicate']);
    });

    it('control: ordinary text carries the held instructions as before', async () => {
        const { record, fake } = await started('claude', ['compact']);
        host.holdForNextWork(record.id, INSTRUCTIONS);
        host.promptWith(record.id, 'hello', [], 'you');
        expect(String(fake.prompts[0])).toContain(INSTRUCTIONS);
    });
});

describe('CODEX: the same, as the provider command', () => {
    it('runs `compact`, and the chat shows the small row, not your message', async () => {
        const { record, fake } = await started('codex', ['compact', 'review']);
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        await tick();
        expect(fake.commands).toEqual(['compact']);
        expect(fake.prompts).toEqual([]);
        expect(yourMessages(record)).toEqual([]);
        expect(notices(record).filter((m) => m.includes('/compact'))).toHaveLength(1);
    });
});

describe('the documented list', () => {
    it('names Claude built-in commands, and nothing for a provider with none documented', () => {
        expect(documentedCommands('claude')).toEqual(expect.arrayContaining(['compact', 'clear', 'context', 'model']));
        expect(documentedCommands('codex')).toEqual([]);
        expect(documentedCommands('unknown')).toEqual([]);
    });
});
