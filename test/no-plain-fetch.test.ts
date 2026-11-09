import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { httpFetchOver } from '../src/main/php-versions.js';

/**
 * NODE'S `fetch` IS NOT THIS MACHINE'S NETWORK. In Electron's main process and in genie-host the global `fetch` trusts Node's bundled roots and knows no OS proxy. So a company's root, a test VM's alias
 * CA or a proxy makes it fail, while everything beside it works. The relay's calls to Tynn took it from 2026-10-19 (`relayHostPorts({ ..., fetch })`): batch FF's upgrade signed in through the host and
 * then read "Tynn could not be reached (fetch failed)" for the relay ticket. Tynn's calls go through the window's `net.fetch` or session, or the host's host-https-fetch.ts, one trust set and one proxy path.
 *
 * The owner's ruling (2026-11-03): all of them, because a toolchain or PHP download failing behind a proxy is the same problem. Every plain `fetch` under src/main is named here with what it reaches, and the
 * one left talks to this machine. A new one fails this test until someone decides.
 */
const KNOWN: Record<string, { count: number; reaches: string }> = {
    'src/main/mcp-server.ts': { count: 1, reaches: "this machine: Genie's own MCP endpoint, with no CA and no proxy between" },
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

describe('the downloads', () => {
    const answering = (response: Response) => { const asked: Array<{ url: string; redirect: unknown }> = []; return { asked, get: async (url: string, init: { redirect: 'follow' }) => { asked.push({ url, redirect: init.redirect }); return response; } }; };

    it('go over the network they are handed, and follow a redirect: a download is sent on to another origin, and its checksum is what is trusted', async () => {
        const net = answering(new Response('the-bytes'));
        expect(await httpFetchOver(net.get).text('https://windows.php.net/x')).toEqual({ ok: true, body: 'the-bytes' });
        expect(net.asked).toEqual([{ url: 'https://windows.php.net/x', redirect: 'follow' }]);
    });

    it('bytes are the bytes', async () => {
        const got = await httpFetchOver(answering(new Response(new Uint8Array([1, 2, 3]))).get).bytes('https://x/y');
        expect(got).toEqual({ ok: true, body: new Uint8Array([1, 2, 3]) });
    });

    it('an answer that is not ok, and a network that fails, are said, not thrown', async () => {
        expect(await httpFetchOver(answering(new Response('', { status: 404 })).get).text('https://x/y')).toEqual({ ok: false, error: 'HTTP 404' });
        expect(await httpFetchOver(async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); }).bytes('https://x/y')).toEqual({ ok: false, error: 'net::ERR_PROXY_CONNECTION_FAILED' });
    });
});

describe('wired through the window\'s network', () => {
    const main = readFileSync('src/main/main.ts', 'utf8');
    it('every toolchain and PHP download', () => {
        expect(main).toMatch(/const httpFetch = httpFetchOver\(\(url, init\) => net\.fetch\(url, init\)\);/);
    });
    it('the toolchain version index', () => {
        expect(main).toMatch(/latestIndex\(\{[^\n]*fetchJson: async \(url\) => \(await net\.fetch\(url\)\)\.json\(\)/);
    });
    it('the release notes are genie-host’s: the window no longer asks for them (Tynn #585)', () => {
        expect(main).not.toMatch(/api\.github\.com\/repos\/Renaissance-Analytics\/genie\/releases/);
        expect(readFileSync('src/main/genie-host.ts', 'utf8')).toMatch(/await send\('https:\/\/api\.github\.com\/repos\/Renaissance-Analytics\/genie\/releases\?per_page=100'/);
    });
    it('the Tailscale installer', () => {
        expect(main).toMatch(/installTailscale\(\{ download: \(url\) => net\.fetch\(url\) \}\)/);
    });
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
