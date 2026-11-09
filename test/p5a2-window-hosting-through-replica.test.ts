import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * P5a.2: A WINDOW TOUCHES THE HOST'S HOSTING ONLY THROUGH ITS REPLICA. The window's writers (hosting-actions.ts,
 * mcp-tools-hosting.ts, feature-ipc.ts) reach the sites, the engines and the front door through `services` — the
 * replica when linked — and never build or import a piece of the hosting of their own; main.ts never composes one;
 * compose.ts builds its own only when it was handed none (the emergency path). A value import is a run-time edge;
 * `import type` is not.
 */

const HOSTING_INTERNALS = ['service-registry', 'site-manager', 'envelope-sites-host', 'hosting-compose', 'dotenv-sync', 'gen-ca', 'hosts-file', 'elevate', 'service-driver', 'gen-router-server', 'front-door-port', 'browser-trust'];
const VALUE_IMPORT = /^import (?!type )[^'"]*from '\.\/([a-z0-9-]+)\.js';/gm;
const valueImports = (path: string): string[] => [...readFileSync(path, 'utf8').matchAll(VALUE_IMPORT)].map((m) => m[1]!).filter((m) => HOSTING_INTERNALS.includes(m));
const code = (path: string): string => readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('the window reaches the host’s hosting only through the replica', () => {
    it('POSITIVE CONTROL: the scan finds the hosting’s own pieces where they are built', () => {
        expect(valueImports('src/main/hosting-compose.ts')).toEqual(expect.arrayContaining(['service-registry', 'site-manager', 'envelope-sites-host', 'gen-ca', 'hosts-file', 'elevate']));
    });

    for (const file of ['src/main/hosting-actions.ts', 'src/main/mcp-tools-hosting.ts', 'src/main/feature-ipc.ts']) {
        it(`${file} builds no piece of the hosting: it imports none at run time`, () => {
            expect(valueImports(file)).toEqual([]);
        });
    }

    it('main.ts composes no hosting of its own, and runs only the host’s elevations', () => {
        const main = code('src/main/main.ts');
        expect(main).not.toMatch(/composeHosting\(/);
        // The window runs the host's elevations (elevate.js) and reads envelope folders (nodeEnvelopeFs); it builds no piece.
        expect(valueImports('src/main/main.ts').filter((m) => m !== 'elevate' && m !== 'envelope-sites-host')).toEqual([]);
        expect(main).not.toMatch(/new (EnvelopeSites|SiteManager|ServiceRegistry|ServiceDriver|GenRouterServer|HostsSync|DotEnvSync)\b|GenCa\.open\(/);
    });

    it('compose.ts builds no hosting of its own: it is handed genie-host’s, or a test’s (Tynn #584)', () => {
        const compose = code('src/main/compose.ts');
        expect(compose).not.toMatch(/composeHosting\(/);
        expect(compose).toMatch(/const ownHosting = input\.hosting \? null : await input\.buildOwnHosting!\(/);
    });

    it('an engine update goes through the host’s check (updateEngine), never the registry’s update from a window', () => {
        expect(code('src/main/hosting-actions.ts')).not.toMatch(/\.engines\.update\(/);
        expect(code('src/main/hosting-actions.ts')).toMatch(/s\.updateEngine\(/);
    });
});
