import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS, isEngineMethod } from '../src/core/engine-protocol.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { HOST_NATIVE_TOOLS, WINDOW_ACTIONS, runsInWindow } from '../src/main/mcp-host-tools.js';
import type { Registration } from '../src/main/mcp-tools.js';
import { windowToolRunner } from '../src/main/window-tools.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d-A (Tynn #1043; part of #955 and #913). What main still asked of its engine link and no
 * longer needs, because genie-host does the work itself and nothing in the window reads the answer:
 *  - the engine link's Files watch (the Files panel watches over the one protocol: host-local-watches.ts);
 *  - the host tools' forward (`withHostTools` / `runHostTool`) and the flow callers main built for it;
 *  - compose's `hostConfigSync`, and the terminal env main handed its own copy of `manageTerminals`;
 *  - the pty port main made, and the ptys it listed at link-up to hand compose for adoption.
 * EACH HAS ITS PROOF FIRST: a test of the code as it was, saying why nothing can reach it. A proof holds before the
 * deletion and after it; the deletion's own tests follow. Each goes end to end: main, the engine client, the engine
 * server, the engine method and the pins that name it.
 * The processes child's exec route (`spawnLink` / `onSpawnFrame`) is LIVE (genie#1397): it stays, listed as `link`.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const main = code(src('src/main/main.ts'));
const compose = code(src('src/main/compose.ts'));
const client = code(src('src/main/session-engine-client.ts'));
const server = code(src('src/main/session-engine-server.ts'));
/** Every file of src/main and src/core (not the tests), as code. */
const sources = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const dir of ['src/main', 'src/core']) for (const name of readdirSync(resolve(root, dir))) if (name.endsWith('.ts')) out.set(`${dir}/${name}`, code(src(`${dir}/${name}`)));
    return out;
};
/** The files whose code matches. */
const filesWith = (pattern: RegExp): string[] => [...sources()].filter(([, text]) => pattern.test(text)).map(([file]) => file).sort();

describe('PROOF: nothing in the window watches files over the engine link', () => {
    /** A view registered on main's engine watch, or a listener added to what it hears. */
    const READS = /\bfilesWatch\??\.(watch|unwatch)\(|\bfilesEventListeners\.add\(/;

    it('no file registers a view on main’s `filesWatch` or listens to `filesEventListeners`: both are only made and closed', () => {
        expect(filesWith(READS)).toEqual([]);
        // CONTROL: the pattern finds a registration and a listener; a hub's own `this.#api.filesWatch.watch` is not main's.
        expect(READS.test('if (filesWatch?.watch(viewId, workspace, want)) return;')).toBe(true);
        expect(READS.test('filesEventListeners.add(listener);')).toBe(true);
        expect(READS.test('const filesWatch = null; filesWatch?.close();')).toBe(false);
    });

    it('the Files panel’s watch is genie-host’s own, under its own owner, said over the protocol', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/const hostFilesWatches = hostFilesWatch\(\{ hub: \(\) => files, /);
        expect(host).toMatch(/filesWatch: hostFilesWatches\.port,/);
        expect(code(src('src/main/host-api.ts'))).toMatch(/deps\.filesWatch\?\.subscribe\(event => listener\(LOCAL_EVENTS\.files, event\)\)/);
    });
});

describe('PROOF: no host tool’s call leaves the window for genie-host, and no flow runs in the window', () => {
    const ran: string[] = [];
    const registrations: Registration[] = ['sites', 'manageTerminals', 'flows', 'pages'].map((name) => ({
        definition: { name, description: name, inputSchema: { type: 'object' } },
        handler: async (args: Record<string, unknown>) => { ran.push(`${name}:${String(args.action ?? '')}`); return { text: `${name} ran here` }; },
    }) as unknown as Registration);
    const run = windowToolRunner(() => registrations, new Map());

    it('a call genie-host forwards for one of its own tools is refused here, `sites open` too since 2g-4d D2 (Tynn #1046); a window tool runs the plain handler', async () => {
        ran.length = 0;
        // What genie-host's MCP server forwards (mcp-host-tools.ts): a window tool, or a host tool's window action.
        expect((await run({ name: 'manageTerminals', args: { action: 'create' }, headers: {}, caller: null })).isError).toBe(true);
        expect((await run({ name: 'flows', args: { action: 'run' }, headers: {}, caller: null })).isError).toBe(true);
        expect((await run({ name: 'sites', args: { action: 'list' }, headers: {}, caller: null })).isError).toBe(true);
        expect(ran).toEqual([]);
        // `sites open` is genie-host's own now (its browser); a window tool runs the handler main registered.
        expect((await run({ name: 'sites', args: { action: 'open' }, headers: {}, caller: null })).isError).toBe(true);
        expect((await run({ name: 'pages', args: { action: 'list' }, headers: {}, caller: null })).text).toBe('pages ran here');
        expect(ran).toEqual(['pages:list']);
    });

    it('no host tool has a window action (`sites open` was the last, until 2g-4d D2), so no host tool’s handler in the window can run', () => {
        expect(WINDOW_ACTIONS).toEqual({});
        for (const tool of HOST_NATIVE_TOOLS) for (const action of ['create', 'list', 'run', 'send', 'open', undefined]) {
            expect(runsInWindow(tool, action === undefined ? {} : { action }), `${tool} ${action}`).toBe(false);
        }
        // CONTROL: a window tool always runs in the window.
        expect(runsInWindow('pages', {})).toBe(true);
    });

    it('the window runs no flow engine of its own: compose starts one only with no `flowsEngine`, and main composes nothing (2g-4d E)', () => {
        expect(compose).toMatch(/if \(!input\.flowsEngine\) \{\s*ownFlows = await input\.alone!\.openFlows\(\);/);
        expect(compose).toMatch(/const ownEngine = ownFlows \? input\.alone!\.startFlows\(\{/);
        expect(compose).toMatch(/setFlowToolCaller: \(call\) => \{ ownEngine\?\.setToolCaller\(call\); \},/);
        expect(main).not.toMatch(/flowsEngine:|composeWindowServices/);
        expect(main).not.toMatch(/\balone:/);
    });

    it('main stops before any tool is built when there is no host, so the forward’s "no host" arm never ran either', () => {
        const at = (needle: string) => { const i = main.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
        expect(main).toMatch(/if \(agentEngineLink === null\) \{\s*await stopForNoHost\(hostRuntime\.error\);\s*return;\s*\}/);
        expect(at('if (agentEngineLink === null) {')).toBeLessThan(at('withActionSignal(allGenieTools(genieToolDeps({'));
    });
});

describe('PROOF: the window writes no workspace config, and opens no terminal for an agent', () => {
    it('`syncConfig` is asked only by the feature machine and genie-host’s workspace files; main imports neither and never asks', () => {
        const askers = filesWith(/\.syncConfig\(/);
        expect(askers).toEqual(['src/main/feature-machine.ts', 'src/main/features-host.ts', 'src/main/host-workspace-files.ts']);
        expect(main).not.toMatch(/syncConfig/);
        for (const file of askers) expect(main, file).not.toContain(`./${file.slice('src/main/'.length, -'.ts'.length)}.js`);
        // CONTROL: the import check finds a module main does import.
        expect(main).toContain('./window-tools.js');
    });

    it('the tools’ `terminalEnv` feeds manageTerminals alone, which is genie-host’s own tool with no window action', () => {
        const deps = code(src('src/main/genie-tool-deps.ts'));
        expect(deps.match(/\bp\.terminalEnv\b/g) ?? []).toHaveLength(2);
        expect(deps).toMatch(/\.\.\.\(p\.terminalEnv \? \{ envFor: p\.terminalEnv \} : \{\}\),/);
        expect(HOST_NATIVE_TOOLS.has('manageTerminals')).toBe(true);
        expect(WINDOW_ACTIONS.manageTerminals).toBeUndefined();
    });
});

describe('PROOF: compose reads no pty port, and adopts a pty only when it runs the supervisor itself', () => {
    it('compose reads `input.pty` and `input.processPty` nowhere; `input.adoptPtys` only where no supervisor was handed in', () => {
        expect(compose).not.toMatch(/input\.(pty|processPty)\b/);
        const adopts = compose.match(/input\.adoptPtys/g) ?? [];
        expect(adopts.length).toBeLessThanOrEqual(1);
        if (adopts.length === 1) expect(compose).toMatch(/if \(input\.supervisor\) supervisor = input\.supervisor;\s*else \{\s*const own = input\.alone!\.supervisor\(\);\s*for \(const pty of input\.adoptPtys \?\? \[\]\) own\.adopt\(pty\);/);
        // CONTROL: the same pattern finds an input compose does read.
        expect(compose).toMatch(/input\.(supervisor|flowsEngine)\b/);
    });

    it('main always hands compose genie-host’s supervisor', () => {
        expect(main).toMatch(/^ {8}supervisor: agentEngineLink\.client\.supervisor\(\),$/m);
    });

    it('nothing reads the ptys main listed at link-up, or its terminals’ spawn host: each is only written', () => {
        for (const name of ['adoptablePtys', 'spawnTerminalsNow']) {
            const uses = [...main.matchAll(new RegExp(`^.*\\b${name}\\b.*$`, 'gm'))].map((m) => m[0].trim());
            // A declaration, an assignment, the boot's log line of what it found, or the compose input proven unread above.
            for (const line of uses) expect(line, name).toMatch(new RegExp(`^(let ${name}\\b|${name} = |if \\(${name}\\.length > 0\\) lifecycleLog\\(|adoptPtys: ${name},$)`));
        }
    });
});

describe('the dead uses left main', () => {
    it('main keeps no engine Files watch: no tree keeper, no watch, no listeners', () => {
        expect(main).not.toMatch(/FilesTreeKeeper|filesEventListeners|\bfilesWatch\b|onFilesEvent|filesUnwatch|FilesHubEvent|FilesWant/);
        // CONTROL: the Files panel's own host stays (it answers a path for an export and a drag).
        expect(main).toMatch(/filesHost = new FilesHost\(\{/);
    });

    it('main forwards no host tool and builds no flow caller: its tools are the registrations as built', () => {
        expect(main).not.toMatch(/withHostTools|runHostTool|FlowCallers|flowCallers|createFlowToolCaller|setFlowToolCaller|flow-tools\.js/);
        expect(main).toMatch(/const registrations = withActionSignal\(allGenieTools\(genieToolDeps\(\{/);
        expect(main).toMatch(/windowToolRun = windowToolRunner\(\(\) => registrations, vouchedCallers\);/);
        expect(main).toMatch(/const resolveCaller = \(terminalId: string\) => vouchedCallers\.get\(terminalId\) \?\? sessionCaller\(terminalId\);/);
    });

    it('main hands compose no config writer and its tools no terminal env', () => {
        expect(main).not.toMatch(/hostConfigSync|terminalEnv|\bmcpEnv\b/);
    });

    it('main makes no pty port and lists no pty to adopt; the processes child’s exec route stays, reconciled at link-up', () => {
        expect(main).not.toMatch(/realFancyTermPort|\bptyPort\b|processPty|adoptPtys|adoptablePtys|spawnTerminalsNow|ListedPty|^\s*pty:/m);
        // LIVE (genie#1397): every execFileRunner command and stream of the window runs in genie-host's processes child.
        expect(main).toMatch(/const processes = new SpawnHostClient\(\{ entry: '', link: engineLink\.spawnLink\('processes'\), log: lifecycleLog \}\);/);
        expect(main).toMatch(/engineLink\.onSpawnFrame\('processes', \(frame\) => processes\.linkFrame\(frame\)\);/);
        expect(main).toMatch(/const reconcile = \(\): Promise<unknown> => processes\.linkUp\(\);/);
        expect(main).toMatch(/await reconcile\(\)\.catch\(/);
        expect(main).toMatch(/routeExecThroughSpawnHost\(spawnHostNow\);/);
    });

    it('compose takes none of them: no pty, processPty, adoptPtys or hostConfigSync input', () => {
        expect(compose).not.toMatch(/processPty|adoptPtys|hostConfigSync|ListedPty|PtyPort/);
        expect(compose).not.toMatch(/^\s*readonly pty: /m);
        // CONTROL: the same pattern finds an input compose keeps.
        expect(compose).toMatch(/^\s*readonly userData: /m);
    });

    it('`withHostTools` and `terminalEnvFor` are gone: nothing else called them', () => {
        expect(filesWith(/\bwithHostTools\b|\bterminalEnvFor\b/)).toEqual([]);
        // CONTROL: what the window still runs for genie-host is there.
        expect(code(src('src/main/window-tools.ts'))).toMatch(/export function windowToolRunner\(/);
    });
});

describe('the engine link carries no Files watch, host-tool or config route any more', () => {
    const GONE_METHODS = ['engine.filesWatch', 'engine.filesUnwatch', 'engine.runTool', 'engine.configSync'];

    it('none of their methods is an engine method: a frame naming one does not parse', () => {
        for (const method of GONE_METHODS) {
            expect(ENGINE_METHODS as readonly string[], method).not.toContain(method);
            expect(isEngineMethod(method), method).toBe(false);
        }
        // CONTROL: the exec route's method stays.
        expect(isEngineMethod('engine.spawn')).toBe(true);
    });

    it('the server answers none of them and says no files event; the client has no member for them', () => {
        for (const name of [...GONE_METHODS, 'files.event']) {
            expect(server.includes(`'${name}'`), `server: ${name}`).toBe(false);
            expect(client.includes(`'${name}'`), `client: ${name}`).toBe(false);
        }
        for (const member of ['filesWatch', 'filesUnwatch', 'onFilesEvent', 'runHostTool', 'configSync']) {
            expect(client, member).not.toMatch(new RegExp(`^\\s{4}(async\\s+)?${member}\\(`, 'm'));
        }
        expect(client).not.toMatch(/#filesViews|#filesListeners/);
        expect(server).not.toMatch(/filesEvent\(|runNative|configSync/);
        // CONTROL: members that stay are found by the same pattern.
        expect(client).toMatch(/^\s{4}spawnLink\(/m);
        expect(client).toMatch(/^\s{4}onSpawnFrame\(/m);
    });

    it('genie-host’s files hub says its events to its own owner only, and its MCP server runs no tool for a window’s caller', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).not.toMatch(/engine\.filesEvent|runNative|configSync:/);
        expect(host).toMatch(/send: \(owner, event\) => \{ if \(owner === HOST_LOCAL_OWNER\) hostFilesWatches\.deliver\(event\); \},/);
        const mcp = code(src('src/main/host-mcp.ts'));
        expect(mcp).not.toMatch(/runNative|injected|injectSeq/);
        // CONTROL: the host's MCP server still serves its tools to flows.
        expect(mcp).toMatch(/registrations: \(\) => servedNow,/);
    });
});

describe('the window’s engine inventory', () => {
    const row = (use: string) => WINDOW_ENGINE_INVENTORY.find(([u]) => u === use)?.[1] ?? null;

    it('the processes child’s exec route is the link’s own: spawnLink and onSpawnFrame are `link`', () => {
        expect(row('spawnLink')).toBe('link');
        expect(row('onSpawnFrame')).toBe('link');
    });

    it('has no row for the host tools’ forward or the Files watch', () => {
        for (const use of ['runHostTool', 'onFilesEvent', 'filesWatch', 'filesUnwatch']) expect(row(use), use).toBeNull();
        // CONTROL: a row that stays is found.
        expect(row('supervisor')).toBe('move:2g');
    });
});

describe('the files that held nothing else', () => {
    it('the engine Files tunnel’s test files are gone with the route', () => {
        for (const file of ['test/engine-files-tunnel.test.ts', 'test/p4-files-watch-engine-recovery.test.ts']) expect(existsSync(resolve(root, file)), file).toBe(false);
        // CONTROL: the check finds a file that is there.
        expect(existsSync(resolve(root, 'test/engine-spawn-tunnel.test.ts'))).toBe(true);
    });
});
