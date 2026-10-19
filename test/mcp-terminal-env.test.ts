import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { moreGenieTools, type TerminalsPort } from '../src/main/mcp-tools-more.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * AN AGENT'S TERMINAL GETS THE ENV THE PERSON'S DOES. The Terminals tab opens a shell with the workspace's service
 * engines (DB_*, REDIS_URL…) and Genie's endpoint (GENIE_MCP_URL / GENIE_MCP_TOKEN); `manageTerminals create` opened
 * one with NEITHER (main.ts handed the agent path `terminals.open(options)` untouched) — so a migration an agent ran in
 * its own terminal could not reach the database the person's shell reached. Both paths now take their env from ONE
 * function, `terminalEnvFor` (hosting-actions.ts).
 */

const atlas: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: '/w/example' };

function fakeTerminals() {
    const opened: Array<{ workspaceId: string; command?: string; env?: Readonly<Record<string, string>> }> = [];
    const port: TerminalsPort = {
        list: () => [],
        open: (o) => { opened.push(o); return { id: `term_${opened.length}`, pid: 100, shell: 'bash', scrollback: '' }; },
        write: () => true,
        scrollback: () => undefined,
        scrollbackCap: 1_000_000,
    };
    return { port, opened };
}

async function create(tools: Registration[], command: string) {
    const reg = tools.find((t) => t.definition.name === 'manageTerminals')!;
    return reg.handler({ action: 'create', command, terminalId: 't-atlas' }, { server: 'genie', tool: 'manageTerminals', headers: {} });
}

const SERVICE_ENV = { DB_HOST: '127.0.0.1', DB_PORT: '4101', GENIE_MCP_URL: 'http://127.0.0.1:4100/mcp' };

describe('manageTerminals create', () => {
    it('opens the terminal with the workspace env it is given — for the CALLER’s workspace', async () => {
        const t = fakeTerminals();
        const asked: string[] = [];
        const tools = moreGenieTools({
            knowledge: (() => { throw new Error('not exercised'); }) as never,
            terminals: t.port,
            approve: async () => 'allowed',
            resolveCaller: (id) => (id === 't-atlas' ? atlas : null),
            envFor: (workspaceId) => { asked.push(workspaceId); return SERVICE_ENV; },
        });
        const r = await create(tools, 'php artisan migrate');
        expect(r.isError).toBe(false);
        expect(asked).toEqual(['example']);
        expect(t.opened).toHaveLength(1);
        expect(t.opened[0]!.env).toEqual(SERVICE_ENV);
    });

    it('through Genie’s one tool builder: the `terminalEnv` part reaches manageTerminals (a part nobody reads would pass the test above)', async () => {
        const t = fakeTerminals();
        const never = (() => { throw new Error('not exercised'); }) as never;
        const tools = allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, approve: async () => 'allowed', roster: () => [], resolveCaller: (id) => (id === 't-atlas' ? atlas : null),
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: t.port, terminalEnv: () => SERVICE_ENV,
            plugins: { tools: () => [], guard: () => null, run: never },
        }));
        await create(tools, 'php artisan migrate');
        expect(t.opened.map((o) => o.env?.DB_PORT)).toEqual(['4101']);
    });
});

describe('the env both paths use, over the real composition', () => {
    const pty: PtyPort = {
        open: () => ({ id: 'term_1', pid: 1, shell: 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    const docker: DockerRunner = async (args) => {
        if (args[0] === 'image' || (args[0] === 'container' && args[1] === 'inspect')) return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-terminal-env-'));
        for (const ws of ['example', 'example-other']) {
            await mkdir(join(dir, ws), { recursive: true });
            await writeFile(join(dir, ws, 'project.json'), '{ "name": "x", "repos": [] }\n', 'utf8');
        }
        services = await composeServices({
            userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker, portFree: async () => true,
            workspaces: () => [{ id: 'example', path: join(dir, 'example') }, { id: 'example-other', path: join(dir, 'example-other') }],
        });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    it('terminalEnvFor: the workspace’s engines, then Genie’s endpoint — and another workspace gets the endpoint only', async () => {
        const { terminalEnvFor } = await import('../src/main/hosting-actions.js');
        await handleFeatureAction(services, { kind: 'services.create', form: { workspaceId: 'example', engine: 'postgres', major: '17', scope: 'dedicated' }, consent: true });
        const port = String(services.engines.list()[0]!.publishedPort);
        const mcp = { GENIE_MCP_URL: 'http://127.0.0.1:4100/mcp', GENIE_MCP_TOKEN: 'tok' };
        const env = terminalEnvFor(services, 'example', mcp);
        expect(env).toMatchObject({ DB_PORT: port, PGPORT: port, DB_DATABASE: 'example', ...mcp });
        expect(env).toEqual({ ...services.engines.envFor('example'), ...mcp });
        const other = terminalEnvFor(services, 'example-other', mcp);
        expect(other).toEqual(mcp);
        // Before compose has run (main's `services` is still null), the endpoint alone.
        expect(terminalEnvFor(null, 'example', mcp)).toEqual(mcp);
    });
});

describe('main wires both paths to the one function', () => {
    // Comment lines dropped by LINE, CRLF-safe: a guard that matched a comment would pass on prose.
    const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    it('the Terminals tab and the agents’ tools both call terminalEnvFor — counted', () => {
        const main = code('src/main/main.ts');
        expect(main.match(/terminalEnvFor\(/g) ?? []).toHaveLength(2);
        expect(main).toMatch(/terminalEnv: \(workspaceId\) => terminalEnvFor\(composed, workspaceId, mcpEnv\(\)\)/);
        expect(main).toMatch(/const env = terminalEnvFor\(services, workspace\.id, mcpEnv\(\)\);/);
        // The env is no longer assembled by hand anywhere in main.
        expect(main).not.toMatch(/\.\.\.serviceEnv/);
    });

    it('the agents’ services/sites tools get the composition, and the Services and Hosting tabs redraw when an agent acts', () => {
        const main = code('src/main/main.ts');
        expect(main).toMatch(/hosting: composed,/);
        expect(main).toMatch(/composed\.engines\.onChange\(pushFeatures\);/);
        expect(main).toMatch(/composed\.sites\.onChange\(pushFeatures\);/);
    });
});
