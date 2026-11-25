import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, checkManifest, manifestBytes, packTrack, readArchive } from '../scripts/pack-track.mjs';
import { publicKeyOf, signManifestBytes } from '../scripts/sign-manifest.mjs';
import {
    ARCHES, CHANNELS, PACKAGE_TRACKS, PLATFORMS, parseManifest, parseTrackTag, semverOf, trackBuildFromEnv, trackTag,
    trustedKeysAfter, verifyManifest, verifyTree, type ManifestExpect, type TrackManifest,
} from '../src/core/track-manifest.js';

/*
 * THE SIGNED RELEASE MANIFEST (Tynn #1058 L1). Every package of every track (client, host, launcher) carries a
 * manifest.json signed with Ed25519, and nothing is run before it verifies: the signature, then the shape, then that it is
 * the track, platform, architecture and channel asked for, then that it is newer than what is installed, then every
 * file. The release side is scripts/pack-track.mjs (package + manifest) and scripts/sign-manifest.mjs (the signature);
 * the reader is src/core/track-manifest.ts, and the Rust launcher (L2) reads the same format
 * (contracts/track-manifest.schema.json). Every key here is a THROWAWAY made in the test: no real key is ever used.
 */

const ROOT = join(__dirname, '..');

interface Pair { privatePem: string; publicKey: string; keyObject: KeyObject }
function keyPair(): Pair {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: raw.toString('base64'), keyObject: privateKey };
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1058-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const FILES: Record<string, string> = {
    'genie-host': '#!/bin/sh\necho host\n',
    'resources/app/host.js': 'console.log("host")\n',
    'resources/app/node_modules/a/index.js': 'module.exports = 1;\n',
    'LICENSE': 'MIT\n',
};

async function source(files: Record<string, string> = FILES): Promise<string> {
    const from = join(dir, 'src');
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(from, path)), { recursive: true });
        await writeFile(join(from, path), text);
    }
    return from;
}

const META = { track: 'host', build: '2026.11.25-1', channel: 'dev', platform: 'linux', arch: 'x64', minLauncher: '2026.11.25-1', notes: 'Fixes.' } as const;
const EXPECT: ManifestExpect = { track: 'host', platform: 'linux', arch: 'x64', channel: 'dev', current: '2026.11.18-2', launcher: '2026.11.25-1' };

/** A manifest object as the release side writes it, its exact bytes, and its signature by `key`. */
function signed(key: Pair, change: (m: Record<string, unknown>) => void = () => {}): { bytes: Buffer; sig: string; manifest: Record<string, unknown> } {
    const manifest: Record<string, unknown> = {
        format: 1, track: 'host', build: '2026.11.25-1', schema: '2026.11.25', channel: 'dev', platform: 'linux', arch: 'x64',
        minLauncher: '2026.11.25-1', files: [{ path: 'LICENSE', size: 4, sha256: sha('MIT\n') }, { path: 'genie-host', size: 3, sha256: sha('abc') }], notes: '',
    };
    change(manifest);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    return { bytes, sig: signManifestBytes(bytes, key.privatePem), manifest };
}

describe('track builds and tags', () => {
    it('makes the semver electron-builder needs: no leading zeros', () => {
        expect(semverOf('2026.01.05-1')).toBe('2026.1.5-1');
        expect(semverOf('2026.11.25-1')).toBe('2026.11.25-1');
        expect(semverOf('2.0.0')).toBeNull();
    });

    it('names each track\'s release tag, and reads it back', () => {
        for (const track of PACKAGE_TRACKS) {
            expect(trackTag(track, '2026.11.25-1.1')).toBe(`${track}-v2026.11.25-1.1`);
            expect(parseTrackTag(trackTag(track, '2026.11.25-1.1'))).toEqual({ track, build: '2026.11.25-1.1' });
        }
        expect(parseTrackTag('v2.0.0')).toBeNull(); // the bridge is the old updater's tag, not a track's
        expect(parseTrackTag('browser-v2026.11.25-1')).toBeNull();
        expect(parseTrackTag('host-v2026.02.30-1')).toBeNull();
    });

    it('reads a program\'s own build from GENIE_TRACK_BUILD, and nothing else', () => {
        expect(trackBuildFromEnv({ GENIE_TRACK_BUILD: '2026.11.25-1' })).toBe('2026.11.25-1');
        expect(trackBuildFromEnv({ GENIE_TRACK_BUILD: '2.0.0' })).toBeNull();
        expect(trackBuildFromEnv({})).toBeNull();
    });
});

describe('the manifest\'s shape is the contract\'s', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'contracts', 'track-manifest.schema.json'), 'utf8'));

    it('has the same fields, required fields and enums as contracts/track-manifest.schema.json', () => {
        expect(schema.properties.format.const).toBe(1);
        expect(schema.properties.track.enum).toEqual([...PACKAGE_TRACKS]);
        expect(schema.properties.channel.enum).toEqual([...CHANNELS]);
        expect(schema.properties.platform.enum).toEqual([...PLATFORMS]);
        expect(schema.properties.arch.enum).toEqual([...ARCHES]);
        const key = keyPair();
        const { manifest } = signed(key);
        const parsed = parseManifest(manifest);
        expect(parsed.ok).toBe(true);
        expect(() => checkManifest(manifest)).not.toThrow();
        expect(Object.keys(manifest).sort()).toEqual([...schema.required].sort());
        for (const field of schema.required as string[]) {
            const without = { ...manifest };
            delete without[field];
            expect(parseManifest(without), field).toMatchObject({ ok: false, code: 'format' });
            expect(() => checkManifest(without), field).toThrow();
        }
        expect(Object.keys(schema.properties).sort()).toEqual([...schema.required, 'nextKey'].sort());
    });

    it.each<[string, (m: Record<string, unknown>) => void]>([
        ['an unknown field', (m) => { m.extra = 1; }],
        ['format 2', (m) => { m.format = 2; }],
        ['the browser track (not a package track)', (m) => { m.track = 'browser'; }],
        ['a schema that is not the build\'s', (m) => { m.schema = '2026.11.24'; }],
        ['a build with +metadata', (m) => { m.build = '2026.11.25-1+ci'; }],
        ['the bridge\'s version as a build', (m) => { m.build = '2.0.0'; m.schema = '2.0.0'; }],
        ['no files', (m) => { m.files = []; }],
        ['files out of order', (m) => { m.files = [...(m.files as unknown[])].reverse(); }],
        ['two paths equal but for case', (m) => { m.files = [{ path: 'A', size: 0, sha256: sha('') }, { path: 'a', size: 0, sha256: sha('') }]; }],
        ['a path with ..', (m) => { m.files = [{ path: 'a/../../b', size: 0, sha256: sha('') }]; }],
        ['an absolute path', (m) => { m.files = [{ path: '/etc/passwd', size: 0, sha256: sha('') }]; }],
        ['a backslash path', (m) => { m.files = [{ path: 'a\\b', size: 0, sha256: sha('') }]; }],
        ['a drive path', (m) => { m.files = [{ path: 'C:x', size: 0, sha256: sha('') }]; }],
        ['an upper-case hash', (m) => { m.files = [{ path: 'a', size: 0, sha256: sha('').toUpperCase() }]; }],
        ['a negative size', (m) => { m.files = [{ path: 'a', size: -1, sha256: sha('') }]; }],
        ['a nextKey that is not 32 bytes', (m) => { m.nextKey = Buffer.alloc(31).toString('base64'); }],
    ])('refuses %s, in the reader and in the release scripts alike', (_name, change) => {
        const key = keyPair();
        const { manifest } = signed(key, change);
        expect(parseManifest(manifest)).toMatchObject({ ok: false, code: 'format' });
        expect(() => checkManifest(manifest)).toThrow();
    });
});

describe('verify before run', () => {
    it('round trip: a package packed and signed by the release scripts verifies, file for file', async () => {
        const key = keyPair();
        const from = await source();
        await chmod(join(from, 'genie-host'), 0o755);
        const out = join(dir, 'out');
        const packed = await packTrack({ ...META, from, out });
        expect(packed.base).toBe('host-2026.11.25-1-linux-x64');
        expect(packed.archive).toBe(join(out, 'host-2026.11.25-1-linux-x64.tar.zst'));
        expect(packed.manifest).toBe(join(out, 'host-2026.11.25-1-linux-x64.manifest.json'));
        const bytes = await readFile(packed.manifest);
        const sig = signManifestBytes(bytes, key.privatePem);
        const verdict = verifyManifest(bytes, sig, [key.publicKey], EXPECT);
        expect(verdict).toMatchObject({ ok: true, key: key.publicKey });
        if (!verdict.ok) return;
        expect(verdict.manifest.files.map((f) => f.path)).toEqual(Object.keys(FILES).sort());
        for (const f of verdict.manifest.files) expect(f).toEqual({ path: f.path, size: Buffer.byteLength(FILES[f.path]!), sha256: sha(FILES[f.path]!) });

        const entries = await readArchive(packed.archive);
        expect(entries.map((e) => e.path)).toEqual(Object.keys(FILES).sort());
        for (const e of entries) expect(e.data.toString()).toBe(FILES[e.path]);
        expect(entries.find((e) => e.path === 'genie-host')!.mode & 0o111).toBe(0o111);
        expect(entries.find((e) => e.path === 'LICENSE')!.mode & 0o111).toBe(0);

        const unpacked = join(dir, 'unpacked');
        for (const e of entries) { await mkdir(dirname(join(unpacked, e.path)), { recursive: true }); await writeFile(join(unpacked, e.path), e.data); }
        await writeFile(join(unpacked, 'manifest.json'), bytes);
        await writeFile(join(unpacked, 'manifest.json.sig'), sig);
        await writeFile(join(unpacked, '.complete'), '');
        expect(await verifyTree(verdict.manifest, unpacked)).toEqual({ ok: true });
    });

    it('packs Windows as a standard zip (another reader agrees, file for file)', async () => {
        const from = await source();
        const packed = await packTrack({ ...META, platform: 'win32', from, out: join(dir, 'out') });
        expect(packed.archive.endsWith('host-2026.11.25-1-win32-x64.zip')).toBe(true);
        const theirs = await new Promise<Record<string, string>>((resolve, reject) => {
            const seen: Record<string, string> = {};
            yauzl.open(packed.archive, { lazyEntries: true }, (err, zip) => {
                if (err || !zip) return reject(err);
                zip.on('entry', (entry: yauzl.Entry) => {
                    zip.openReadStream(entry, (e, stream) => {
                        if (e || !stream) return reject(e);
                        const chunks: Buffer[] = [];
                        stream.on('data', (c: Buffer) => chunks.push(c));
                        stream.on('end', () => { seen[entry.fileName] = Buffer.concat(chunks).toString(); zip.readEntry(); });
                    });
                });
                zip.on('end', () => resolve(seen));
                zip.on('error', reject);
                zip.readEntry();
            });
        });
        expect(theirs).toEqual(Object.fromEntries(Object.keys(FILES).sort().map((p) => [p, FILES[p]])));
        expect((await readArchive(packed.archive)).map((e) => e.data.toString())).toEqual(Object.keys(FILES).sort().map((p) => FILES[p]));
    });

    it('writes the manifest the reader parses, with the files sorted and the schema from the build', async () => {
        const from = await source();
        const manifest = await buildManifest(from, META);
        expect(parseManifest(manifest)).toMatchObject({ ok: true });
        expect(manifest.schema).toBe('2026.11.25');
        expect(manifestBytes(manifest).toString()).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    });

    it('refuses to pack what no launcher would install', async () => {
        const from = await source();
        await expect(packTrack({ ...META, build: '2.0.0', from, out: join(dir, 'o1') })).rejects.toThrow(/track build/);
        await expect(packTrack({ ...META, build: '2026.11.18-0', from, out: join(dir, 'o2') })).rejects.toThrow(/track build/);
        await expect(packTrack({ ...META, track: 'browser' as 'host', from, out: join(dir, 'o3') })).rejects.toThrow(/track/);
        await expect(packTrack({ ...META, from: join(dir, 'empty'), out: join(dir, 'o4') })).rejects.toThrow();
    });

    it('a manifest with one flipped byte refuses, in words, naming nothing it could not trust', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key);
        const flipped = Buffer.from(bytes);
        const at = flipped.indexOf('"notes"') + 2;
        flipped[at] ^= 0x01;
        const verdict = verifyManifest(flipped, sig, [key.publicKey], EXPECT);
        expect(verdict).toMatchObject({ ok: false, code: 'signature' });
        if (!verdict.ok) expect(verdict.reason).toMatch(/This update's signature is not Genie's\. Nothing was installed\./);
    });

    it('a signature with one flipped byte refuses; so does one that is not a signature', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key);
        const raw = Buffer.from(sig, 'base64');
        raw[10] ^= 0x80;
        expect(verifyManifest(bytes, raw.toString('base64'), [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(bytes, '', [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(bytes, 'not base64!', [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(bytes, sig.slice(0, 40), [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
    });

    it('the signature file is one line of base64 with no newline; trailing whitespace (a CRLF checkout) is read past', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key);
        expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
        expect(verifyManifest(bytes, `${sig}\r\n`, [key.publicKey], EXPECT)).toMatchObject({ ok: true });
        expect(verifyManifest(bytes, Buffer.from(sig), [key.publicKey], EXPECT)).toMatchObject({ ok: true });
    });

    it('a manifest signed with the wrong key refuses; so does one with no trusted key at all', () => {
        const genie = keyPair();
        const other = keyPair();
        const { bytes, sig } = signed(other);
        expect(verifyManifest(bytes, sig, [genie.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(bytes, sig, [], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(bytes, sig, ['not a key'], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(bytes, sig, ['not a key', other.publicKey], EXPECT)).toMatchObject({ ok: true, key: other.publicKey });
    });

    it('a signed manifest of the wrong shape refuses after its signature checks', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key, (m) => { delete m.files; });
        expect(verifyManifest(bytes, sig, [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'format' });
        const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signed(key).bytes]);
        expect(verifyManifest(bom, signManifestBytes(bom, key.privatePem), [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'format' });
        const garbage = Buffer.from('{not json');
        expect(verifyManifest(garbage, signManifestBytes(garbage, key.privatePem), [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'format' });
    });

    it.each<[string, Partial<ManifestExpect>, string]>([
        ['another track', { track: 'client' }, 'track'],
        ['another platform', { platform: 'win32' }, 'platform'],
        ['another architecture', { arch: 'arm64' }, 'arch'],
        ['a dev build on a stable install', { channel: 'stable' }, 'channel'],
    ])('the wrong package refuses: %s', (_name, change, code) => {
        const key = keyPair();
        const { bytes, sig } = signed(key);
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, ...change })).toMatchObject({ ok: false, code });
    });

    it('a stable build is taken by a dev install', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key, (m) => { m.channel = 'stable'; });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, channel: 'dev' })).toMatchObject({ ok: true });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, channel: 'stable' })).toMatchObject({ ok: true });
    });

    it('a downgrade refuses, and so does the same build again; a first install or the bridge\'s v2.0.0 takes any build', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key);
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, current: '2026.11.25-1.1' })).toMatchObject({ ok: false, code: 'downgrade' });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, current: '2026.12.01-1' })).toMatchObject({ ok: false, code: 'downgrade' });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, current: '2026.11.25-1' })).toMatchObject({ ok: false, code: 'downgrade' });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, current: null })).toMatchObject({ ok: true });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, current: '2.0.0' })).toMatchObject({ ok: true });
    });

    it('a package that needs a newer launcher refuses; a launcher at or above its minimum takes it', () => {
        const key = keyPair();
        const { bytes, sig } = signed(key, (m) => { m.minLauncher = '2026.11.26-1'; });
        expect(verifyManifest(bytes, sig, [key.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'launcher-too-old' });
        expect(verifyManifest(bytes, sig, [key.publicKey], { ...EXPECT, launcher: '2026.11.26-1' })).toMatchObject({ ok: true });
        const none = signed(key, (m) => { m.minLauncher = null; });
        expect(verifyManifest(none.bytes, none.sig, [key.publicKey], EXPECT)).toMatchObject({ ok: true });
    });

    it('checks in the spec\'s order: the signature before anything the manifest says', () => {
        const genie = keyPair();
        const other = keyPair();
        const { bytes, sig } = signed(other, (m) => { m.track = 'client'; delete m.notes; });
        expect(verifyManifest(bytes, sig, [genie.publicKey], { ...EXPECT, current: '2027.01.01-1' })).toMatchObject({ ok: false, code: 'signature' });
    });
});

describe('every file, none missing, none extra', () => {
    async function installed(): Promise<{ manifest: TrackManifest; root: string }> {
        const root = await source();
        const manifest = await buildManifest(root, META);
        await writeFile(join(root, 'manifest.json'), manifestBytes(manifest));
        await writeFile(join(root, 'manifest.json.sig'), 'x');
        await writeFile(join(root, '.complete'), '');
        return { manifest: manifest as TrackManifest, root };
    }

    it('verifies an intact folder', async () => {
        const { manifest, root } = await installed();
        expect(await verifyTree(manifest, root)).toEqual({ ok: true });
    });

    it('a file with one flipped byte refuses', async () => {
        const { manifest, root } = await installed();
        const path = join(root, 'resources/app/host.js');
        const b = await readFile(path);
        b[3] ^= 0x01;
        await writeFile(path, b);
        expect(await verifyTree(manifest, root)).toMatchObject({ ok: false, code: 'sha256', path: 'resources/app/host.js' });
    });

    it('a truncated file refuses on its size', async () => {
        const { manifest, root } = await installed();
        await writeFile(join(root, 'LICENSE'), 'MI');
        expect(await verifyTree(manifest, root)).toMatchObject({ ok: false, code: 'size', path: 'LICENSE' });
    });

    it('a missing component refuses', async () => {
        const { manifest, root } = await installed();
        await rm(join(root, 'genie-host'));
        expect(await verifyTree(manifest, root)).toMatchObject({ ok: false, code: 'missing-file', path: 'genie-host' });
    });

    it('a file the manifest does not list refuses (a planted program)', async () => {
        const { manifest, root } = await installed();
        await writeFile(join(root, 'resources/app/git.exe'), 'planted');
        expect(await verifyTree(manifest, root)).toMatchObject({ ok: false, code: 'unlisted-file', path: 'resources/app/git.exe' });
    });
});

describe('key rotation', () => {
    it('a next key is trusted only when a manifest signed by the current key names it', () => {
        const current = keyPair();
        const next = keyPair();
        const naming = signed(current, (m) => { m.nextKey = next.publicKey; });
        const verdict = verifyManifest(naming.bytes, naming.sig, [current.publicKey], EXPECT);
        expect(verdict).toMatchObject({ ok: true });
        const trusted = trustedKeysAfter([current.publicKey], verdict);
        expect(trusted).toEqual([current.publicKey, next.publicKey]);
        expect(trustedKeysAfter(trusted, verdict)).toEqual(trusted);

        const byNext = signed(next);
        expect(verifyManifest(byNext.bytes, byNext.sig, [current.publicKey], EXPECT)).toMatchObject({ ok: false, code: 'signature' });
        expect(verifyManifest(byNext.bytes, byNext.sig, trusted, EXPECT)).toMatchObject({ ok: true, key: next.publicKey });
    });

    it('a stranger naming its own key is refused and trusts nothing', () => {
        const current = keyPair();
        const stranger = keyPair();
        const self = signed(stranger, (m) => { m.nextKey = stranger.publicKey; });
        const verdict = verifyManifest(self.bytes, self.sig, [current.publicKey], EXPECT);
        expect(verdict).toMatchObject({ ok: false, code: 'signature' });
        expect(trustedKeysAfter([current.publicKey], verdict)).toEqual([current.publicKey]);
    });

    it('a next key named in a manifest that fails a later check is not trusted either', () => {
        const current = keyPair();
        const next = keyPair();
        const old = signed(current, (m) => { m.nextKey = next.publicKey; });
        const verdict = verifyManifest(old.bytes, old.sig, [current.publicKey], { ...EXPECT, current: '2027.01.01-1' });
        expect(verdict).toMatchObject({ ok: false, code: 'downgrade' });
        expect(trustedKeysAfter([current.publicKey], verdict)).toEqual([current.publicKey]);
    });
});

describe('scripts/sign-manifest.mjs (the release job\'s side)', () => {
    it('signs only with an Ed25519 key, and names the public key the launcher builds in', () => {
        const key = keyPair();
        expect(publicKeyOf(key.privatePem)).toBe(key.publicKey);
        const x = generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
        expect(() => signManifestBytes(Buffer.from('{}'), x)).toThrow(/Ed25519/);
    });

    it('from the command line: signs each manifest from the environment\'s key, writes .sig with no newline, prints no key', async () => {
        const key = keyPair();
        const from = await source();
        const packed = await packTrack({ ...META, from, out: join(dir, 'out') });
        const run = (env: Record<string, string>) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'sign-manifest.mjs'), packed.manifest], {
            env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env }, encoding: 'utf8',
        });

        const none = run({});
        expect(none.status).toBe(2);
        expect(none.stderr).toMatch(/GENIE_MANIFEST_SIGNING_KEY/);

        const wrong = run({ GENIE_MANIFEST_SIGNING_KEY: key.privatePem, GENIE_MANIFEST_PUBLIC_KEY: keyPair().publicKey });
        expect(wrong.status).not.toBe(0);
        expect(wrong.stderr).toMatch(/not the key/);

        const ok = run({ GENIE_MANIFEST_SIGNING_KEY: key.privatePem, GENIE_MANIFEST_PUBLIC_KEY: key.publicKey });
        expect(ok.status, ok.stderr).toBe(0);
        const body = key.privatePem.split('\n')[1]!;
        expect(ok.stdout + ok.stderr).not.toContain(body);
        const sig = await readFile(`${packed.manifest}.sig`, 'utf8');
        expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
        expect(verifyManifest(await readFile(packed.manifest), sig, [key.publicKey], EXPECT)).toMatchObject({ ok: true });
    });

    it('refuses to sign a manifest the launcher would refuse', async () => {
        const key = keyPair();
        const path = join(dir, 'bad.manifest.json');
        await writeFile(path, JSON.stringify({ format: 1, track: 'browser' }));
        const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sign-manifest.mjs'), path], {
            env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', GENIE_MANIFEST_SIGNING_KEY: key.privatePem }, encoding: 'utf8',
        });
        expect(r.status).not.toBe(0);
        await expect(readFile(`${path}.sig`)).rejects.toThrow();
    });
});
