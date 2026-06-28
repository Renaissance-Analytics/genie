import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
    startMobileServer,
    stopMobileServer,
    mobileServerState,
    mobileEmit,
    mobileTermFanout,
    setLocked,
} from '../server';
import { _resetAuthForTest, currentPin } from '../auth';
import { _resetAuditForTest } from '../audit';
import { _resetBridgeForTest } from '../terminal-bridge';
import type { MobileDataDeps } from '../api';

/**
 * Mobile-server integration test. We bind to 127.0.0.1 via the test-only
 * bindIpOverride (no real tailnet) and drive the REAL http + ws stack:
 *   - REST: pair happy-path (stubbed auto-confirm) → token; bad-PIN rate-limit;
 *     401 without a token; /api/state with a token.
 *   - WS: /ws/events receives an emitted event; /ws/term echoes phone input into
 *     a writeToTerminal mock and streams pty onData (via mobileTermFanout).
 * Catches serialization/auth/wiring bugs Pest-style in-process tests miss.
 */

let appDir: string;
const written: Array<{ id: string; data: string }> = [];
// Drives the mock updater deps: flip to true to simulate a staged build so the
// install endpoint returns 200; left false it reports not-ready (→ 409).
let updateReady = false;

function buildAppDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mobile-it-'));
    fs.writeFileSync(
        path.join(dir, 'mobile.html'),
        '<!doctype html><html><head></head><body>m</body></html>',
    );
    return dir;
}

let wsRoot: string;

const deps = (): MobileDataDeps => ({
    listWorkspaces: () => [{ id: 'ws-1', project_name: 'Demo', path: wsRoot }],
    listTerminalSpecs: () => [
        {
            id: 't-1',
            workspace_id: 'ws-1',
            label: 'shell',
            type: 'terminal',
            cwd: '/tmp/demo',
            live_cwd: null,
        },
    ],
    listAllProcesses: () => [],
    liveTerminalIds: () => ['t-1'],
    startProcess: () => {},
    stopProcess: () => {},
    restartProcess: () => {},
    createAgentTerminal: () => ({ id: 't-new', scrollback: '' }),
    killTerminalById: () => true,
    writeToTerminal: (id, data) => {
        written.push({ id, data });
        return true;
    },
    readTerminalOutput: () => ({ data: '', cursor: 0, dropped: false }),
    getScrollback: () => 'catch-up-scrollback',
    resize: () => true,
    listPendingQuestions: () => [],
    answerPendingQuestion: () => true,
    updateStatus: () => ({
        state: updateReady ? 'ready-to-restart' : 'up-to-date',
        currentVersion: '0.0.0-test',
        latestVersion: updateReady ? '0.0.1-test' : null,
        readyToInstall: updateReady,
    }),
    installUpdate: () =>
        updateReady ? { ok: true } : { ok: false, reason: 'not-ready' as const },
    checkUpdate: async () => ({
        state: updateReady ? 'ready-to-restart' : 'up-to-date',
        currentVersion: '0.0.0-test',
        latestVersion: updateReady ? '0.0.1-test' : null,
        readyToInstall: updateReady,
    }),
});

async function start(autoConfirm = true): Promise<number> {
    appDir = buildAppDir();
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mobile-ws-'));
    await startMobileServer({
        serverVersion: '0.0.0-test',
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mobile-ud-')),
        appDir,
        enabled: true,
        configuredPort: () => 0, // ephemeral — avoid clashing with a real 51718
        data: deps(),
        confirmPair: async () => autoConfirm,
        bindIpOverride: '127.0.0.1',
    });
    const st = mobileServerState();
    if (!st.running || !st.port) throw new Error('server did not bind');
    return st.port;
}

function req(
    port: number,
    method: string,
    pathname: string,
    opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
        const headers: Record<string, string> = {};
        if (data) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(Buffer.byteLength(data));
        }
        if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
        const r = http.request(
            { host: '127.0.0.1', port, path: pathname, method, headers },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    let json: any = null;
                    try {
                        json = body ? JSON.parse(body) : null;
                    } catch {
                        json = body;
                    }
                    resolve({ status: res.statusCode ?? 0, json });
                });
            },
        );
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

/**
 * Open a WS and resolve once connected (or reject on error). A `message`
 * listener is attached BEFORE 'open' resolves so no early frame (e.g. the
 * /ws/term catch-up the server sends the instant the socket is up) is missed.
 */
function openWs(url: string, frames?: any[]): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { origin: 'http://127.0.0.1' });
        if (frames) ws.on('message', (m) => frames.push(JSON.parse(String(m))));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

/** Pair and return a valid bearer token. */
async function pair(port: number): Promise<string> {
    const r = await req(port, 'POST', '/api/pair', { body: { pin: currentPin() } });
    expect(r.status).toBe(200);
    return r.json.token as string;
}

beforeEach(() => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetBridgeForTest();
    written.length = 0;
    updateReady = false;
});

afterEach(() => {
    stopMobileServer();
    if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
    if (wsRoot) {
        fs.rmSync(wsRoot, { recursive: true, force: true });
        wsRoot = '';
    }
});

describe('mobile server (integration, 127.0.0.1)', () => {
    it('serves the app shell under /m/ with the <base> injected', async () => {
        const port = await start();
        const res = await new Promise<{ status: number; body: string }>((resolve) => {
            http.get({ host: '127.0.0.1', port, path: '/m/' }, (r) => {
                let body = '';
                r.on('data', (c) => (body += c));
                r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
            });
        });
        expect(res.status).toBe(200);
        expect(res.body).toContain('<base href="/m/">');
    });

    it('pairs on the correct PIN + desktop confirm and mints a token', async () => {
        const port = await start(true);
        const token = await pair(port);
        expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects a wrong PIN and rate-limits after several attempts', async () => {
        const port = await start(true);
        const wrong = currentPin() === '000000' ? '111111' : '000000';
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) {
            const r = await req(port, 'POST', '/api/pair', { body: { pin: wrong } });
            statuses.push(r.status);
        }
        expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
        expect(statuses.slice(5)).toContain(429);
    });

    it('401s /api/state without a token, 200s with one', async () => {
        const port = await start();
        const noTok = await req(port, 'GET', '/api/state');
        expect(noTok.status).toBe(401);

        const token = await pair(port);
        const ok = await req(port, 'GET', '/api/state', { token });
        expect(ok.status).toBe(200);
        expect(ok.json.workspaces[0].name).toBe('Demo');
        expect(ok.json.terminals[0].id).toBe('t-1');
        expect(ok.json.terminals[0].running).toBe(true);
    });

    it('refuses a state-changing action while locked (423), then allows after unlock', async () => {
        const port = await start();
        const token = await pair(port);
        setLocked(true);
        const locked = await req(port, 'POST', '/api/terminal/t-1/kill', { token });
        expect(locked.status).toBe(423);
        setLocked(false);
        const ok = await req(port, 'POST', '/api/terminal/t-1/kill', { token });
        expect(ok.status).toBe(200);
    });

    it('GET /api/update/status: 401 without a token, 200 with one', async () => {
        const port = await start();
        const noTok = await req(port, 'GET', '/api/update/status');
        expect(noTok.status).toBe(401);

        const token = await pair(port);
        const ok = await req(port, 'GET', '/api/update/status', { token });
        expect(ok.status).toBe(200);
        expect(ok.json.state).toBe('up-to-date');
        expect(ok.json.readyToInstall).toBe(false);
        expect(ok.json.currentVersion).toBe('0.0.0-test');
    });

    it('POST /api/update/install: 409 when nothing is staged', async () => {
        const port = await start();
        const token = await pair(port);
        const r = await req(port, 'POST', '/api/update/install', { token });
        expect(r.status).toBe(409);
    });

    it('POST /api/update/install: 200 once a build is staged', async () => {
        const port = await start();
        const token = await pair(port);
        updateReady = true;
        const ready = await req(port, 'GET', '/api/update/status', { token });
        expect(ready.json.readyToInstall).toBe(true);
        const r = await req(port, 'POST', '/api/update/install', { token });
        expect(r.status).toBe(200);
        expect(r.json.ok).toBe(true);
    });

    it('POST /api/update/install: 423 while the desktop is locked', async () => {
        const port = await start();
        const token = await pair(port);
        updateReady = true;
        setLocked(true);
        const locked = await req(port, 'POST', '/api/update/install', { token });
        expect(locked.status).toBe(423);
        setLocked(false);
    });

    it('rejects a WS upgrade without a valid token', async () => {
        const port = await start();
        await expect(openWs(`ws://127.0.0.1:${port}/ws/events?token=bogus`)).rejects.toBeTruthy();
    });

    it('/ws/events delivers an emitted dashboard event', async () => {
        const port = await start();
        const token = await pair(port);
        const evFrames: any[] = [];
        const ws = await openWs(`ws://127.0.0.1:${port}/ws/events?token=${token}`, evFrames);
        // Give the socket a tick to register in the set, then emit.
        await new Promise((r) => setTimeout(r, 20));
        mobileEmit('process:status', { id: 'p-1', status: 'running' });
        await new Promise((r) => setTimeout(r, 30));
        const msg = evFrames.find((f) => f.type === 'process:status');
        expect(msg).toBeTruthy();
        expect(msg.payload).toEqual({ id: 'p-1', status: 'running' });
        ws.close();
    });

    it('/ws/term streams catch-up + onData and writes phone input to the pty', async () => {
        const port = await start();
        const token = await pair(port);
        const frames: any[] = [];
        const ws = await openWs(
            `ws://127.0.0.1:${port}/ws/term?terminal=t-1&token=${token}`,
            frames,
        );
        // Catch-up scrollback arrives first.
        await new Promise((r) => setTimeout(r, 30));
        expect(frames.some((f) => f.type === 'data' && f.data === 'catch-up-scrollback')).toBe(true);

        // Phone input → writeToTerminal mock.
        ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
        await new Promise((r) => setTimeout(r, 30));
        expect(written).toContainEqual({ id: 't-1', data: 'ls\r' });

        // pty onData (via the ipc.ts tap) → streamed down to the phone, batched.
        mobileTermFanout('t-1', 'hello from pty');
        await new Promise((r) => setTimeout(r, 60));
        expect(frames.some((f) => f.type === 'data' && f.data === 'hello from pty')).toBe(true);
        ws.close();
    });

    it('uploads a file into the workspace .ai/ dir (happy path)', async () => {
        const port = await start();
        const token = await pair(port);
        const payload = Buffer.from('hello .ai').toString('base64');
        const r = await req(port, 'POST', '/api/workspace/ws-1/upload', {
            token,
            body: { name: 'note.txt', dataBase64: payload },
        });
        expect(r.status).toBe(200);
        expect(r.json.ok).toBe(true);
        const written = fs.readFileSync(path.join(wsRoot, '.ai', '_dirty','note.txt'), 'utf8');
        expect(written).toBe('hello .ai');
        // The reported path stays inside <ws>/.ai.
        expect(r.json.path).toBe(path.join(wsRoot, '.ai', '_dirty','note.txt'));
    });

    it('dedupes a colliding name instead of overwriting', async () => {
        const port = await start();
        const token = await pair(port);
        const body = (data: string) => ({
            name: 'dup.txt',
            dataBase64: Buffer.from(data).toString('base64'),
        });
        const first = await req(port, 'POST', '/api/workspace/ws-1/upload', {
            token,
            body: body('one'),
        });
        const second = await req(port, 'POST', '/api/workspace/ws-1/upload', {
            token,
            body: body('two'),
        });
        expect(first.json.path).toBe(path.join(wsRoot, '.ai', '_dirty','dup.txt'));
        expect(second.json.path).toBe(path.join(wsRoot, '.ai', '_dirty','dup (1).txt'));
        // Original is untouched.
        expect(fs.readFileSync(first.json.path, 'utf8')).toBe('one');
        expect(fs.readFileSync(second.json.path, 'utf8')).toBe('two');
    });

    it('rejects a traversal filename without escaping .ai', async () => {
        const port = await start();
        const token = await pair(port);
        const r = await req(port, 'POST', '/api/workspace/ws-1/upload', {
            token,
            body: {
                name: '../escape.txt',
                dataBase64: Buffer.from('x').toString('base64'),
            },
        });
        // basename `escape.txt` lands inside .ai (never the parent).
        expect([200]).toContain(r.status);
        expect(r.json.path).toBe(path.join(wsRoot, '.ai', '_dirty','escape.txt'));
        expect(fs.existsSync(path.join(wsRoot, 'escape.txt'))).toBe(false);
    });

    it('401s an upload without a token and 423s while locked', async () => {
        const port = await start();
        const token = await pair(port);
        const noTok = await req(port, 'POST', '/api/workspace/ws-1/upload', {
            body: { name: 'x.txt', dataBase64: 'eA==' },
        });
        expect(noTok.status).toBe(401);
        setLocked(true);
        const locked = await req(port, 'POST', '/api/workspace/ws-1/upload', {
            token,
            body: { name: 'x.txt', dataBase64: 'eA==' },
        });
        expect(locked.status).toBe(423);
        setLocked(false);
    });

    it('404s an upload to an unknown workspace', async () => {
        const port = await start();
        const token = await pair(port);
        const r = await req(port, 'POST', '/api/workspace/nope/upload', {
            token,
            body: { name: 'x.txt', dataBase64: 'eA==' },
        });
        expect(r.status).toBe(404);
    });

    it('does not bind when disabled (opt-in)', async () => {
        appDir = buildAppDir();
        await startMobileServer({
            serverVersion: '0.0.0-test',
            userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mobile-ud-')),
            appDir,
            enabled: false, // off by default
            configuredPort: () => 0,
            data: deps(),
            confirmPair: async () => true,
            bindIpOverride: '127.0.0.1', // even with a bind IP, disabled → no bind
        });
        const st = mobileServerState();
        expect(st.running).toBe(false);
    });

    it('fails closed (does not bind) when enabled but no tailnet is detected', async () => {
        // Guard: if the host actually HAS a tailnet (a dev machine running
        // Tailscale), real detection would legitimately bind — skip the assert
        // there. We test the fail-closed path only when detection returns null.
        const { detectTailnetIp } = await import('../tailnet');
        if (detectTailnetIp() !== null) return; // real tailnet present — N/A here
        appDir = buildAppDir();
        await startMobileServer({
            serverVersion: '0.0.0-test',
            userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mobile-ud-')),
            appDir,
            enabled: true,
            configuredPort: () => 0,
            data: deps(),
            confirmPair: async () => true,
            // No bindIpOverride → real detectTailnetIp(); no tailnet → null.
        });
        const st = mobileServerState();
        expect(st.running).toBe(false);
        expect(st.tailnetNotDetected).toBe(true);
    });
});
