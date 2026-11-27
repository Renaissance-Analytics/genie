#!/usr/bin/env -S npx tsx
/**
 * THE TRACK-MANIFEST ROW (Tynn #1058 L3; was update-metadata): every package this run made verifies as the launcher would
 * take it, by src/core/track-manifest.ts itself. For each `<track>-<build>-<platform>-<arch>`:
 *   - its manifest's signature by the run's key, its shape, and that it is the track, platform and architecture it says;
 *   - every file in its archive is one the manifest lists, at its size and SHA-256, none missing and none unlisted;
 *   - the host names the client of this build (withClient), and only the host names one;
 *   - CONTROLS, in the same run: one flipped byte in the manifest refuses (signature), and one flipped byte in a file is
 *     caught (its SHA-256).
 *
 *   npx tsx scripts/track-manifest-check.mts <packages dir> <public key file>
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readArchive } from './pack-track.mjs';
import { clientOf, verifyManifest, type PackageTrack } from '../src/core/track-manifest.js';

const [dir, keyFile] = process.argv.slice(2);
if (!dir || !keyFile) { console.error('usage: track-manifest-check.mts <packages dir> <public key file>'); process.exit(2); }
const key = readFileSync(keyFile, 'utf8').trim();
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let failed = 0;
const say = (ok: boolean, line: string) => { console.log(`### ${ok ? 'OK  ' : 'FAIL'} ${line}`); if (!ok) failed++; };

const stems = readdirSync(dir).filter((n) => n.endsWith('.manifest.json')).map((n) => n.slice(0, -'.manifest.json'.length)).sort();
const tracks = stems.map((s) => s.split('-')[0]);
say(['browser', 'client', 'host', 'launcher'].every((t) => tracks.includes(t)), `a package per track: ${stems.join(', ')}`);
const builds = new Map<string, string>();

for (const stem of stems) {
    const m = /^([a-z]+)-(.+)-(win32|linux)-(x64|arm64)$/.exec(stem);
    if (!m) { say(false, `${stem}: not <track>-<build>-<platform>-<arch>`); continue; }
    const [, track, build, p, a] = m as unknown as [string, PackageTrack, string, string, string];
    const bytes = readFileSync(join(dir, `${stem}.manifest.json`));
    const sig = readFileSync(join(dir, `${stem}.manifest.json.sig`), 'utf8');
    const expect = { track, platform: p as 'win32' | 'linux', arch: a as 'x64' | 'arm64', channel: 'dev' as const, current: null, launcher: null };
    const v = verifyManifest(bytes, sig, [key], expect);
    say(v.ok, `${stem}: the manifest verifies${v.ok ? '' : ` (${v.reason})`}`);
    if (!v.ok) continue;
    say(p === platform && a === arch, `${stem}: for this machine`);
    builds.set(track, build);
    const archive = join(dir, `${stem}${p === 'win32' ? '.zip' : '.tar.zst'}`);
    const entries = await readArchive(archive);
    const listed = new Map(v.manifest.files.map((f) => [f.path, f]));
    let bad = 0;
    for (const e of entries) {
        const f = listed.get(e.path);
        if (!f || f.size !== e.data.length || f.sha256 !== sha(e.data)) { bad++; if (bad <= 5) console.log(`###      ${e.path}: ${f ? 'not the file its manifest names' : 'not in the manifest'}`); }
        listed.delete(e.path);
    }
    say(bad === 0 && listed.size === 0, `${stem}: ${entries.length} files, each its manifest's (${bad} wrong, ${listed.size} missing)`);
    if (track === 'host' || track === 'browser') say(clientOf(v.manifest) !== null, `${stem}: names the client it ${track === 'host' ? 'ships with' : 'runs on'} (${v.manifest.withClient})`);
    else say(clientOf(v.manifest) === null && v.manifest.withClient === undefined, `${stem}: names no client`);

    // The controls: a gauge that refuses nothing proves nothing.
    const flipped = Buffer.from(bytes);
    const at = flipped.indexOf('"notes"') + 2;
    flipped[at] = flipped[at]! ^ 0x01;
    const refused = verifyManifest(flipped, sig, [key], expect);
    say(!refused.ok && refused.code === 'signature', `${stem}: CONTROL one flipped byte in the manifest refuses (${refused.ok ? 'it did not' : refused.code})`);
    const first = entries.find((e) => e.data.length > 0);
    if (first) {
        const data = Buffer.from(first.data);
        data[0] = data[0]! ^ 0x01;
        const f = v.manifest.files.find((x) => x.path === first.path)!;
        say(sha(data) !== f.sha256, `${stem}: CONTROL one flipped byte in ${first.path} is caught by its SHA-256`);
    }
}
for (const t of ['host', 'browser']) {
    const stem = stems.find((s) => s.startsWith(`${t}-`));
    if (!stem) continue;
    const m = JSON.parse(readFileSync(join(dir, `${stem}.manifest.json`), 'utf8')) as { withClient?: string; files?: Array<{ path: string }> };
    say(m.withClient === builds.get('client'), `the ${t} names the client packed beside it (${m.withClient} = ${builds.get('client')})`);
    if (t === 'browser') say(JSON.stringify(m.files?.map((f) => f.path)) === '["browser.json"]', 'the browser carries no second copy of the app (browser.json alone)');
}
console.log(`### track-manifest=${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
