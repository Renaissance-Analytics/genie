import type { ServerDeps } from '../mcp/server';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AppCredentials, type CredentialRows } from './backend-credentials';
import { createAppHttpHandler } from './backend-http';
import { configureAppBackendEnv, clearAppBackendEnv } from './backend-runtime';
import { appGrantFor, appIdentityFor, appIdForBackendWorkspace } from './grant-lookup';
import { dispatchAppCall } from './bridge';

let server: Server | null = null;
interface State { version: 1; port: number; credentials: CredentialRows }
export async function startAppBackendServer(deps: ServerDeps): Promise<void> {
    if (server) return;
    const file = path.join(deps.userDataDir, 'app-backend-credentials.json');
    let state: State = { version: 1, port: 0, credentials: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
        if (raw.version !== 1 || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 ||
            !raw.credentials || typeof raw.credentials !== 'object' || Array.isArray(raw.credentials) ||
            Object.entries(raw.credentials).some(([token, row]) => !/^[A-Za-z0-9_-]{43}$/.test(token) ||
                !row || typeof row.appId !== 'string' || typeof row.grant !== 'string')) {
            throw new Error('Invalid app backend credential state.');
        }
        state = raw;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const save = (credentials: CredentialRows) => {
        state.credentials = credentials;
        fs.mkdirSync(deps.userDataDir, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
    };
    const credentials = new AppCredentials(appGrantFor, state.credentials, save);
    const handle = createAppHttpHandler({
        credentials,
        me: appIdentityFor,
        call: (appId, input) => dispatchAppCall(appId, {
            tool: input.tool, args: input.args, workspaceId: input.workspaceId,
        }, deps),
    });
    const next = createServer((req, res) => {
        void handle(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: 'The app request failed.' }));
        });
    });
    next.headersTimeout = 10_000;
    next.requestTimeout = 10_000;
    try {
        await new Promise<void>((resolve, reject) => {
            next.once('error', reject);
            next.listen(state.port, '127.0.0.1', () => { next.off('error', reject); resolve(); });
        });
        const address = next.address();
        if (!address || typeof address === 'string') throw new Error('App endpoint did not bind.');
        state.port = address.port;
        save(state.credentials);
        configureAppBackendEnv(appIdForBackendWorkspace, credentials, `http://127.0.0.1:${state.port}/app`);
        next.unref();
        server = next;
    } catch (error) {
        next.close(() => {});
        throw error;
    }
}
export async function stopAppBackendServer(): Promise<void> {
    clearAppBackendEnv();
    const old = server;
    server = null;
    if (old) {
        old.closeAllConnections();
        await new Promise<void>(resolve => old.close(() => resolve()));
    }
}
