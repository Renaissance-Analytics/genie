import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { terminalManager } from '@particle-academy/fancy-term-host';
import { listTerminalSpecs } from './db';
import { hostBackendKind } from './terminal/host-service';

/**
 * Localhost control server for the bundled `genie` CLI.
 *
 * Genie's main process is the source of truth for the live terminal/process
 * list (the manager knows each pty's PID), the host backend kind + PID, and the
 * specs' labels/cwds. Rather than have a CLI reverse-engineer the pty-host's
 * socket protocol, we expose a tiny loopback HTTP API and write its port+token
 * to `<userData>/genie-control.json` so the CLI can find + call it.
 *
 * Bound to 127.0.0.1 on an ephemeral port; every request must carry the token
 * (in the path) that's only readable from the user's own userData dir.
 *
 *   GET  /<token>/status              → formatted host + terminals table (text)
 *   POST /<token>/terminal/<id>/kill  → kill one terminal/process
 *   POST /<token>/host/<action>       → start | stop | restart the host
 */

export interface ControlDeps {
    userDataDir: string;
    /** Kill a single terminal/process by id; returns false if unknown. */
    killTerminal: (id: string) => boolean;
    /** Host lifecycle — each returns a short human-readable result line. */
    hostStop: () => Promise<string>;
    hostStart: () => Promise<string>;
    hostRestart: () => Promise<string>;
}

let server: http.Server | null = null;
let port: number | null = null;
let token: string | null = null;
let deps: ControlDeps | null = null;

function readHostPid(userDataDir: string): number | null {
    try {
        const j = JSON.parse(
            fs.readFileSync(path.join(userDataDir, 'ptyhost.json'), 'utf8'),
        );
        return typeof j.pid === 'number' ? j.pid : null;
    } catch {
        return null;
    }
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM means the process exists but we can't signal it → still alive.
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function pad(s: string, n: number): string {
    s = s ?? '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

/** Build the `genie status` table (host line + one row per terminal/process). */
function statusText(d: ControlDeps): string {
    const pid = readHostPid(d.userDataDir);
    const running = pid != null && isAlive(pid);
    const kind = hostBackendKind();
    const specs = listTerminalSpecs();
    const specById = new Map(specs.map((s) => [s.id, s]));
    const live = terminalManager().list(); // [{ id, pid, shell }]
    const liveById = new Map(live.map((t) => [t.id, t]));

    interface Row {
        id: string;
        label: string;
        cwd: string;
        kind: string;
        pid: string;
        state: string;
    }
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const t of live) {
        const s = specById.get(t.id);
        if (s?.type === 'code') continue; // editors aren't "terminals"
        seen.add(t.id);
        rows.push({
            id: t.id,
            label: s?.label ?? '—',
            cwd: s?.live_cwd ?? s?.cwd ?? '—',
            kind: s?.type === 'process' ? 'process' : 'terminal',
            pid: String(t.pid),
            state: 'running',
        });
    }
    for (const s of specs) {
        if (s.type === 'code' || seen.has(s.id)) continue;
        // A non-live spec: a stopped process, or a saved-but-not-open terminal.
        rows.push({
            id: s.id,
            label: s.label,
            cwd: s.live_cwd ?? s.cwd,
            kind: s.type === 'process' ? 'process' : 'terminal',
            pid: '—',
            state: 'stopped',
        });
    }

    const head =
        `host: ${kind}` +
        (pid != null ? ` · pid ${pid}` : '') +
        ` · ${running ? 'running' : 'not running'}`;
    if (rows.length === 0) {
        return `${head}\n\n(no terminals)\n`;
    }
    const header =
        '  ' +
        pad('ID', 12) +
        pad('LABEL', 18) +
        pad('KIND', 9) +
        pad('PID', 8) +
        pad('STATE', 9) +
        'PATH';
    const lines = rows.map(
        (r) =>
            '  ' +
            pad(r.id, 12) +
            pad(r.label, 18) +
            pad(r.kind, 9) +
            pad(r.pid, 8) +
            pad(r.state, 9) +
            r.cwd,
    );
    return `${head}\n\n${header}\n${lines.join('\n')}\n`;
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
}

async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    if (!deps || !token) return sendText(res, 503, 'control server not ready\n');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== token) return sendText(res, 403, 'forbidden\n');
    const rest = parts.slice(1);

    // GET /<token>/status
    if (req.method === 'GET' && rest[0] === 'status') {
        return sendText(res, 200, statusText(deps));
    }
    // POST /<token>/terminal/<id>/kill
    if (req.method === 'POST' && rest[0] === 'terminal' && rest[2] === 'kill') {
        const ok = deps.killTerminal(decodeURIComponent(rest[1] ?? ''));
        return sendText(
            res,
            ok ? 200 : 404,
            ok ? `killed ${rest[1]}\n` : `no such terminal: ${rest[1]}\n`,
        );
    }
    // POST /<token>/host/<action>
    if (req.method === 'POST' && rest[0] === 'host') {
        const action = rest[1];
        try {
            const msg =
                action === 'stop'
                    ? await deps.hostStop()
                    : action === 'start'
                      ? await deps.hostStart()
                      : action === 'restart'
                        ? await deps.hostRestart()
                        : null;
            if (msg === null) return sendText(res, 400, `unknown host action: ${action}\n`);
            return sendText(res, 200, msg.endsWith('\n') ? msg : `${msg}\n`);
        } catch (e) {
            return sendText(res, 500, `host ${action} failed: ${e instanceof Error ? e.message : String(e)}\n`);
        }
    }
    sendText(res, 404, 'not found\n');
}

/** Start the control server (idempotent) + write the discovery file. */
export function startControlServer(d: ControlDeps): Promise<void> {
    deps = d;
    if (server) return Promise.resolve();
    token = crypto.randomBytes(18).toString('hex');
    return new Promise((resolve) => {
        server = http.createServer((req, res) => {
            void handle(req, res).catch(() => {
                try {
                    sendText(res, 500, 'internal error\n');
                } catch {
                    /* already sent */
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            port = typeof addr === 'object' && addr ? addr.port : null;
            try {
                fs.writeFileSync(
                    path.join(d.userDataDir, 'genie-control.json'),
                    JSON.stringify({ port, token }) + '\n',
                    { mode: 0o600 },
                );
            } catch {
                /* discovery file is best-effort */
            }
            resolve();
        });
    });
}
