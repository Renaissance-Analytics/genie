import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
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
 * its own terminal could not reach the database the person's shell reached. Every shell is genie-host's now: an agent's
 * (manageTerminals is its own tool), the header's throwaway Terminal and the Terminals tab's (Tynn #898 step 2d-4b2,
 * host-local-ports.ts). Each takes ONE env there: the workspace's service engines, its Playwright variables and Genie's
 * endpoint (genie-host.ts `shellEnv`). The window's own copy, `terminalEnvFor`, fed nothing and left in Tynn #1043.
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

describe('main wires both paths to the one function', () => {
    // Comment lines dropped by LINE, CRLF-safe: a guard that matched a comment would pass on prose.
    const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    it('main assembles no terminal env: an agent’s terminal, the header’s Terminal and the Terminals tab are genie-host’s', () => {
        const main = code('src/main/main.ts');
        // None since 2g-4d-A (Tynn #1043): manageTerminals is genie-host's own tool, so nothing read the env main handed its copy.
        expect(main).not.toMatch(/terminalEnv/);
        expect(code('src/main/hosting-actions.ts')).not.toMatch(/terminalEnvFor/);
        // The header's Terminal button (Tynn story #378): a workspace terminal's environment, in a window of its own.
        expect(code('src/main/genie-host.ts')).toMatch(/scratchTerminalFor\(\{ scratch: hostScratch\w*, home: userHome\(\), workspace: \(id\) => hostRegistry\.workspace\(id\) \?\? null, envFor: shellEnv \}/);
        expect(/localTerminals: createNativeTerminalPort\(\{/.test(main)).toBe(false);
        // The Terminals tab: genie-host's port, with the workspace's service variables and Genie's MCP endpoint.
        expect(/localTerminals: createNativeTerminalPort\(\{/.test(code('src/main/host-local-ports.ts'))).toBe(true);
        expect(/environment: sources\.terminalEnv,/.test(code('src/main/host-local-ports.ts'))).toBe(true);
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/terminalEnv: shellEnv,/);
        expect(host).toMatch(/return \{ \.\.\.engine\.serviceEnvFor\(workspaceId\), \.\.\.playwrightHost\.envFor\(workspaceId\), \.\.\.\(endpoint \? \{ GENIE_MCP_URL: endpoint\.url, GENIE_MCP_TOKEN: endpoint\.token \} : \{\}\) \};/);
        // The env is no longer assembled by hand anywhere in main.
        expect(main).not.toMatch(/\.\.\.serviceEnv/);
    });

    it('the agents’ services/sites tools get the composition, and the Services and Hosting tabs redraw when an agent acts', () => {
        const main = code('src/main/main.ts');
        expect(main).toMatch(/hosting: composed,/);
        const owner = code('src/main/features-host.ts');
        expect(owner).toMatch(/h\.api\.engines\.onChange\(changed\), h\.api\.sites\.onChange\(changed\)/);
        // The tabs redraw through RemoteHost from genie-host's HostFeatures (Tynn #898 step 2e-2).
        expect(code('src/main/genie-host.ts')).toMatch(/phoneApi = hostAloneApi\(\{\s*hostName: hostname\(\),\s*features: hostFeatures,/);
    });
});
