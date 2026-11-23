import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d E2a (Tynn #955, task #1494). The window composes nothing since E1, so it reads none of the
 * engine link's replicas of genie-host's stores, supervisor and flows. E2a removes them END TO END: the client's
 * accessors and their dump/event cases, the server's options, emissions, connect-time dumps and method cases, the engine
 * methods, and the replica half of each module. What a window or a phone does with them goes over the protocol
 * (features.act/snapshot, registry.write, chatDrafts.*), and genie-host keeps its services in-process. E2b does hosting.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const GONE = ['stores', 'supervisor', 'flows'] as const;

describe('the engine link carries no replica of the stores, the supervisor or the flows', () => {
    it('no engine method of theirs', () => {
        for (const name of GONE) expect(ENGINE_METHODS as readonly string[], name).not.toContain(`engine.${name}`);
        // CONTROL: the same list still has what the window uses (the browser, its own link).
        expect(ENGINE_METHODS as readonly string[]).toContain('engine.browser');
    });

    it('a window’s engine client has no accessor for them', () => {
        for (const name of GONE) expect(name in SessionEngineClient.prototype, name).toBe(false);
        // CONTROL: the prototype read sees a member that stays.
        expect('browserCall' in SessionEngineClient.prototype).toBe(true);
    });

    it('the client reads no dump or event of theirs; the server sends none and takes no option for them', () => {
        const client = code(src('src/main/session-engine-client.ts'));
        expect(client).not.toMatch(/'stores\.(dump|event)'|'supervisor\.(dump|event)'|'flows\.event'|storeReplicas|SupervisorReplica|FlowsReplica/);
        const server = code(src('src/main/session-engine-server.ts'));
        expect(server).not.toMatch(/'stores\.(dump|event)'|'supervisor\.(dump|event)'|'flows\.event'/);
        expect(server).not.toMatch(/readonly (stores|supervisor|flows)\?: /);
        // CONTROL: the scan reads the server's real options.
        expect(server).toMatch(/readonly browser\?: BrowserService;/);
    });

    it('genie-host hands its engine server none of them; it keeps its services in-process', () => {
        const host = code(src('src/main/genie-host.ts'));
        const options = host.slice(host.indexOf('new SessionEngineServer({'), host.indexOf('new SessionEngineServer({') + 6000);
        expect(options).not.toMatch(/\n\s*supervisor: supervisorService,|\n\s*flows: flowsService,|\n\s*stores,\n/);
        // CONTROL: the slice is the real options (the browser is handed over).
        expect(options).toMatch(/\n\s*browser: browserService,/);
    });
});

describe('the replica halves go; what genie-host uses stays', () => {
    it('supervisor-host.ts (its service and its replica) is gone', () => {
        expect(existsSync(resolve(root, 'src/main/supervisor-host.ts'))).toBe(false);
        // CONTROL: the check finds a file that is there (the supervisor's own API).
        expect(existsSync(resolve(root, 'src/main/process-supervisor.ts'))).toBe(true);
    });

    it('agent-stores-replica.ts keeps only genie-host’s registry store', async () => {
        const mod = await import('../src/main/agent-stores-replica.js') as Record<string, unknown>;
        for (const gone of ['storeReplicas', 'InboxReplica', 'AttentionReplica', 'ApprovalsReplica', 'SettingsReplica']) expect(mod[gone], gone).toBeUndefined();
        expect(typeof mod.HostRegistryStore).toBe('function');
    });
});
