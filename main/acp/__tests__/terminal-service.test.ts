import { describe, expect, it } from 'vitest';
import { AcpTerminalService, type TerminalPorts } from '../terminal-service';

/**
 * The agent asking the CLIENT to run a command — and the keystone of "demote the
 * terminal, do not delete it". Genie's pty host stops being the agent's interface and
 * becomes its tool.
 *
 * The assertions worth having are the refusals and the one piece of honesty:
 *
 *  - a cwd outside the workspace is REFUSED, because the agent names it and an agent
 *    running commands elsewhere is operating somewhere nobody agreed to;
 *  - an unknown terminal id is an ERROR, not an empty success, because empty output reads
 *    as "the command produced nothing";
 *  - `truncated` is reported, because an agent reading a silently-trimmed log draws
 *    conclusions from evidence missing its beginning.
 */

const ports = (over: Partial<TerminalPorts> = {}) => {
    const created: Array<Record<string, unknown>> = [];
    const killed: string[] = [];
    const removed: string[] = [];
    const p: TerminalPorts = {
        create: (opts) => {
            created.push({ ...opts });
            return `spec-${created.length}`;
        },
        readSince: () => ({ data: 'out', cursor: 1, truncated: false }),
        kill: (id) => killed.push(id),
        remove: (id) => removed.push(id),
        waitForExit: async () => ({ exitCode: 0, signal: null }),
        workspaceRoot: () => '/ws',
        isInside: (root, child) => child.startsWith(root),
        ...over,
    };
    return { ports: p, created, killed, removed };
};

describe('create', () => {
    it('runs the command in the workspace root by default', () => {
        const { ports: p, created } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        const { terminalId } = svc.create({ command: 'npm', args: ['test'] });

        expect(terminalId).toMatch(/^acp-term-/);
        expect(created[0]).toMatchObject({ command: 'npm', args: ['test'], cwd: '/ws', ownerSpecId: 'agent-1' });
    });

    it('REFUSES a cwd outside the workspace', () => {
        // The agent names it, so it is untrusted input.
        const { ports: p, created } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        expect(() => svc.create({ command: 'sh', cwd: '/etc' })).toThrow(/outside this agent/i);
        expect(created).toEqual([]);
    });

    it('allows a cwd inside the workspace', () => {
        // Positive control: without it, "refuses /etc" would also pass for a service that
        // refuses everything.
        const { ports: p, created } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        svc.create({ command: 'npm', cwd: '/ws/packages/app' });
        expect(created[0]).toMatchObject({ cwd: '/ws/packages/app' });
    });

    it('refuses when the agent has no workspace at all', () => {
        const { ports: p } = ports({ workspaceRoot: () => null });
        expect(() => new AcpTerminalService('agent-1', p).create({ command: 'sh' })).toThrow(/no workspace/i);
    });

    it('turns the protocol env list into an env object', () => {
        const { ports: p, created } = ports();
        new AcpTerminalService('agent-1', p).create({
            command: 'sh',
            env: [{ name: 'FOO', value: 'bar' }],
        });
        expect(created[0]!.env).toEqual({ FOO: 'bar' });
    });

    it('gives each terminal a distinct id', () => {
        const { ports: p } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        const a = svc.create({ command: 'a' }).terminalId;
        const b = svc.create({ command: 'b' }).terminalId;
        expect(a).not.toBe(b);
    });
});

describe('output', () => {
    it('returns what is new since the last read, advancing the cursor', () => {
        // Cursor-addressed, which is the contract terminal/output describes.
        const seen: number[] = [];
        const { ports: p } = ports({
            readSince: (_id, cursor) => {
                seen.push(cursor);
                return { data: 'chunk', cursor: cursor + 5, truncated: false };
            },
        });
        const svc = new AcpTerminalService('agent-1', p);
        const { terminalId } = svc.create({ command: 'sh' });

        svc.output(terminalId);
        svc.output(terminalId);
        expect(seen).toEqual([0, 5]);
    });

    it('REPORTS truncation rather than hiding it', () => {
        const { ports: p } = ports({
            readSince: () => ({ data: 'tail only', cursor: 9, truncated: true }),
        });
        const svc = new AcpTerminalService('agent-1', p);
        const { terminalId } = svc.create({ command: 'sh' });
        expect(svc.output(terminalId)).toEqual({ output: 'tail only', truncated: true });
    });

    it('returns output RAW, escapes and all', () => {
        // stripAnsi is lossy and for display. A parser is better served by escapes it can
        // ignore than by a mangled approximation.
        const raw = 'before\u001b[31mred\u001b[0mafter';
        const { ports: p } = ports({ readSince: () => ({ data: raw, cursor: 1, truncated: false }) });
        const svc = new AcpTerminalService('agent-1', p);
        const { terminalId } = svc.create({ command: 'sh' });
        expect(svc.output(terminalId).output).toBe(raw);
    });

    it('ERRORS on an unknown terminal instead of returning nothing', () => {
        // Empty output reads as "the command produced nothing", which is a lie about
        // something that never ran.
        const { ports: p } = ports();
        expect(() => new AcpTerminalService('agent-1', p).output('ghost')).toThrow(/unknown terminal/i);
    });
});

describe('lifecycle', () => {
    it('kills on request without forgetting the terminal', async () => {
        // kill is not release: the agent may still want the exit status.
        const { ports: p, killed } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        const { terminalId } = svc.create({ command: 'sh' });
        svc.kill(terminalId);
        expect(killed).toEqual(['spec-1']);
        await expect(svc.waitForExit(terminalId)).resolves.toEqual({ exitCode: 0, signal: null });
    });

    it('release kills AND removes the spec', () => {
        // Otherwise an agent that opens terminals all session leaves a pile of dead specs
        // behind it.
        const { ports: p, killed, removed } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        const { terminalId } = svc.create({ command: 'sh' });
        svc.release(terminalId);
        expect(killed).toEqual(['spec-1']);
        expect(removed).toEqual(['spec-1']);
        expect(() => svc.output(terminalId)).toThrow(/unknown terminal/i);
    });

    it('lists what it still holds, so teardown can reap them', () => {
        const { ports: p } = ports();
        const svc = new AcpTerminalService('agent-1', p);
        svc.create({ command: 'a' });
        const b = svc.create({ command: 'b' }).terminalId;
        expect(svc.liveSpecIds()).toEqual(['spec-1', 'spec-2']);
        svc.release(b);
        expect(svc.liveSpecIds()).toEqual(['spec-1']);
    });
});
