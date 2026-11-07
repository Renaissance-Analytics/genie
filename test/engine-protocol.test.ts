import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ENGINE_PROTOCOL, hostDecision, hostEndpoint, parseEngineFrame, parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { lineTransport, UNTRUSTED_LINE_LIMIT, type LineTransport } from '../src/core/line-transport.js';
import { parseMessage } from '../src/core/remote-protocol.js';
import { linkToHost, type EngineLaunchPorts } from '../src/main/engine-launch.js';

/** The host split's wire (phase 1): the remote bridge's envelope over the engine's table, a line transport, and discovery. */

describe('one envelope, two method tables', () => {
    it('an engine call parses on the engine table and is refused by the remote bridge\'s, and the other way round', () => {
        const engineCall = JSON.stringify({ kind: 'call', id: 1, method: 'engine.start', args: [] });
        expect(parseEngineFrame(engineCall)).toMatchObject({ ok: true, message: { kind: 'call', method: 'engine.start' } });
        expect(parseMessage(engineCall).ok).toBe(false);
        const bridgeCall = JSON.stringify({ kind: 'call', id: 1, method: 'openAgent', args: [] });
        expect(parseMessage(bridgeCall)).toMatchObject({ ok: true });
        expect(parseEngineFrame(bridgeCall).ok).toBe(false);
    });

    it('hello, welcome, result and event are the remote bridge\'s frames', () => {
        expect(parseEngineFrame(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token: 't' } }))).toMatchObject({ ok: true });
        expect(parseEngineFrame(JSON.stringify({ kind: 'welcome', connectionId: 'c', host: 'h', isOwner: true, workspaceId: null, protocol: 1 }))).toMatchObject({ ok: true });
        expect(parseEngineFrame(JSON.stringify({ kind: 'result', id: 3, ok: false, reason: 'no' }))).toMatchObject({ ok: true });
        expect(parseEngineFrame(JSON.stringify({ kind: 'event', channel: 'engine.agent', payload: {} }))).toMatchObject({ ok: true });
        expect(parseEngineFrame('not json').ok).toBe(false);
    });
});

describe('adopt, replace or start', () => {
    const record: HostRecord = { pid: 42, endpoint: 'e', protocol: ENGINE_PROTOCOL, build: 'b1', startedAt: 1 };
    const want = { protocol: ENGINE_PROTOCOL, build: 'b1' };

    it('a live host of this protocol and build is adopted', () => {
        expect(hostDecision(record, () => true, want)).toEqual({ kind: 'adopt', record });
    });

    it('a live host of another build or protocol is replaced, and says why', () => {
        expect(hostDecision({ ...record, build: 'b0' }, () => true, want)).toMatchObject({ kind: 'replace', why: 'build b0, this window is b1' });
        expect(hostDecision({ ...record, protocol: 0 }, () => true, want)).toMatchObject({ kind: 'replace' });
    });

    it('no record, an unreadable one, or a dead pid is a start', () => {
        expect(hostDecision(null, () => true, want)).toEqual({ kind: 'start' });
        expect(hostDecision(parseHostRecord('{"pid":"x"}'), () => true, want)).toEqual({ kind: 'start' });
        expect(hostDecision(record, () => false, want)).toEqual({ kind: 'start' });
    });

    it('the endpoint is a per-user pipe on Windows and a socket in the runtime dir elsewhere', () => {
        expect(hostEndpoint('win32', 'C:/x', 'abc')).toBe('\\\\.\\pipe\\genie-host-abc');
        expect(hostEndpoint('linux', '/home/u/.genie/runtime', 'abc')).toBe('/home/u/.genie/runtime/host.sock');
    });
});

/** A stream the line transport reads and writes, in memory. */
class FakeStream extends EventEmitter {
    written: string[] = [];
    destroyed = false;
    write(text: string): boolean { this.written.push(text); return true; }
    end(): void { this.emit('close'); }
    destroy(): void { this.destroyed = true; this.emit('close'); }
}

describe('the line transport', () => {
    it('reassembles frames split across chunks, and splits chunks that carry several', () => {
        const stream = new FakeStream();
        const t = lineTransport(stream);
        const got: string[] = [];
        t.onMessage((m) => got.push(m));
        stream.emit('data', Buffer.from('{"a":'));
        stream.emit('data', Buffer.from('1}\n{"b":2}\n{"c"'));
        stream.emit('data', ':3}\n');
        expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
        t.send('{"x":1}');
        expect(stream.written).toEqual(['{"x":1}\n']);
    });

    it('closes a peer that sends an unbroken line past the pre-auth limit; a trusted peer may send more', () => {
        const stream = new FakeStream();
        const t = lineTransport(stream);
        let closed = false;
        t.onClose(() => { closed = true; });
        stream.emit('data', 'x'.repeat(UNTRUSTED_LINE_LIMIT + 1));
        expect(closed).toBe(true);
        expect(stream.destroyed).toBe(true);

        const trusted = new FakeStream();
        const t2 = lineTransport(trusted);
        t2.trusted();
        const got: string[] = [];
        t2.onMessage((m) => got.push(m));
        trusted.emit('data', `${'y'.repeat(UNTRUSTED_LINE_LIMIT * 2)}\n`);
        expect(got[0]?.length).toBe(UNTRUSTED_LINE_LIMIT * 2);
    });
});

describe('linkToHost: the window finds its host', () => {
    const fakeTransport = (): LineTransport => ({ send: () => {}, onMessage: () => () => {}, onClose: () => () => {}, close: () => {}, trusted: () => {} });

    function ports(over: Partial<EngineLaunchPorts>, files: Map<string, string>, alive: Set<number>): EngineLaunchPorts {
        let t = 0;
        return {
            runtimeDir: '/rt', logsDir: '/logs', build: 'b1', hostScript: 'host.js', execPath: 'node', genieHome: '/g', env: {},
            alive: (pid) => alive.has(pid),
            readFile: (f) => files.get(f.replace(/\\/g, '/')) ?? null,
            connectTo: async () => fakeTransport(),
            sleep: async () => { t += 100; },
            now: () => t,
            ...over,
        };
    }

    it('adopts a live host of its build without starting one', async () => {
        const files = new Map([['/rt/host.json', JSON.stringify({ pid: 7, endpoint: 'p', protocol: ENGINE_PROTOCOL, build: 'b1', startedAt: 1 })], ['/rt/host.token', 'tok\n']]);
        let spawned = 0;
        const link = await linkToHost(ports({ spawnHost: () => { spawned += 1; return 8; } }, files, new Set([7])));
        expect(link).toMatchObject({ how: 'adopted', token: 'tok', record: { pid: 7 } });
        expect(spawned).toBe(0);
    });

    it('replaces a host of another build: asks it to shut down, waits, then starts its own', async () => {
        const files = new Map([['/rt/host.json', JSON.stringify({ pid: 7, endpoint: 'p', protocol: ENGINE_PROTOCOL, build: 'b0', startedAt: 1 })], ['/rt/host.token', 'old']]);
        const alive = new Set([7]);
        const order: string[] = [];
        const link = await linkToHost(ports({
            askShutdown: async () => { order.push('shutdown'); alive.delete(7); },
            spawnHost: () => {
                order.push('spawn');
                alive.add(9);
                files.set('/rt/host.json', JSON.stringify({ pid: 9, endpoint: 'p2', protocol: ENGINE_PROTOCOL, build: 'b1', startedAt: 2 }));
                files.set('/rt/host.token', 'new');
                return 9;
            },
        }, files, alive));
        expect(order).toEqual(['shutdown', 'spawn']);
        expect(link).toMatchObject({ how: 'replaced', token: 'new', record: { pid: 9 } });
    });

    it('a started host that exits before it is ready is an error naming its log, not a hang', async () => {
        const files = new Map<string, string>();
        await expect(linkToHost(ports({ spawnHost: () => 11 }, files, new Set()))).rejects.toThrow(/genie-host\.log/);
    });
});
