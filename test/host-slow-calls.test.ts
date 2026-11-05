import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot } from '../src/main/feature-ipc.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * WHERE A SLOW ANSWER WAITS (genie-test-windows, job Q0, 2026-11-05). In the quit proof's step 9t, a settings change
 * through `features.act` took 12.4 s on one run and more than 20 s on the next. Meanwhile the window's main was held
 * for 1-1.7 s at a time only, so the wait was elsewhere: in genie-host's answer, or in a part of the features snapshot.
 * genie-host logged nothing at all about its own event loop or its calls. So:
 *  - genie-host times every call a window makes (`host ipc slow channel=<method> ms=…` in the lifecycle log) and its own
 *    event loop (`host stall main ms=…`), with the window's watchdog;
 *  - the features snapshot names a slow part (`features slow part=… ms=…`).
 */

const TOKEN = 'slow-calls-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

let dir: string | null = null;
let services: ComposedServices | null = null;
afterEach(async () => {
    await services?.shutdown();
    services = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
});

describe('genie-host times the calls a window makes', () => {
    it('each call is timed from its dispatch to its answer, by method', async () => {
        dir = await mkdtemp(join(tmpdir(), 'slow-calls-'));
        const timed: string[] = [];
        const server = new SessionEngineServer({ token: TOKEN, build: 't', timeCall: (method) => { timed.push(`begin ${method}`); return () => { timed.push(`end ${method}`); }; } });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
        expect(await client.ping()).toBe(true);
        // The client's own calls at connect are timed too; the ping is one call, begun and ended.
        expect(timed.filter((t) => t.endsWith(' engine.ping'))).toEqual(['begin engine.ping', 'end engine.ping']);
        // Every call timed is ended: none is left open once its answer is in.
        expect(timed.filter((t) => t.startsWith('begin ')).length).toBe(timed.filter((t) => t.startsWith('end ')).length);
        client.disconnect();
    });

    it('genie-host runs the watchdog on itself, its lines marked as the host’s, and hands it every call', () => {
        const src = readFileSync('src/main/genie-host.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(src).toMatch(/new StallWatchdog\(\{\s*log: \(line\) => lifecycleLog\(`host \$\{line\}`\)/);
        expect(src).toMatch(/timeCall: \(method\) => hostWatchdog\.ipc\(method\)/);
        expect(src).toMatch(/hostWatchdog\.start\(\);/);
    });
});

function fakePty(): PtyPort {
    let n = 0;
    return {
        open: () => ({ id: `term_${++n}`, pid: 500 + n, shell: 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
}

describe('the features snapshot names its slow part', () => {
    it('a knowledge read over the bound is named with its time; CONTROL: under the bound nothing is said', async () => {
        dir = await mkdtemp(join(tmpdir(), 'slow-snapshot-'));
        services = await composeServices({ userData: dir, pty: fakePty(), v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        const real = services.knowledge;
        const slow = { ...services, knowledge: Object.assign(Object.create(Object.getPrototypeOf(real)), real, { list: async (...a: Parameters<typeof real.list>) => { await new Promise((r) => setTimeout(r, 60)); return real.list(...a); } }) } as ComposedServices;
        const said: string[] = [];
        await featureSnapshot(slow, { toolStatuses: null, knowledgeQuery: '' }, { slowPart: { ms: 40, log: (part, ms) => said.push(`${part} ${ms >= 40 ? 'over' : 'under'}`) } });
        expect(said).toContain('knowledge over');
        said.length = 0;
        await featureSnapshot(services, { toolStatuses: null, knowledgeQuery: '' }, { slowPart: { ms: 5_000, log: (part) => said.push(part) } });
        expect(said).toEqual([]);
    });

    it('main writes those to the lifecycle log', () => {
        const src = readFileSync('src/main/main.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(src).toMatch(/slowPart: \{ ms: [0-9_]+, log: \(part, ms\) => lifecycleLog\(`features slow part=\$\{part\} ms=\$\{ms\}`\) \}/);
    });
});
