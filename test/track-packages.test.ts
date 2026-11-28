import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    COMPONENT_TRACKS, bridgeConfig, clientBuilderConfig, launcherInstallerConfig, layoutBrowser, layoutHost, layoutWindowApp, programName, trackTreeProblems,
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
        expect(programName('host', 'win32')).toBe('genie-host.exe');
        expect(programName('launcher', 'win32')).toBe('Genie.exe');
        expect(programName('client', 'linux')).toBe('genie-client');
        expect(programName('host', 'linux')).toBe('genie-host');
        expect(programName('launcher', 'linux')).toBe('genie');
    });

    it('packs the host, the client and the browser as separate tracks (GApps join later as their own)', () => {
        expect(COMPONENT_TRACKS).toEqual(['client', 'browser', 'host']);
    });

    it('the launcher reads the same names (native/launcher/src/layout.rs)', () => {
        const layout = readFileSync('native/launcher/src/layout.rs', 'utf8');
        for (const name of ['genie-client.exe', 'genie-host.exe', '"genie-client"', '"genie-host"']) {
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
        // No third-party sourcemaps: nothing loads them at runtime.
        expect(c.files).toContain('!**/node_modules/**/*.map');
        // Everything else of electron-builder.yml is kept (the asar, its unpack rules, the per-OS file rules, the fuse).
        for (const keep of ['dist/**', 'package.json']) expect(c.files).toContain(keep);
        expect(c.asarUnpack).toEqual(base.asarUnpack);
        expect(c.electronFuses).toEqual(base.electronFuses);
        // A platform's own `files` take the place of the top-level list for the app's files (electron-builder 26.15.3,
        // measured: the Windows build's builder-debug.yml had only `**/*` and win.files' exclusions, so the repository went
        // into the client's asar, item 1126-191543-b3aa95). Each platform list therefore carries the top-level patterns
        // first, then its own.
        expect(c.win.files.slice(0, 2)).toEqual(['dist/**', 'package.json']);
        for (const p of (base.win as any).files as string[]) expect(c.win.files).toContain(p);
        // An include after an exclusion takes the file back (electron-builder's matcher: the last match wins; the gate
        // 1126-195203-d667d9 found host.js in the client once win.files began with dist/**). So every exclusion of the
        // client's own comes after the last include.
        const lastInclude = Math.max(...c.win.files.map((p: string, i: number) => (p.startsWith('!') ? -1 : i)));
        for (const own of ['!dist/main/host.js', '!dist/main/host.js.map', '!**/node_modules/**/*.map']) {
            expect(c.win.files.indexOf(own), own).toBeGreaterThan(lastInclude);
            expect(c.files.indexOf(own), own).toBeGreaterThan(Math.max(...c.files.map((p: string, i: number) => (p.startsWith('!') ? -1 : i))));
        }
        expect(new Set(c.win.files).size, 'no pattern twice').toBe(c.win.files.length);
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

    it('the browser is its own track with NO second copy of the app: browser.json, and its manifest names the client it runs on', async () => {
        // The coordinator, 2026-11-26: while the browser is the client app run with --genie-browser, its package carries
        // only what is browser-only, and the launcher runs the installed client build its manifest names.
        const out = join(dir, 'browser');
        await layoutBrowser({ out });
        expect(await tree(out)).toEqual(['browser.json']);
        expect(JSON.parse(await readFile(join(out, 'browser.json'), 'utf8'))).toEqual({ runs: 'client', args: ['--genie-browser'] });
        expect(trackTreeProblems({ track: 'browser', platform: 'win32', arch: 'x64', files: ['browser.json'] })).toEqual([]);
        expect(trackTreeProblems({ track: 'browser', platform: 'win32', arch: 'x64', files: ['browser.json', 'genie-client.exe', 'resources/app.asar'] }).map((p: { file: string }) => p.file).sort())
            .toEqual(['genie-client.exe', 'resources/app.asar']);
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
        // Execute bits exist only where the file system has them (the Windows unit run has none).
        if (platform === 'linux' && process.platform !== 'win32') expect((await stat(join(out, 'genie-host'))).mode & 0o111).toBe(0o111);
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

    it('a client package holds no host bundle: host.js in its app.asar fails it', () => {
        const files = ['genie-client.exe', 'resources/app.asar'];
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files, asarFiles: ['/dist/main/main.js'] })).toEqual([]);
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files, asarFiles: ['/dist/main/main.js', '/dist/main/host.js'] }))
            .toEqual([expect.objectContaining({ file: 'resources/app.asar:/dist/main/host.js' })]);
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files: ['genie-client.exe', 'resources/app.asar', 'resources/bin/genie-launch.exe'], asarFiles: [] }))
            .toEqual([expect.objectContaining({ file: 'resources/bin/genie-launch.exe' })]);
        // The client's app.asar holds the app and its production modules, nothing of the repository (the Windows build packed
        // scripts/, test/ and CI screenshots into a 956 MiB asar: item 1126-183942-7000a7).
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files, asarFiles: ['/package.json', '/dist/main/main.js', '/node_modules/react/index.js'] })).toEqual([]);
        expect(trackTreeProblems({ track: 'client', platform: 'win32', arch: 'x64', files, asarFiles: ['/dist/main/main.js', '/scripts/smoke-cdp.mjs', '/test/a.test.ts', '/session-shot-20s.png', '\\contracts\\workspace-ux.json'] }).map((p: { file: string }) => p.file))
            .toEqual(['resources/app.asar:/scripts', 'resources/app.asar:/test', 'resources/app.asar:/session-shot-20s.png', 'resources/app.asar:/contracts']);
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
        expect(c.nsis.packElevateHelper).toBe(false);
        expect(c.extraMetadata.version).toBe('2026.11.26-1');
        expect(c.win.artifactName).toBe('Genie-${version}-launcher-setup.${ext}');
        expect(c.win.target).toEqual(['nsis']);
        expect(c.directories.output).toBe('release/tracks/installer');
        expect(c.publish).toBeNull();
    });

    it('does the bare install: the launcher and its packages, Genie opened after; the silent form installs them itself', () => {
        const nsh = readFileSync('build/launcher-installer.nsh', 'utf8');
        // NSIS hosts no webview: no page of its own. The choice is the launcher's window (native/launcher/ui/setup.html).
        expect(nsh).not.toMatch(/nsDialogs|licensePage|Page custom/);
        expect(nsh).toMatch(/\/PROFILE=/);
        // /S (and electron-updater's silent run): the launcher installs from the packages beside it, and refuses in words.
        expect(nsh).toMatch(/\$\{if\} \$\{Silent\}[\s\S]*"\$INSTDIR\\Genie\.exe" install --profile \$GenieProfile --from "\$INSTDIR\\packages" --yes[\s\S]*RMDir \/r "\$INSTDIR\\packages"/);
        // Genie (doctor mode) beside Genie, both the launcher.
        expect(nsh).toContain('(doctor mode).lnk" "$appExe" "--doctor"');
        // An upgrade runs the old uninstaller over the folder: only a real uninstall stops Genie and removes the code root.
        expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}[\s\S]*Genie\.exe" uninstall --yes/);
    });
});

describe('the bridge (Tynn #1058 L9): what every single-app install updates to through its own electron-updater', () => {
    const base = yaml('electron-builder.yml');

    it('Windows: the launcher\'s installer under today\'s name and version, its feed file written, published to the draft', () => {
        const c = bridgeConfig(base, { version: '2.0.0', os: 'win' }) as Record<string, any>;
        expect(c.appId).toBe('ai.tynn.genie');
        expect(c.productName).toBe('Genie');
        expect(c.nsis.include).toBe('build/launcher-installer.nsh');
        expect(c.nsis.packElevateHelper).toBe(false);
        expect(c.nsis.oneClick).toBe(true);
        expect(c.nsis.perMachine).toBe(false);
        // The name every single-app release had: electron-updater reads it from latest.yml, and release-check from the draft.
        expect(c.win.artifactName).toBe((base.win as Record<string, unknown>).artifactName);
        expect(c.win.target).toEqual(['nsis']);
        expect(c.extraMetadata.version).toBe('2.0.0');
        expect(c.directories.output).toBe('release/tracks/bridge');
        // A publish target, so electron-builder writes latest.yml and the .blockmap: the release's, a draft only.
        expect(c.publish).toEqual(base.publish);
        expect(c.publish.releaseType).toBe('draft');
    });

    it('Linux: an AppImage of the launcher and its packages, run as genie, under today\'s name', () => {
        const c = bridgeConfig(base, { version: '2.0.0', os: 'linux' }) as Record<string, any>;
        expect(c.linux.target).toEqual(['AppImage']);
        expect(c.linux.executableName).toBe('genie');
        expect(c.linux.artifactName).toBe('${productName}-${version}.${ext}');
        expect(c.linux.icon).toBe((base.linux as Record<string, unknown>).icon);
        expect(c.extraMetadata.version).toBe('2.0.0');
        expect(c.directories.output).toBe('release/tracks/bridge');
        expect(c.protocols).toEqual(base.protocols);
        expect(c.publish).toEqual(base.publish);
    });

    it('a test VM\'s bridge names its local feed instead (the migrate-single-install row), and nothing else', () => {
        const c = bridgeConfig(base, { version: '2.0.0', os: 'linux', feed: 'http://127.0.0.1:8099/' }) as Record<string, any>;
        expect(c.publish).toEqual({ provider: 'generic', url: 'http://127.0.0.1:8099/' });
        expect(() => bridgeConfig(base, { version: '2.0.0', os: 'linux', feed: 'https://example.com/' })).toThrow(/127\.0\.0\.1/);
    });

    it('is built by build-track-packages.mjs bridge from the launcher and this OS\'s signed packages, its feed naming the host', () => {
        const script = readFileSync('scripts/build-track-packages.mjs', 'utf8');
        expect(script).toMatch(/cmd === 'bridge'\) await bridge\(a\)/);
        expect(script).toMatch(/async function bridge\(a\)[\s\S]*bridgeConfig\(baseConfig\(\), \{ version: a\.version, os[\s\S]*prepackaged: dir/);
        // The feed names the host the bridge brings: the outgoing Genie's update kind decides client-only or a drain.
        expect(script).toMatch(/async function bridge\(a\)[\s\S]*feedHostIdentity\(/);
    });
});

describe('the setup window: the owner\'s direction C, "Wish Orb", in the launcher (Tynn #1058 L3)', () => {
    const html = readFileSync('native/launcher/ui/setup.html', 'utf8');

    it('carries the mockup\'s three install screens and its own CSS, bundled: nothing is fetched', () => {
        for (const id of ['s-choose', 's-install', 's-ready']) expect(html).toContain(`id="${id}"`);
        expect(html).toContain('/*GENIE_CSS*/');
        expect(readFileSync('native/launcher/src/ui.rs', 'utf8')).toMatch(/include_str!\("\.\.\/ui\/base\.css"\)[\s\S]*include_str!\("\.\.\/ui\/theme-c\.css"\)/);
        expect(readFileSync('native/launcher/ui/theme-c.css', 'utf8')).toMatch(/C: Wish Orb/);
        expect(html).not.toMatch(/(src|href)="https?:/);
    });

    it('asks the owner\'s choice: Genie + this computer as a host (recommended, chosen) or Genie only', () => {
        expect(html).toMatch(/class="opt on" data-profile="both"[\s\S]*Genie \+ this computer as a host[\s\S]*Recommended/);
        expect(html).toMatch(/data-profile="client"[\s\S]*Genie only/);
        expect(html).toContain('Installs for you only. No administrator rights needed.');
        expect(html).toMatch(/send\(\{ kind: 'install', profile: profile \}\)/);
    });

    it('honours reduce motion (the mockup\'s own rule, in the bundled CSS)', () => {
        expect(readFileSync('native/launcher/ui/base.css', 'utf8')).toContain('@media (prefers-reduced-motion: reduce)');
    });
});
