import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { linkToHost, type EngineLaunchPorts } from '../src/main/engine-launch.js';

// The endpoint is reserved early, but no local window can authenticate or discover the new token
// until the owned workspace API exists. Pin executable lines, not comments (Tynn #666).
it('the host builds its session and owned workspace API before admitting or publishing a local window', () => {
    const source = readFileSync('src/main/genie-host.ts', 'utf8').split(/\r?\n/)
        .map(line => line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    const main = 'async function main(): Promise<void> {';
    expect(source.split(main)).toHaveLength(2);
    const start = source.indexOf(main), end = source.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const lines = [
        '    const server: Server = createServer();', // No early accept callback in the constructor.
        '    const host = new ' + 'SessionHost({',
        '    engine.attach(host);',
        '    phoneApi = hostAloneApi({',
        "    server.on('connection', (socket) => engine.accept(lineTransport(socket), { local: true }));",
        '    await writeTextPrivate(tokenFile, token);',
        '    await writeTextPrivate(recordFile, JSON.stringify(record));',
    ];
    const positions = lines.map(line => {
        expect(body.split(line), line).toHaveLength(2);
        return body.indexOf(line);
    });
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    expect(source.match(/server\.(?:on|once|addListener)\(['"]connection['"]/g)).toHaveLength(1);
    expect(source.match(/engine\.accept\(/g)).toHaveLength(1);
    const factory = readFileSync('src/main/host-alone-api.ts', 'utf8');
    expect(factory).toMatch(/^export function hostAloneApi\(ports: HostAlonePorts\): HostApi \{/m);
});

describe('the actual window launcher waits for owned-service publication', () => {
    it.each(['first boot', 'restart with a stale record'] as const)('%s cannot connect to an unpublished host', async mode => {
        let published = false, clock = 0;
        let waiting!: () => void, release!: () => void;
        const paused = new Promise<void>(resolve => { waiting = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const runtimeDir = '/fixture-runtime';
        const record = (pid: number) => JSON.stringify({ pid, endpoint: `fixture-${pid}`, protocol: ENGINE_PROTOCOL, build: 'ready-666', startedAt: 1 });
        const connectTo = vi.fn(async () => {
            expect(published).toBe(true);
            return { send: () => {}, onLine: () => {}, onClose: () => {}, close: () => {} } as never;
        });
        const spawnHost = vi.fn(() => 42);
        const ports: EngineLaunchPorts = {
            runtimeDir, logsDir: '/fixture-logs', build: 'ready-666', hostScript: '/fixture-host.js',
            execPath: '/fixture-node', genieHome: '/fixture-home', env: {}, connectTo, spawnHost,
            alive: pid => pid === 42, now: () => clock,
            readFile: file => {
                if (file === join(runtimeDir, 'host.json')) return published ? record(42) : mode === 'first boot' ? null : record(41);
                if (file === join(runtimeDir, 'host.token')) return published ? 'fixture-token' : null;
                return null;
            },
            sleep: async ms => { waiting(); await gate; clock += ms; },
        };
        const pending = linkToHost(ports);
        try {
            await Promise.race([paused, pending.then(() => { throw new Error('the launcher linked before its host was published'); })]);
            expect(spawnHost).toHaveBeenCalledTimes(1); expect(connectTo).not.toHaveBeenCalled();
            published = true; release();
            await expect(pending).resolves.toMatchObject({ how: 'started', token: 'fixture-token', record: { pid: 42 } });
            expect(connectTo).toHaveBeenCalledExactlyOnceWith('fixture-42');
        } finally { published = true; release(); await pending.catch(() => {}); }
    });
});
