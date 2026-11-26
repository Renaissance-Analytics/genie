#!/usr/bin/env node
/**
 * A PACKAGE SET WITH ONE TAMPERED FILE, for the launcher-install rows (Tynn #1058 L3): the failure the setup window must
 * show in words. Copies <packages> to <out>, then packs the browser's tree again with one byte of browser.json changed and
 * puts only that archive in place: its signed manifest is the original, so the archive is not what the signature covers.
 * Test VMs only.
 *
 *   node scripts/ci/tamper-package.mjs <packages dir> <trees dir> <out dir>
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packTrack } from '../pack-track.mjs';

const [pkgs, trees, out] = process.argv.slice(2);
if (!pkgs || !trees || !out) { console.error('usage: tamper-package.mjs <packages> <trees> <out>'); process.exit(2); }
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
await rm(out, { recursive: true, force: true });
await cp(pkgs, out, { recursive: true });
const stem = (await readdir(out)).find((n) => n.startsWith('browser-') && n.endsWith('.manifest.json'))?.slice(0, -'.manifest.json'.length);
if (!stem) { console.error('tamper-package: no browser package'); process.exit(1); }
const manifest = JSON.parse(await readFile(join(out, `${stem}.manifest.json`), 'utf8'));
const work = `${out}.work`;
await rm(work, { recursive: true, force: true });
await cp(join(trees, 'browser'), join(work, 'tree'), { recursive: true });
const file = join(work, 'tree', 'browser.json');
const bytes = await readFile(file);
bytes[0] = bytes[0] ^ 0x01;
await writeFile(file, bytes);
await mkdir(join(work, 'packed'), { recursive: true });
const packed = await packTrack({ track: 'browser', build: manifest.build, channel: manifest.channel, platform, arch, withClient: manifest.withClient, minLauncher: manifest.minLauncher, notes: manifest.notes, from: join(work, 'tree'), out: join(work, 'packed') });
await cp(packed.archive, join(out, packed.archive.split(/[\\/]/).pop()));
await rm(work, { recursive: true, force: true });
console.log(`tampered: ${stem} (browser.json, one byte; the signed manifest is the original) in ${out}`);
