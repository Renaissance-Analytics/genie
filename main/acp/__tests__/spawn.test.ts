import { describe, expect, it, vi } from 'vitest';
import { startAcpAgent, type ChildLike, type SpawnPorts } from '../spawn';

/**
 * Starting a real ACP agent.
 *
 * The orchestration is tested against a fake child, because the interesting decisions
 * are all REFUSALS and they are the kind that do not fail loudly if they are missing:
 * spawning a provider with no ACP mode starts something that is not an ACP server and
 * then times out in the handshake (reads as a hung agent); spawning on the wrong Node
 * dies on an unsupported-engine error with nothing on screen; and forwarding an API key
 * works perfectly while billing the wrong account.
 */

const fakeChild = () => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const written: string[] = [];
    const on = (ev: string, cb: (...a: unknown[]) => void) => {
        (handlers[ev] ??= []).push(cb);
    };
    const child: ChildLike = {
        pid: 4242,
        stdout: { on: (_e, cb) => on('stdout', cb as never) },
        stderr: { on: (_e, cb) => on('stderr', cb as never) },
        stdin: { write: (s) => written.push(s) },
        on: (ev, cb) => on(ev, cb as never),
        kill: () => on('killed', () => {}),
    };
    return {
        child,
        written,
        emit: (ev: string, ...args: unknown[]) => (handlers[ev] ?? []).forEach((cb) => cb(...args)),
    };
};

const ports = (over: Partial<SpawnPorts> = {}) => {
    const f = fakeChild();
    const spawned: Array<{ command: string; args: string[]; env: Record<string, string>; cwd: string }> = [];
    const stderrLines: string[] = [];
    const p: SpawnPorts = {
        spawn: (command, args, env, cwd) => {
            spawned.push({ command, args, env, cwd });
            return f.child;
        },
        nodeVersion: () => 'v22.13.0',
        nodeExec: () => '/usr/bin/node',
        adapterScript: (pkg: string) => `/n/${pkg}/dist/index.js`,
        hostEnv: () => ({ PATH: '/usr/bin', HOME: '/home/me' }),
        onStderr: (line) => stderrLines.push(line),
        ...over,
    };
    return { ports: p, fake: f, spawned, stderrLines };
};

describe('refusals', () => {
    it('refuses a provider with no ACP mode, and NAMES it', () => {
        const { ports: p, spawned } = ports();
        const r = startAcpAgent({ provider: 'aider', cwd: '/w', auth: 'subscription' }, p);
        expect('error' in r && r.error).toMatch(/aider/);
        // And it did not start anything: a wrong spawn would run something that is not
        // an ACP server and then hang in the handshake.
        expect(spawned).toEqual([]);
    });

    it('refuses when the adapter is not installed, and says so differently', () => {
        // Distinct from "no ACP mode": this one has a fix, and the message has to point
        // at it rather than telling somebody their provider is unsupported.
        const { ports: p, spawned } = ports({ adapterScript: () => null });
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        expect('error' in r && r.error).toMatch(/not installed/);
        expect('error' in r && r.error).toMatch(/claude-agent-acp/);
        expect(spawned).toEqual([]);
    });

    it('refuses a Node below the floor, and names the version it found', () => {
        // The pty host runs 20.20.2. An operator reading "unsupported engine" from a
        // dead child learns nothing; the refusal has to say which runtime and why.
        const { ports: p, spawned } = ports({ nodeVersion: () => 'v20.20.2' });
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        expect('error' in r && r.error).toMatch(/20\.20\.2/);
        expect('error' in r && r.error).toMatch(/22/);
        expect(spawned).toEqual([]);
    });

    it('refuses rather than guessing when the Node version is unreadable', () => {
        const { ports: p } = ports({ nodeVersion: () => '' });
        expect('error' in startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p)).toBe(true);
    });
});

describe('the spawn itself', () => {
    it('runs the published adapter bin with bare argv, in the agent cwd', () => {
        const { ports: p, spawned } = ports();
        startAcpAgent({ provider: 'claude', cwd: '/repo', auth: 'subscription' }, p);
        expect(spawned[0]).toMatchObject({
            command: '/usr/bin/node',
            args: ['/n/@agentclientprotocol/claude-agent-acp/dist/index.js'],
            cwd: '/repo',
        });
    });

    it('gives the child the SUBSCRIPTION environment, with no api key in it', () => {
        // The requirement, at the one place it is actually applied.
        const { ports: p, spawned } = ports({
            hostEnv: () => ({ PATH: '/usr/bin', HOME: '/home/me', ANTHROPIC_API_KEY: 'sk-ant-live' }),
        });
        startAcpAgent({ provider: 'claude', cwd: '/repo', auth: 'subscription' }, p);
        expect(spawned[0]!.env.HOME).toBe('/home/me');
        expect('ANTHROPIC_API_KEY' in spawned[0]!.env).toBe(false);
    });

    it('POSITIVE CONTROL: passes the key when the session is an api-key one', () => {
        const { ports: p, spawned } = ports({
            hostEnv: () => ({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-live' }),
        });
        startAcpAgent({ provider: 'claude', cwd: '/repo', auth: 'api-key' }, p);
        expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBe('sk-ant-live');
    });

    it('uses the native mode for a provider that has one', () => {
        const { ports: p, spawned } = ports();
        startAcpAgent({ provider: 'gemini', cwd: '/repo', auth: 'subscription' }, p);
        expect(spawned[0]).toMatchObject({ command: 'gemini', args: ['--acp'] });
    });
});

describe('the wiring', () => {
    it('reads a message off stdout and delivers it to the client', async () => {
        const { ports: p, fake } = ports();
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        if ('error' in r) throw new Error(r.error);

        const seen: unknown[] = [];
        r.client.onNotification('session/update', (params) => seen.push(params));
        fake.emit('stdout', '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"notice"}}\n');
        expect(seen).toEqual([{ sessionUpdate: 'notice' }]);
    });

    it('reassembles a message split across two stdout chunks', async () => {
        const { ports: p, fake } = ports();
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        if ('error' in r) throw new Error(r.error);

        const seen: unknown[] = [];
        r.client.onNotification('session/update', (params) => seen.push(params));
        fake.emit('stdout', '{"jsonrpc":"2.0","method":"session/upd');
        expect(seen).toEqual([]);
        fake.emit('stdout', 'ate","params":{"sessionUpdate":"notice"}}\n');
        expect(seen).toEqual([{ sessionUpdate: 'notice' }]);
    });

    it('writes a request to the child stdin as one line', () => {
        const { ports: p, fake } = ports();
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        if ('error' in r) throw new Error(r.error);

        void r.client.request('initialize', { protocolVersion: 1 });
        expect(fake.written).toHaveLength(1);
        expect(fake.written[0]!.endsWith('\n')).toBe(true);
        expect(JSON.parse(fake.written[0]!)).toMatchObject({ method: 'initialize' });
    });

    it('CLOSES the client when the child exits, naming the code', async () => {
        // Otherwise every request in flight hangs, which upstream is indistinguishable
        // from an agent thinking very hard.
        const { ports: p, fake } = ports();
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        if ('error' in r) throw new Error(r.error);

        const pending = r.client.request('initialize', {});
        fake.emit('exit', 1, null);
        await expect(pending).rejects.toThrow(/1/);
        expect(r.client.closed).toBe(true);
    });

    it('closes the client when the spawn itself errors', async () => {
        const { ports: p, fake } = ports();
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        if ('error' in r) throw new Error(r.error);

        const pending = r.client.request('initialize', {});
        fake.emit('error', new Error('ENOENT'));
        await expect(pending).rejects.toThrow(/ENOENT/);
    });

    it('forwards stderr for diagnosis instead of discarding it', () => {
        // An ACP child that cannot authenticate says so on stderr and then exits. Drop
        // that and the only evidence of WHY is gone.
        const { ports: p, fake, stderrLines } = ports();
        startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        fake.emit('stderr', 'auth: no credentials found\n');
        expect(stderrLines.join('')).toContain('no credentials found');
    });

    it('reports the pid, so a human can find the process', () => {
        const { ports: p } = ports();
        const r = startAcpAgent({ provider: 'claude', cwd: '/w', auth: 'subscription' }, p);
        expect('error' in r ? null : r.pid).toBe(4242);
    });
});
