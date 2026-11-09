import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ZipFile } from 'yazl';
import { packageDigest, packageSigningBytes, publisherKeyId } from '../../src/core/plugin-integrity.js';
import type { MarketplaceReview, MarketplaceRow } from '../../src/core/marketplace.js';
import { hostHttpsFetch } from '../../src/main/host-https-fetch.js';
import { MarketplaceClient } from '../../src/main/marketplace-client.js';
import { MarketplaceHost } from '../../src/main/marketplace-host.js';
import { MarketplaceSession } from '../../src/main/marketplace-session.js';
import { PluginsService } from '../../src/main/plugins-host.js';
import { readPackageFiles } from '../../src/main/plugin-package.js';

/** Owner7182/7185/7187: Node-only, isolated tynn-c5.gen, tynn_test lock held by the caller. Never production. */
const root = resolve(process.env.C5_PROOF_DIR ?? '');
const origin = process.env.C5_PROOF_ORIGIN ?? '';
if (!process.env.C5_PROOF_DIR || !/^https:\/\/tynn-c5\.gen\/?$/.test(origin)) throw new Error('Explicit disposable C5 proof directory and tynn-c5.gen origin required');
const marker = 'C5 disposable Node proof';
const stage = process.argv[2];
const secrets = join(root, 'secrets'), source = join(root, 'package');
const keyFile = join(secrets, 'publisher.pem'), tokenFile = join(secrets, 'publisher.token');
interface Fixture { id: string; keyId: string; version: string }

async function prepare(): Promise<void> {
    await mkdir(root, { recursive: false }); await writeFile(join(root, '.c5-proof'), marker);
    await mkdir(secrets, { mode: 0o700 }); await mkdir(source);
    const pair = generateKeyPairSync('ed25519'), publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); await writeFile(join(secrets, 'publisher.public.pem'), publicPem);
    const fixture: Fixture = { id: `org.example.c5-${randomBytes(6).toString('hex')}`, keyId: publisherKeyId(publicPem), version: '1.2.3' };
    await writeFile(join(root, 'fixture.json'), JSON.stringify(fixture));
    await writeFile(join(source, 'genie-plugin.json'), JSON.stringify({ ...fixture, keyId: undefined, name: 'Disposable C5 proof', publisher: { name: 'C5 proof publisher', keyId: fixture.keyId }, capabilities: { network: { hosts: [] }, genieApi: [] }, mcpTools: [{ name: 'hello', description: 'Proof only', inputSchema: { type: 'object' }, run: 'tools.cjs', process: 'subprocess', gated: true }] }));
    await writeFile(join(source, 'tools.cjs'), 'throw new Error("proof plugin must not execute during publishing or installation");');
    await writeFile(join(source, 'bytes.bin'), Buffer.from([0, 255, 254, 128, 10]));
    console.log('C5 fixture files prepared; private key stays outside the package.');
}
async function signedControl(privatePem: string): Promise<Buffer> {
    const read = await readPackageFiles(source); if (!read.ok) throw new Error('Control package cannot be read');
    const files = read.files.map(file => file.path === 'genie-plugin.json' ? { ...file, bytes: Buffer.from(JSON.stringify({ ...JSON.parse(file.bytes.toString()), version: '0.0.0' })) } : file);
    const archive = new ZipFile(), chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => { archive.outputStream.on('data', chunk => chunks.push(chunk as Buffer)); archive.outputStream.once('end', () => resolve(Buffer.concat(chunks))); archive.outputStream.once('error', reject); });
    for (const file of files) archive.addBuffer(file.bytes, file.path, { mode: 0o100644 });
    archive.addBuffer(Buffer.from(sign(null, packageSigningBytes(packageDigest(files)), privatePem).toString('base64')), 'genie-plugin.sig', { mode: 0o100644 }); archive.end(); return done;
}
async function command(args: string[]): Promise<{ code: number | null; text: string }> {
    const npmCli = process.env.C5_NPM_CLI ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    await readFile(npmCli); // A missing npm dependency is SETUP failure, never the feature RED.
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [npmCli, 'run', 'publish:plugin', '--', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
        child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; }); child.once('error', reject); child.once('close', code => resolve({ code, text }));
    });
}
async function verifyProof(): Promise<void> {
    assert.equal(await readFile(join(root, '.c5-proof'), 'utf8'), marker);
    const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8')) as Fixture;
    const privatePem = await readFile(keyFile, 'utf8'), token = (await readFile(tokenFile, 'utf8')).trim();
    const http = hostHttpsFetch({ maxResponseBytes: 1024 * 1024, streamResponse: true });
    const boundary = `genie-c5-control-${randomBytes(16).toString('hex')}`, zip = await signedControl(privatePem);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="plugin.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const control = await http(`${origin}/api/v1/marketplace/publish`, { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) }, body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const controlText = await control.text(); let controlData: { id?: string; version?: { version?: string } } | null = null;
    try { controlData = JSON.parse(controlText) as { id?: string; version?: { version?: string } } | null; } catch { /* Diagnostic is boolean/length only; never echo a response or credential. */ }
    console.log(`C5 control diagnostic: status=${control.status}, json=${control.headers.get('content-type')?.includes('application/json') === true}, bytes=${Buffer.byteLength(controlText)}, idMatch=${controlData?.id === fixture.id}, versionMatch=${controlData?.version?.version === '0.0.0'}.`);
    assert.equal(control.status, 201, 'Real Tynn signed-upload positive control must succeed before the CLI assertion');
    console.log('C5 over-wire positive control: real Tynn accepted independently signed ZIP with dedicated token (HTTP201).');
    const args = [source, '--key-file', keyFile, '--token-file', tokenFile, '--origin', origin];
    const result = await command(args);
    if (result.text.includes(token) || result.text.includes(privatePem)) throw new Error('CLI leaked a fixture credential; output suppressed');
    assert.equal(result.code, 0, /Missing script.*publish:plugin/.test(result.text) ? 'C5 CLI feature is absent: npm run publish:plugin is missing, after a working real HTTP control' : 'Actual publishing CLI must succeed; child output suppressed');
    const retry = await command(args); assert.equal(retry.code, 0, 'Identical actual CLI retry must succeed');
    if (retry.text.includes(token) || retry.text.includes(privatePem)) throw new Error('CLI retry leaked a fixture credential; output suppressed');
    console.log('C5 actual npm publishing command and identical retry succeeded; no credential output.');
    const registry = await MarketplaceClient.open({ cacheFile: join(root, 'registry.json'), fetch: http, origin });
    let host: MarketplaceHost | undefined, session: MarketplaceSession | undefined;
    try {
        await registry.refresh(); assert.ok(registry.publisherKeys()[fixture.keyId]);
        const pluginsDir = join(root, 'installed'); await mkdir(pluginsDir);
        const plugins = await PluginsService.open({ dir: pluginsDir, keys: {}, publisherChecksOff: () => false, registry });
        host = await MarketplaceHost.open({ pluginsDir, stagingDir: join(root, 'staging'), grantsFile: join(root, 'grants.json'), registry, plugins, fetch: http, origin });
        session = new MarketplaceSession(() => host ?? null);
        const catalog = await session.call('search', [fixture.id]) as { packages: MarketplaceRow[] };
        assert.ok(catalog.packages.some(row => row.id === fixture.id && row.version.version === fixture.version));
        const review = await session.call('prepare', [fixture.id, fixture.version]) as MarketplaceReview;
        assert.equal(review.needsConsent, true); assert.equal(review.package.version.key_id, fixture.keyId);
        assert.deepEqual(await session.call('install', [review.token, true]), { id: fixture.id, version: fixture.version });
        const installed = plugins.dump().entries.find(entry => entry.id === fixture.id); assert.ok(installed);
        assert.deepEqual(await readFile(join(pluginsDir, fixture.id, 'bytes.bin')), Buffer.from([0, 255, 254, 128, 10]));
        assert.ok((await readdir(source)).every(name => name !== 'genie-plugin.sig'));
        console.log('C5 real MarketplaceSession search/review/consent/install succeeded with registry trust and exact binary bytes; no plugin code executed.');
    } finally { await session?.close(); await host?.close(); registry.close(); }
}
if (stage === 'prepare') await prepare(); else if (stage === 'verify') await verifyProof(); else throw new Error('Expected prepare or verify');
