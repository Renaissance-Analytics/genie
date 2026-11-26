#!/usr/bin/env node
/**
 * BUILD THE PACKAGES PER TRACK, AND THE LAUNCHER'S INSTALLER (Tynn #1058 L3). In the test VMs and the release job only,
 * never on a desktop. What each package holds is scripts/track-packages.mjs's; this runs it on a real build:
 *
 *   node scripts/build-track-packages.mjs packages --build <track build> --channel stable|dev --launcher <launcher program>
 *        [--out release/tracks/packages] [--signed]
 *     1. electron-builder builds the client as an unpacked app named genie-client, with no host bundle
 *        (release/tracks/client-app/<os>-unpacked); unsigned unless --signed (the release's Azure Trusted Signing)
 *     2. its app.asar is extracted, and the client, browser, host and launcher trees are laid out (release/tracks/trees)
 *     3. each is packed with its unsigned manifest (scripts/pack-track.mjs): the host's names the client of this build
 *   Then scripts/sign-manifest.mjs signs the manifests (the protected release job; a throwaway key in a test VM).
 *
 *   node scripts/build-track-packages.mjs installer --build <track build> --launcher <Genie.exe> [--from <packages>]
 *     Windows: the NSIS installer from a folder of Genie.exe and packages\ (this OS's client, browser and host packages,
 *     manifests and signatures), electron-builder --prepackaged: release/tracks/installer/Genie-<semver>-launcher-setup.exe
 *
 * The dist/ of `npm run build` and build/runtime's Caddy (scripts/fetch-caddy.ts) must be there first.
 */
import { createRequire } from 'node:module';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packTrack } from './pack-track.mjs';
import { clientBuilderConfig, launcherInstallerConfig, layoutHost, layoutWindowApp, programName, treeOf, trackTreeProblems } from './track-packages.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

function args(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m) { out._.push(argv[i]); continue; }
        if (m[1] === 'signed') { out.signed = true; continue; }
        if (i + 1 >= argv.length) throw new Error(`--${m[1]} needs a value`);
        out[m[1]] = argv[++i];
    }
    return out;
}

function semverOf(build) {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d+)(?:\.(\d+))?$/.exec(build);
    if (!m) throw new Error(`not a track build: ${build}`);
    return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}-${m[4]}${m[5] ? `.${m[5]}` : ''}`;
}

function baseConfig() {
    const yaml = require('js-yaml');
    return yaml.load(require('node:fs').readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n'));
}

async function exists(p) { return stat(p).then(() => true, () => false); }

/**
 * The configuration as a file of its own, passed by path: an object passed to electron-builder is merged over
 * electron-builder.yml, and its arrays are joined (builder-util-runtime deepAssign), which would put back what is left out.
 */
async function configFile(name, config) {
    const dir = join(ROOT, 'release', 'tracks');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `electron-builder.${name}.json`);
    await writeFile(file, JSON.stringify(config, null, 2));
    return file;
}

async function buildClient({ signed }) {
    const { build, Platform, Arch } = require('electron-builder');
    const config = clientBuilderConfig(baseConfig());
    if (!signed && platform === 'win32') config.win = { ...config.win, signExecutable: false };
    const target = (platform === 'win32' ? Platform.WINDOWS : Platform.LINUX).createTarget('dir', Arch[arch]);
    console.log(`[tracks] electron-builder: the client as an unpacked app named genie-client (${signed ? 'signed' : 'unsigned'})`);
    await build({ projectDir: ROOT, config: await configFile('client', config), targets: target, publish: 'never' });
    const out = join(ROOT, 'release', 'tracks', 'client-app', platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
    if (!(await exists(join(out, programName('client', platform))))) throw new Error(`electron-builder made no ${programName('client', platform)} in ${out}`);
    return out;
}

async function packages(a) {
    for (const k of ['build', 'channel', 'launcher']) if (!a[k]) throw new Error(`--${k} is required`);
    const out = resolve(a.out ?? join(ROOT, 'release', 'tracks', 'packages'));
    if (!(await exists(join(ROOT, 'dist', 'main', 'host.js')))) throw new Error('dist/main/host.js is not built: npm run build first');
    const unpackedApp = await buildClient({ signed: Boolean(a.signed) });
    const trees = join(ROOT, 'release', 'tracks', 'trees');
    await rm(trees, { recursive: true, force: true });
    const asarDir = join(trees, '.asar');
    const asar = require('@electron/asar');
    asar.extractAll(join(unpackedApp, 'resources', 'app.asar'), asarDir);
    const asarFiles = asar.listPackage(join(unpackedApp, 'resources', 'app.asar'), { isPack: false }).map((f) => f.replace(/\\/g, '/'));
    if (asarFiles.includes('/dist/main/host.js')) throw new Error('the client\'s app.asar holds dist/main/host.js: the host bundle must not be in the client');

    const made = {};
    for (const track of ['client', 'browser']) {
        made[track] = join(trees, track);
        const r = await layoutWindowApp({ from: unpackedApp, out: made[track], track, platform });
        console.log(`[tracks] ${track}: ${r.files} files`);
    }
    made.host = join(trees, 'host');
    const h = await layoutHost({ unpackedApp, asarDir, dist: join(ROOT, 'dist'), runtimeDir: join(unpackedApp, 'resources', 'runtime'), out: made.host, platform, arch });
    console.log(`[tracks] host: ${h.files} files; ${h.leftOut.length} left out by Tynn #437's rule${h.leftOut.length ? ` (${h.leftOut.slice(0, 8).map((l) => l.file).join(', ')}${h.leftOut.length > 8 ? ', ...' : ''})` : ''}`);
    made.launcher = join(trees, 'launcher');
    await mkdir(made.launcher, { recursive: true });
    await copyFile(resolve(a.launcher), join(made.launcher, programName('launcher', platform)));

    // What each package holds is checked before it is packed: a tree with a problem is never packed.
    let bad = 0;
    for (const track of ['client', 'browser', 'host', 'launcher']) {
        const problems = trackTreeProblems({ track, platform, arch, files: await treeOf(made[track]), asarFiles: track === 'client' || track === 'browser' ? asarFiles : [] });
        for (const p of problems) console.log(`### ${track} ${p.why === 'missing' ? 'MISSING  ' : 'NOT HERE '} ${p.file}${p.why === 'missing' ? '' : `  (${p.why})`}`);
        bad += problems.length;
    }
    if (bad) throw new Error(`${bad} problem(s) in the package trees (above)`);

    await mkdir(out, { recursive: true });
    const meta = { build: a.build, channel: a.channel, platform, arch, minLauncher: null, notes: `Genie ${a.build}` };
    for (const track of ['client', 'browser', 'host', 'launcher']) {
        const r = await packTrack({ ...meta, track, from: made[track], out, ...(track === 'host' ? { withClient: a.build } : {}) });
        console.log(`[tracks] packed ${r.archive} (${r.value.files.length} files, ${(await stat(r.archive)).size} bytes)`);
    }
    await writeFile(join(out, 'asar-files.json'), JSON.stringify(asarFiles));
}

async function installer(a) {
    if (platform !== 'win32') throw new Error('the NSIS installer is built on Windows');
    for (const k of ['build', 'launcher']) if (!a[k]) throw new Error(`--${k} is required`);
    const from = resolve(a.from ?? join(ROOT, 'release', 'tracks', 'packages'));
    const dir = join(ROOT, 'release', 'tracks', 'installer-dir');
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'packages'), { recursive: true });
    await copyFile(resolve(a.launcher), join(dir, 'Genie.exe'));
    let n = 0;
    for (const name of await readdir(from)) {
        // This OS's client, browser and host: the launcher is the folder's Genie.exe.
        if (!/^(client|browser|host)-.*-win32-x64\.(zip|manifest\.json|manifest\.json\.sig)$/.test(name)) continue;
        await copyFile(join(from, name), join(dir, 'packages', name));
        n++;
    }
    if (n !== 9) throw new Error(`the installer carries a package, a manifest and a signature per track (9 files); ${from} gave ${n}`);
    const { build, Platform, Arch } = require('electron-builder');
    const config = launcherInstallerConfig(baseConfig(), { version: semverOf(a.build) });
    if (!a.signed) config.win = { ...config.win, signExecutable: false };
    console.log(`[tracks] electron-builder --prepackaged: the launcher's installer, ${config.extraMetadata.version}`);
    const outputs = await build({ projectDir: ROOT, config: await configFile('installer', config), prepackaged: dir, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never' });
    for (const o of outputs) console.log(`[tracks] installer: ${o}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        const a = args(process.argv.slice(2));
        const cmd = a._[0];
        if (cmd === 'packages') await packages(a);
        else if (cmd === 'installer') await installer(a);
        else throw new Error('usage: build-track-packages.mjs packages|installer --build <track build> ...');
    } catch (e) {
        console.error(`build-track-packages: ${e instanceof Error ? e.stack ?? e.message : e}`);
        process.exit(1);
    }
}

