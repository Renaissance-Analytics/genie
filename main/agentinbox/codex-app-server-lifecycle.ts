import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { CodexAgentInboxSession, type CodexAppServerSocket } from './codex-app-server';

export const CODEX_APP_TOKEN_ENV = 'GENIE_CODEX_APP_TOKEN';

export function codexAppServerLaunch(input: {
    codexExecutable: string;
    address: string;
    tokenFile: string;
}): { command: string; args: string[] } {
    return {
        command: input.codexExecutable,
        args: [
            'app-server',
            '--listen',
            input.address,
            '--ws-auth',
            'capability-token',
            '--ws-token-file',
            input.tokenFile,
        ],
    };
}

const REMOTE_FLAG = /(^|\s)--remote(?:=|\s)/;

export function codexRemoteTuiLaunch(command: string, address: string): string {
    if (REMOTE_FLAG.test(command)) return command;
    return `${command.trim()} --remote ${address} --remote-auth-token-env ${CODEX_APP_TOKEN_ENV}`;
}

export function codexAppServerConfigArgs(command: string): string[] {
    const args: string[] = [];
    const pattern = /(?:^|\s)(-c|--config)\s+("[^"]*"|'[^']*'|\S+)/g;
    for (const match of command.matchAll(pattern)) {
        const raw = match[2];
        const value = (raw.startsWith('"') && raw.endsWith('"')) ||
            (raw.startsWith("'") && raw.endsWith("'"))
            ? raw.slice(1, -1)
            : raw;
        args.push('-c', value);
    }
    return args;
}

function resolveWindowsCodexShim(
    executable: string,
    env: NodeJS.ProcessEnv,
): { command: string; prefix: string[] } | null {
    if (process.platform !== 'win32') return { command: executable, prefix: [] };
    const requested = executable.toLowerCase().replace(/\.cmd$/i, '');
    if (requested !== 'codex') return null;
    for (const entry of String(env.Path ?? env.PATH ?? '').split(path.delimiter)) {
        if (!entry) continue;
        const node = path.join(entry, 'node.exe');
        const script = path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(node) && fs.existsSync(script)) {
            return { command: node, prefix: [script] };
        }
    }
    return null;
}

class WsSocket implements CodexAppServerSocket {
    constructor(private readonly socket: WebSocket) {}

    send(data: string): void {
        this.socket.send(data);
    }

    onMessage(listener: (data: string) => void): void {
        this.socket.on('message', (data) => listener(data.toString()));
    }
}

export interface RunningCodexAppServer {
    address: string;
    token: string;
    session: CodexAgentInboxSession;
}

interface OwnedServer extends RunningCodexAppServer {
    child: ChildProcess;
    socket: WebSocket;
    tokenFile: string;
}

export interface PreparedCodexAppServer {
    token: string;
    tokenFile: string;
}

/** Synchronous because the terminal shell must inherit the token at spawn time. */
export function prepareCodexAppServer(
    terminalId: string,
    stateDir: string,
): PreparedCodexAppServer {
    const token = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const tokenFile = path.resolve(stateDir, `${terminalId}.token`);
    fs.writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    return { token, tokenFile };
}

async function allocateLoopbackPort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function connect(
    address: string,
    token: string,
    child: ChildProcess,
    diagnostics: () => string,
): Promise<WebSocket> {
    const deadline = Date.now() + 10_000;
    let lastError = 'connection timed out';
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            const detail = diagnostics().trim();
            throw new Error(
                `Codex App Server exited with code ${child.exitCode}${detail ? `: ${detail}` : '.'}`,
            );
        }
        try {
            return await new Promise<WebSocket>((resolve, reject) => {
                const socket = new WebSocket(address, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const timer = setTimeout(() => {
                    socket.terminate();
                    reject(new Error('connect timeout'));
                }, 750);
                socket.once('open', () => {
                    clearTimeout(timer);
                    resolve(socket);
                });
                socket.once('error', (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
            });
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Codex App Server did not become ready: ${lastError}`);
}

/** Genie owns one authenticated App Server per visible Codex agent terminal. */
export class CodexAppServerManager {
    private readonly servers = new Map<string, OwnedServer>();

    async start(input: {
        terminalId: string;
        cwd: string;
        stateDir: string;
        codexExecutable?: string;
        env?: NodeJS.ProcessEnv;
        prepared?: PreparedCodexAppServer;
        resumeThreadId?: string | null;
        configArgs?: string[];
    }): Promise<RunningCodexAppServer> {
        const existing = this.servers.get(input.terminalId);
        if (existing) return existing;
        const prepared = input.prepared ?? prepareCodexAppServer(input.terminalId, input.stateDir);
        const { token, tokenFile } = prepared;
        const address = `ws://127.0.0.1:${await allocateLoopbackPort()}`;
        const launch = codexAppServerLaunch({
            codexExecutable: input.codexExecutable ?? 'codex',
            address,
            tokenFile,
        });
        launch.args.splice(1, 0, ...(input.configArgs ?? []));
        const resolved = resolveWindowsCodexShim(launch.command, input.env ?? process.env);
        if (process.platform === 'win32' && !resolved) {
            try { fs.unlinkSync(tokenFile); } catch { /* already gone */ }
            throw new Error('Codex App Server could not resolve the installed Codex CLI runtime.');
        }
        const child = spawn(resolved?.command ?? launch.command, [
            ...(resolved?.prefix ?? []),
            ...launch.args,
        ], {
            cwd: input.cwd,
            env: input.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.resume();
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-4_000);
        });
        try {
            const socket = await connect(address, token, child, () => stderr);
            const session = new CodexAgentInboxSession(new WsSocket(socket));
            await session.initialize(input.cwd, input.resumeThreadId);
            const owned: OwnedServer = { address, token, session, child, socket, tokenFile };
            this.servers.set(input.terminalId, owned);
            child.once('exit', () => this.stop(input.terminalId));
            return owned;
        } catch (error) {
            child.kill();
            try { fs.unlinkSync(tokenFile); } catch { /* already gone */ }
            throw error;
        }
    }

    stop(terminalId: string): void {
        const owned = this.servers.get(terminalId);
        if (!owned) return;
        this.servers.delete(terminalId);
        try { owned.socket.close(); } catch { /* already closed */ }
        if (owned.child.exitCode === null) owned.child.kill();
        try { fs.unlinkSync(owned.tokenFile); } catch { /* already removed */ }
    }
}

export const codexAppServerManager = new CodexAppServerManager();
