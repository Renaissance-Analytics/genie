import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE_LIMITS, PACKAGE_SIGNATURE_FILE, packageDigest, packageLimitProblem, packageListing, packageSigningBytes, publisherKeyId } from '../src/core/plugin-integrity.js';
import { readPackageFiles } from '../src/main/plugin-package.js';
import { pluginTools } from '../src/main/mcp-tools-plugins.js';
import { PluginHost } from '../src/main/plugin-host.js';
import { renderSdkDocs } from '../src/core/sdk-docs.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * ADF B4 (Tynn #454; spec .ai/plans/specs/adf-sdk.md, story B4): CODE INTEGRITY. The owner's ruling: signed packages
 * only. A package's signature covers EVERY file in it, not the manifest alone: a digest over the sorted list of each
 * file's path and SHA-256, signed with Ed25519. It is checked when Genie loads its plugins and again before each run of
 * a signed package's tool, so a file changed, added or removed after signing is refused as tampered, with publisher
 * checks (developer mode) on or off. An unsigned package under developer mode is a person's own work in progress: it is
 * not re-checked before each run.
 */
const pair = generateKeyPairSync('ed25519');
const PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
// C1's key id (Tynn marketplace): `sha256:` + lowercase hex SHA-256 over the key's whole SPKI DER.
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: PEM };
const MANIFEST = JSON.stringify({
    id: 'com.example.notes', name: 'Notes', version: '1.0.0', publisher: { name: 'Example Co', keyId: KEY_ID },
    mcpTools: [{ name: 'append', description: 'Append a note.', inputSchema: { type: 'object' }, run: 'tools.cjs', process: 'subprocess', gated: false }],
    capabilities: { network: { hosts: [] }, genieApi: [] },
});
const TOOLS = "module.exports = { append: async () => 'ok' };\n";

let dir: string;
let plugins: string;
let pkg: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-b4-'));
    plugins = join(dir, 'plugins');
    pkg = join(plugins, 'notes');
    await mkdir(join(pkg, 'lib'), { recursive: true });
    await writeFile(join(pkg, 'genie-plugin.json'), MANIFEST);
    await writeFile(join(pkg, 'tools.cjs'), TOOLS);
    await writeFile(join(pkg, 'lib', 'format.cjs'), 'module.exports = (s) => s.trim();\n');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const open = (publisherChecksOff: boolean) => PluginHost.open({ dir: plugins, keys, publisherChecksOff });
const stateOf = async (publisherChecksOff: boolean) => (await open(publisherChecksOff)).list().find((p) => p.id === 'com.example.notes' || p.folder === 'notes');
const flipOneByte = async (file: string) => {
    const bytes = await readFile(file);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(file, bytes);
};

describe('a signed package: the signature covers every file', () => {
    it('signed and untouched, it loads, labelled with its signer', async () => {
        await signPackage(pkg, pair.privateKey);
        expect(await stateOf(false)).toMatchObject({ state: 'enabled', label: `signed by ${KEY_ID}` });
    });

    it('ONE BYTE of tools.cjs changed after signing: refused as tampered, with publisher checks on AND off', async () => {
        await signPackage(pkg, pair.privateKey);
        await flipOneByte(join(pkg, 'tools.cjs'));
        for (const publisherChecksOff of [false, true]) {
            const entry = await stateOf(publisherChecksOff);
            expect(entry, `publisherChecksOff ${publisherChecksOff}`).toMatchObject({ state: 'refused', label: null });
            expect(entry!.reason).toMatch(/tampered/);
        }
    });

    it('a file added, a file removed, or the manifest edited after signing: each refused as tampered', async () => {
        await signPackage(pkg, pair.privateKey);
        await writeFile(join(pkg, 'lib', 'extra.cjs'), 'module.exports = 1;\n');
        expect((await stateOf(true))!.reason).toMatch(/tampered/);
        await unlink(join(pkg, 'lib', 'extra.cjs'));
        expect((await stateOf(false))!.state).toBe('enabled');
        await unlink(join(pkg, 'lib', 'format.cjs'));
        expect((await stateOf(true))!.reason).toMatch(/tampered/);
        await writeFile(join(pkg, 'lib', 'format.cjs'), 'module.exports = (s) => s.trim();\n');
        expect((await stateOf(false))!.state).toBe('enabled');
        await writeFile(join(pkg, 'genie-plugin.json'), MANIFEST.replace('"Notes"', '"Notez"'));
        expect((await stateOf(true))!.reason).toMatch(/tampered/);
    });

    it('a signature over the manifest bytes alone (the old form) does not cover the package: refused as tampered', async () => {
        await writeFile(join(pkg, PACKAGE_SIGNATURE_FILE), sign(null, Buffer.from(MANIFEST), pair.privateKey).toString('base64'));
        for (const publisherChecksOff of [false, true]) expect((await stateOf(publisherChecksOff))!.reason, `publisherChecksOff ${publisherChecksOff}`).toMatch(/tampered/);
    });

    it('CONTROL: unsigned under developer mode loads, labelled UNSIGNED; without it, refused as unsigned, not as tampered', async () => {
        expect(await stateOf(true)).toMatchObject({ state: 'enabled', label: 'Unverified' });
        const refused = await stateOf(false);
        expect(refused!.state).toBe('refused');
        expect(refused!.reason).toMatch(/^unsigned plugins are not installed/);
        expect(refused!.reason).not.toMatch(/tampered/);
    });
});

describe('checked again before each run of a signed package\'s tool', () => {
    const caller = { agentId: 'a', agentName: 'atlas', workspaceId: 'ws', workspacePath: dir } as unknown as Caller;
    const toolFor = (host: PluginHost, ran: string[]) => pluginTools({
        plugins: { tools: () => host.tools(), guard: (id) => host.guard(id) },
        run: async (input) => { ran.push(input.tool.name); return { ok: true, result: 'ran' }; },
        approve: async () => 'allowed',
        resolveCaller: () => caller,
    })[0]!;

    it('tools.cjs changed after Genie loaded the package: the call is refused as tampered, the code never runs, and the package is refused from then on', async () => {
        await signPackage(pkg, pair.privateKey);
        const host = await open(false);
        const ran: string[] = [];
        const tool = toolFor(host, ran);
        const first = await tool.handler({ terminalId: 't' }, { server: 'genie', tool: tool.definition.name, headers: {} });
        expect(first.isError).toBe(false);
        expect(ran).toEqual(['append']);

        await flipOneByte(join(pkg, 'tools.cjs'));
        const second = await tool.handler({ terminalId: 't' }, { server: 'genie', tool: tool.definition.name, headers: {} });
        expect(second.isError).toBe(true);
        expect(second.text).toMatch(/tampered/);
        expect(ran).toEqual(['append']);
        expect(host.list().find((p) => p.id === 'com.example.notes')).toMatchObject({ state: 'refused', reason: expect.stringMatching(/tampered/) });
        expect(host.guard('com.example.notes')).toBeNull();
    });

    it('CONTROL: an unsigned package under developer mode is the person\'s own work in progress: edited, it still runs', async () => {
        const host = await open(true);
        const ran: string[] = [];
        const tool = toolFor(host, ran);
        await writeFile(join(pkg, 'tools.cjs'), "module.exports = { append: async () => 'edited' };\n");
        const r = await tool.handler({ terminalId: 't' }, { server: 'genie', tool: tool.definition.name, headers: {} });
        expect(r.isError).toBe(false);
        expect(ran).toEqual(['append']);
    });
});

describe('the format (genie-package/1), as the Tynn marketplace checks it too', () => {
    it('a key id is C1\'s: sha256 over the SPKI DER, from the PEM, whatever its line wrapping', () => {
        expect(publisherKeyId(PEM)).toBe(KEY_ID);
        expect(publisherKeyId(PEM.replace(/\n/g, '\r\n'))).toBe(KEY_ID);
        expect(KEY_ID).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('the signed bytes are `genie-package/1 sha256:<digest>` and a newline, ASCII', () => {
        const digest = 'a'.repeat(64);
        expect(packageSigningBytes(digest).toString('latin1')).toBe(`genie-package/1 sha256:${digest}\n`);
    });

    it('a key Genie holds under an id that is not its fingerprint is not trusted: refused, naming the key', async () => {
        const other = generateKeyPairSync('ed25519');
        const mislabelled = { [KEY_ID]: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
        await signPackage(pkg, other.privateKey);
        const host = await PluginHost.open({ dir: plugins, keys: mislabelled, publisherChecksOff: false });
        const entry = host.list().find((p) => p.id === 'com.example.notes');
        expect(entry!.state).toBe('refused');
        expect(entry!.reason).toMatch(/is not the fingerprint of the key/);
    });
});

describe('the limits (approved with the format): refused before any hashing, in words', () => {
    const entry = (path: string, size: number) => ({ path, size });

    it('are 10,000 files, 200 MB in all, 50 MB a file and 1,024 bytes a path', () => {
        expect(PACKAGE_LIMITS).toEqual({ files: 10_000, totalBytes: 200 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, pathBytes: 1024 });
    });

    it('each limit, one past it, is refused naming it; at the limit, nothing is', () => {
        const MB = 1024 * 1024;
        expect(packageLimitProblem(Array.from({ length: 10_000 }, (_, i) => entry(`f${i}`, 1)))).toBeNull();
        expect(packageLimitProblem(Array.from({ length: 10_001 }, (_, i) => entry(`f${i}`, 1)))).toMatch(/10,001 files.*at most 10,000/);
        expect(packageLimitProblem([entry('big.bin', 50 * MB)])).toBeNull();
        expect(packageLimitProblem([entry('big.bin', 50 * MB + 1)])).toMatch(/big\.bin is .* at most 50 MB a file/);
        const fiveOf40 = Array.from({ length: 5 }, (_, i) => entry(`part${i}.bin`, 40 * MB));
        expect(packageLimitProblem(fiveOf40)).toBeNull();
        expect(packageLimitProblem([...fiveOf40, entry('one-more', 1)])).toMatch(/at most 200 MB in all/);
        expect(packageLimitProblem([entry(`${'a'.repeat(1024)}`, 1)])).toBeNull();
        expect(packageLimitProblem([entry(`${'a'.repeat(1025)}`, 1)])).toMatch(/a path of 1,025 bytes.*at most 1,024/);
        // Bytes, not characters: 512 two-byte characters is 1,024 bytes; 513 is over.
        expect(packageLimitProblem([entry('é'.repeat(512), 1)])).toBeNull();
        expect(packageLimitProblem([entry('é'.repeat(513), 1)])).toMatch(/1,026 bytes/);
    });

    it('a package with a file past 50 MB is refused before it is read: the reason says why, and nothing was hashed', async () => {
        await truncate(join(pkg, 'tools.cjs'), 50 * 1024 * 1024 + 1).catch(async () => { await writeFile(join(pkg, 'tools.cjs'), ''); await truncate(join(pkg, 'tools.cjs'), 50 * 1024 * 1024 + 1); });
        let reads = 0;
        const r = await readPackageFiles(pkg, { onRead: () => { reads++; } });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/tools\.cjs is .* at most 50 MB a file/);
        expect(reads).toBe(0);
        const entry = await stateOf(true);
        expect(entry!.state).toBe('refused');
        expect(entry!.reason).toMatch(/at most 50 MB a file/);
    });
});

describe('docs/sdk/packages.md: the format, generated from the code that checks it', () => {
    it('states the files, the order, the line, the signed bytes, the key id and the limits; the index links to it', () => {
        const docs = renderSdkDocs();
        const page = docs.get('packages.md');
        expect(page).toBeDefined();
        expect(page).toContain('genie-package/1');
        expect(page).toContain(PACKAGE_SIGNATURE_FILE);
        expect(page).toContain('<lowercase hex SHA-256 of the file\'s bytes><two spaces><path>');
        expect(page).toContain('genie-package/1 sha256:<digest>');
        expect(page).toMatch(/UTF-8 bytes of their paths/);
        expect(page).toMatch(/`sha256:` followed by the lowercase hex SHA-256 of the key's whole SPKI DER/);
        expect(page).toContain('at most 10,000 files');
        expect(page).toContain('at most 200 MB in all');
        expect(page).toContain('at most 50 MB a file');
        expect(page).toContain('at most 1,024 bytes');
        expect(page).toMatch(/tampered/);
        expect(docs.get('README.md')).toContain('(packages.md)');
    });
});

describe('the digest', () => {
    const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });

    it('lists every file by path and SHA-256, sorted, without the signature file; the order files were read in does not matter', () => {
        const a = [file('tools.cjs', 'x'), file('genie-plugin.json', '{}'), file('lib/a.cjs', 'y'), file(PACKAGE_SIGNATURE_FILE, 'sig')];
        const b = [a[2]!, a[3]!, a[0]!, a[1]!];
        expect(packageListing(a).split('\n').filter(Boolean).map((l) => l.split('  ')[1])).toEqual(['genie-plugin.json', 'lib/a.cjs', 'tools.cjs']);
        expect(packageDigest(a)).toBe(packageDigest(b));
        expect(packageDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a renamed file, or moved bytes between two files, is a different digest', () => {
        const base = [file('a.cjs', 'one'), file('b.cjs', 'two')];
        expect(packageDigest([file('a2.cjs', 'one'), file('b.cjs', 'two')])).not.toBe(packageDigest(base));
        expect(packageDigest([file('a.cjs', 'onet'), file('b.cjs', 'wo')])).not.toBe(packageDigest(base));
    });

    it('a package holding a link is refused: a package is plain files only', async (ctx) => {
        try {
            await symlink(join(dir, 'elsewhere'), join(pkg, 'lib', 'link'));
        } catch (error) {
            // This machine does not let a test make links (Windows without the privilege). SKIPPED, visibly, so a run says
            // it did not prove this, rather than passing as if it had.
            ctx.skip(`no link could be made here: ${(error as Error).message}`);
            return;
        }
        await signPackage(pkg, pair.privateKey).catch(() => undefined);
        const entry = await stateOf(true);
        expect(entry!.state).toBe('refused');
        expect(entry!.reason).toMatch(/link/);
    });
});
