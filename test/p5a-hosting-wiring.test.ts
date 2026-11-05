import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * P5a WIRING (the host split): genie-host builds Genie's hosting and serves it, raises no OS prompt of its own (every
 * elevation goes to a window), and shuts the hosting's own part down after the supervised processes; a linked window is
 * handed the host's hosting and builds none. The behaviour is proven in hosting-host-contract.test.ts and
 * p5a-hosting-linked.test.ts; this pins that the real entry points are wired to it. Comments are stripped by line.
 */

const code = (path: string): string => readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('P5a: the entry points are wired to the host’s hosting', () => {
    const host = code('src/main/genie-host.ts');
    const main = code('src/main/main.ts');

    it('genie-host composes the hosting under its own supervisor, elevates through a window only, and serves it', () => {
        expect(host).toMatch(/hosting = await composeHosting\(\{[\s\S]{0,600}?supervisor: processSupervisor,/);
        expect(host).toMatch(/elevate: \(steps\) => hostingElevation\.run\(steps\),/);
        expect(host).toMatch(/new WindowElevation\(\{\s*connected: \(\) => engineRef\?\.windowConnected\(\) \?\? false,\s*ask: \(steps\) => \(engineRef \? engineRef\.elevate\(steps\)/);
        expect(host).toMatch(/\.\.\.\(hostingService \? \{ hosting: hostingService \} : \{\}\),/);
    });

    it('genie-host shuts the hosting’s own part down AFTER the supervised processes', () => {
        const fn = host.slice(host.indexOf('async function shutdown('));
        const relay = fn.indexOf('await relay?.stop()');
        const hosting = fn.indexOf('await hostingStack?.shutdown()');
        expect(relay).toBeGreaterThan(-1);
        expect(hosting).toBeGreaterThan(relay);
    });

    it('a linked window hands compose the host’s hosting, runs the host’s elevations, and passes what only Electron knows', () => {
        expect(main).toMatch(/\.\.\.\(agentEngineLink \? \{ hosting: agentEngineLink\.client\.hosting\(\) \} : \{\}\),/);
        expect(main).toMatch(/elevate: \(steps: readonly PrivilegedStep\[\]\) => runElevatedBatch\(process\.platform, steps,/);
        expect(main).toMatch(/env: \{ \.\.\.process\.env, GENIE_V1_USERDATA: app\.getPath\('userData'\), GENIE_APPDATA: app\.getPath\('appData'\), GENIE_RESOURCES: process\.resourcesPath \},/);
    });
});
