import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d E2b (Tynn #955, task #1494). After E2a took the stores, supervisor and flows replicas off
 * the engine link, the hosting replica is the last of them: since E1 the window reads none of it (its front door comes on
 * frontdoor.watch, D1; the Hosting and Services tabs on features.snapshot/act). E2b removes it END TO END: the client's
 * hosting() accessor, its dump/event cases and its phpCgiFor option (which only the replica used), the server's option,
 * emissions, connect-time dump and method case, engine.hosting, and HostingService/HostingReplica with their dump and
 * event types. The hosting's own types (SitesApi, EnginesApi, EnvelopeSitesApi, HostingApi) and WindowElevation stay.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

describe('the engine link carries no replica of genie-host’s hosting', () => {
    it('no engine.hosting', () => {
        expect(ENGINE_METHODS as readonly string[]).not.toContain('engine.hosting');
        // CONTROL: the same list still has what the window uses.
        expect(ENGINE_METHODS as readonly string[]).toContain('engine.browser');
    });

    it('a window’s engine client has no hosting() accessor and takes no phpCgiFor', () => {
        expect('hosting' in SessionEngineClient.prototype).toBe(false);
        expect('browserCall' in SessionEngineClient.prototype).toBe(true);
        expect(code(src('src/main/session-engine-client.ts'))).not.toMatch(/phpCgiFor|HostingReplica|'hosting\.(dump|event)'/);
    });

    it('the server sends no hosting dump or event and takes no hosting option; genie-host builds no HostingService', () => {
        const server = code(src('src/main/session-engine-server.ts'));
        expect(server).not.toMatch(/'hosting\.(dump|event)'|readonly hosting\?: |HostingService/);
        expect(server).toMatch(/readonly browser\?: BrowserService;/);
        const host = code(src('src/main/genie-host.ts'));
        expect(host).not.toMatch(/new HostingService\(|hosting: hostingService/);
        // CONTROL: genie-host still builds the elevations a window runs.
        expect(host).toMatch(/new WindowElevation\(/);
    });

    it('main hands its engine client no PHP resolver', () => {
        expect(code(src('src/main/main.ts'))).not.toMatch(/phpCgiFor:/);
    });
});

describe('hosting-host.ts keeps the hosting’s types and the elevations, and nothing of the replica', () => {
    it('no HostingService, HostingReplica, HostingDump or HostingEvent', async () => {
        const mod = await import('../src/main/hosting-host.js') as Record<string, unknown>;
        expect(mod.HostingService).toBeUndefined();
        expect(mod.HostingReplica).toBeUndefined();
        expect(code(src('src/main/hosting-host.ts'))).not.toMatch(/export (interface|type) Hosting(Dump|Event)\b/);
        expect(typeof mod.WindowElevation).toBe('function');
        expect(existsSync(resolve(root, 'src/main/hosting-host.ts'))).toBe(true);
    });
});

describe('the plain-Node host boot script waits for genie-host’s front door, not for a replica’s dump', () => {
    it('no hosting.dump in scripts/host-plain-node-boot.mjs', () => {
        expect(src('scripts/host-plain-node-boot.mjs')).not.toMatch(/'hosting\.dump'/);
    });
});
