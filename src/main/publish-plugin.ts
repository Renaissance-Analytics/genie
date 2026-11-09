import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import yazl from 'yazl';
import { compareMarketplaceVersions } from '../core/marketplace.js';
import { PACKAGE_MANIFEST_FILE, PACKAGE_SIGNATURE_FILE, packageDigest, packageLimitProblem, packageSigningBytes, publisherKeyId, type PackageFile } from '../core/plugin-integrity.js';
import { parseManifest } from '../core/plugins.js';
import { hostHttpsFetch, type HostHttpsResponse } from './host-https-fetch.js';
import { readPackageFiles } from './plugin-package.js';

const RESPONSE_BYTES = 64 * 1024;
const ARCHIVE_BYTES = 256 * 1024 * 1024;
const TOKEN = /^mpt_[0-7][0-9A-HJKMNP-TV-Z]{25}\.[a-f0-9]{64}$/;
interface UploadInit { method: 'POST'; headers: Record<string, string>; body: Uint8Array; credentials: 'omit'; redirect: 'error'; signal: AbortSignal }
type Upload = (url: string, init: UploadInit) => Promise<Pick<HostHttpsResponse, 'ok' | 'status' | 'text'>>;
export interface PublishPluginOptions { dir: string; keyFile: string; tokenFile?: string; env?: NodeJS.ProcessEnv; origin?: string; timeoutMs?: number; fetch?: Upload }
export interface PublishedPlugin { id: string; version: string; digest: string; keyId: string; created: boolean }
class PublishProblem extends Error {}
function refuse(message: string): never { throw new PublishProblem(message); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function originOf(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
    } catch { /* Never echo a URL which might contain a credential. */ }
    return refuse('The publishing destination must be an HTTPS origin without credentials, path, query or fragment.');
}
function inside(root: string, path: string): boolean {
    const child = relative(root, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
async function secretFile(path: string, root: string, limit: number): Promise<Buffer> {
    const canonical = await realpath(path);
    if (inside(root, canonical)) refuse('Keep private key and credential files outside the package directory.');
    const file = await open(canonical, 'r');
    try {
        const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) refuse('Invalid secret file type or size.');
        const bytes = Buffer.alloc(limit + 1); let length = 0;
        while (length <= limit) {
            const part = await file.read(bytes, length, bytes.length - length, null);
            if (!part.bytesRead) break; length += part.bytesRead;
        }
        if (length === 0 || length > limit) refuse('Invalid secret file size.');
        return bytes.subarray(0, length);
    } finally { await file.close(); }
}
async function zipSnapshot(files: readonly PackageFile[], signature: Buffer): Promise<Buffer> {
    const zip = new yazl.ZipFile(), chunks: Buffer[] = []; let size = 0;
    const done = new Promise<Buffer>((resolve, reject) => {
        zip.on('error', reject); zip.outputStream.on('error', reject);
        zip.outputStream.on('data', (bytes: Buffer) => {
            size += bytes.length;
            if (size > ARCHIVE_BYTES) { (zip.outputStream as Readable).destroy(new Error('Package archive exceeds its size limit.')); return; }
            chunks.push(bytes);
        });
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const settings = { mode: 0o100644, mtime: new Date('2000-01-01T00:00:00Z') };
    for (const file of files) zip.addBuffer(file.bytes, file.path, settings);
    zip.addBuffer(signature, PACKAGE_SIGNATURE_FILE, settings); zip.end(); return done;
}

/** A bounded immutable B4 snapshot; signing never writes a source file or uploads a private key. */
export async function publishPlugin(options: PublishPluginOptions): Promise<PublishedPlugin> {
    try { return await publish(options); }
    catch (error) {
        if (error instanceof PublishProblem) throw error;
        // File, crypto, ZIP and transport exceptions can contain paths, inputs or reflected response data.
        return refuse('Publishing could not be prepared. Check the package, private key file and publisher token file.');
    }
}
async function publish(options: PublishPluginOptions): Promise<PublishedPlugin> {
    const origin = originOf(options.origin ?? 'https://tynn.ai');
    const timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120000) refuse('The upload deadline must be between 1 and 120000 milliseconds.');
    const root = await realpath(options.dir); if (!(await lstat(root)).isDirectory()) refuse('Choose a package directory.');
    const keyBytes = await secretFile(options.keyFile, root, 16 * 1024);
    let key: KeyObject;
    try { key = createPrivateKey(keyBytes); } catch { return refuse('Use a valid Ed25519 private key in a local PEM file.'); }
    if (key.asymmetricKeyType !== 'ed25519') refuse('Use an Ed25519 private key.');
    const env = options.env ?? process.env;
    const token = (options.tokenFile ? (await secretFile(options.tokenFile, root, 4096)).toString('utf8') : env.GENIE_PUBLISH_TOKEN ?? '').trim();
    if (!TOKEN.test(token)) refuse('A dedicated publisher publishing token is required; use a token file or GENIE_PUBLISH_TOKEN.');
    let snapshot: Awaited<ReturnType<typeof readPackageFiles>>;
    try { snapshot = await readPackageFiles(root); } catch { return refuse('Package files could not be read safely; check links, paths and B4 limits.'); }
    if (!snapshot.ok) refuse('Package files were refused; check links, paths and B4 limits.');
    if (packageLimitProblem(snapshot.files.map(file => ({ path: file.path, size: file.bytes.length })))) refuse('Package files exceed the B4 size, count or path limits.');
    const files = snapshot.files.filter(file => file.path !== PACKAGE_SIGNATURE_FILE);
    const privateDer = key.export({ type: 'pkcs8', format: 'der' });
    for (const file of files) {
        if (file.bytes.includes(keyBytes) || file.bytes.includes(privateDer) || file.bytes.includes('PRIVATE KEY-----') || file.bytes.includes(token)) refuse('Package contains private key or credential material; remove the secret before publishing.');
    }
    const manifestFile = files.find(file => file.path === PACKAGE_MANIFEST_FILE); if (!manifestFile) refuse(`Package root needs ${PACKAGE_MANIFEST_FILE}.`);
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes)); } catch { return refuse('The package manifest must be valid UTF-8 JSON.'); }
    const parsed = parseManifest(raw); if (!parsed.ok) refuse('The package manifest is invalid; check it against the Genie manifest contract.');
    const manifest = parsed.manifest;
    try { compareMarketplaceVersions(manifest.version, manifest.version); } catch { return refuse('The package manifest needs a valid SemVer version.'); }
    const keyId = publisherKeyId(createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString());
    if (manifest.publisher.keyId !== keyId) refuse('The manifest publisher keyId must match this Ed25519 signing key. Register its public key with Tynn first.');
    const digest = packageDigest(files);
    const zip = await zipSnapshot(files, Buffer.from(sign(null, packageSigningBytes(digest), key).toString('base64')));
    const boundary = `genie-publish-${randomBytes(24).toString('hex')}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="plugin.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload = options.fetch ?? hostHttpsFetch({ maxResponseBytes: RESPONSE_BYTES });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Upload deadline exceeded')), timeout); deadline.unref();
    try {
        let response: Awaited<ReturnType<Upload>>;
        try {
            response = await upload(`${origin}/api/v1/marketplace/publish`, { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) }, body, credentials: 'omit', redirect: 'error', signal: controller.signal });
        } catch { return refuse('Package upload failed or timed out. Check HTTPS trust, connectivity and the registry address; redirects are refused.'); }
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) refuse('Invalid registry confirmation response.');
        if (!response.ok || (response.status !== 200 && response.status !== 201)) refuse(`Registry refused publication (HTTP${response.status}). Check the publisher token, verified publisher, registered active signing key, archive and immutable version.`);
        let text: string;
        try { text = await response.text(); } catch { return refuse('Registry confirmation could not be read or exceeds the response limit.'); }
        if (Buffer.byteLength(text) > RESPONSE_BYTES) refuse('Registry confirmation exceeds the response size limit.');
        let confirmation: unknown;
        try { confirmation = JSON.parse(text); } catch { return refuse('Registry confirmation response is not valid JSON.'); }
        if (!record(confirmation) || confirmation.id !== manifest.id || !record(confirmation.version) || confirmation.version.version !== manifest.version
            || confirmation.version.digest !== digest || confirmation.version.key_id !== keyId) refuse('Registry confirmation does not match the signed package id, version, digest and key.');
        return { id: manifest.id, version: manifest.version, digest, keyId, created: response.status === 201 };
    } finally { clearTimeout(deadline); controller.abort(); }
}

const USAGE = 'Usage: npm run publish:plugin -- <package-dir> --key-file <private.pem> [--token-file <publisher.token>] [--origin <https-origin>]\nUse Account → Publishers to mint a publish-only token. GENIE_PUBLISH_TOKEN may supply it instead of a file. Secrets are never accepted as command-line values.';
export async function runPublishCli(args: readonly string[], env: NodeJS.ProcessEnv, io: { out(line: string): void; error(line: string): void }): Promise<number> {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { io.out(USAGE); return 0; }
    let dir: string | undefined, keyFile: string | undefined, tokenFile: string | undefined, origin: string | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (!arg.startsWith('-') && dir === undefined) { dir = arg; continue; }
        if (!['--key-file', '--token-file', '--origin'].includes(arg) || seen.has(arg) || !args[index + 1] || args[index + 1]!.startsWith('-')) { io.error('Invalid or duplicate option/argument.\n' + USAGE); return 1; }
        seen.add(arg); const value = args[++index]!;
        if (arg === '--key-file') keyFile = value; else if (arg === '--token-file') tokenFile = value; else origin = value;
    }
    if (!dir || !keyFile) { io.error(USAGE); return 1; }
    try {
        const result = await publishPlugin({ dir, keyFile, env, ...(tokenFile ? { tokenFile } : {}), ...(origin ? { origin } : {}) });
        io.out(`Published ${result.id} ${result.version} (${result.created ? 'new version' : 'identical retry'}), sha256:${result.digest}.`); return 0;
    } catch (error) { io.error(error instanceof PublishProblem ? error.message : 'Publishing failed; no credential details are displayed.'); return 1; }
}
