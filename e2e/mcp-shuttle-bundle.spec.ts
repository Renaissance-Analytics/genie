import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * The BUILT MCP shuttle bundle starts on plain Node (genie#346).
 *
 * Unit tests prove the shuttle's behaviour and hold its import graph to Node
 * built-ins. What only a build can prove is that webpack's output,
 * `app/mcp-shuttle.js`, actually RUNS outside Electron — no `electron` require
 * slipped in through a bundler default, no chunk it cannot find, no module it
 * expects Electron to provide. This spawns the real file on the Node that runs
 * Playwright, which has no Electron at all, and talks to it over real loopback.
 */

const BUNDLE = path.resolve(__dirname, '..', 'app', 'mcp-shuttle.js');
const TOKEN = 'wsBundleToken';

const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
const blockers: net.Server[] = [];

test.afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
    await Promise.all(blockers.splice(0).map((b) => new Promise<void>((r) => b.close(() => r()))));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
}

function launch(port: number): { child: ChildProcessWithoutNullStreams; firstLine: Promise<Record<string, unknown>>; exited: Promise<number | null> } {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-shuttle-bundle-'));
    dirs.push(stateDir);
    fs.writeFileSync(
        path.join(stateDir, 'topology.json'),
        JSON.stringify({ endpoints: { [TOKEN]: { kind: 'workspace', workspaceId: 'w1' } }, workspaces: { w1: ['t1'] } }),
    );
    const child = spawn(process.execPath, [BUNDLE], {
        env: {
            ...process.env,
            GENIE_SHUTTLE_STATE_DIR: stateDir,
            GENIE_SHUTTLE_PORT: String(port),
            GENIE_SHUTTLE_WIRE_GENERATION: '1',
            GENIE_SHUTTLE_VERSION: 'e2e',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += String(c)));
    const firstLine = new Promise<Record<string, unknown>>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (c) => {
            out += String(c);
            const newline = out.indexOf('\n');
            if (newline >= 0) resolve(JSON.parse(out.slice(0, newline)));
        });
        child.once('exit', (code) => reject(new Error(`the bundle exited (${code}) before saying anything: ${stderr}`)));
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, firstLine, exited };
}

function ping(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: `/mcp/${TOKEN}`, method: 'POST', headers: { 'content-type': 'application/json' } },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    });
}

test('the built shuttle starts on plain Node and answers on its port', async () => {
    expect(fs.existsSync(BUNDLE), `${BUNDLE} was not built`).toBe(true);
    const port = await freePort();

    const { firstLine } = launch(port);

    expect(await firstLine).toMatchObject({ event: 'started', port });
    const answer = await ping(port);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ id: 1, result: {} });
});

test('the built shuttle refuses a taken port, says so, and exits with its refusal code', async () => {
    const port = await freePort();
    const blocker = net.createServer();
    blockers.push(blocker);
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));

    const { firstLine, exited } = launch(port);

    expect(await firstLine).toMatchObject({ event: 'refused', reason: 'port-in-use' });
    expect(await exited).toBe(3);
});

test('Genie’s spawner starts the built shuttle detached and hears back over IPC', async () => {
    // What Genie itself will do: the standalone runtime, the built bundle, output
    // to a log file, and the outcome as one IPC message rather than a pipe the
    // shuttle could die of EPIPE on once Genie exits.
    const { spawnShuttleProcess } = await import('../main/mcp-shuttle/spawn');
    const port = await freePort();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-shuttle-spawned-'));
    dirs.push(stateDir);

    const outcome = await spawnShuttleProcess({
        nodePath: process.execPath,
        scriptPath: BUNDLE,
        env: {
            ...(process.env as Record<string, string>),
            GENIE_SHUTTLE_STATE_DIR: stateDir,
            GENIE_SHUTTLE_PORT: String(port),
            GENIE_SHUTTLE_WIRE_GENERATION: '1',
            GENIE_SHUTTLE_VERSION: 'e2e',
        },
        logFile: path.join(stateDir, 'shuttle.log'),
    });

    expect(outcome.kind, JSON.stringify(outcome)).toBe('started');
    if (outcome.kind !== 'started') return;
    try {
        const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'shuttle.json'), 'utf8'));
        expect(record).toMatchObject({ pid: outcome.pid, port });
    } finally {
        process.kill(outcome.pid);
    }
});
