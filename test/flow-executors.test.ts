import { describe, expect, it } from 'vitest';
import { genieExecutors, type FlowPorts } from '../src/main/flow-executors.js';
import { GENIE_NODE_KINDS } from '../src/main/flow-kinds.js';

/**
 * FLOW EXECUTORS — Genie's own node kinds for fancy-flow, with every effect behind an injected port
 * so a flow can be run here without an agent, a pty or a store. Three kinds to start: prompt an
 * agent and wait for its reply; run a command in a workspace terminal and read its exit; add a
 * knowledge node. Every kind is namespaced `genie/…` and declares its ports and config, so the
 * canvas can draw it and a run can be pinned.
 */

function ports(over: Partial<FlowPorts> = {}): FlowPorts & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
        calls,
        promptAgent: async (address, text) => { calls.push(['prompt', address, text]); return `reply to: ${text}`; },
        runCommand: async (workspaceId, command, cwd) => { calls.push(['run', workspaceId, command, cwd]); return { exitCode: 0, output: 'ok\n' }; },
        addKnowledge: async (input) => { calls.push(['knowledge', input]); return { id: 'kn_1' }; },
        ...over,
    };
}

const node = (kind: string, config: Record<string, unknown>) => ({ id: 'n1', type: 'action', position: { x: 0, y: 0 }, data: { kind, label: kind, config } }) as never;
const ctx = (kind: string, config: Record<string, unknown>, inputs: Record<string, unknown> = {}) => ({
    node: node(kind, config),
    inputs,
    abort: (reason?: string): never => { throw new Error(reason ?? 'aborted'); },
    emit: () => {},
    executors: {},
}) as never;

describe('the kinds', () => {
    // Five since genie#1204 item 5: four steps, and the file trigger — a trigger has no input; every step has one.
    it('are four genie/ steps and one genie/ trigger, each with a category, ports and a config schema the canvas can draw', () => {
        expect(GENIE_NODE_KINDS.map((k) => k.name).sort()).toEqual(['genie/agent_prompt', 'genie/file_added', 'genie/file_move', 'genie/knowledge_add', 'genie/terminal_run']);
        for (const k of GENIE_NODE_KINDS) {
            // A category fancy-flow's NodeCategory has; the old 'action' is not one of them.
            expect(['ai', 'io', 'data', 'trigger']).toContain(k.category);
            expect((k.inputs as unknown[]).length, k.name).toBe(k.category === 'trigger' ? 0 : 1);
            expect((k.outputs as unknown[]).length).toBeGreaterThan(0);
            expect(k.configSchema!.length).toBeGreaterThan(0);
            expect(k.label.length).toBeGreaterThan(0);
        }
    });
});

describe('genie/agent_prompt', () => {
    it('prompts the configured agent with the templated text and outputs the reply', async () => {
        const p = ports();
        const ex = genieExecutors(p);
        const out = await ex['genie/agent_prompt']!(ctx('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'Summarise {{in.text}}' }, { in: { text: 'the release notes' } }));
        expect(p.calls).toEqual([['prompt', 'claude:atlas', 'Summarise the release notes']]);
        expect(out).toEqual({ reply: 'reply to: Summarise the release notes', agent: 'claude:atlas' });
    });

    it('no agent configured → the node aborts with the reason; a failing port aborts with ITS reason', async () => {
        const ex = genieExecutors(ports());
        await expect(ex['genie/agent_prompt']!(ctx('genie/agent_prompt', { prompt: 'x' }))).rejects.toThrow(/agent/);
        const failing = genieExecutors(ports({ promptAgent: async () => { throw new Error('atlas is not running'); } }));
        await expect(failing['genie/agent_prompt']!(ctx('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'x' }))).rejects.toThrow(/atlas is not running/);
    });
});

describe('genie/terminal_run', () => {
    it('runs the command in the workspace (cwd optional) and outputs exit code and output', async () => {
        const p = ports();
        const out = await genieExecutors(p)['genie/terminal_run']!(ctx('genie/terminal_run', { workspace: 'tynn', command: 'npm test', cwd: 'repos/tynn' }));
        expect(p.calls).toEqual([['run', 'tynn', 'npm test', 'repos/tynn']]);
        expect(out).toEqual({ exitCode: 0, output: 'ok\n', ok: true });
    });

    it('a non-zero exit FAILS the node unless allowFailure is set, in which case it is an output', async () => {
        const p = ports({ runCommand: async () => ({ exitCode: 2, output: 'boom' }) });
        await expect(genieExecutors(p)['genie/terminal_run']!(ctx('genie/terminal_run', { workspace: 'tynn', command: 'x' }))).rejects.toThrow(/exit code 2/);
        const out = await genieExecutors(p)['genie/terminal_run']!(ctx('genie/terminal_run', { workspace: 'tynn', command: 'x', allowFailure: true }));
        expect(out).toEqual({ exitCode: 2, output: 'boom', ok: false });
    });
});

describe('genie/knowledge_add', () => {
    it('adds a node with templated title and body, defaulting class to knowledge and scope to the flow’s workspace', async () => {
        const p = ports();
        const out = await genieExecutors(p)['genie/knowledge_add']!(ctx('genie/knowledge_add', { workspace: 'tynn', title: 'Run {{in.id}}', body: 'exit {{in.exitCode}}' }, { in: { id: 42, exitCode: 0 } }));
        expect(p.calls).toEqual([['knowledge', { title: 'Run 42', body: 'exit 0', class: 'knowledge', scope: { kind: 'workspace', id: 'tynn' }, tags: [] }]]);
        expect(out).toEqual({ id: 'kn_1' });
    });
});

describe('templating', () => {
    it('{{path}} resolves dotted paths into inputs; a missing path renders EMPTY and is reported, never the literal braces', async () => {
        const p = ports();
        const ex = genieExecutors(p);
        await ex['genie/agent_prompt']!(ctx('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'a={{in.a}} b={{in.missing}} c={{in.nested.c}}' }, { in: { a: 1, nested: { c: 'x' } } }));
        expect(p.calls[0]).toEqual(['prompt', 'claude:atlas', 'a=1 b= c=x']);
    });
});
