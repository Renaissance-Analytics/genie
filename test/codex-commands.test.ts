import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { extensionsFrom, toPromptCmds, unsupportedSlashCommand } from '../src/core/provider-commands.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { toStreamEvent } from '../src/core/stream-event.js';
import { ledgerRow } from '../src/core/stream-view.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * CODEX'S COMMANDS AND TOOL NAMES, LIKE CLAUDE'S (Tynn #440 part B, prism-acp 0.39.0).
 * - Codex advertises its commands (`compact`, `review`) as Claude does; the `/` menu offers exactly those.
 * - An advertised command typed to Codex runs as the provider's command (`runCommand(name)`), never as chat text.
 * - A `/name` the agent did not advertise is refused by Genie (prism-acp sends any other `/text` to the model).
 * - A refusal from the provider (`CommandUnsupported`) is said with its reason.
 * - The phone's text-only message (`host.prompt`) is checked the same way as the composer's.
 * - Tool rows take the provider's own `name` (`shell`, `<server>.<tool>`, `edit`) for the kind column.
 */

/** prism-acp 0.39.0's Codex `available_commands_update`, as its driver emits it. */
const CODEX_COMMANDS = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
        { name: 'compact', description: 'Compact this thread', _meta: { 'particle.academy/command_source': 'command' } },
        { name: 'review', description: 'Review uncommitted changes', _meta: { 'particle.academy/command_source': 'command' } },
    ],
};

describe('the rule: not in the list it advertised = refused', () => {
    const codex = extensionsFrom(CODEX_COMMANDS)!;
    it('an advertised command goes; one it did not advertise is refused, naming it', () => {
        expect(unsupportedSlashCommand('/compact', codex, false)).toBeNull();
        expect(unsupportedSlashCommand('/review', codex, false)).toBeNull();
        expect(unsupportedSlashCommand('/frobnicate', codex, false)).toContain('/frobnicate');
        expect(unsupportedSlashCommand('/init', codex, true)).toContain('/init');
    });
    it('a Codex that cannot run them (availableCommands: null) offers none', () => {
        const none = extensionsFrom({ sessionUpdate: 'available_commands_update', availableCommands: null })!;
        expect(unsupportedSlashCommand('/compact', none, false)).toContain('/compact');
    });
    it('the / menu offers exactly what the agent advertised', () => {
        expect(toPromptCmds(codex.commands).map((c) => c.name)).toEqual(['/compact', '/review']);
    });
});

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake {
    prompts: unknown[];
    commands: string[];
    events: DriverEvents;
    ready: () => void;
    /** What the next `runCommand` does: resolve (accepted), or reject as prism-acp's CommandUnsupported. */
    refuse: string | null;
}
const fakes = new Map<string, Fake>();
const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        const fake: Fake = { prompts: [], commands: [], events: options.events, ready: resolve, refuse: null };
        fakes.set(record.id, fake);
        const driver: Record<string, unknown> = {
            start: () => {},
            prompt: (content: unknown) => { fake.prompts.push(content); },
            kill: () => {},
            cliSessionId: null,
        };
        if (record.provider === 'codex') {
            driver['ready'] = ready;
            driver['runCommand'] = async (name: string) => {
                fake.commands.push(name);
                if (fake.refuse !== null) {
                    throw Object.assign(new Error(`command unsupported: ${fake.refuse}`), { name: 'CommandUnsupported', code: 'command_unsupported', reason: fake.refuse });
                }
            };
        }
        return driver as unknown as ReturnType<SessionDriverFactory>;
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-codex-commands-'));
    fakes.clear();
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const started = async (provider: 'claude' | 'codex', commands: string[] | null = ['compact', 'review']): Promise<{ record: AgentRecord; fake: Fake }> => {
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

describe('a command typed to a Codex agent', () => {
    it('ADVERTISED: run as the provider\'s command, never sent to the model as text; the turn it opens shows it', async () => {
        const { record, fake } = await started('codex');
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        await tick();
        expect(fake.commands).toEqual(['compact']);
        expect(fake.prompts).toEqual([]);
        expect(rows(record).some((e) => e.kind === 'message' && e.speaker === 'you' && e.text === '/compact')).toBe(true);
        expect(host.inTurn(record.id)).toBe(true);
        // Its completion arrives as the turn's end, as prism-acp says.
        fake.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        expect(host.inTurn(record.id)).toBe(false);
    });

    it('NOT ADVERTISED: refused in the composer, naming it; nothing reaches the provider', async () => {
        const { record, fake } = await started('codex');
        const sent = host.promptWith(record.id, '/frobnicate', [], 'you');
        expect(sent.ok).toBe(false);
        expect(sent.ok ? null : sent.reason).toContain('/frobnicate');
        expect(fake.commands).toEqual([]);
        expect(fake.prompts).toEqual([]);
    });

    it('WITH ARGUMENTS: a native command takes none, so it is refused rather than sent as text', async () => {
        const { record, fake } = await started('codex');
        const sent = host.promptWith(record.id, '/review the auth changes', [], 'you');
        expect(sent.ok).toBe(false);
        expect(sent.ok ? null : sent.reason).toContain('/review');
        expect(fake.commands).toEqual([]);
        expect(fake.prompts).toEqual([]);
    });

    it('REFUSED BY THE PROVIDER (CommandUnsupported): said with its reason; no turn is left running', async () => {
        const { record, fake } = await started('codex');
        fake.refuse = 'native_method_missing';
        expect(host.promptWith(record.id, '/review', [], 'you')).toEqual({ ok: true });
        await tick();
        expect(fake.commands).toEqual(['review']);
        const said = rows(record).filter((e) => e.kind === 'notice' && e.message.includes('/review'));
        expect(said).toHaveLength(1);
        expect(said[0]!.kind === 'notice' ? said[0]!.message : '').toContain('native method missing');
        expect(host.inTurn(record.id)).toBe(false);
        expect(fake.prompts).toEqual([]);
    });

    it('control: ordinary text still goes to the model', async () => {
        const { record, fake } = await started('codex');
        expect(host.promptWith(record.id, 'what changed?', [], 'you')).toEqual({ ok: true });
        expect(fake.prompts).toHaveLength(1);
        expect(fake.commands).toEqual([]);
    });
});

describe('the phone\'s text-only message (host.prompt by you) is checked the same way', () => {
    it('not advertised: refused, nothing sent', async () => {
        const { record, fake } = await started('codex');
        expect(host.prompt(record.id, '/frobnicate', 'you')).toBe(false);
        expect(fake.prompts).toEqual([]);
        expect(fake.commands).toEqual([]);
    });
    it('advertised: run as the command', async () => {
        const { record, fake } = await started('codex');
        expect(host.prompt(record.id, '/compact', 'you')).toBe(true);
        await tick();
        expect(fake.commands).toEqual(['compact']);
        expect(fake.prompts).toEqual([]);
    });
    it('control: Genie\'s own or a peer\'s text that starts with a slash is not a typed command', async () => {
        const { record, fake } = await started('codex');
        expect(host.prompt(record.id, '/frobnicate', 'genie')).toBe(true);
        expect(fake.prompts).toHaveLength(1);
    });
});

describe('a command typed to a Claude agent (its CLI runs what it advertised)', () => {
    it('advertised: sent as the prompt, as before; not advertised: refused', async () => {
        const { record, fake } = await started('claude', ['compact']);
        expect(host.promptWith(record.id, '/compact', [], 'you')).toEqual({ ok: true });
        expect(fake.prompts).toEqual(['/compact']);
        const sent = host.promptWith(record.id, '/nope', [], 'you');
        expect(sent.ok).toBe(false);
        expect(fake.prompts).toEqual(['/compact']);
    });
});

describe('Codex tool rows take the provider\'s own name (prism-acp 0.39.0)', () => {
    const row = (update: Record<string, unknown>) => ledgerRow({ id: 'r1', at: null, event: toStreamEvent(update)! });

    it('a shell command: kind `shell`, the command beside it', () => {
        const r = row({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'shell', title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
        expect(r.kind).toBe('shell');
        expect(r.main).toBe('shell  npm test');
    });

    it('an MCP call: kind `<server>.<tool>`; the tool is not said twice', () => {
        const r = row({ sessionUpdate: 'tool_call', toolCallId: 't2', name: 'genie.imDone', title: 'imDone', status: 'in_progress', rawInput: { description: 'handoff' } });
        expect(r.kind).toBe('genie.imDone');
        expect(r.main).toBe('genie.imDone  handoff');
    });

    it('an edit: kind `edit`', () => {
        const r = row({ sessionUpdate: 'tool_call', toolCallId: 't3', name: 'edit', title: 'Apply file changes', kind: 'edit', status: 'in_progress' });
        expect(r.kind).toBe('edit');
    });

    it('control: a call the provider did not name gets no name from Genie', () => {
        const r = row({ sessionUpdate: 'tool_call', toolCallId: 't4', title: 'mystery', status: 'in_progress', _meta: { 'particle.academy/native_item_type': 'dynamicToolCall' } });
        expect(r.kind).toBeNull();
    });
});
