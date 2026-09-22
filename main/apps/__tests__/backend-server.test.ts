import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../mcp/server';
const mocks = vi.hoisted(() => ({ listens: [] as unknown[][] }));
vi.mock('node:http', () => ({ createServer: () => ({
    once: vi.fn(), off: vi.fn(), unref: vi.fn(), closeAllConnections: vi.fn(),
    listen: (...args: any[]) => { mocks.listens.push(args.slice(0, 2)); args[2](); },
    address: () => ({ port: 42345 }),
    close: (callback: Function) => callback(),
}) }));
vi.mock('../../db', () => ({ getAppGrantForWorkspace: () => ({ appId: 'hb', revoked: false }) }));
vi.mock('../grant-lookup', () => ({
    appGrantFor: () => ({ appId: 'hb', appName: 'Homeward Bound', workspaceId: 'home', scope: 'self', capabilities: ['notify'], revoked: false }),
    appIdentityFor: () => ({ id: 'hb' }),
    appIdForBackendWorkspace: () => 'hb',
}));
vi.mock('../bridge', () => ({ dispatchAppCall: vi.fn() }));
import { startAppBackendServer, stopAppBackendServer } from '../backend-server';
import { appBackendEnv } from '../backend-runtime';
const dirs: string[] = [];
afterEach(async () => {
    await stopAppBackendServer();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it('binds only loopback and restores the URL and grant token across Genie restarts', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-app-endpoint-'));
    dirs.push(userDataDir);
    await startAppBackendServer({ userDataDir } as ServerDeps);
    const before = appBackendEnv('home');
    expect(before.GENIE_APP_URL).toBe('http://127.0.0.1:42345/app');
    expect(before.GENIE_APP_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.listens.at(-1)).toEqual([0, '127.0.0.1']);
    await stopAppBackendServer();
    await startAppBackendServer({ userDataDir } as ServerDeps);
    expect(appBackendEnv('home')).toEqual(before);
    expect(mocks.listens.at(-1)).toEqual([42345, '127.0.0.1']);
});

it('starts the app endpoint before autostart processes need their credentials', () => {
    const source = fs.readFileSync(path.resolve('main/background.ts'), 'utf8');
    const ready = source.indexOf('await startAppBackendServer(mcpDeps)');
    expect(ready).toBeGreaterThan(0);
    expect(source.indexOf('if (!drainRestorePending) startAutostartProcesses();')).toBeGreaterThan(ready);
    expect(source.includes("app.once('will-quit', () => { void stopAppBackendServer(); });")).toBe(true);
});
