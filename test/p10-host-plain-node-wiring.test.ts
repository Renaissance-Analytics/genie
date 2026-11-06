import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_BROWSER_HERE, NO_PAGES_HERE } from '../src/core/host-runtime.js';

/**
 * GENIE-HOST ON PLAIN NODE, WIRED (P10.1d). The rules are driven where they live (browser-service.test.ts,
 * mcp-host-tools.test.ts, host-runtime.test.ts) and the whole host is booted on plain Node in CI
 * (scripts/host-plain-node-boot.mjs); this holds that the host entry asks what it runs on, and gives the browser service
 * and the MCP server what it has not. Comments stripped by line.
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

    it('asks once what it runs on', () => {
        expect(host()).toMatch(/const onElectron = runsOnElectron\(\);/);
    });

    // The browser service's half is pinned in browser-process-wiring.test.ts ("it starts no process for it").

    it('with no Electron, the MCP server answers pages with why', () => {
        expect(host()).toMatch(/startHostMcp\(\{[^]*?\.\.\.\(onElectron \? \{\} : \{ unavailableHere: new Map\(\[\['pages', NO_PAGES_HERE\]\]\) \}\),[^]*?\}\);/);
    });
});

describe('host-mcp.ts', () => {
    it('hands what is not available here to the registrations', () => {
        expect(strip('src/main/host-mcp.ts')).toMatch(/hostRegistrations\(all, \{[^}]*\.\.\.\(ports\.unavailableHere \? \{ unavailableHere: ports\.unavailableHere \} : \{\}\)/);
    });
});
