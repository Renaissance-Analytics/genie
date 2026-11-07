import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_BROWSER_HERE, NO_PAGES_HERE } from '../src/core/host-runtime.js';

/**
 * GENIE-HOST ON PLAIN NODE, WIRED (P10.1d). The rules are driven where they live (host-runtime.test.ts,
 * browser-service.test.ts, mcp-host-tools.test.ts, elevation-waiting-deck.test.ts, p10-updates-not-here.test.ts) and the
 * whole host is booted on plain Node in CI (scripts/host-plain-node-boot.mjs); this holds that the host entry asks ONE
 * helper what it can have, and hands every feature that needs a window, the browser or an elevation its answer.
 * Comments stripped by line.
 */

const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

describe('what the host says it cannot do', () => {
    it('the words say "not available on this host", and why', () => {
        expect(NO_BROWSER_HERE).toMatch(/^The Genie browser is not available on this host: .*no Electron/);
        expect(NO_PAGES_HERE).toMatch(/^pages is not available on this host: .*no Electron.*Nothing was done\.$/);
    });
});

describe('genie-host.ts', () => {
    const host = () => strip('src/main/genie-host.ts');

    it('asks hostCapabilities once, and nothing else decides it', () => {
        expect(host()).toMatch(/const capabilities = hostCapabilities\(\);/);
        expect(host()).not.toMatch(/runsOnElectron|onElectron|process\.versions/);
    });

    // The browser service's half is pinned in browser-process-wiring.test.ts ("it starts no process for it").

    it('the MCP server is handed the capabilities', () => {
        expect(host()).toMatch(/startHostMcp\(\{[^]*?\n\s*capabilities,\n[^]*?\}\);/);
    });

    it('elevation is asked only on a host that can elevate', () => {
        expect(host()).toMatch(/new WindowElevation\(\{[^]*?ask: [^\n]*\n\s*elevation: capabilities\.elevation,\n\s*\}\);/);
    });

    it('the updater exists only on a host with a window: otherwise it says why, and its helper is never launched', () => {
        expect(host()).toMatch(/new UpdatesService\(\{\s*\.\.\.\(capabilities\.window \? \{\} : \{ unavailable: NO_UPDATES_HERE \}\),/);
    });
});

describe('host-mcp.ts', () => {
    it('hands the capabilities to the registrations', () => {
        const src = strip('src/main/host-mcp.ts');
        expect(src).toMatch(/hostRegistrations\(all, \{[^}]*\.\.\.\(ports\.capabilities \? \{ capabilities: ports\.capabilities \} : \{\}\)/);
        expect(src).not.toMatch(/unavailableHere/);
    });
});
