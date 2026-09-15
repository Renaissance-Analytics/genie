import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { McpContext } from '../../mcp/protocol';
import { SHUTTLE_ERROR_CODES } from '../core';
import { lengthPrefixedJsonCodec } from '../frame-codec';
import type { ShuttleManifest } from '../manifest-store';
import { buildManifest } from '../publisher';
import {
    readOrCreatePublisherSecret,
    shuttleControlPath,
    startShuttle,
    type RunningShuttle,
    type StartShuttleOptions,
} from '../shuttle';
import type { ShuttleTopology } from '../topology-store';

/**
 * THE SHUTTLE, AS A RUNNING THING.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2, §9.1, §9.2. Every
 * layer below has its own tests; this is the one that owns a port, a control
 * pipe and a state directory, and has to behave when any of them is already
 * someone else's. Real loopback sockets and a real directory — nothing here is
 * worth faking, because the failures it guards against live in the OS.
 */

const TOKEN = 'wsShuttleToken';
const WIRE = 3;

const dirs: string[] = [];
const running: RunningShuttle[] = [];
const blockers: net.Server[] = [];

afterEach(async () => {
    await Promise.all(running.splice(0).map((s) => s.close()));
    await Promise.all(blockers.splice(0).map((b) => new Promise<void>((r) => b.close(() => r()))));
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stateDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-shuttle-'));
    dirs.push(dir);
    return dir;
}

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
}

async function manifest(generation = 1): Promise<ShuttleManifest> {
    const ctx = {
        terminalId: '',
        serverName: 'genie',
        serverVersion: '0.7.0-beta.323',
        pluginTools: () => [{ name: 'artboard_post', description: 'Post.', inputSchema: { type: 'object' } }],
    } as unknown as McpContext;
    return buildManifest(ctx, { genieVersion: '0.7.0-beta.323', generation });
}

const topology: ShuttleTopology = {
    endpoints: { [TOKEN]: { kind: 'workspace', workspaceId: 'w1' } },
    workspaces: { w1: ['t-only'] },
};

async function options(dir: string, over: Partial<StartShuttleOptions> = {}): Promise<StartShuttleOptions> {
    return {
        port: await freePort(),
        controlPath: shuttleControlPath(dir),
        stateDir: dir,
        secret: readOrCreatePublisherSecret(dir),
        wireGeneration: WIRE,
        shuttleVersion: '0.7.0-beta.323',
        ...over,
    };
}

async function start(opts: StartShuttleOptions): Promise<RunningShuttle> {
    const result = await startShuttle(opts);
    if (!result.ok) throw new Error(`shuttle refused to start: ${result.error}`);
    running.push(result.shuttle);
    return result.shuttle;
}

function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: `/mcp/${TOKEN}`,
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            },
            (res) => {
                let text = '';
                res.on('data', (c) => (text += c));
                res.on('end', () => {
                    const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).at(-1);
                    resolve({ status: res.statusCode ?? 0, json: JSON.parse(data ? data.slice(5) : text) });
                });
            },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

/** A publisher speaking the control channel frame by frame, as Genie will. */
async function publishOver(controlPath: string, secret: string, frames: unknown[]): Promise<net.Socket> {
    const codec = lengthPrefixedJsonCodec();
    const socket = net.connect(controlPath);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const decoder = codec.decoder();
    const welcomed = new Promise<void>((resolve, reject) => {
        socket.on('data', (chunk: Buffer) => {
            for (const m of decoder.push(chunk) as Array<{ type: string; reason?: string }>) {
                if (m.type === 'welcome') resolve();
                if (m.type === 'closed') reject(new Error(m.reason));
            }
        });
    });
    socket.write(codec.encode({ type: 'hello', wireGeneration: WIRE, secret, generation: 1 }));
    await welcomed;
    for (const frame of frames) socket.write(codec.encode(frame));
    return socket;
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 20));
    }
};

describe('startShuttle — the port it owns (§9.2)', () => {
    it('REFUSES to start when the configured port is taken, and records why', async () => {
        // Every `.mcp.json` names this port as a literal. A shuttle that quietly
        // took another one would be healthy and unreachable: every agent dials the
        // configured port and gets somebody else. Refusing lets Genie serve
        // in-process instead, and the record is what makes the refusal visible.
        const dir = stateDir();
        const opts = await options(dir);
        const blocker = net.createServer();
        blockers.push(blocker);
        await new Promise<void>((r) => blocker.listen(opts.port, '127.0.0.1', r));

        const result = await startShuttle(opts);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('port-in-use');
        // Its own file: a refusal must never overwrite the record of a shuttle
        // that IS running.
        const refused = JSON.parse(fs.readFileSync(path.join(dir, 'refused.json'), 'utf8'));
        expect(refused).toMatchObject({ reason: 'port-in-use', port: opts.port });
        // Nothing half-started is left behind: the control channel is not up.
        await expect(
            new Promise((resolve, reject) => net.connect(opts.controlPath).once('connect', resolve).once('error', reject)),
        ).rejects.toBeTruthy();
    });

    it('POSITIVE CONTROL: binds a free port and says so in shuttle.json', async () => {
        const dir = stateDir();
        const opts = await options(dir);

        const shuttle = await start(opts);

        expect(shuttle.port).toBe(opts.port);
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'shuttle.json'), 'utf8'));
        expect(record).toMatchObject({ pid: process.pid, port: opts.port, wireGeneration: WIRE });
        expect(fs.existsSync(path.join(dir, 'refused.json'))).toBe(false);
    });

    it('refuses when another shuttle already holds the control channel', async () => {
        const dir = stateDir();
        // Routed, so the running shuttle's answer below is about IT, not a 404.
        fs.writeFileSync(path.join(dir, 'topology.json'), JSON.stringify(topology));
        const first = await start(await options(dir));

        const second = await startShuttle(await options(dir));

        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.reason).toBe('control-in-use');
        // The first one is untouched by the attempt, and so is its record.
        expect((await post(first.port, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'shuttle.json'), 'utf8'));
        expect(record.port).toBe(first.port);
    });
});

describe('startShuttle — what outlives Genie (§3.2)', () => {
    it('keeps what a Genie published, and serves it after the shuttle itself restarts', async () => {
        const dir = stateDir();
        const opts = await options(dir);
        const first = await start(opts);
        const published = await manifest();
        const socket = await publishOver(opts.controlPath, opts.secret, [
            { type: 'publish', manifest: published },
            { type: 'topology', topology },
        ]);
        await until(() => fs.existsSync(path.join(dir, 'manifest.json')) && fs.existsSync(path.join(dir, 'topology.json')));
        socket.destroy();
        await first.close();
        running.splice(running.indexOf(first), 1);

        // A cold shuttle, no Genie anywhere: discovery is still answered.
        const second = await start(opts);
        const init = await post(second.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        const tools = await post(second.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

        expect(init.json.result?.serverInfo?.name).toBe('genie');
        expect(tools.json.result?.tools.map((t: { name: string }) => t.name)).toContain('artboard_post');
    });

    it('ignores a publish from a connection that never authenticated', async () => {
        const dir = stateDir();
        const opts = await options(dir);
        await start(opts);
        const codec = lengthPrefixedJsonCodec();
        const socket = net.connect(opts.controlPath);
        await new Promise<void>((r) => socket.once('connect', () => r()));
        socket.write(codec.encode({ type: 'publish', manifest: await manifest() }));
        await new Promise((r) => setTimeout(r, 200));
        socket.destroy();

        expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    });
});

describe('startShuttle — a Genie that does not come back (§9.1)', () => {
    it('answers a waiting call once the grace runs out, with nothing else arriving to notice', async () => {
        // The core only ORPHANS when told the time has passed. A shuttle that
        // relied on the next request to tell it would leave the one agent that
        // is waiting hanging for as long as nobody else calls — which, with Genie
        // gone, may be forever. The timer is the shuttle's, armed at boot and on
        // every detach.
        const dir = stateDir();
        fs.writeFileSync(path.join(dir, 'topology.json'), JSON.stringify(topology));
        const shuttle = await start(await options(dir, { graceMs: 150 }));

        const started = Date.now();
        const call = await post(shuttle.port, {
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'imDone', arguments: {} },
        });

        expect(call.json.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieOrphaned);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('still answers when the timer fires a moment BEFORE the clock says the grace is up', async () => {
        // The timer and the clock are not the same clock. Node schedules timers
        // on its loop's cached monotonic time and the core measures the grace with
        // `now()`, so a timer can fire when `now()` says a millisecond or two of
        // grace is still left. The core then correctly declines to orphan — and
        // nothing ever asked again, so the waiting call hung for good. It did, on
        // CI: this suite's test above timed out at 60s on a loaded runner.
        //
        // Reproduced deterministically with a clock that reads BEHIND at the first
        // tick, exactly as a loop-time lag would.
        const dir = stateDir();
        fs.writeFileSync(path.join(dir, 'topology.json'), JSON.stringify(topology));
        let lagNextReadAfter = Number.POSITIVE_INFINITY;
        let lagged = false;
        const now = () => {
            const real = Date.now();
            if (!lagged && real >= lagNextReadAfter) {
                lagged = true;
                return real - 1_000;
            }
            return real;
        };
        const graceMs = 150;
        const shuttle = await start(await options(dir, { graceMs, now }));
        // The request's own tick runs as it arrives, well inside the grace; the
        // TIMER's tick is the first read this late, and that is the one that lies,
        // as a timer firing ahead of the clock would.
        lagNextReadAfter = Date.now() + graceMs - 30;

        const started = Date.now();
        const call = await post(shuttle.port, {
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: { name: 'imDone', arguments: {} },
        });

        expect(lagged, 'the lagging read must actually have happened').toBe(true);
        expect(call.json.error?.code).toBe(SHUTTLE_ERROR_CODES.GenieOrphaned);
        expect(Date.now() - started).toBeLessThan(3_000);
    }, 10_000);
});

describe('startShuttle — what it says about itself (§9.1)', () => {
    it('logs each Genie that attaches and each that goes, with the generation', async () => {
        // A shuttle is a process nobody watches. When agents' calls start failing,
        // its log is the only account of whether a Genie was attached at the time.
        const dir = stateDir();
        const events: Array<Record<string, unknown>> = [];
        const opts = await options(dir, { log: (event) => void events.push(event) });
        await start(opts);

        const socket = await publishOver(opts.controlPath, opts.secret, []);
        await until(() => events.some((e) => e.event === 'attached'));
        socket.destroy();
        await until(() => events.some((e) => e.event === 'detached'));

        expect(events.find((e) => e.event === 'attached')).toMatchObject({ generation: 1 });
        expect(events.map((e) => e.event)).toEqual(['attached', 'detached']);
    });
});

describe('the publisher secret', () => {
    it('is created once and read back unchanged', () => {
        const dir = stateDir();
        const first = readOrCreatePublisherSecret(dir);
        const second = readOrCreatePublisherSecret(dir);

        expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(second).toBe(first);
    });

    it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
        const dir = stateDir();
        readOrCreatePublisherSecret(dir);

        expect(fs.statSync(path.join(dir, 'publisher.secret')).mode & 0o077).toBe(0);
    });
});
