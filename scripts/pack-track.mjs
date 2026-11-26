#!/usr/bin/env node
/**
 * ONE TRACK'S PACKAGE AND ITS MANIFEST (Tynn #1058 L1; format 2 since L3), for the release job. Packs a folder (the
 * client's unpacked app, the browser's, the host's runtime and bundle, or the launcher) into the release assets the
 * launcher downloads (scripts/build-track-packages.mjs lays each folder out):
 *
 *   <out>/<track>-<build>-<platform>-<arch>.zip            Windows (deflate; a standard zip)
 *   <out>/<track>-<build>-<platform>-<arch>.tar.zst        Linux (ustar + pax paths, zstd)
 *   <out>/<track>-<build>-<platform>-<arch>.manifest.json  every file's path, size and SHA-256 (contracts/track-manifest.schema.json)
 *
 * The manifest is signed afterwards, in the protected release job, by scripts/sign-manifest.mjs (<manifest>.sig). Installed,
 * the two become the build folder's manifest.json and manifest.json.sig. A package is FILES ONLY: no links, no install
 * scripts. checkManifest is the release side's copy of src/core/track-manifest.ts `parseManifest`;
 * test/track-manifest.test.ts holds the two to the same refusals.
 *
 *   node scripts/pack-track.mjs --track host --build 2026.11.25-1 --channel dev --platform linux --arch x64 \
 *        --from <folder> --out <folder> [--with-client <build>] [--min-launcher <build>] [--notes <text> | --notes-file <file>]
 *        [--next-key <base64>]
 *
 * --with-client is required of a host (the client build it ships with) and refused for any other track.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const PACKAGE_TRACKS = ['client', 'host', 'browser', 'launcher'];
export const MANIFEST_FORMAT = 2;
export const CHANNELS = ['stable', 'dev'];
export const PLATFORMS = ['win32', 'linux'];
export const ARCHES = ['x64', 'arm64'];
const FIELDS = new Set(['format', 'track', 'build', 'schema', 'channel', 'platform', 'arch', 'withClient', 'minLauncher', 'files', 'notes', 'nextKey']);
const FILE_FIELDS = new Set(['path', 'size', 'sha256']);
const BUILD = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d{0,5})(?:\.(\d{1,6}))?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;

/** A track build a manifest may name: `<real date>-<release>[.<hotfix>]`, no `+metadata`. Its schema, or null. */
export function schemaOfBuild(build) {
    const m = typeof build === 'string' ? BUILD.exec(build) : null;
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (y < 2000 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return `${m[1]}.${m[2]}.${m[3]}`;
}

function pathProblem(path) {
    if (typeof path !== 'string' || path.length === 0) return 'a file has no path';
    if (path.length > 1024) return 'a path is longer than 1024 characters';
    // eslint-disable-next-line no-control-regex
    if (/[\\:\u0000-\u001f\u007f]/.test(path)) return `the path ${JSON.stringify(path)} has a backslash, a colon or a control character`;
    for (const s of path.split('/')) if (s === '' || s === '.' || s === '..') return `the path ${JSON.stringify(path)} is not a plain relative path`;
    return null;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws, saying why, unless `m` is a format-2 manifest the launcher would read. */
export function checkManifest(m) {
    const bad = (why) => { throw new Error(`not a track manifest: ${why}`); };
    if (!isObject(m)) bad('not an object');
    for (const k of Object.keys(m)) if (!FIELDS.has(k)) bad(`unknown field "${k}"`);
    if (m.format !== MANIFEST_FORMAT) bad(`format ${JSON.stringify(m.format)}`);
    if (!PACKAGE_TRACKS.includes(m.track)) bad(`the track ${JSON.stringify(m.track)}`);
    const schema = schemaOfBuild(m.build);
    if (!schema) bad(`the build ${JSON.stringify(m.build)} is not a track build`);
    if (m.schema !== schema) bad(`the schema ${JSON.stringify(m.schema)} is not the build's`);
    if (!CHANNELS.includes(m.channel)) bad(`the channel ${JSON.stringify(m.channel)}`);
    if (!PLATFORMS.includes(m.platform)) bad(`the platform ${JSON.stringify(m.platform)}`);
    if (!ARCHES.includes(m.arch)) bad(`the architecture ${JSON.stringify(m.arch)}`);
    if (m.track === 'host' && !(typeof m.withClient === 'string' && schemaOfBuild(m.withClient))) bad(`a host names the client build it ships with (withClient), and it is ${JSON.stringify(m.withClient)}`);
    if (m.track !== 'host' && m.withClient !== undefined) bad(`only a host names withClient, and this is the ${m.track}`);
    if (m.minLauncher !== null && !schemaOfBuild(m.minLauncher)) bad(`minLauncher ${JSON.stringify(m.minLauncher)}`);
    if (typeof m.notes !== 'string' || m.notes.length > 65536) bad('the notes');
    if (m.nextKey !== undefined && (typeof m.nextKey !== 'string' || !KEY.test(m.nextKey))) bad('nextKey is not a 32-byte key');
    if (!Array.isArray(m.files) || m.files.length === 0) bad('no files');
    const folded = new Set();
    let previous = null;
    for (const f of m.files) {
        if (!isObject(f)) bad('a file entry is not an object');
        for (const k of Object.keys(f)) if (!FILE_FIELDS.has(k)) bad(`a file has a field "${k}"`);
        const problem = pathProblem(f.path);
        if (problem) bad(problem);
        if (!Number.isSafeInteger(f.size) || f.size < 0) bad(`${f.path} has no size`);
        if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) bad(`${f.path} has no SHA-256`);
        if (previous !== null && !(Buffer.compare(Buffer.from(previous), Buffer.from(f.path)) < 0)) bad('the files are not sorted by path');
        if (folded.has(f.path.toLowerCase())) bad(`two files are ${f.path} but for case`);
        folded.add(f.path.toLowerCase());
        previous = f.path;
    }
    return m;
}

/** The manifest's exact bytes: what is signed and shipped. */
export function manifestBytes(m) {
    return Buffer.from(`${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

/** Every file under `from`, sorted by path in byte order: [{path, abs, mode}]. A link or any other non-file throws. */
async function filesOf(from) {
    const out = [];
    async function walk(rel) {
        for (const e of await readdir(join(from, rel), { withFileTypes: true })) {
            const path = rel ? `${rel}/${e.name}` : e.name;
            const abs = join(from, path);
            const st = await lstat(abs);
            if (st.isDirectory()) await walk(path);
            else if (st.isFile()) out.push({ path, abs, mode: st.mode & 0o111 ? 0o755 : 0o644 });
            else throw new Error(`${path} is not a plain file (a link?): a package is files only`);
        }
    }
    await walk('');
    out.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    return out;
}

/** The manifest for the folder `from`, as `meta` names it (track, build, channel, platform, arch, withClient, minLauncher, notes, nextKey). */
export async function buildManifest(from, meta) {
    const files = [];
    for (const f of await filesOf(from)) {
        const data = await readFile(f.abs);
        files.push({ path: f.path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
    const m = {
        format: MANIFEST_FORMAT, track: meta.track, build: meta.build, schema: schemaOfBuild(meta.build), channel: meta.channel, platform: meta.platform,
        arch: meta.arch, ...(meta.withClient !== undefined ? { withClient: meta.withClient } : {}), minLauncher: meta.minLauncher ?? null, files, notes: meta.notes ?? '',
        ...(meta.nextKey !== undefined ? { nextKey: meta.nextKey } : {}),
    };
    return checkManifest(m);
}

// ---- zip (stored as deflate; a fixed 1980-01-01 time so a package is reproducible) ----
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function zip(entries) {
    if (entries.length >= 0xffff) throw new Error(`${entries.length} files: more than a zip without zip64 holds`);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.path, 'utf8');
        const crc = zlib.crc32(e.data);
        const deflated = zlib.deflateRawSync(e.data, { level: 9 });
        const [method, body] = deflated.length < e.data.length ? [8, deflated] : [0, e.data];
        if (e.data.length >= 0xffffffff || offset + body.length + 30 + name.length >= 0xffffffff) throw new Error('the package is larger than a zip without zip64 holds');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

function unzip(buf) {
    let at = buf.length - 22;
    while (at >= 0 && buf.readUInt32LE(at) !== 0x06054b50) at--;
    if (at < 0) throw new Error('not a zip: no end of central directory');
    const count = buf.readUInt16LE(at + 10);
    let p = buf.readUInt32LE(at + 16);
    const out = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('not a zip: a broken central directory');
        const madeBy = buf.readUInt16LE(p + 4) >> 8;
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28);
        const xlen = buf.readUInt16LE(p + 30);
        const clen = buf.readUInt16LE(p + 32);
        const attrs = buf.readUInt32LE(p + 38);
        const local = buf.readUInt32LE(p + 42);
        const path = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
        p += 46 + nlen + xlen + clen;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const body = buf.subarray(start, start + csize);
        const data = method === 8 ? zlib.inflateRawSync(body) : method === 0 ? Buffer.from(body) : null;
        if (!data) throw new Error(`${path}: compression method ${method}`);
        if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`${path}: its CRC or size does not match`);
        out.push({ path, mode: madeBy === 3 ? (attrs >>> 16) & 0o777 : 0o644, data });
    }
    return out;
}

// ---- tar (ustar; a pax `path` record for a long name), compressed with zstd ----
function octal(n, width) {
    return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name, size, mode, type) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write(octal(mode, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
    h.write(octal(size, 12), 124); h.write(octal(315532800, 12), 136);
    h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
}

const pad512 = (n) => Buffer.alloc((512 - (n % 512)) % 512);

function tar(entries) {
    const parts = [];
    for (const e of entries) {
        const name = Buffer.from(e.path, 'utf8');
        if (name.length > 100) {
            const body = (len) => `${len} path=${e.path}\n`;
            let len = Buffer.byteLength(body(0));
            while (Buffer.byteLength(body(len)) !== len) len = Buffer.byteLength(body(len));
            const record = Buffer.from(body(len), 'utf8');
            parts.push(tarHeader('PaxHeader', record.length, 0o644, 'x'), record, pad512(record.length));
        }
        parts.push(tarHeader(name.length > 100 ? name.subarray(0, 100).toString('utf8') : e.path, e.data.length, e.mode, '0'), e.data, pad512(e.data.length));
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

function untar(buf) {
    const out = [];
    let at = 0;
    let longPath = null;
    while (at + 512 <= buf.length) {
        const h = buf.subarray(at, at + 512);
        if (h.every((b) => b === 0)) break;
        const field = (o, n) => h.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(field(124, 12).trim(), 8);
        const type = field(156, 1) || '0';
        const data = Buffer.from(buf.subarray(at + 512, at + 512 + size));
        at += 512 + size + ((512 - (size % 512)) % 512);
        if (type === 'x') {
            const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
            longPath = m ? m[1] : null;
            continue;
        }
        if (type !== '0') throw new Error(`a tar entry of type ${JSON.stringify(type)}: a package is files only`);
        out.push({ path: longPath ?? field(0, 100), mode: parseInt(field(100, 8).trim(), 8) & 0o777, data });
        longPath = null;
    }
    return out;
}

/** The files of a package written by packTrack (.zip or .tar.zst): [{path, mode, data}], in the archive's order. */
export async function readArchive(path) {
    const buf = await readFile(path);
    if (path.endsWith('.zip')) return unzip(buf);
    if (path.endsWith('.tar.zst')) return untar(zlib.zstdDecompressSync(buf));
    throw new Error(`${path}: not a .zip or a .tar.zst`);
}

/** Packs `from` for one track, platform and architecture into `out`: the archive and its unsigned manifest. */
export async function packTrack({ from, out, ...meta }) {
    if (!PACKAGE_TRACKS.includes(meta.track)) throw new Error(`not a package track: ${JSON.stringify(meta.track)} (${PACKAGE_TRACKS.join(', ')})`);
    if (!schemaOfBuild(meta.build)) throw new Error(`not a track build: ${JSON.stringify(meta.build)} (<YYYY.MM.DD>-<release>[.<hotfix>])`);
    const manifest = await buildManifest(from, meta);
    const entries = [];
    for (const f of await filesOf(from)) entries.push({ path: f.path, mode: f.mode, data: await readFile(f.abs) });
    const base = `${manifest.track}-${manifest.build}-${manifest.platform}-${manifest.arch}`;
    await mkdir(out, { recursive: true });
    const archive = join(out, `${base}${manifest.platform === 'win32' ? '.zip' : '.tar.zst'}`);
    const packed = manifest.platform === 'win32'
        ? zip(entries)
        : zlib.zstdCompressSync(tar(entries), { params: { [zlib.constants.ZSTD_c_compressionLevel]: 10 } });
    await writeFile(archive, packed);
    const manifestPath = join(out, `${base}.manifest.json`);
    await writeFile(manifestPath, manifestBytes(manifest));
    return { base, archive, manifest: manifestPath, value: manifest };
}

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m || i + 1 >= argv.length) throw new Error(`unexpected argument ${JSON.stringify(argv[i])}`);
        out[m[1]] = argv[++i];
    }
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        const a = args(process.argv.slice(2));
        for (const k of ['track', 'build', 'channel', 'platform', 'arch', 'from', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
        const notes = a['notes-file'] ? await readFile(a['notes-file'], 'utf8') : (a.notes ?? '');
        const r = await packTrack({
            from: a.from, out: a.out, track: a.track, build: a.build, channel: a.channel, platform: a.platform, arch: a.arch,
            minLauncher: a['min-launcher'] ?? null, notes, ...(a['with-client'] ? { withClient: a['with-client'] } : {}), ...(a['next-key'] ? { nextKey: a['next-key'] } : {}),
        });
        console.log(`${r.archive}\n${r.manifest}  (${r.value.files.length} files)`);
    } catch (e) {
        console.error(`pack-track: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    }
}
