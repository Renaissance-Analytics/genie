import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    COMPONENT_TRACKS, clientBuilderConfig, launcherInstallerConfig, layoutHost, layoutWindowApp, programName, trackTreeProblems,
} from '../scripts/track-packages.mjs';
import { packagePlan } from '../scripts/win-sign-plan.mjs';
import { runtimeFiles } from '../src/main/host-runtime.js';

/*
 * PACKAGES PER TRACK (Tynn #1058 L3; spec: the envelope's .ai/plans/genie-2-host-split-2026-10-31.md, "Launcher build
 * spec", slice L3). One electron-builder build makes the client as an unpacked app named genie-client with no host bundle;
 * the browser is that app again, named genie-browser, on its own track (the owner, 2026-11-26: each part updates on its
 * own); the host is P6-1's copy laid out at build time (genie-host, its runtime files, the bundle under app/, the natives
 * for this OS, the bundled Caddy), holding no app.asar. scripts/build-track-packages.mjs runs these on the real build;
 * the VM rows package-tracks, packed-tree-*, sign-plan-* and track-manifest read what it made.
 */

const require = createRequire(import.meta.url);
const yaml = (file: string) => require('js-yaml').load(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-l3-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function put(root: string, files: Record<string, string>): Promise<void> {
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
    }
}

async function tree(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(d: string): Promise<void> {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else out.push(relative(root, p).replace(/\\/g, '/'));
        }
    }
    await walk(root);
    return out.sort();
}

describe('the programs, one per track', () => {
    it('names each program as the launcher starts it: never Genie, which is the launcher (the installer ends it by name)', () => {
        expect(programName('client', 'win32')).toBe('genie-client.exe');
        expect(programName('browser', 'win32')).toBe('genie-browser.exe');
        expect(programName('host', 'win32')).toBe('genie-host.exe');
        expect(programName('launcher', 'win32')).toBe('Genie.exe');
        expect(programName('client', 'linux')).toBe('genie-client');
        expect(programName('browser', 'linux')).toBe('genie-browser');
        expect(programName('host', 'linux')).toBe('genie-host');
        expect(programName('launcher', 'linux')).toBe('genie');
    });

    it('packs the host, the client and the browser as separate tracks (GApps join later as their own)', () => {
        expect(COMPONENT_TRACKS).toEqual(['client', 'browser', 'host']);
    });

    it('the launcher reads the same names (native/launcher/src/layout.rs)', () => {
        const layout = readFileSync('native/launcher/src/layout.rs', 'utf8');
        for (const name of ['genie-client.exe', 'genie-browser.exe', 'genie-host.exe', '"genie-client"', '"genie-browser"', '"genie-host"']) {
            expect(layout).toContain(name.startsWith('"') ? name : `"${name}"`);
        }
    });
});

describe('the client, built by electron-builder', () => {
    const base = yaml('electron-builder.yml');

    it('is an unpacked app named genie-client with no host bundle in it, and no copy of the launcher', () => {
        const c = clientBuilderConfig(base) as Record<string, any>;
        expect(c.executableName).toBe('genie-client');
        expect(c.files).toContain('!dist/main/host.js');
        expect(c.files).toContain('!dist/main/host.js.map');
        // Everything else of electron-builder.yml is kept (the asar, its unpack rules, the per-OS file rules, the fuse).
        for (const keep of ['dist/**', 'package.json']) expect(c.files).toContain(keep);
        expect(c.asarUnpack).toEqual(base.asarUnpack);
        expect(c.electronFuses).toEqual(base.electronFuses);
        expect(c.win.files).toEqual((base.win as any).files);
        expect(c.appId).toBe(base.appId);
        // The launcher is its own program now (Genie.exe / genie): the client carries no genie-launch.exe.
        expect(JSON.stringify(c.extraResources)).not.toContain('genie-launch.exe');
        expect(c.directories.output).toBe('release/tracks/client-app');
        expect(c.publish).toBeNull();
    });

    it('leaves electron-builder.yml itself as it is: the single-app build still ships until the bridge (L9)', () => {
        expect(base.executableName).toBeUndefined();
        expect(JSON.stringify(base.extraResources)).toContain('genie-launch.exe');
    });
});

describe('the client and the browser packages', () => {
    const unpacked = (platform: 'win32' | 'linux') => ({
        [platform === 'win32' ? 'genie-client.exe' : 'genie-client']: 'electron',
        'resources/app.asar': 'asar',
        'resources/app.asar.unpacked/node_modules/node-pty/lib/index.js': 'pty',
        'resources/bin/genie-launch.exe': 'old launcher',
        'resources/runtime/caddy.exe': 'caddy',
        'resources/runtime/caddy': 'caddy',
        'resources/icon.png': 'icon',
        'icudtl.dat': 'icu',
        'LICENSE.electron.txt': 'license',
    });

    it.each(['win32', 'linux'] as const)('%s: the client is the build with its program named genie-client, nothing of the host or the launcher', async (platform) => {
        const from = join(dir, 'unpacked');
        await put(from, unpacked(platform));
        const out = join(dir, 'client');
        await layoutWindowApp({ from, out, track: 'client', platform });
        const files = await tree(out);
        expect(files).toContain(programName('client', platform));
        expect(files).toContain('resources/app.asar');
        expect(files).toContain('resources/icon.png');
        expect(files.filter((f) => /genie-launch|caddy/.test(f))).toEqual([]);
    });

    it.each(['win32', 'linux'] as const)('%s: the browser is the same app, its program named genie-browser, on its own track', async (platform) => {
        const from = join(dir, 'unpacked');
        await put(from, unpacked(platform));
        const out = join(dir, 'browser');
        await layoutWindowApp({ from, out, track: 'browser', platform });
        const files = await tree(out);
        expect(files).toContain(programName('browser', platform));
        expect(files).not.toContain(programName('client', platform));
        expect(await readFile(join(out, programName('browser', platform)), 'utf8')).toBe('electron');
    });
});

describe('the host package: P6-1\'s copy, made at build time', () => {
    async function inputs(platform: 'win32' | 'linux') {
        const unpackedApp = join(dir, 'unpacked');
        const exe = programName('client', platform);
        await put(unpackedApp, {
            [exe]: 'electron binary',
            'icudtl.dat': 'icu', 'v8_context_snapshot.bin': 'v8', 'libffmpeg.so': 'ffmpeg', 'ffmpeg.dll': 'ffmpeg', 'resources.pak': 'pak',
            'resources/app.asar': 'asar',
            'resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node': 'native pty',
        });
        // The asar's contents, extracted (scripts/build-track-packages.mjs does it with @electron/asar).
        const asar = join(dir, 'asar');
        await put(asar, {
            'package.json': '{"name":"genie"}',
            'dist/main/main.js': 'main',
            'node_modules/node-pty/build/Release/pty.node': 'stub',
            'node_modules/node-pty/lib/index.js': 'pty js',
            'node_modules/@particle-academy/prism-acp/index.js': 'prism',
        });
        const dist = join(dir, 'dist');
        await put(dist, { 'main/host.js': 'host', 'main/main.js': 'main', 'renderer/index.html': '<html>' });
        const caddy = join(dir, 'runtime');
        await put(caddy, { [platform === 'win32' ? 'caddy.exe' : 'caddy']: 'caddy' });
        return { unpackedApp, asar, dist, caddy, exe };
    }

    it.each(['win32', 'linux'] as const)('%s: genie-host, its runtime files, the bundle under app/, the natives, Caddy, and no app.asar', async (platform) => {
        const i = await inputs(platform);
        const out = join(dir, 'host');
        await layoutHost({ unpackedApp: i.unpackedApp, asarDir: i.asar, dist: i.dist, runtimeDir: i.caddy, out, platform });
        const files = await tree(out);
        const expected = [
            programName('host', platform),
            ...runtimeFiles(platform),
            'app/dist/main/host.js', 'app/dist/main/main.js', 'app/dist/renderer/index.html',
            'app/node_modules/@particle-academy/prism-acp/index.js',
            'app/node_modules/node-pty/build/Release/pty.node',
            'app/node_modules/node-pty/lib/index.js',
            'app/package.json',
            `resources/runtime/${platform === 'win32' ? 'caddy.exe' : 'caddy'}`,
        ].sort();
        expect(files).toEqual(expected);
        expect(await readFile(join(out, programName('host', platform)), 'utf8')).toBe('electron binary');
        // A native file is the unpacked one: the asar holds only a stub of it.
        expect(await readFile(join(out, 'app/node_modules/node-pty/build/Release/pty.node'), 'utf8')).toBe('native pty');
        // The bundle is the build's dist, host.js and all (the client's asar has none).
        expect(await readFile(join(out, 'app/dist/main/host.js'), 'utf8')).toBe('host');
        if (platform === 'linux') expect((await stat(join(out, 'genie-host'))).mode & 0o111).toBe(0o111);
    });

    it('the launcher starts the entry where layout.rs says it is (HOST_ENTRY)', () => {
        expect(readFileSync('native/launcher/src/layout.rs', 'utf8')).toContain('pub const HOST_ENTRY: &str = "app/dist/main/host.js";');
    });

    it('refuses a build with no host.js in it, rather than packing a host that cannot start', async () => {
        const i = await inputs('linux');
        await rm(join(i.dist, 'main', 'host.js'));
        await expect(layoutHost({ unpackedApp: i.unpackedApp, asarDir: i.asar, dist: i.dist, runtimeDir: i.caddy, out: join(dir, 'h'), platform: 'linux' })).rejects.toThrow(/host\.js/);
    });
});

describe('what each package must hold, and must not', () => {
    const own = 'win32-x64';
    const nodePty = (p: string) => `${p}node_modules/node-pty/prebuilds/${own}/`;
    const winHostRequired = [
        'genie-host.exe', 'icudtl.dat', 'v8_context_snapshot.bin', 'app/dist/main/host.js', 'app/package.json', 'resources/runtime/caddy.exe',
        ...['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((f) => `${nodePty('app/')}${f}`),
        'app/node_modules/@particle-academy/fancy-pty/bin/win32-x64/fancy-pty-helper.exe',
        'app/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node',
        'app/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe',
        'app/node_modules/@particle-academy/prism-acp/native/win32-arm64/prism-acp-supervisor.exe',
    ];

    it('a good host package passes; one holding an app.asar, or lacking its entry, does not', () => {
        expect(trackTreeProblems({ track: 'host', platform: 'win32', arch: 'x64', files: winHostRequired })).toEqual([]);
        expect(trackTreeProblems({ track: 'host', platform: 'win32', arch: 'x64', files: [...winHostRequired, 'resources/app.asar'] }))
            .toEqual([expect.objectContaining({ file: 'resources/app.asar', why: expect.stringMatching(/app\.asar/) })]);
        expect(trackTreeProblems({ track: 'host', platform: 'win32', arch: 'x64', files: winHostRequired.filter((f) => f !== 'app/dist/main/host.js') }))
            .toEqual([expect.objectContaining({ file: 'app/dist/main/host.js', why: 'missing' })]);
    });

    it('a host package holds no other platform\'s binaries and no build leftovers (Tynn #437\'s rule, under app/)', () => {
        const extra = [`app/node_modules/node-pty/prebuilds/linux-x64/pty.node`, 'app/node_modules/node-pty/src/unix/pty.cc', 'app/node_modules/x/build.ps1'];
        const problems = trackTreeProblems({ track: 'host', platform: 'win32', arch: 'x64', files: [...winHostRequired, ...extra] });
        expect(problems.map((p: { file: string }) => p.file).sort()).toEqual([...extra].sort());
    });

    it('a client or browser package holds no host bundle: host.js in its app.asar fails it', () => {
        const files = ['genie-client.exe', 'resources/app.asar'];
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files, asarFiles: ['/dist/main/main.js'] })).toEqual([]);
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files, asarFiles: ['/dist/main/main.js', '/dist/main/host.js'] }))
            .toEqual([expect.objectContaining({ file: 'resources/app.asar:/dist/main/host.js' })]);
        expect(trackTreeProblems({ track: 'browser', platform: 'linux', arch: 'x64', files: ['genie-browser', 'resources/app.asar'], asarFiles: ['/dist/main/host.js'] }))
            .toEqual([expect.objectContaining({ file: 'resources/app.asar:/dist/main/host.js' })]);
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files: ['genie-client.exe', 'resources/app.asar', 'resources/bin/genie-launch.exe'], asarFiles: [] }))
            .toEqual([expect.objectContaining({ file: 'resources/bin/genie-launch.exe' })]);
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files: ['resources/app.asar'], asarFiles: [] }))
            .toEqual([expect.objectContaining({ file: 'genie-client.exe', why: 'missing' })]);
    });
});

describe('what the release signs in each package (Windows)', () => {
    const signExts = (yaml('electron-builder.yml').win as { signExts: string[] }).signExts;

    it('the host package: every program and native module ships signed, never a file another publisher signed', () => {
        const files = ['genie-host.exe', 'icudtl.dat', 'app/dist/main/host.js', 'resources/runtime/caddy.exe', 'app/node_modules/node-pty/prebuilds/win32-x64/pty.node',
            'app/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', 'app/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
            'app/node_modules/node-pty/prebuilds/win32-x64/winpty.dll', 'app/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe'];
        expect(packagePlan(files, signExts).sort()).toEqual([
            'genie-host.exe', 'resources/runtime/caddy.exe', 'app/node_modules/node-pty/prebuilds/win32-x64/pty.node',
            'app/node_modules/node-pty/prebuilds/win32-x64/winpty.dll', 'app/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe',
        ].sort());
    });

    it('the launcher package: Genie.exe', () => {
        expect(packagePlan(['Genie.exe'], signExts)).toEqual(['Genie.exe']);
    });
});

describe('the installer: the launcher at Genie.exe, and the packages it installs', () => {
    const base = yaml('electron-builder.yml');

    it('is today\'s installer shape: the same appId and folder, one-click, per user, no elevation', () => {
        const c = launcherInstallerConfig(base, { version: '2026.11.26-1' }) as Record<string, any>;
        expect(c.appId).toBe('ai.tynn.genie');
        expect(c.productName).toBe('Genie');
        expect(c.nsis.oneClick).toBe(true);
        expect(c.nsis.perMachine).toBe(false);
        expect(c.nsis.deleteAppDataOnUninstall).toBe(false);
        expect(c.nsis.include).toBe('build/launcher-installer.nsh');
        expect(c.extraMetadata.version).toBe('2026.11.26-1');
        expect(c.win.artifactName).toBe('Genie-${version}-launcher-setup.${ext}');
        expect(c.win.target).toEqual(['nsis']);
        expect(c.directories.output).toBe('release/tracks/installer');
        expect(c.publish).toBeNull();
    });

    it('asks client + local host (the default) or client only, and installs from its own packages; /S /PROFILE=client is the automated form', () => {
        const nsh = readFileSync('build/launcher-installer.nsh', 'utf8');
        expect(nsh).toMatch(/This computer runs Genie's host/);
        expect(nsh).toMatch(/Client only/);
        expect(nsh).toMatch(/\/PROFILE=/);
        expect(nsh).toContain('"$INSTDIR\\Genie.exe" install --profile $GenieProfile --from "$INSTDIR\\packages" --yes');
        // The NSIS folder holds the launcher alone once the packages are in the code root.
        expect(nsh).toContain('RMDir /r "$INSTDIR\\packages"');
        // Genie (doctor mode) beside Genie, both the launcher.
        expect(nsh).toContain('(doctor mode).lnk" "$appExe" "--doctor"');
        // An upgrade runs the old uninstaller over the folder: only a real uninstall stops Genie and removes the code root.
        expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}[\s\S]*Genie\.exe" uninstall --yes/);
        // The choice is skipped on an update (electron-updater runs it silent), as a license page would be.
        expect(nsh).toMatch(/!macro licensePage/);
    });
});
