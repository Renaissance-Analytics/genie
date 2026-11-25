import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A WORKSPACE'S SERVICE VARIABLES ARE GENIE-HOST'S OWN (Tynn #1044, the beta.65 hotfix).
 *
 * genie-host owns the hosting stack (its engines, P5a), yet its engine server answered `serviceEnvFor` — what every kept
 * process, scheduled task, flow `terminal_run` and agent it starts gets — only from the copy a WINDOW handed over with an
 * agent's `engine.start`. After any host restart that copy is empty until a window starts an agent in that workspace, so
 * a queue worker restored at boot ran with no DB_PORT and no DB_PASSWORD.
 *
 * Here the engine server is given the host's own reading and must answer it with no start at all, read fresh every time
 * (an engine added later is seen), and never let a window's stale copy stand in for it.
 */

const TOKEN = 'service-env-token';
const ENV = { DB_CONNECTION: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: '33061', DB_PASSWORD: 'fixture-pass' };
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-svc-env-')); });
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });

describe('genie-host answers a workspace\'s service env from its own engines (Tynn #1044)', () => {
    it('with NO agent ever started (a host just restarted), a process gets DB_PORT and DB_PASSWORD', () => {
        const engines: Record<string, Record<string, string>> = { ws: ENV };
        const server = new SessionEngineServer({ token: TOKEN, build: 't', serviceEnvFor: (id: string) => engines[id] ?? {} } as ConstructorParameters<typeof SessionEngineServer>[0]);
        // What genie-host's process book, scheduler and flows read (genie-host.ts `engine.serviceEnvFor`).
        expect(server.serviceEnvFor('ws')).toMatchObject({ DB_PORT: '33061', DB_PASSWORD: 'fixture-pass' });
        // What an agent the host starts reads (the session host's option).
        expect(server.hostOptions().serviceEnvFor('ws')).toMatchObject({ DB_PORT: '33061', DB_PASSWORD: 'fixture-pass' });
        // A workspace with no engine gets none (control: the reading is per workspace, not one env for all).
        expect(server.serviceEnvFor('other')).toEqual({});
        // Read at every call: an engine added after boot is seen by the next start, with no window involved.
        engines['other'] = { REDIS_URL: 'redis://127.0.0.1:6380' };
        expect(server.serviceEnvFor('other')).toEqual({ REDIS_URL: 'redis://127.0.0.1:6380' });
    });

    it('a window\'s copy handed over with engine.start does not replace the host\'s own', async () => {
        const server = new SessionEngineServer({ token: TOKEN, build: 't', adoptWindowEnv: () => {}, serviceEnvFor: (id: string) => (id === 'ws' ? ENV : {}) } as ConstructorParameters<typeof SessionEngineServer>[0]);
        const driverFor: DriverFor = () => ((_o: { events: DriverEvents }) => {
            return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        }) as unknown as SessionDriverFactory;
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
        hosts.push(host);
        server.attach(host);
        const [h, w] = memoryPair();
        server.accept(h);
        // An older window still sends its own (stale, or empty after its hosting replica dropped) copy with each start.
        const client = new SessionEngineClient({ env: () => ({}), serviceEnvFor: () => ({ DB_PORT: '1', DB_PASSWORD: 'stale' }) });
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        await client.start(agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas' }), dir);
        expect(server.serviceEnvFor('ws')).toMatchObject({ DB_PORT: '33061', DB_PASSWORD: 'fixture-pass' });
        // A window starting an agent of a workspace with no engines does not hand that workspace any either.
        await client.start(agentRecord({ id: mintAgentId(), workspaceId: 'bare', provider: 'claude', name: 'echo' }), dir);
        expect(server.serviceEnvFor('bare')).toEqual({});
    });
});
