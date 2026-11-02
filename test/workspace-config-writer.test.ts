import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { configWriter, writeWorkspaceConfig, type WorkspaceConfigRequest } from '../src/main/workspace-config-sync.js';

/**
 * ONE WRITER OF A WORKSPACE'S AGENT CONFIG (P3.4). The legacy cleanup and the normal sync read and rewrite the same three files, and shared one lock so a sync could not write
 * a removed credential back. With the host split, the host cleaned up under no lock while a window synced under its own. Dropping the window's cleanup would not have fixed
 * that, since the window's sync is itself a writer. So with a host, the whole sync runs in the host, under the lock its agent preparation holds.
 */

const LEGACY = 'rpk_legacy_shared_credential';
const entry = { type: 'http', url: 'https://tynn.ai/mcp/tynn', headers: { Authorization: `Bearer ${LEGACY}` } };
const flags = { mcp_sync_claude: true, mcp_sync_cursor: true, mcp_sync_codex: true, mcp_sync_hooks: false };
const endpoint = { url: 'http://127.0.0.1:1/mcp', token: 'synthetic-genie' };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'config-writer-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
const request = (): WorkspaceConfigRequest => ({ workspacePath: dir, flags, endpoint });

describe('writeWorkspaceConfig', () => {
    it('removes the legacy credential, keeps what is the person\'s, and writes Genie\'s entry', async () => {
        await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tynn: entry, keep: { command: 'user-server' } } }));
        const results = await writeWorkspaceConfig(request());
        const text = await readFile(join(dir, '.mcp.json'), 'utf8');
        expect(text).not.toContain(LEGACY);
        expect(text).toContain('user-server');
        expect(text).toContain(endpoint.url);
        expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);
    });

    it('a config it cannot read writes nothing, and says it was the cleanup', async () => {
        await writeFile(join(dir, '.mcp.json'), '{ not json');
        const results = await writeWorkspaceConfig(request());
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ id: 'tynn', label: 'Tynn (legacy config cleanup)', ok: false });
        expect(await readFile(join(dir, '.mcp.json'), 'utf8')).toBe('{ not json');
    });
});

describe('the one lock', () => {
    it('work on a workspace runs one at a time, in order, and a failure does not stop what follows', async () => {
        const withConfig = configWriter();
        const order: string[] = [];
        let release: () => void = () => {};
        const first = withConfig(dir, async () => { order.push('first in'); await new Promise<void>((done) => { release = done; }); order.push('first out'); throw new Error('no'); });
        const second = withConfig(dir, async () => { order.push('second'); });
        await new Promise((r) => setImmediate(r));
        expect(order).toEqual(['first in']);
        release();
        await expect(first).rejects.toThrow('no');
        await second;
        expect(order).toEqual(['first in', 'first out', 'second']);
    });

    it('other workspaces do not wait', async () => {
        const withConfig = configWriter();
        let release: () => void = () => {};
        const held = withConfig('/a', () => new Promise<void>((done) => { release = done; }));
        let ran = false;
        await withConfig('/b', async () => { ran = true; });
        expect(ran).toBe(true);
        release();
        await held;
    });

    it('wired: the host\'s preparation and its sync hold the same lock', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/const withConfig = configWriter\(\);/);
        expect(host).toMatch(/hostAgentKeys\(\{\s*[^]*?withConfig,/);
        expect(host).toMatch(/configSync: \(asked\) => withConfig\(asked\.workspacePath, \(\) => writeWorkspaceConfig\(asked\)\)/);
        expect(readFileSync('src/main/host-agent-keys.ts', 'utf8')).toMatch(/withConfig: options\.withConfig/);
    });
});

describe('over the link', () => {
    async function linked(configSync?: (asked: WorkspaceConfigRequest) => Promise<unknown>) {
        const TOKEN = 'a'.repeat(64);
        const server = new SessionEngineServer({ token: TOKEN, build: 'test', ...(configSync ? { configSync: configSync as never } : {}) });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        return client;
    }

    it('the window asks, the host writes, and the results come back', async () => {
        const asked: WorkspaceConfigRequest[] = [];
        const client = await linked(async (r) => { asked.push(r); return [{ id: 'claude', label: 'Claude', ok: true }]; });
        expect(await client.configSync(request())).toEqual([{ id: 'claude', label: 'Claude', ok: true }]);
        expect(asked).toEqual([request()]);
    });

    it('a host that cannot do it rejects, so nothing reads as synced', async () => {
        const client = await linked();
        await expect(client.configSync(request())).rejects.toThrow();
    });

    it('with no link it rejects', async () => {
        await expect(new SessionEngineClient().configSync(request())).rejects.toThrow();
    });
});

describe('the window, with a host', () => {
    const compose = readFileSync('src/main/compose.ts', 'utf8');

    it('compose has no writer of its own: one function does it, and its lock serves the window running its own engine', () => {
        expect(compose).not.toMatch(/reconcileLegacyTynnConfig/);
        expect(compose).toMatch(/const withConfig = configWriter\(\);/);
        expect(compose).toMatch(/input\.hostConfigSync/);
    });

    it('main hands compose the host when there is one', () => {
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/hostConfigSync: \(\) => agentEngineLink\?\.client \?\? null/);
    });
});
