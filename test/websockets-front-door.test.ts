import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE SHARED WEBSOCKETS SERVER: ONE ADDRESS, ALWAYS SECURE, A NAMESPACE PER WORKSPACE (the owner, 2026-10-17, holding
 * beta.29: "We don't need multiple wss servers and yes, always WSS, not WS. All genie sites should always be secure. each
 * workstation should have its own namespace, not server" — per WORKSPACE, one address; "the genie agent can access all,
 * but workspace agents can only access their space on the server").
 *
 * - ONE address, `websockets.gen`, served by the front door with Genie's certificate — not a name per workspace.
 * - SECURE EVERYWHERE: the browser keys AND the app's server keys (REVERB_*, GENIE_WS_*) are https / wss on 443 through
 *   the front door; nothing plain, not even on loopback.
 * - A workspace is its own APP on the server (its own id, key and secret): a workspace agent sees its own app only; the
 *   Genie agent sees every workspace's app — ids and public keys, never a secret.
 * Every value is invented; names are RFC 2606 (`example*`).
 */

const HOST = 'websockets.gen';
const pty: PtyPort = {
    open: () => ({ id: 't', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};
function fakeDocker(): DockerRunner {
    const containers = new Map<string, string>();
    return async (args) => {
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
}

let dir: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-ws-one-'));
    for (const ws of ['example', 'example-other']) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] })}\n`, 'utf8');
    }
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: fakeDocker(), portFree: async () => true,
        workspaces: () => [{ id: 'example', path: join(dir, 'example') }, { id: 'example-other', path: join(dir, 'example-other') }],
    });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

const attach = (workspaceId: string) => services.engines.add({ engine: 'websockets', major: '4.7.0', scope: { kind: 'shared' }, consent: true, workspaceId });
const engine = () => services.engines.list().find((i) => i.engine === 'websockets')!;
const where = (env: Record<string, string>, prefix: string) => ({ host: env[`${prefix}_HOST`], port: env[`${prefix}_PORT`], scheme: env[`${prefix}_SCHEME`] });

describe('the shared WebSockets server', () => {
    it('every key — the browser’s AND the server’s — names the one secure address: websockets.gen, 443, https', async () => {
        await attach('example');
        const env = services.engines.envFor('example');
        for (const prefix of ['VITE_REVERB', 'VITE_GENIE_WS', 'REVERB', 'GENIE_WS']) expect({ prefix, ...where(env, prefix) }).toEqual({ prefix, host: HOST, port: '443', scheme: 'https' });
        // Nothing plain anywhere in it.
        expect(Object.entries(env).filter(([, v]) => /^(ws|http):\/\//.test(v) || v === 'http')).toEqual([]);
    });

    it('ONE front-door route for the server, however many workspaces use it (CONTROL: none before any does), and its name is in the hosts file', async () => {
        expect(services.routes().filter((r) => r.host.startsWith('websockets'))).toEqual([]);
        await attach('example');
        await attach('example-other');
        expect(services.routes().filter((r) => r.host.startsWith('websockets'))).toEqual([{ host: HOST, target: `127.0.0.1:${engine().publishedPort}` }]);
        expect(services.configuredHosts()).toContain(HOST);
    });

    it('each workspace is its own app: a workspace agent sees its own; the Genie agent sees every one — never a secret', async () => {
        await attach('example');
        await attach('example-other');
        const secrets = Object.values(engine().slices ?? {}).map((s) => s.password);
        const callers: Record<string, Caller> = {
            't-example': { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: join(dir, 'example') } as Caller,
            't-genie': { agentId: mintAgentId(), agentName: 'genie', workspaceId: '__genie__', workspacePath: dir } as Caller,
        };
        const tools = hostingTools({ resolveCaller: (id) => callers[id] ?? null, approve: async () => 'allowed', services });
        const list = async (terminalId: string) => {
            const r = await tools.find((t) => t.definition.name === 'services')!.handler({ action: 'list', terminalId } as never, { server: 'genie', tool: 'services', headers: {} });
            return { text: r.text, view: (JSON.parse(r.text).services as Array<Record<string, any>>).find((s) => s.engine === 'websockets') };
        };
        const mine = await list('t-example');
        expect(mine.view?.app?.id).toBe('ws_example');
        expect(mine.view?.apps).toBeUndefined();
        const all = await list('t-genie');
        expect((all.view?.apps as Array<{ workspaceId: string; id: string }> | undefined)?.map((a) => `${a.workspaceId}:${a.id}`).sort()).toEqual(['example-other:ws_example_other', 'example:ws_example']);
        for (const s of secrets) { expect(mine.text).not.toContain(s); expect(all.text).not.toContain(s); }
    });
});
