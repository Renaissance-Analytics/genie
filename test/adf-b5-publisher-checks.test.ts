import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { pluginTools } from '../src/main/mcp-tools-plugins.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { PluginHost } from '../src/main/plugin-host.js';
import { localPluginTools } from '../src/main/plugins-host.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * ADF B5 (Tynn #455; spec .ai/plans/specs/adf-sdk.md, story B5): "TURN OFF PUBLISHER CHECKS". The owner's ruling: signed
 * packages only, with a switch the person turns off at their own risk. Decision 4 (2026-11-07): an unsigned package then
 * runs, labelled **Unverified**, with NO network until the person allows it for that package; a signature that does
 * not verify is refused either way (B4).
 *
 * The switch is the `publisher_checks_off` setting (it replaces developer mode, whose name said nothing of the risk). The
 * renderer's confirm and banner: test/adf-b5-plugins-page.test.tsx.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };

/** A tool that fetches the URL it is given and answers what happened: `ok`, or the error's code. */
const FETCH_TOOL = `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.once('line', async (line) => {
    const { call } = JSON.parse(line);
    let outcome;
    try { outcome = await (await fetch(call.args.url)).text(); } catch (e) { outcome = String((e && (e.code || (e.cause && e.cause.code))) || e); }
    process.stdout.write(JSON.stringify({ result: outcome }) + '\\n');
    process.exit(0);
});
`;
const manifest = (id: string, signed: boolean) => JSON.stringify({
    id, name: id.split('.').pop(), version: '1.0.0', publisher: { name: 'Example Co', keyId: signed ? KEY_ID : 'sha256:unknown' },
    mcpTools: [{ name: 'probe', description: 'Fetch a URL.', inputSchema: { type: 'object' }, run: 'tool.mjs', process: 'subprocess', gated: false }],
    capabilities: { network: { hosts: ['127.0.0.1'] }, genieApi: [] },
});

let dir: string;
let plugins: string;
let server: Server;
let url = '';
beforeAll(async () => {
    server = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(async () => { await new Promise<void>((ok) => server.close(() => ok())); });
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-b5-'));
    plugins = join(dir, 'plugins');
    for (const [folder, id, signed] of [['local', 'com.example.local', false], ['signed', 'com.example.signed', true]] as const) {
        await mkdir(join(plugins, folder), { recursive: true });
        await writeFile(join(plugins, folder, 'genie-package.json'), manifest(id, signed));
        await writeFile(join(plugins, folder, 'tool.mjs'), FETCH_TOOL);
        if (signed) await signPackage(join(plugins, folder), pair.privateKey);
    }
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const open = (publisherChecksOff: boolean) => PluginHost.open({ dir: plugins, keys, publisherChecksOff });
const entry = (host: PluginHost, id: string) => host.list().find((p) => p.id === id);

describe('the switch', () => {
    it('is the publisher_checks_off setting, worded for its risk, off by default; developer mode is gone', () => {
        const setting = SETTINGS.find((s) => s.key === 'publisher_checks_off');
        expect(setting).toMatchObject({ label: 'Turn off publisher checks', type: 'boolean', default: false });
        expect(setting!.description).toMatch(/unsigned or unknown publishers can run code on this machine/i);
        expect(SETTINGS.some((s) => s.key === 'developer_mode')).toBe(false);
    });
});

describe('publisher checks ON (the default): signed packages only', () => {
    it('an unsigned package is refused, saying how to run it and at whose risk', async () => {
        const host = await open(false);
        expect(entry(host, 'com.example.local')).toMatchObject({ state: 'refused', label: null });
        expect(entry(host, 'com.example.local')!.reason).toMatch(/^unsigned plugins are not installed: .*turn off publisher checks/);
        expect(entry(host, 'com.example.signed')).toMatchObject({ state: 'enabled', label: `signed by ${KEY_ID}`, unverified: false });
    });
});

describe('publisher checks OFF: an unsigned package runs, Unverified, with no network until allowed', () => {
    it('it runs, labelled Unverified', async () => {
        const host = await open(true);
        expect(entry(host, 'com.example.local')).toMatchObject({ state: 'enabled', label: 'Unverified', unverified: true, networkHosts: ['127.0.0.1'], networkAllowed: false });
        // A signed package is not Unverified, and needs no allowing: its declared hosts are its own.
        expect(entry(host, 'com.example.signed')).toMatchObject({ unverified: false, networkAllowed: true });
    });

    it('its network is refused by name until the person allows it for that package; allowed, persisted; taken back, refused again', async () => {
        const host = await open(true);
        const asked = { kind: 'network' as const, host: '127.0.0.1' };
        const refused = host.guard('com.example.local')!(asked);
        expect(refused).toMatchObject({ allowed: false });
        if (!refused.allowed) expect(refused.reason).toMatch(/Unverified.*no network until you allow it.*Settings → Plugins/);
        expect(host.capabilities('com.example.local')?.network.hosts).toEqual([]);

        expect(await host.setNetworkAllowed('com.example.local', true)).toBe(true);
        expect(host.guard('com.example.local')!(asked)).toEqual({ allowed: true });
        expect(host.capabilities('com.example.local')?.network.hosts).toEqual(['127.0.0.1']);
        const again = await open(true);
        expect(entry(again, 'com.example.local')).toMatchObject({ networkAllowed: true });

        await again.setNetworkAllowed('com.example.local', false);
        expect(again.guard('com.example.local')!(asked)).toMatchObject({ allowed: false });
        // CONTROL: the signed package's declared host is allowed with no allowing.
        expect(again.guard('com.example.signed')!(asked)).toEqual({ allowed: true });
        // Nothing to allow on a signed package or an unknown one.
        expect(await again.setNetworkAllowed('com.example.signed', true)).toBe(false);
        expect(await again.setNetworkAllowed('com.nobody', true)).toBe(false);
    });

    it('END TO END: its tool\'s real fetch, in its sandboxed process, is refused until allowed, then reaches the host', async () => {
        const host = await open(true);
        const caller = { agentId: 'a', agentName: 'atlas', workspaceId: 'ws', workspacePath: dir } as unknown as Caller;
        const source = localPluginTools({ tools: () => host.tools(), guard: (id) => host.guard(id), capabilities: (id) => host.capabilities(id) }, { sandboxDir: join(dir, 'sandbox'), api: async () => null });
        // Registered ONCE, as the MCP server does: an allowance given later must still reach the run.
        const tools = pluginTools({ plugins: source, run: source.run, approve: async () => 'allowed', resolveCaller: () => caller });
        const tool = tools.find((t) => t.definition.name === 'com.example.local.probe')!;
        const call = async () => {
            const r = await tool.handler({ terminalId: 't', url }, { server: 'genie', tool: tool.definition.name, headers: {} });
            return r.text;
        };
        expect(await call()).toContain('ERR_GENIE_NETWORK_DENIED');
        await host.setNetworkAllowed('com.example.local', true);
        expect(await call()).toContain('ok');
        expect(await call()).not.toContain('ERR_GENIE_NETWORK_DENIED');
    }, 60_000);
});

describe('a signature that does not verify is refused with the switch on or off (B4)', () => {
    it('one byte of the signed package changed: refused as tampered, both ways', async () => {
        await writeFile(join(plugins, 'signed', 'tool.mjs'), `${FETCH_TOOL}// changed\n`);
        for (const off of [false, true]) {
            const host = await open(off);
            expect(entry(host, 'com.example.signed'), `publisher checks off: ${off}`).toMatchObject({ state: 'refused' });
            expect(entry(host, 'com.example.signed')!.reason).toMatch(/tampered/);
        }
    });
});
