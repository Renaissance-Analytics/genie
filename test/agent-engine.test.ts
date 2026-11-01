import { describe, expect, it } from 'vitest';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import type { LineTransport } from '../src/core/line-transport.js';
import { connectAgentEngine } from '../src/main/agent-engine.js';

/**
 * THE EMERGENCY FALLBACK NEVER RUNS BESIDE A LIVE HOST (genie-test-windows, 2026-11-01).
 *
 * Measured: a relaunched window could not link to the running host, gave up, and fell back to the in-process engine —
 * whose boot sweep ended all eleven of the live host's providers (lifecycle.log `sweep kind=agent … ended=…`, three
 * seconds after the relaunch). The fallback exists for "the host cannot start at all" (plan §4.1). A host that is alive
 * and not answering is a host to keep reaching, said on the Deck — never one to run a second engine beside.
 */

/** A transport that closes as soon as the window says hello: a live host that refuses, or drops, the link. */
const closingTransport = (): LineTransport => {
    const closes = new Set<() => void>();
    return {
        send: () => { queueMicrotask(() => { for (const l of [...closes]) l(); }); },
        onMessage: () => () => {},
        onClose: (l) => { closes.add(l); return () => closes.delete(l); },
        close: () => {},
        trusted: () => {},
    };
};

const files = (pid: number) => new Map([
    ['/rt/host.json', JSON.stringify({ pid, endpoint: 'pipe', protocol: ENGINE_PROTOCOL, build: 'b1', startedAt: 1 })],
    ['/rt/host.token', 'tok'],
]);

function options(live: Set<number>, fileMap: Map<string, string>, errors: string[], spawned: number[]) {
    return {
        callbacks: {},
        launch: {
            runtimeDir: '/rt', logsDir: '/logs', build: 'b1', hostScript: 'host.js', execPath: 'node', genieHome: '/g', env: {},
            alive: (pid: number) => live.has(pid),
            readFile: (f: string) => fileMap.get(f.replace(/\\/g, '/')) ?? null,
            connectTo: async () => closingTransport(),
            spawnHost: () => { spawned.push(1); return null; },
            sleep: async () => {},
            startTimeoutMs: 1,
        },
        records: () => [],
        onError: (_kind: string, e: Error) => { errors.push(e.message); },
        agentName: (id: string) => id,
        log: () => {},
        sleep: () => new Promise<void>(() => {}), // reconnects wait forever here: the test reads the first answer only
    };
}

describe('connectAgentEngine beside a live host', () => {
    it('a LIVE host that will not link is never answered with the in-process fallback (null)', async () => {
        const errors: string[] = [];
        const spawned: number[] = [];
        const link = await connectAgentEngine(options(new Set([4242]), files(4242), errors, spawned));
        // Not null: main keeps the client (disconnected, reconnecting) and runs NO engine of its own.
        expect(link).not.toBeNull();
        expect(link?.client.connected).toBe(false);
        // A live host is never replaced or doubled because one link failed.
        expect(spawned).toEqual([]);
        expect(errors.join(' ')).toMatch(/running but not answering/);
    });

    it('positive control: with NO live host and none that can start, the answer is null — the emergency fallback', async () => {
        const errors: string[] = [];
        const link = await connectAgentEngine(options(new Set(), new Map(), errors, []));
        expect(link).toBeNull();
    });
});
