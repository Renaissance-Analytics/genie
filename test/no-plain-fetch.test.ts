import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NODE'S `fetch` IS NOT THIS MACHINE'S NETWORK. In Electron's main process and in genie-host the global `fetch` trusts Node's bundled roots and knows no OS proxy. So a company's root, a test VM's alias
 * CA or a proxy makes it fail, while everything beside it works. The relay's calls to Tynn took it from 2026-10-19 (`relayHostPorts({ ..., fetch })`): batch FF's upgrade signed in through the host and
 * then read "Tynn could not be reached (fetch failed)" for the relay ticket. Tynn's calls go through the window's `net.fetch` or session, or the host's host-https-fetch.ts, one trust set and one proxy path.
 *
 * Every plain `fetch` under src/main is named here with what it reaches. A new one fails this test until someone decides.
 */
const KNOWN: Record<string, { count: number; reaches: string }> = {
    'src/main/main.ts': { count: 2, reaches: 'public: the toolchain version index, and the release notes on api.github.com' },
    'src/main/mcp-server.ts': { count: 1, reaches: "this machine: Genie's own MCP endpoint" },
    'src/main/php-versions.ts': { count: 2, reaches: 'public: PHP version downloads' },
    'src/main/tailscale-cli.ts': { count: 1, reaches: 'public: the Tailscale installer' },
};

const code = (text: string) => text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/typeof fetch/g, '').replace(/'[^']*'|`[^`]*`/g, "''")).join('\n');
/** A call, or the global passed along by shorthand. Not `x.fetch(`, `#fetch(`, or a property being declared. */
export const plainFetches = (text: string): number => (code(text).match(/(^|[^.#\w])fetch\s*(\(|,|\})/gm) ?? []).length;

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = `${dir}/${name}`;
        return statSync(join(dir, name)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
}
const found = () => Object.fromEntries(walk('src/main').map((file) => [file, plainFetches(readFileSync(file, 'utf8'))]).filter(([, count]) => (count as number) > 0));

describe('the reading itself', () => {
    it.each([
        ['await fetch(url)', 1],
        ['relayHostPorts({ tynnHost, fetch })', 1],
        ['relayHostPorts({ fetch, tynnHost })', 1],
        ['fetch: (url, init) => net.fetch(url, init)', 0],
        ['await this.#fetch(path)', 0],
        ['await input.fetch(url)', 0],
        ['readonly fetch: typeof fetch;', 0],
        ['// a comment about fetch(url)', 0],
        ["const words = 'fetch(url)';", 0],
    ])('%s reads as %i', (text, count) => { expect(plainFetches(text)).toBe(count); });
});

describe('every plain fetch under src/main', () => {
    it('is one someone decided on, as many as were decided', () => {
        expect(found()).toEqual(Object.fromEntries(Object.entries(KNOWN).map(([file, known]) => [file, known.count])));
    });

    it('none reaches Tynn: nothing named for Tynn, the relay or a workstation has one', () => {
        const named = Object.keys(found()).filter((file) => /tynn|relay|workstation/i.test(file));
        expect(named).toEqual([]);
    });

    it('the relay asks Tynn through the window\'s network', () => {
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/relayHostPorts\(\{[^\n]*fetch: \(url, init\) => net\.fetch\(url, init\)/);
    });
});
