import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { McpContext } from '../../mcp/protocol';
import { createShuttleSupervisor, type ShuttleStatus, type ShuttleSupervisor, type SpawnOutcome } from '../ensure';
import { lengthPrefixedJsonCodec } from '../frame-codec';
import { buildManifest } from '../publisher';
import {
    readOrCreatePublisherSecret,
    shuttleControlPath,
    startShuttle,
    type RunningShuttle,
    type StartShuttleOptions,
} from '../shuttle';

/**
 * ENSURE A SHUTTLE, OR SAY WHY NOT — Genie's side of §3.3 and §9.1.
 *
 * genie#346 Phase 1. At boot Genie must end up in exactly one of two states: a
 * publisher attached to a live shuttle, or serving in-process as it does today.
 * Never neither — the app must not fail to start because a shuttle would not —
 * and never silently the second when the first was possible. After that, a shuttle
 * that dies must be noticed on the EVENT of its pipe closing and brought back,
 * not discovered by the next agent whose tools stopped answering.
 *
 * Real shuttles on real pipes; only the process spawn is stood in for, by starting
 * the shuttle in this process — what a spawn is for is proven separately.
 */

const WIRE = 5;

const dirs: string[] = [];
const shuttles: RunningShuttle[] = [];
const supervisors: ShuttleSupervisor[] = [];

afterEach(async () => {
    for (const s of supervisors.splice(0)) s.stop();
    await Promise.all(shuttles.splice(0).map((s) => s.close()));
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
}

async function world() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-ensure-'));
    dirs.push(stateDir);
    const base: StartShuttleOptions = {
        port: await freePort(),
        controlPath: shuttleControlPath(stateDir),
        stateDir,
        secret: readOrCreatePublisherSecret(stateDir),
        wireGeneration: WIRE,
        shuttleVersion: 'test',
    };
    const boot = async (over: Partial<StartShuttleOptions> = {}): Promise<RunningShuttle> => {
        const result = await startShuttle({ ...base, ...over });
        if (!result.ok) throw new Error(`test shuttle refused: ${result.error}`);
        shuttles.push(result.shuttle);
        return result.shuttle;
    };
    return { stateDir, base, boot };
}

type World = Awaited<ReturnType<typeof world>>;

function supervisor(w: World, over: Partial<Parameters<typeof createShuttleSupervisor>[0]> = {}) {
    const statuses: ShuttleStatus[] = [];
    const spawned = vi.fn(async (): Promise<SpawnOutcome> => {
        await w.boot();
        return { kind: 'started' };
    });
    const s = createShuttleSupervisor(
        {
            connect: () => net.connect(w.base.controlPath),
            codec: lengthPrefixedJsonCodec(),
            secret: () => readOrCreatePublisherSecret(w.stateDir),
            wireGeneration: WIRE,
            generation: 1,
            run: async () => ({ result: { ran: true } }),
            spawnShuttle: spawned,
            stopStaleShuttle: async () => {},
            retryDelaysMs: [0, 20, 50],
            ...over,
        },
        { onStatus: (status) => void statuses.push(status) },
    );
    supervisors.push(s);
    return { s, statuses, spawned };
}

async function manifest(generation: number) {
    const ctx = { terminalId: '', serverName: 'genie', serverVersion: 'test', pluginTools: () => [] } as unknown as McpContext;
    return buildManifest(ctx, { genieVersion: 'test', generation });
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 10));
    }
};

const publishedGeneration = (dir: string): number | null => {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).generation;
    } catch {
        return null;
    }
};

describe('at boot', () => {
    it('ATTACHES to a shuttle that is already running, and starts nothing', async () => {
        // The case that matters most: the shuttle outlived the Genie that started
        // it, and this is the new one. Spawning a second would be refused at best.
        const w = await world();
        const running = await w.boot();
        const { s, spawned } = supervisor(w);

        const status = await s.start();

        expect(status).toEqual({ mode: 'shuttle', how: 'attached' });
        expect(spawned).not.toHaveBeenCalled();
        expect(running.state()).toBe('attached');
    });

    it('STARTS one when none is running, then attaches to it', async () => {
        const w = await world();
        const { s, spawned } = supervisor(w);

        const status = await s.start();

        expect(status).toEqual({ mode: 'shuttle', how: 'spawned' });
        expect(spawned).toHaveBeenCalledOnce();
    });

    it('attaches when its own start lost a race to another Genie’s', async () => {
        const w = await world();
        const { s } = supervisor(w, {
            spawnShuttle: async () => {
                await w.boot();
                return { kind: 'refused', reason: 'control-in-use', error: 'Another MCP shuttle is already running.' };
            },
        });

        expect(await s.start()).toEqual({ mode: 'shuttle', how: 'attached' });
    });

    it('serves IN-PROCESS when the port is someone else’s, and says so', async () => {
        const w = await world();
        const { s } = supervisor(w, {
            spawnShuttle: async () => ({ kind: 'refused', reason: 'port-in-use', error: 'Port 51717 is already in use.' }),
        });

        const status = await s.start();

        expect(status.mode).toBe('in-process');
        expect(status.mode === 'in-process' && status.reason).toContain('51717');
    });

    it('serves IN-PROCESS when no shuttle can be started at all', async () => {
        const w = await world();
        const { s } = supervisor(w, {
            spawnShuttle: async () => ({ kind: 'failed', error: 'No standalone Node runtime is shipped with this build.' }),
        });

        const status = await s.start();

        expect(status).toMatchObject({ mode: 'in-process' });
        expect(status.mode === 'in-process' && status.reason).toContain('standalone Node');
    });

    it('REPLACES a shuttle that speaks another wire generation — a deep upgrade', async () => {
        const w = await world();
        let stale: RunningShuttle | null = await w.boot({ wireGeneration: WIRE - 1 });
        const stopStaleShuttle = vi.fn(async () => {
            await stale?.close();
            stale = null;
        });
        const { s, spawned } = supervisor(w, { stopStaleShuttle });

        const status = await s.start();

        expect(status).toEqual({ mode: 'shuttle', how: 'replaced' });
        expect(stopStaleShuttle).toHaveBeenCalledOnce();
        expect(spawned).toHaveBeenCalledOnce();
    });

    it('does NOT kill a shuttle it simply failed to authenticate to', async () => {
        // Only a wire mismatch is a reason to replace. A refused secret is a
        // process this Genie cannot prove is its own, and killing it is not a
        // decision to take on that evidence.
        const w = await world();
        await w.boot({ secret: 'someone-elses-secret-0123456789abcdef' });
        const stopStaleShuttle = vi.fn(async () => {});
        const { s } = supervisor(w, { stopStaleShuttle });

        const status = await s.start();

        expect(status.mode).toBe('in-process');
        expect(stopStaleShuttle).not.toHaveBeenCalled();
    });
});

describe('a Genie whose event loop is busy booting', () => {
    /** Hold the event loop, the way a Genie's own boot does on a slow machine. */
    const block = (ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            /* busy */
        }
    };

    it('does not give up on a welcome that ARRIVED while the loop was busy', async () => {
        // Measured on Windows CI: the welcome was already in the socket, but the
        // loop came back to its timer first — timers run before I/O — so Genie
        // closed a connection the shuttle had just welcomed and dispatched to,
        // and the call waiting for a Genie was answered "interrupted".
        //
        // The shuttle has to answer from ANOTHER process for the welcome to land
        // while this one is held, so it is a minimal one: welcome, 50ms after hello.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-ensure-stall-'));
        dirs.push(dir);
        const controlPath = shuttleControlPath(dir);
        const fixture = path.join(dir, 'slow-shuttle.cjs');
        fs.writeFileSync(
            fixture,
            `const net = require('net');
             net.createServer((sock) => {
                 sock.once('data', () => setTimeout(() => {
                     const body = Buffer.from(JSON.stringify({ type: 'welcome', wireGeneration: ${WIRE} }));
                     const head = Buffer.alloc(4);
                     head.writeUInt32BE(body.length);
                     sock.write(Buffer.concat([head, body]));
                 }, 50));
                 sock.on('error', () => {});
             }).listen(${JSON.stringify(controlPath)}, () => process.send('ready'));`,
        );
        const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise<void>((r) => child.once('message', () => r()));
        try {
            const s = createShuttleSupervisor({
                connect: () => net.connect(controlPath),
                codec: lengthPrefixedJsonCodec(),
                secret: () => 'irrelevant',
                wireGeneration: WIRE,
                generation: 1,
                run: async () => ({ result: {} }),
                spawnShuttle: async () => ({ kind: 'failed', error: 'must not be needed' }),
                stopStaleShuttle: async () => {},
                welcomeTimeoutMs: 100,
                retryDelaysMs: [],
            });
            supervisors.push(s);

            const started = s.start();
            await new Promise((r) => setTimeout(r, 20));
            // Held from the CHECK phase, so the next iteration begins at the timers.
            await new Promise<void>((r) => setImmediate(() => (block(500), r())));

            expect(await started).toEqual({ mode: 'shuttle', how: 'attached' });
        } finally {
            child.kill();
        }
    });
});

describe('what it publishes', () => {
    it('sends the latest surface on attach, and again to a shuttle that replaced a dead one', async () => {
        const w = await world();
        const { s } = supervisor(w);
        s.publish(await manifest(1));
        s.publish(await manifest(2));

        await s.start();
        await until(() => publishedGeneration(w.stateDir) === 2);

        // The shuttle dies and takes its files' writer with it; the new one must
        // be told again rather than trusted to have read them back.
        fs.rmSync(path.join(w.stateDir, 'manifest.json'));
        await shuttles.splice(0).at(0)!.close();

        await until(() => publishedGeneration(w.stateDir) === 2);
    });
});

describe('the watchdog (§9.1)', () => {
    it('brings a shuttle back when its pipe closes, with no request needed to notice', async () => {
        const w = await world();
        const { s, statuses, spawned } = supervisor(w);
        await s.start();
        spawned.mockClear();

        await shuttles.splice(0).at(0)!.close();

        await until(() => spawned.mock.calls.length === 1 && statuses.at(-1)?.mode === 'shuttle');
        expect(statuses.at(-1)).toEqual({ mode: 'shuttle', how: 'spawned' });
    });

    it('falls back IN-PROCESS once it has run out of attempts to bring one back', async () => {
        const w = await world();
        let first = true;
        const { s, statuses } = supervisor(w, {
            spawnShuttle: async () => {
                if (!first) return { kind: 'failed', error: 'it keeps dying' };
                first = false;
                await w.boot();
                return { kind: 'started' };
            },
        });
        await s.start();

        await shuttles.splice(0).at(0)!.close();

        await until(() => statuses.at(-1)?.mode === 'in-process');
        expect(statuses.at(-1)).toMatchObject({ mode: 'in-process' });
    });

    it('stands down when a NEWER Genie takes the shuttle over — it does not fight for it', async () => {
        const w = await world();
        await w.boot();
        const older = supervisor(w);
        await older.s.start();

        const newer = supervisor(w, { generation: 2 });
        await newer.s.start();

        await until(() => older.statuses.at(-1)?.mode === 'displaced');
        await new Promise((r) => setTimeout(r, 150));
        expect(older.spawned).not.toHaveBeenCalled();
        expect(newer.statuses.at(-1)).toEqual({ mode: 'shuttle', how: 'attached' });
    });

    it('does nothing further once stopped', async () => {
        const w = await world();
        const { s, spawned } = supervisor(w);
        await s.start();
        spawned.mockClear();

        s.stop();
        await shuttles.splice(0).at(0)!.close();
        await new Promise((r) => setTimeout(r, 150));

        expect(spawned).not.toHaveBeenCalled();
    });
});
