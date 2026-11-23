import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
        // The sync is genie-host's own (its feature machine's and its workspace files'): no window asks for one (Tynn #1043).
        expect(host).toMatch(/const featureConfig = async \(workspacePath: string, /);
        expect(host).not.toMatch(/configSync: async/);
        expect(readFileSync('src/main/host-agent-keys.ts', 'utf8')).toMatch(/withConfig: options\.withConfig/);
    });
});

describe('no window asks genie-host to write a workspace’s config (Tynn #1043)', () => {
    it('the engine link has no config route: the method, the client’s member and the server’s case are gone', () => {
        expect(readFileSync('src/core/engine-protocol.ts', 'utf8')).not.toMatch(/engine\.configSync/);
        expect(readFileSync('src/main/session-engine-client.ts', 'utf8')).not.toMatch(/configSync/);
        expect(readFileSync('src/main/session-engine-server.ts', 'utf8')).not.toMatch(/configSync/);
        // CONTROL: the same read finds a method that stays.
        expect(readFileSync('src/core/engine-protocol.ts', 'utf8')).toMatch(/engine\.proxyRemember/);
    });
});

describe('a composition that runs alone', () => {
    const compose = readFileSync('src/main/compose.ts', 'utf8');

    it('compose has one writer, under its lock, and takes no host to write for it', () => {
        expect(compose).not.toMatch(/reconcileLegacyTynnConfig/);
        expect(compose).toMatch(/const withConfig = configWriter\(\);/);
        expect(compose).toMatch(/const results = \[\.\.\.await withConfig\(workspacePath, \(\) => writeWorkspaceConfig\(request\)\)\];/);
        expect(compose).not.toMatch(/hostConfigSync/);
    });

    it('main hands compose no config writer', () => {
        expect(readFileSync('src/main/main.ts', 'utf8')).not.toMatch(/hostConfigSync/);
    });
});
