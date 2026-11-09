import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_MANIFEST_FILE, PACKAGE_SIGNATURE_FILE, packageDigest, packageSigningBytes, publisherKeyId } from '../src/core/plugin-integrity.js';
import { readPackageFiles } from '../src/main/plugin-package.js';
import { extractMarketplaceArchive } from '../src/main/marketplace-archive.js';
import { hostHttpsFetch, type HostHttpsResponse } from '../src/main/host-https-fetch.js';
import { issueCa, issueLeaf } from '../src/main/x509.js';

// Resolve the future module inside test cases: absent behavior must fail running
// assertions, without stopping typecheck or test-file collection.
const modulePath = '../src/main/publish-plugin.js';
type UploadInit = { method: 'POST'; headers: Record<string, string>; body: Uint8Array; credentials: 'omit'; redirect: 'error'; signal: AbortSignal };
type Upload = (url: string, init: UploadInit) => Promise<Pick<HostHttpsResponse, 'ok' | 'status' | 'text'>>;
interface Options { dir: string; keyFile: string; tokenFile?: string; env?: NodeJS.ProcessEnv; origin?: string; timeoutMs?: number; fetch?: Upload }
interface Published { id: string; version: string; digest: string; keyId: string; created: boolean }
interface PublisherModule { publishPlugin(options: Options): Promise<Published>; runPublishCli(args: readonly string[], env: NodeJS.ProcessEnv, io: { out(line: string): void; error(line: string): void }): Promise<number> }
const load = async (): Promise<PublisherModule> => await import(/* @vite-ignore */ modulePath) as PublisherModule;
const pair = generateKeyPairSync('ed25519');
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyId = publisherKeyId(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
const token = 'mpt_01ARZ3NDEKTSV4RRFFQ69G5FAV.' + 'a4'.repeat(32);
const identity = { id: 'org.example.c5', name: 'C5 fixture', version: '1.2.3', publisher: { name: 'C5 publisher', keyId }, capabilities: { network: { hosts: [] }, genieApi: [] } };
let root: string, dir: string, keyFile: string, tokenFile: string;
let upload: ReturnType<typeof vi.fn<Upload>>;
const servers: Server[] = [];
const options = (): Options => ({ dir, keyFile, tokenFile, env: {}, fetch: upload });
async function accepted(status = 201): Promise<Pick<HostHttpsResponse, 'ok' | 'status' | 'text'>> {
    const read = await readPackageFiles(dir); if (!read.ok) throw new Error('fixture unreadable');
    return { ok: true, status, text: async () => JSON.stringify({ id: identity.id, version: { version: identity.version, digest: packageDigest(read.files), key_id: keyId } }) };
}
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-c5-publish-')); dir = join(root, 'package');
    keyFile = join(root, 'publisher.pem'); tokenFile = join(root, 'publisher.token');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify(identity));
    await writeFile(join(dir, 'nested', 'bytes.bin'), Buffer.from([0, 0xff, 0xfe, 0x80, 10]));
    await writeFile(join(dir, '.included'), 'dotfiles are signed too');
    await writeFile(keyFile, privatePem, { mode: 0o600 }); await writeFile(tokenFile, token + '\n', { mode: 0o600 });
    upload = vi.fn<Upload>().mockImplementation(async () => accepted());
});
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await rm(root, { recursive: true, force: true }); });

describe('C5 signed publisher upload', () => {
    it('sends the actual B4 ZIP snapshot over verified TLS without mutating the source or uploading secrets', async () => {
        const { publishPlugin } = await load();
        const now = Date.now(), ca = issueCa({ commonName: 'C5 test CA', organization: 'C5 tests', notBefore: new Date(now - 86400000), notAfter: new Date(now + 86400000) });
        const leaf = issueLeaf(ca, ['localhost'], new Date(now - 86400000), new Date(now + 86400000));
        let request: { path: string; authorization?: string; cookie?: string; contentType: string; bytes: Buffer } | undefined;
        const answer = await accepted();
        const server = createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
            const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk as Buffer)); req.on('end', () => {
                request = { path: req.url ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), contentType: req.headers['content-type'] ?? '', bytes: Buffer.concat(chunks) };
                void answer.text().then(body => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(body); });
            });
        });
        servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `https://localhost:${(server.address() as AddressInfo).port}`;
        const transport: Upload = (url, init) => hostHttpsFetch({ machineRoots: () => [ca.certPem], env: {}, maxResponseBytes: 65536 })(url, init);
        const result = await publishPlugin({ ...options(), origin, fetch: transport });
        expect(result).toMatchObject({ id: identity.id, version: identity.version, keyId, created: true });
        expect(request?.path).toBe('/api/v1/marketplace/publish'); expect(request?.authorization).toBe(`Bearer ${token}`); expect(request?.cookie).toBeUndefined();
        const boundary = /boundary=([A-Za-z0-9-]+)/.exec(request!.contentType)?.[1]; expect(boundary).toBeTruthy();
        const bytes = request!.bytes, start = bytes.indexOf(Buffer.from('\r\n\r\n')) + 4, end = bytes.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
        expect(bytes.subarray(0, start).toString()).toMatch(/name="archive"; filename="plugin.zip"/);
        const zip = join(root, 'received.zip'), extracted = join(root, 'received'); await writeFile(zip, bytes.subarray(start, end)); await mkdir(extracted);
        await extractMarketplaceArchive(zip, extracted, new AbortController().signal);
        const read = await readPackageFiles(extracted); expect(read.ok).toBe(true); if (!read.ok) throw new Error(read.reason);
        expect(read.files.map(file => file.path).sort()).toEqual(['.included', PACKAGE_MANIFEST_FILE, 'genie-plugin.sig', 'nested/bytes.bin']);
        const digest = packageDigest(read.files), signature = read.files.find(file => file.path === PACKAGE_SIGNATURE_FILE)!.bytes;
        expect(verify(null, packageSigningBytes(digest), pair.publicKey, Buffer.from(signature.toString().trim(), 'base64'))).toBe(true);
        expect(digest).toBe(result.digest); expect(await readFile(join(extracted, 'nested/bytes.bin'))).toEqual(Buffer.from([0, 0xff, 0xfe, 0x80, 10]));
        expect(await readdir(dir)).not.toContain(PACKAGE_SIGNATURE_FILE);
        for (const file of read.files) { expect(file.bytes.includes(Buffer.from(privatePem))).toBe(false); expect(file.bytes.includes(Buffer.from(token))).toBe(false); }
    });
    it('accepts an identical retry without modifying an existing source signature', async () => {
        const { publishPlugin } = await load(); await writeFile(join(dir, PACKAGE_SIGNATURE_FILE), 'old detached signature'); upload.mockImplementation(() => accepted(200));
        expect(await publishPlugin(options())).toMatchObject({ created: false }); expect(await readFile(join(dir, PACKAGE_SIGNATURE_FILE), 'utf8')).toBe('old detached signature');
    });
    it('requires the canonical manifest and refuses an old-only package without fallback', async () => {
        const { publishPlugin } = await load(); await publishPlugin(options()); expect(upload).toHaveBeenCalledTimes(1);
        await rename(join(dir, PACKAGE_MANIFEST_FILE), join(dir, 'genie-plugin.json'));
        await expect(publishPlugin(options())).rejects.toThrow(/manifest|genie-package/i); expect(upload).toHaveBeenCalledTimes(1);
    });
    it('accepts a dedicated environment token without a token file', async () => {
        const { publishPlugin } = await load(); const input = options(); delete input.tokenFile;
        await publishPlugin({ ...input, env: { GENIE_PUBLISH_TOKEN: token } }); expect(upload.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${token}`);
    });
    it.each(['missing', 'project token', 'Genie token', 'wrong format'])('refuses %s credentials before network access', async state => {
        const { publishPlugin } = await load(); const input = options(); delete input.tokenFile;
        const value = state === 'missing' ? '' : state === 'project token' ? 'rpk_fixture.secret' : state === 'Genie token' ? 'genie_fixture.secret' : 'mpt_incomplete';
        await expect(publishPlugin({ ...input, env: { GENIE_PUBLISH_TOKEN: value } })).rejects.toThrow(/publishing token|publisher token/i); expect(upload).not.toHaveBeenCalled();
    });
    it.each(['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org?token=x', 'https://example.org#x'])('refuses a non-origin credential destination %s', async origin => {
        const { publishPlugin } = await load(); await expect(publishPlugin({ ...options(), origin })).rejects.toThrow(/HTTPS origin/i); expect(upload).not.toHaveBeenCalled();
    });
    it.each(['key file', 'token file', 'private key copy', 'token copy'])('keeps %s out of the signed package', async state => {
        const { publishPlugin } = await load(); const input = options();
        if (state === 'key file') { input.keyFile = join(dir, 'secret.pem'); await writeFile(input.keyFile, privatePem); }
        if (state === 'token file') { input.tokenFile = join(dir, 'secret.token'); await writeFile(input.tokenFile, token); }
        if (state === 'private key copy') await writeFile(join(dir, 'copied.pem'), privatePem);
        if (state === 'token copy') await writeFile(join(dir, 'copied.token'), token);
        await expect(publishPlugin(input)).rejects.toThrow(/secret|credential|private key/i); expect(upload).not.toHaveBeenCalled();
    });
    it.each(['mismatched key', 'invalid manifest', 'not Ed25519'])('refuses %s before upload', async state => {
        const { publishPlugin } = await load();
        if (state === 'mismatched key') await writeFile(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify({ ...identity, publisher: { ...identity.publisher, keyId: 'sha256:' + '0'.repeat(64) } }));
        if (state === 'invalid manifest') await writeFile(join(dir, PACKAGE_MANIFEST_FILE), '{');
        if (state === 'not Ed25519') await writeFile(keyFile, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
        await expect(publishPlugin(options())).rejects.toThrow(/manifest|key|Ed25519/i); expect(upload).not.toHaveBeenCalled();
    });
    it('refuses links rather than archiving their targets', async () => {
        const { publishPlugin } = await load(); await symlink(root, join(dir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(publishPlugin(options())).rejects.toThrow(/package|link/i); expect(upload).not.toHaveBeenCalled();
    });
    it.each([401, 403, 404, 409, 422, 429, 503])('reports registry refusal HTTP%s without echoing its body', async status => {
        const { publishPlugin } = await load(); upload.mockResolvedValue({ ok: false, status, text: async () => privatePem + token });
        const error = await publishPlugin(options()).catch(failure => failure as Error); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(new RegExp(`HTTP${status}`)); expect((error as Error).message).not.toContain(token); expect((error as Error).message).not.toContain(privatePem);
    });
    it.each(['wrong digest', 'wrong id', 'invalid JSON', 'oversized response'])('refuses %s in an apparent success', async state => {
        const { publishPlugin } = await load(), good = JSON.parse(await (await accepted()).text()) as { id: string; version: { digest: string } };
        if (state === 'wrong digest') good.version.digest = '0'.repeat(64); if (state === 'wrong id') good.id = 'org.example.other';
        upload.mockResolvedValue({ ok: true, status: 201, text: async () => state === 'invalid JSON' ? '{' : state === 'oversized response' ? 'x'.repeat(65537) : JSON.stringify(good) });
        await expect(publishPlugin(options())).rejects.toThrow(/response|confirmation|limit/i);
    });
    it('aborts a stalled upload at its deadline', async () => {
        const { publishPlugin } = await load(); upload.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
        await expect(publishPlugin({ ...options(), timeoutMs: 30 })).rejects.toThrow(/upload|deadline|timed out/i);
    });
    it('passes binary multipart with cookie omission and redirect refusal', async () => {
        const { publishPlugin } = await load(); await publishPlugin(options());
        expect(upload).toHaveBeenCalledTimes(1); const [url, init] = upload.mock.calls[0]!;
        expect(url).toBe('https://tynn.ai/api/v1/marketplace/publish'); expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
        expect(init.body).toBeInstanceOf(Uint8Array); expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.headers).not.toHaveProperty('Cookie');
    });
});

describe('C5 CLI entry and secret-safe failures', () => {
    it.each([['--token', token], ['--key', privatePem], ['--unknown', 'value']])('refuses unsupported secret argv option %s without echoing values', async (...args) => {
        const { runPublishCli } = await load(), out: string[] = [], error: string[] = [];
        expect(await runPublishCli(args, {}, { out: line => out.push(line), error: line => error.push(line) })).toBe(1);
        expect(error.join()).toMatch(/usage|option|argument/i); expect([...out, ...error].join()).not.toContain(token); expect([...out, ...error].join()).not.toContain(privatePem);
    });
    it('runs the actual plain Node help entry through the existing tsx dependency', async () => {
        const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/publish-plugin.ts', '--help'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
            child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; }); child.once('error', reject); child.once('exit', code => resolve({ code, text }));
        });
        expect(result.code).toBe(0); expect(result.text).toMatch(/publish:plugin/); expect(result.text).toMatch(/--key-file/); expect(result.text).toMatch(/--token-file/);
    });
});
